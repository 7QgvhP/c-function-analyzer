import Parser = require('web-tree-sitter');

// 解析結果を保持するインターフェース定義

/**
 * シンボルが宣言・定義されている位置です。
 *
 * `filePath` を省略した場合は解析対象ファイル自身を指します
 * （インクルードファイル内の定義を指す場合のみ設定されます）。
 */
export interface DefinitionLocation {
    filePath?: string;
    /** 行番号（0始まり） */
    line: number;
    /** 列番号（0始まり） */
    column: number;
}

export interface VariableInfo {
    name: string;
    type: string;
    details?: string; // 補足情報（例：「値渡し引数」「ポインタ書き込み（出力）」「グローバル変数」など）
    /**
     * エディタ上に対応する識別子が存在し、ハイライト検索の対象になるか。
     * 省略時は true として扱います（「戻り値 (return)」など実体のない項目のみ false）。
     */
    highlightable?: boolean;
    /** 宣言・定義されている位置。特定できなかった場合は未設定 */
    definition?: DefinitionLocation;
}

/** 呼び出し関数・マクロ関数の情報 */
export interface FunctionInfo {
    /** 表示名（マクロ関数を含む） */
    name: string;
    /** 宣言・定義されている位置。特定できなかった場合は未設定 */
    definition?: DefinitionLocation;
}

export interface AnalysisResult {
    functionName: string;
    returnType: string;
    inputs: VariableInfo[];
    outputs: VariableInfo[];
    internalVariables: VariableInfo[];
    calledFunctions: FunctionInfo[];
    macroVariables?: VariableInfo[];
    macroFunctions?: FunctionInfo[];
    startLine: number;
    endLine: number;
    filePath?: string;
}

// 標準的なマクロや予約語など、グローバル変数判定から除外するブラックリスト
const EXCLUDE_LIST = new Set([
    'NULL', 'TRUE', 'FALSE', 'true', 'false',
    'stdin', 'stdout', 'stderr',
    'sizeof', 'countof',
    'int', 'char', 'float', 'double', 'void', 'short', 'long', 'signed', 'unsigned',
    'struct', 'union', 'enum'
]);

/** 関数引数の解析情報 */
interface ParamInfo {
    name: string;
    /** 型名（アスタリスクを含まない部分） */
    type: string;
    /** ポインタ宣言（*）の深さ */
    pointerDepth: number;
    /** 配列宣言（[]）の深さ */
    arrayDepth: number;
    /** ポインタまたは配列（＝デレファレンスによる書き込みが可能）か */
    isPointer: boolean;
    /** 引数が宣言されている位置 */
    definition: DefinitionLocation;
}

/** 宣言された変数の情報（ローカル変数・ファイルスコープ変数で共用） */
interface DeclaredVar {
    /** 型名（ポインタのアスタリスクを含む） */
    type: string;
    /** 宣言されている位置 */
    definition: DefinitionLocation;
}

/** フェーズ3: 関数シグネチャの解析結果 */
interface SignatureInfo {
    functionName: string;
    returnType: string;
    params: ParamInfo[];
}

/** フェーズ4: 関数ボディの走査で収集した生データ */
interface BodyAnalysis {
    /** ローカル変数（名前 → 型名と宣言位置） */
    localVars: Map<string, DeclaredVar>;
    /** 直接呼び出されている関数名 */
    calledFunctions: Set<string>;
    /** 読み取られているグローバル変数のアクセスパス */
    globalVarReads: Set<string>;
    /** 書き込まれているグローバル変数のアクセスパス */
    globalVarWrites: Set<string>;
    /** 読み取られているポインタ引数のアクセスパス */
    pointerReads: Set<string>;
    /** 書き込まれているポインタ引数のアクセスパス */
    pointerWrites: Set<string>;
}

/** 宣言子（declarator）の解析結果 */
interface DeclaratorInfo {
    /** 宣言されている識別子名（解決できなかった場合は空文字列） */
    name: string;
    /** ポインタ宣言（*）の深さ */
    pointerDepth: number;
    /** 配列宣言（[]）の深さ */
    arrayDepth: number;
    /**
     * 識別子に到達する直前に通過した function_declarator。
     * 関数宣言・関数ポインタ宣言でない場合は null になります。
     */
    ownerFunctionDeclarator: Parser.SyntaxNode | null;
    /** 識別子ノードの位置。名前が解決できなかった場合は null */
    position: DefinitionLocation | null;
}

/**
 * ASTノードの開始位置を定義位置として取り出します。
 *
 * @param node 対象ノード
 * @param filePath インクルードファイル内の場合はそのパス（解析対象ファイル自身なら省略）
 * @returns 定義位置
 */
function toDefinitionLocation(node: Parser.SyntaxNode, filePath?: string): DefinitionLocation {
    const location: DefinitionLocation = {
        line: node.startPosition.row,
        column: node.startPosition.column
    };
    if (filePath) {
        location.filePath = filePath;
    }
    return location;
}

/**
 * ASTノードを再帰的に走査するヘルパー関数
 */
function walk(node: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void) {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, callback);
    }
}

/**
 * 宣言子（declarator）ノードを再帰的に降り、宣言されている識別子名と
 * ポインタ・配列の深さを解決します。
 *
 * ポインタ宣言・配列宣言・括弧付き宣言・関数宣言のいずれの入れ子にも対応します。
 *
 * @param node 宣言子ノード（pointer_declarator, array_declarator, function_declarator など）
 * @returns 識別子名とポインタ・配列の深さ、および引数リストを保持する function_declarator
 */
function resolveDeclarator(node: Parser.SyntaxNode, filePath?: string): DeclaratorInfo {
    let name = '';
    let pointerDepth = 0;
    let arrayDepth = 0;
    let ownerFunctionDeclarator: Parser.SyntaxNode | null = null;
    let position: DefinitionLocation | null = null;

    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (current.type === 'pointer_declarator') {
            pointerDepth++;
        } else if (current.type === 'array_declarator') {
            arrayDepth++;
        } else if (current.type === 'function_declarator') {
            // 識別子に最も近い function_declarator が実際の引数リストを保持する
            ownerFunctionDeclarator = current;
        } else if (current.type === 'identifier') {
            name = current.text;
            position = toDefinitionLocation(current, filePath);
            break;
        }

        // parenthesized_declarator は declarator フィールドを持たないため、'(' の次の子へ進む
        const next: Parser.SyntaxNode | null = current.type === 'parenthesized_declarator'
            ? current.childForFieldName('declarator') || current.child(1)
            : current.childForFieldName('declarator') || current.child(0);

        // 進めない場合、および自分自身へ戻る場合は打ち切る（無限ループ防止）
        if (!next || next.id === current.id) {
            break;
        }
        current = next;
    }

    return { name, pointerDepth, arrayDepth, ownerFunctionDeclarator, position };
}

/**
 * 型指定子のテキストを表示用に整えます。
 *
 * `struct X { ... }` のようなインライン定義を含む場合は `{` より手前の型名部分のみを取り出し、
 * 改行や連続する空白を単一の空白へ正規化します。
 *
 * @param text 型指定子ノードのテキスト
 * @returns 整形後の型名
 */
function cleanTypeText(text: string): string {
    let cleaned = text.trim();
    if (cleaned.includes('{')) {
        cleaned = cleaned.split('{')[0].trim();
    }
    return cleaned.replace(/\s+/g, ' ');
}

/**
 * declaration ノードから宣言されている変数を抽出し、名前→型のマップへ登録します。
 *
 * カンマ区切りの複数宣言、初期化子付き宣言、配列・多重ポインタ・関数ポインタ宣言に対応します。
 * 関数プロトタイプ宣言（`int foo(int);`）は変数ではないため登録しません。
 *
 * @param declNode declaration ノード
 * @param into 登録先のマップ（同名が既に登録されている場合は上書きしません）
 * @param filePath インクルードファイル内の宣言の場合はそのパス
 */
function collectDeclaredVars(
    declNode: Parser.SyntaxNode,
    into: Map<string, DeclaredVar>,
    filePath?: string
): void {
    const typeNode = declNode.childForFieldName('type') || declNode.child(0);
    if (!typeNode) {
        return;
    }

    const typeText = cleanTypeText(typeNode.text);

    for (let i = 0; i < declNode.childCount; i++) {
        const child = declNode.child(i)!;
        if (child === typeNode || child.type === ',' || child.type === ';') {
            continue;
        }

        // init_declarator（初期化子付き宣言）の場合は declarator 部分のみを対象にする
        let decl = child;
        if (child.type === 'init_declarator') {
            decl = child.childForFieldName('declarator') || child.child(0)!;
        }

        const info = resolveDeclarator(decl, filePath);
        if (!info.name || !info.position) {
            continue;
        }

        // 関数プロトタイプ宣言（int foo(int);）は変数ではないため除外する。
        // 関数ポインタ変数（int (*fp)(int);）はポインタ宣言を経由するため区別できる。
        if (info.ownerFunctionDeclarator && info.pointerDepth === 0) {
            continue;
        }

        if (into.has(info.name)) {
            continue;
        }

        into.set(info.name, {
            type: typeText + (info.pointerDepth > 0 ? '*' : ''),
            definition: info.position
        });
    }
}

/**
 * フェーズ1: ファイル直下の変数宣言をスキャンし、グローバル変数の型情報と宣言位置を収集します。
 *
 * @param rootNode ASTのルートノード
 * @param filePath インクルードファイルの場合はそのパス
 * @returns 変数名 → 型名と宣言位置 のマップ
 */
function collectFileScopeVars(
    rootNode: Parser.SyntaxNode,
    filePath?: string
): Map<string, DeclaredVar> {
    const fileScopeVars = new Map<string, DeclaredVar>();
    rootNode.children.forEach(node => {
        if (node.type === 'declaration') {
            collectDeclaredVars(node, fileScopeVars, filePath);
        }
    });
    return fileScopeVars;
}

/**
 * フェーズ1: ファイル内で宣言・定義されている関数の名前と位置を収集します。
 *
 * 関数名は変数ではないため、値として参照されているだけ（関数ポインタへの代入など）の場合に
 * グローバル変数と誤分類しないよう、除外用の名前一覧としても使用します。
 *
 * @param rootNode ASTのルートノード
 * @param filePath インクルードファイルの場合はそのパス
 * @returns 関数名 → 定義位置 のマップ
 */
function collectFileScopeFunctions(
    rootNode: Parser.SyntaxNode,
    filePath?: string
): Map<string, DefinitionLocation> {
    const functionNames = new Map<string, DefinitionLocation>();

    rootNode.children.forEach(node => {
        // 関数定義: int helper(int x) { ... }
        if (node.type === 'function_definition') {
            const declaratorNode = node.childForFieldName('declarator');
            if (declaratorNode) {
                const info = resolveDeclarator(declaratorNode, filePath);
                if (info.name && info.position) {
                    // 定義は宣言より優先するため上書きする
                    functionNames.set(info.name, info.position);
                }
            }
            return;
        }

        // 関数プロトタイプ宣言: int helper(int x);
        // （ポインタ深さ 0 で function_declarator を経由するものが該当する。
        //   int (*fp)(int); のような関数ポインタ変数は pointerDepth > 0 のため対象外）
        if (node.type === 'declaration') {
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i)!;
                if (child.type !== 'function_declarator') {
                    continue;
                }
                const info = resolveDeclarator(child, filePath);
                if (info.name && info.position && info.pointerDepth === 0 && !functionNames.has(info.name)) {
                    functionNames.set(info.name, info.position);
                }
            }
        }
    });

    return functionNames;
}

/**
 * フェーズ2: カーソル行にある関数定義を同定します。
 *
 * カーソル位置のノードから祖先を辿って function_definition を探すため、
 * AST全体を走査する必要がありません（`#ifdef` などで入れ子になった関数定義にも対応します）。
 * カーソルがシグネチャ行（戻り値の型の行から引数リストの閉じ括弧の行まで）に
 * ない場合は解析対象外とします。
 *
 * @param rootNode ASTのルートノード
 * @param cursorLine カーソル行（0始まり）
 * @returns 対象の function_definition ノード、該当しない場合は null
 */
function findFunctionAtCursor(rootNode: Parser.SyntaxNode, cursorLine: number): Parser.SyntaxNode | null {
    // カーソル行の先頭位置にあるノードを起点とする
    const nodeAtCursor = rootNode.descendantForPosition({ row: cursorLine, column: 0 });

    // 直近の function_definition の祖先を探す
    let current: Parser.SyntaxNode | null = nodeAtCursor;
    while (current && current.type !== 'function_definition') {
        current = current.parent;
    }
    if (!current) {
        return null;
    }

    // シグネチャ行の範囲内にカーソルがあるかを判定する
    const declaratorNode = current.childForFieldName('declarator');
    if (!declaratorNode) {
        return null;
    }
    const sigStartRow = current.startPosition.row;      // 戻り値の型から開始
    const sigEndRow = declaratorNode.endPosition.row;   // 引数リストの閉じ括弧で終了

    if (cursorLine < sigStartRow || cursorLine > sigEndRow) {
        return null;
    }
    return current;
}

/**
 * フェーズ3: 関数シグネチャ（関数名・戻り値の型・引数リスト）を解析します。
 *
 * @param funcNode function_definition ノード
 * @returns シグネチャの解析結果
 */
function parseSignature(funcNode: Parser.SyntaxNode): SignatureInfo {
    let functionName = 'unknown';
    let returnType = 'void';

    const declaratorNode = funcNode.childForFieldName('declarator');
    const declaratorInfo = declaratorNode ? resolveDeclarator(declaratorNode) : null;
    if (declaratorInfo && declaratorInfo.name) {
        functionName = declaratorInfo.name;
    }

    // 戻り値の型は、declarator以外の部分（最初のいくつかの型指定子ノード）から取得
    const typeNode = funcNode.childForFieldName('type') || funcNode.child(0);
    if (typeNode) {
        // 例: "int", "static void", "struct Data*" など
        // declaratorの手前までのテキストを結合して戻り値とする
        const declStart = declaratorNode ? declaratorNode.startIndex : funcNode.endIndex;
        const rawType = funcNode.text
            .substring(0, declStart - funcNode.startIndex)
            .trim()
            .replace(/\s+/g, ' '); // 改行や余分な空白を除去
        // ポインタのアスタリスクを型名の末尾に追加
        returnType = rawType + '*'.repeat(declaratorInfo ? declaratorInfo.pointerDepth : 0);
    }

    const params: ParamInfo[] = [];
    // 関数名の識別子に最も近い function_declarator が、実際の引数リストを保持する。
    // （関数ポインタを返す関数では外側の function_declarator が別の引数リストを持つため、
    //   単純に parameter_list を探索すると誤った引数を読んでしまう）
    const ownerFunctionDeclarator = declaratorInfo ? declaratorInfo.ownerFunctionDeclarator : null;
    const parameterList = ownerFunctionDeclarator ? ownerFunctionDeclarator.childForFieldName('parameters') : null;

    if (parameterList) {
        for (let i = 0; i < parameterList.childCount; i++) {
            const child = parameterList.child(i)!;
            if (child.type !== 'parameter_declaration') {
                continue;
            }

            // 引数名を持たない宣言（f(void) の void など）は対象外
            const declNode = child.childForFieldName('declarator');
            if (!declNode) {
                continue;
            }

            const info = resolveDeclarator(declNode);
            if (!info.name || !info.position) {
                continue;
            }

            // 型テキストは declarator の開始位置までを切り出す。
            // （文字列検索では引数名が型名に含まれる場合、誤った位置で切れてしまう）
            const typeText = child.text
                .substring(0, declNode.startIndex - child.startIndex)
                .trim()
                .replace(/\s+/g, ' ');

            params.push({
                name: info.name,
                type: typeText || 'int', // フォールバック
                pointerDepth: info.pointerDepth,
                arrayDepth: info.arrayDepth,
                // ポインタ宣言および配列宣言をポインタ（書き込み可能）として認識
                isPointer: info.pointerDepth > 0 || info.arrayDepth > 0,
                definition: info.position
            });
        }
    }

    return { functionName, returnType, params };
}

/**
 * フェーズ4: 関数ボディを走査し、変数の宣言・参照・書き込み、および関数呼び出しを収集します。
 *
 * @param bodyNode 関数ボディ (compound_statement) ノード。存在しない場合は null
 * @param params フェーズ3で解析した引数リスト
 * @returns 収集した生データ
 */
function analyzeBody(
    bodyNode: Parser.SyntaxNode | null,
    params: ParamInfo[],
    fileScopeFunctions: Map<string, DefinitionLocation>
): BodyAnalysis {
    // 解析中に見つかったローカル変数、グローバル変数、呼び出し関数を格納するセット
    const localVars = new Map<string, DeclaredVar>(); // name -> 型名と宣言位置
    const calledFunctionsSet = new Set<string>();

    // グローバル変数の出現箇所を記録する
    const globalVarReads = new Set<string>();
    const globalVarWrites = new Set<string>();

    // ポインタ引数の書き込み状況を追跡する
    const pointerWrites = new Set<string>();

    // ポインタ引数の読み取り状況を追跡する
    const pointerReads = new Set<string>();

    if (bodyNode) {
        // ---- パス1: 宣言と関数呼び出しの収集 ----
        // 読み書きの分類（パス2）はローカル変数と呼び出し関数の一覧が確定している必要があるため、
        // 先にこれらを収集しきる。1周で行うと、識別子の出現順によって分類結果が変わってしまう。
        walk(bodyNode, (node) => {
            // A. ローカル変数宣言の抽出 (declaration)
            if (node.type === 'declaration') {
                collectDeclaredVars(node, localVars);
            }

            // B. 関数呼び出しの抽出 (call_expression)
            if (node.type === 'call_expression') {
                const funcNameNode = node.childForFieldName('function') || node.child(0);
                // 直接の識別子呼び出し（関数ポインタ経由でないもの）
                if (funcNameNode && funcNameNode.type === 'identifier') {
                    calledFunctionsSet.add(funcNameNode.text);
                }
            }
        });

        // 呼び出し関数リストから、ローカル変数や引数として定義されている名前（関数ポインタなど）を除外
        calledFunctionsSet.forEach(func => {
            const isLocal = localVars.has(func);
            const isParam = params.some(p => p.name === func);
            if (isLocal || isParam) {
                calledFunctionsSet.delete(func);
            }
        });

        // ---- パス2: 読み書きの分類 ----
        walk(bodyNode, (node) => {
            // C. ポインタ書き込みおよびグローバル変数書き込みの判定 (assignment_expression / update_expressionなど)
            // 代入式: result = value など
            if (node.type === 'assignment_expression') {
                const leftNode = node.childForFieldName('left') || node.child(0)!;
                checkLhsWrites(leftNode, params, localVars, pointerWrites, globalVarWrites);
            }
            // インクリメント・デクリメント式: i++ や --p など
            if (node.type === 'update_expression') {
                const argumentNode = node.childForFieldName('argument') || node.child(0)!;
                checkLhsWrites(argumentNode, params, localVars, pointerWrites, globalVarWrites);
            }

            // D. 識別子 (identifier) が出現した際の、入力（読み取り）グローバル変数の候補判定
            if (node.type === 'identifier') {
                const name = node.text;

                // 親ノードがメンバアクセスの右側（例: data.member の member）や、関数宣言名、変数宣言の場合はスキップ
                const parent = node.parent;
                let isFieldOrDeclaration = false;
                if (parent) {
                    if (parent.type === 'field_expression' && parent.childForFieldName('field') === node) {
                        isFieldOrDeclaration = true;
                    }
                    if (parent.type === 'parameter_declaration' || parent.type === 'declaration' || parent.type === 'function_declarator') {
                        isFieldOrDeclaration = true;
                    }
                }

                if (!isFieldOrDeclaration) {
                    const outerNode = getOuterAccessNode(node);
                    const resolved = resolveLhsVariable(outerNode);
                    const accessPath = resolved ? resolved.path : name;
                    const rootName = resolved ? resolved.rootName : name;

                    // ポインタ引数の読み取りをチェック
                    const targetParam = params.find(p => p.name === rootName);
                    if (targetParam && targetParam.isPointer) {
                        if (!isLhsNode(node)) {
                            pointerReads.add(accessPath);
                        }
                    }

                    // 引数、ローカル変数、呼び出し関数、ファイル内で宣言された関数、
                    // ブラックリストのいずれにも属さない場合
                    const isParam = targetParam !== undefined;
                    const isLocal = localVars.has(rootName);
                    const isCall = calledFunctionsSet.has(rootName);
                    // 関数名を値として参照しているだけ（関数ポインタへの代入など）のケース。
                    // 呼び出してはいないが変数でもないため、グローバル変数として扱わない。
                    const isFunction = fileScopeFunctions.has(rootName);

                    if (!isParam && !isLocal && !isCall && !isFunction && !EXCLUDE_LIST.has(rootName)) {
                        // 読み取り（右辺等）で出現しているかチェック
                        // 代入式の左辺として既に書き込み判定されていなければ、読み取り（入力）とみなす
                        if (!isLhsNode(node)) {
                            globalVarReads.add(accessPath);
                        }
                    }
                }
            }
        });
    }

    return {
        localVars,
        calledFunctions: calledFunctionsSet,
        globalVarReads,
        globalVarWrites,
        pointerReads,
        pointerWrites
    };
}

/**
 * フェーズ5: 収集したデータを入力変数・出力変数・内部変数などへ分類・統合します。
 *
 * @param funcNode function_definition ノード（行範囲の取得に使用）
 * @param signature フェーズ3のシグネチャ解析結果
 * @param body フェーズ4のボディ解析結果
 * @param fileScopeVars フェーズ1で収集したグローバル変数の型情報と宣言位置
 * @param fileScopeFunctions フェーズ1で収集した関数名と定義位置
 * @param classifyAllUppercaseAsMacros 大文字のみの識別子をマクロとして分類するか
 * @returns 最終的な解析結果
 */
function buildResult(
    funcNode: Parser.SyntaxNode,
    signature: SignatureInfo,
    body: BodyAnalysis,
    fileScopeVars: Map<string, DeclaredVar>,
    fileScopeFunctions: Map<string, DefinitionLocation>,
    classifyAllUppercaseAsMacros: boolean
): AnalysisResult {
    const { functionName, returnType, params } = signature;
    const { localVars, calledFunctions, globalVarReads, globalVarWrites, pointerReads, pointerWrites } = body;

    const inputs: VariableInfo[] = [];
    const outputs: VariableInfo[] = [];
    const macroVariables: VariableInfo[] = [];
    const macroFunctions: FunctionInfo[] = [];
    const normalCalledFunctions: FunctionInfo[] = [];

    // 呼び出し関数の大文字マクロ分類
    calledFunctions.forEach(func => {
        const info: FunctionInfo = { name: func };
        // ファイル内に定義・宣言があれば、その位置をジャンプ先として持たせる
        const definition = fileScopeFunctions.get(func);
        if (definition) {
            info.definition = definition;
        }

        if (classifyAllUppercaseAsMacros && isAllUppercase(func)) {
            macroFunctions.push(info);
        } else {
            normalCalledFunctions.push(info);
        }
    });

    // 値渡しの引数、および読み取りが行われているポインタ引数は「入力変数」
    // 書き込みが行われているポインタ引数は「出力変数」
    params.forEach(p => {
        // 型名の末尾にポインタ深さ分のアスタリスクを付与する（配列はポインタ1段として扱う）
        const fullType = p.type + '*'.repeat(p.pointerDepth + (p.arrayDepth > 0 ? 1 : 0));

        if (p.isPointer) {
            const matchingWrites = Array.from(pointerWrites).filter(path => getRootName(path) === p.name);
            const matchingReads = Array.from(pointerReads).filter(path => getRootName(path) === p.name);

            if (matchingWrites.length > 0) {
                matchingWrites.forEach(path => {
                    outputs.push({
                        name: path,
                        type: fullType,
                        details: '出力引数（ポインタ書き込みあり）',
                        definition: p.definition
                    });
                });
            }

            if (matchingReads.length > 0) {
                matchingReads.forEach(path => {
                    inputs.push({
                        name: path,
                        type: fullType,
                        details: '入力引数（ポインタ読み取りあり）',
                        definition: p.definition
                    });
                });
            }

            if (matchingWrites.length === 0 && matchingReads.length === 0) {
                inputs.push({
                    name: p.name,
                    type: fullType,
                    details: '入力引数（ポインタ読み取りあり）',
                    definition: p.definition
                });
            }
        } else {
            inputs.push({
                name: p.name,
                type: fullType,
                details: '入力引数（値渡し）',
                definition: p.definition
            });
        }
    });

    // 戻り値がある場合は、出力変数リストに追加
    const cleanReturnType = returnType.replace(/\b(static|extern|inline)\b/g, '').trim();
    if (cleanReturnType !== 'void') {
        outputs.push({
            name: '戻り値 (return)',
            type: returnType,
            details: '関数の戻り値',
            // エディタ上に対応する識別子が存在しないためハイライト対象外とする
            highlightable: false
        });
    }

    // グローバル変数の分類
    // 書き込みが行われているものは「グローバル変数（出力）」
    // 読み取りが行われているものは「グローバル変数（入力）」
    /**
     * グローバル変数のアクセスパス集合を、マクロ変数と通常のグローバル変数に振り分けて登録します。
     *
     * @param paths 対象のアクセスパス集合
     * @param target 通常のグローバル変数の登録先（inputs または outputs）
     * @param macroDetails マクロ変数として分類した場合の補足情報
     * @param details 通常のグローバル変数として分類した場合の補足情報
     */
    const classifyGlobalVars = (
        paths: Set<string>,
        target: VariableInfo[],
        macroDetails: string,
        details: string
    ) => {
        paths.forEach(path => {
            const rootName = getRootName(path);
            if (classifyAllUppercaseAsMacros && isAllUppercase(rootName)) {
                macroVariables.push({
                    name: path,
                    type: 'macro (推定)',
                    details: macroDetails
                });
            } else {
                const declared = fileScopeVars.get(rootName);
                const entry: VariableInfo = {
                    name: path,
                    type: declared ? declared.type : 'global (推定)',
                    details
                };
                if (declared) {
                    entry.definition = declared.definition;
                }
                target.push(entry);
            }
        });
    };

    classifyGlobalVars(globalVarWrites, outputs, 'マクロ変数への書き込み', 'グローバル変数への書き込み');
    classifyGlobalVars(globalVarReads, inputs, 'マクロ変数からの読み取り', 'グローバル変数からの読み取り');

    // 内部（ローカル）変数のリスト化
    const internalVariables: VariableInfo[] = [];
    localVars.forEach((declared, name) => {
        internalVariables.push({
            name,
            type: declared.type,
            definition: declared.definition
        });
    });

    return {
        functionName,
        returnType,
        inputs,
        outputs,
        internalVariables,
        calledFunctions: normalCalledFunctions,
        macroVariables,
        macroFunctions,
        startLine: funcNode.startPosition.row,
        endLine: funcNode.endPosition.row
    };
}

/**
 * C言語コードを解析し、カーソル行にある関数情報を抽出します。
 *
 * 解析は以下の5フェーズで構成されます（詳細は docs/analysis_spec.md を参照）。
 *   1. ファイルスコープの型情報収集   (collectFileScopeVars)
 *   2. カーソル位置の関数同定         (findFunctionAtCursor)
 *   3. 関数シグネチャの解析           (parseSignature)
 *   4. 関数ボディの走査               (analyzeBody)
 *   5. 解析結果の分類・統合           (buildResult)
 *
 * @param tree 解析対象のASTツリー
 * @param cursorLine ユーザーがカーソルを置いている行（0始まり）
 * @param classifyAllUppercaseAsMacros 大文字のみの識別子をマクロとして分類するか
 * @returns 解析結果、またはカーソルが関数名部分にない場合は null
 */
export function analyzeCFunction(
    tree: Parser.Tree,
    cursorLine: number,
    classifyAllUppercaseAsMacros: boolean = true
): AnalysisResult | null {
    const rootNode = tree.rootNode;

    const fileScopeVars = collectFileScopeVars(rootNode);
    const fileScopeFunctions = collectFileScopeFunctions(rootNode);

    const funcNode = findFunctionAtCursor(rootNode, cursorLine);
    if (!funcNode) {
        return null;
    }

    const signature = parseSignature(funcNode);
    const body = analyzeBody(funcNode.childForFieldName('body'), signature.params, fileScopeFunctions);

    return buildResult(funcNode, signature, body, fileScopeVars, fileScopeFunctions, classifyAllUppercaseAsMacros);
}

/**
 * アクセスパス文字列から根元の変数名を抽出します（例: hogestruct[].a -> hogestruct）。
 */
function getRootName(path: string): string {
    const match = path.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
    return match ? match[1] : path;
}

/**
 * 対象ノードが含まれる最外枠のアクセス式ノード（field_expression, subscript_expression 等）を取得します。
 */
function getOuterAccessNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
    let curr = node;
    while (curr.parent) {
        const parent = curr.parent;
        if (
            parent.type === 'field_expression' ||
            parent.type === 'subscript_expression' ||
            parent.type === 'parenthesized_expression' ||
            parent.type === 'parenthesized_declarator'
        ) {
            if (parent.type === 'subscript_expression') {
                const indexNode = parent.childForFieldName('index') || parent.child(2);
                if (indexNode && (indexNode.id === curr.id || isAncestor(indexNode, curr))) {
                    break;
                }
            }
            curr = parent;
        } else {
            break;
        }
    }
    return curr;
}

/**
 * 代入式の左辺（LHS）のノードを再帰的に掘り下げ、根元の変数名（rootName）と
 * 正規化されたアクセスパス（path）、およびポインタ書き込み（デレファレンス * やアロー演算子 -> の有無）を解決します。
 */
function resolveLhsVariable(node: Parser.SyntaxNode): { rootName: string; path: string; isPointerWrite: boolean } | null {
    const outerNode = getOuterAccessNode(node);
    let rootName = '';
    let isPointerWrite = false;

    function buildPath(n: Parser.SyntaxNode): string {
        if (n.type === 'identifier') {
            rootName = n.text;
            return n.text;
        }
        if (n.type === 'field_expression') {
            const argNode = n.childForFieldName('argument') || n.child(0)!;
            const opNode = n.child(1);
            const fieldNode = n.childForFieldName('field') || n.child(2)!;

            if (opNode && opNode.text === '->') {
                isPointerWrite = true;
            }
            const argStr = buildPath(argNode);
            const opStr = opNode ? opNode.text : '.';
            const fieldStr = fieldNode ? fieldNode.text : '';
            return `${argStr}${opStr}${fieldStr}`;
        }
        if (n.type === 'subscript_expression') {
            isPointerWrite = true;
            const argNode = n.childForFieldName('argument') || n.child(0)!;
            const argStr = buildPath(argNode);
            return `${argStr}[]`;
        }
        if (n.type === 'pointer_expression') {
            isPointerWrite = true;
            const argNode = n.childForFieldName('argument') || n.child(1)!;
            return buildPath(argNode);
        }
        if (n.type === 'parenthesized_expression' || n.type === 'parenthesized_declarator') {
            const inner = n.childForFieldName('expression') || n.childForFieldName('declarator') || n.child(1)!;
            return buildPath(inner);
        }
        if (n.type === 'update_expression') {
            const argNode = n.childForFieldName('argument') || n.child(0)!;
            return buildPath(argNode);
        }
        return n.text;
    }

    const pathStr = buildPath(outerNode);
    if (!rootName) {
        return null;
    }
    return { rootName, path: pathStr, isPointerWrite };
}

/**
 * 代入式の左辺（LHS）のノードをチェックし、ポインタ引数またはグローバル変数への書き込みを判定します。
 */
function checkLhsWrites(
    node: Parser.SyntaxNode,
    params: ParamInfo[],
    localVars: Map<string, DeclaredVar>,
    pointerWrites: Set<string>,
    globalVarWrites: Set<string>
) {
    const resolved = resolveLhsVariable(node);
    if (!resolved) {
        return;
    }

    const { rootName, path, isPointerWrite } = resolved;

    const param = params.find(p => p.name === rootName);
    if (param) {
        // 引数の場合: ポインタ/配列引数であり、かつデレファレンス（*, ->, []）を伴う書き込みであれば追加
        if (param.isPointer && isPointerWrite) {
            pointerWrites.add(path);
        }
    } else {
        // 引数以外（＝グローバル変数、またはローカル変数）の場合:
        const isLocal = localVars.has(rootName);
        // ローカル変数でも除外リストでもない場合のみ、グローバル変数への書き込み（出力）とする
        if (!isLocal && !EXCLUDE_LIST.has(rootName)) {
            globalVarWrites.add(path);
        }
    }
}

/**
 * ノードが代入式の左辺（書き込み先）に含まれるかどうかを判定します。
 */
function isLhsNode(node: Parser.SyntaxNode): boolean {
    let current = node;
    while (current.parent) {
        const parent = current.parent;
        // 配列アクセス subscript_expression のインデックス部分にいる場合はLHSではない（読み取り）
        if (parent.type === 'subscript_expression') {
            const indexNode = parent.childForFieldName('index') || parent.child(2);
            if (indexNode && (indexNode.id === current.id || isAncestor(indexNode, current))) {
                return false;
            }
        }
        if (parent.type === 'assignment_expression') {
            const left = parent.childForFieldName('left') || parent.child(0);
            // 代入式の左辺ツリーの下にあるノードであれば Lhs
            if (left && (left.id === current.id || isAncestor(left, current))) {
                // 複合代入（+=, -= など）の場合は、右辺（読み取り）としても出現していると判定する
                const operator = parent.childForFieldName('operator') || parent.child(1);
                if (operator && operator.text !== '=') {
                    return false;
                }
                return true;
            }
        }
        if (parent.type === 'update_expression') {
            // インクリメント・デクリメントは読み取りも兼ねるため、LHS（書き込み専用）とはみなさない
            return false;
        }
        current = parent;
    }
    return false;
}

/**
 * ancestor が descendant の先祖ノードであるか判定します。
 */
function isAncestor(ancestor: Parser.SyntaxNode, descendant: Parser.SyntaxNode): boolean {
    let curr: Parser.SyntaxNode | null = descendant;
    while (curr) {
        if (curr.id === ancestor.id) {
            return true;
        }
        curr = curr.parent;
    }
    return false;
}

/**
 * 文字列がすべて大文字（英大文字、数字、アンダースコア）で構成されているか判定します。
 */
function isAllUppercase(str: string): boolean {
    return /^[A-Z_][A-Z0-9_]*$/.test(str);
}
