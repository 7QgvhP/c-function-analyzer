import Parser = require('web-tree-sitter');

// 解析結果を保持するインターフェース定義
export interface VariableInfo {
    name: string;
    type: string;
    details?: string; // 補足情報（例：「値渡し引数」「ポインタ書き込み（出力）」「グローバル変数」など）
}

export interface AnalysisResult {
    functionName: string;
    returnType: string;
    inputs: VariableInfo[];
    outputs: VariableInfo[];
    internalVariables: VariableInfo[];
    calledFunctions: string[];
    macroVariables?: VariableInfo[];
    macroFunctions?: string[];
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
 * C言語コードを解析し、カーソル行にある関数情報を抽出します。
 * @param tree 解析対象のASTツリー
 * @param cursorLine ユーザーがカーソルを置いている行（0始まり）
 * @returns 解析結果、またはカーソルが関数名部分にない場合は null
 */
export function analyzeCFunction(
    tree: Parser.Tree,
    cursorLine: number,
    classifyAllUppercaseAsMacros: boolean = true
): AnalysisResult | null {
    const rootNode = tree.rootNode;

    // ファイル直下の変数宣言をスキャンして型情報を収集
    const fileScopeVars = new Map<string, string>();
    rootNode.children.forEach(node => {
        if (node.type === 'declaration') {
            const typeNode = node.childForFieldName('type') || node.child(0);
            if (typeNode) {
                let typeText = typeNode.text.trim();
                // 構造体のインライン定義（struct X { ... }）がある場合、{ より手前の定義部分のみを取り出す
                if (typeText.includes('{')) {
                    typeText = typeText.split('{')[0].trim();
                }
                for (let i = 0; i < node.childCount; i++) {
                    const child = node.child(i)!;
                    if (child === typeNode || child.type === ',' || child.type === ';') {
                        continue;
                    }
                    
                    let decl = child;
                    if (child.type === 'init_declarator') {
                        decl = child.childForFieldName('declarator') || child.child(0)!;
                    }

                    if (decl.type === 'function_declarator') {
                        continue;
                    }

                    let varName = '';
                    let isPtr = false;
                    
                    let temp = decl;
                    while (temp) {
                        if (temp.type === 'pointer_declarator') {
                            isPtr = true;
                        }
                        if (temp.type === 'identifier') {
                            varName = temp.text;
                            break;
                        }
                        if (temp.type === 'parenthesized_declarator') {
                            temp = temp.childForFieldName('declarator') || temp.child(1)!;
                        } 
                        else if (temp.type === 'array_declarator') {
                            temp = temp.childForFieldName('declarator') || temp.child(0)!;
                        }
                        else {
                            temp = temp.childForFieldName('declarator') || temp.child(0)!;
                        }
                    }
                    
                    if (varName && decl.type !== 'function_declarator') {
                        const fullType = typeText + (isPtr ? '*' : '');
                        fileScopeVars.set(varName, fullType);
                    }
                }
            }
        }
    });

    let targetFunctionNode: Parser.SyntaxNode | null = null;
    let isCursorOnSignature = false;

    // 1. カーソルがある関数定義 (function_definition) を探索
    walk(rootNode, (node) => {
        if (node.type === 'function_definition') {
            // 関数全体の行範囲
            const startRow = node.startPosition.row;
            const endRow = node.endPosition.row;

            if (cursorLine >= startRow && cursorLine <= endRow) {
                const declaratorNode = node.childForFieldName('declarator');
                if (declaratorNode) {
                    const sigStartRow = node.startPosition.row; // 戻り値の型から開始
                    const sigEndRow = declaratorNode.endPosition.row; // 引数リストの閉じ括弧で終了

                    if (cursorLine >= sigStartRow && cursorLine <= sigEndRow) {
                        targetFunctionNode = node;
                        isCursorOnSignature = true;
                    }
                }
            }
        }
    });

    // カーソルが関数名や引数リストの行にない場合は解析をスキップ
    if (!targetFunctionNode || !isCursorOnSignature) {
        return null;
    }

    const funcNode = targetFunctionNode as Parser.SyntaxNode;

    const startLine = funcNode.startPosition.row;
    const endLine = funcNode.endPosition.row;

    // 2. 関数名と戻り値の型を抽出
    let functionName = 'unknown';
    let returnType = 'void';

    let ptrCount = 0;
    const declaratorNode = funcNode.childForFieldName('declarator');
    if (declaratorNode) {
        // 関数名を取得しつつ、戻り値のポインタ深さ（アスタリスク数）をカウント
        let nameNode = declaratorNode;
        while (nameNode) {
            if (nameNode.type === 'pointer_declarator') {
                ptrCount++;
            }
            if (nameNode.type === 'identifier') {
                functionName = nameNode.text;
                break;
            }
            // pointer_declarator や function_declarator の中を探索
            const childDeclarator = nameNode.childForFieldName('declarator') || nameNode.child(0);
            if (childDeclarator) {
                nameNode = childDeclarator;
            } else {
                break;
            }
        }
    }

    // 戻り値の型は、declarator以外の部分（最初のいくつかの型指定子ノード）から取得
    const typeNode = funcNode.childForFieldName('type') || funcNode.child(0);
    if (typeNode) {
        // 例: "int", "static void", "struct Data*" など
        // declaratorの手前までのテキストを結合して戻り値とする
        const declStart = declaratorNode ? declaratorNode.startIndex : funcNode.endIndex;
        let rawType = funcNode.text.substring(0, declStart - funcNode.startIndex).trim();
        // 改行や余分な空白を除去
        rawType = rawType.replace(/\s+/g, ' ');
        // ポインタのアスタリスクを型名の末尾に追加
        returnType = rawType + '*'.repeat(ptrCount);
    }

    // 3. 引数の抽出
    const params: { name: string; type: string; isPointer: boolean }[] = [];
    if (declaratorNode) {
        // parameter_list ノードを探す
        let paramListNode: Parser.SyntaxNode | null = null;
        walk(declaratorNode, (n) => {
            if (n.type === 'parameter_list') {
                paramListNode = n;
            }
        });

        if (paramListNode) {
            const list = paramListNode as Parser.SyntaxNode;
            for (let i = 0; i < list.childCount; i++) {
                const child = list.child(i)!;
                if (child.type === 'parameter_declaration') {
                    // 各引数の型と名前を抽出
                    const typeDeclNode = child.childForFieldName('type') || child.child(0);
                    const declNode = child.childForFieldName('declarator');

                    if (typeDeclNode && declNode) {
                        let paramName = '';
                        let isPointer = false;

                        // ポインタ宣言 (pointer_declarator) か判定しつつ名前を取得
                        let n = declNode;
                        while (n) {
                            // ポインタ宣言および配列宣言をポインタ（書き込み可能）として認識
                            if (n.type === 'pointer_declarator' || n.type === 'array_declarator') {
                                isPointer = true;
                            }
                            if (n.type === 'identifier') {
                                paramName = n.text;
                                break;
                            }
                            n = n.childForFieldName('declarator') || n.child(0)!;
                        }

                        // 型テキストの抽出
                        const typeText = child.text.substring(0, child.text.indexOf(paramName)).trim();
                        params.push({
                            name: paramName,
                            type: typeText || 'int', // フォールバック
                            isPointer
                        });
                    }
                }
            }
        }
    }

    // 4. 関数内部（ボディ）の解析（変数、グローバル変数、関数呼び出し、書き込み判定）
    const bodyNode = funcNode.childForFieldName('body');
    
    // 解析中に見つかったローカル変数、グローバル変数、呼び出し関数を格納するセット
    const localVars = new Map<string, string>(); // name -> type
    const calledFunctionsSet = new Set<string>();
    
    // グローバル変数の出現箇所を記録する
    const globalVarReads = new Set<string>();
    const globalVarWrites = new Set<string>();
    
    // ポインタ引数の書き込み状況を追跡する
    const pointerWrites = new Set<string>();
    
    // ポインタ引数の読み取り状況を追跡する
    const pointerReads = new Set<string>();

    if (bodyNode) {
        // ボディ内のノードをトラバース
        walk(bodyNode, (node) => {
            // A. ローカル変数宣言の抽出 (declaration)
            if (node.type === 'declaration') {
                const typeNode = node.childForFieldName('type') || node.child(0);
                if (typeNode) {
                    const typeText = typeNode.text;
                    
                    // 宣言されている識別子（変数名）をすべて取り出す（カンマ区切りの複数宣言に対応）
                    for (let i = 0; i < node.childCount; i++) {
                        const child = node.child(i)!;
                        if (child === typeNode || child.type === ',' || child.type === ';') {
                            continue;
                        }
                        
                        // init_declarator の場合は、その declarator フィールドのみを対象にする
                        let decl = child;
                        if (child.type === 'init_declarator') {
                            decl = child.childForFieldName('declarator') || child.child(0)!;
                        }

                        let varName = '';
                        let isPtr = false;
                        
                        let temp = decl;
                        while (temp) {
                            if (temp.type === 'pointer_declarator') {
                                isPtr = true;
                            }
                            if (temp.type === 'identifier') {
                                varName = temp.text;
                                break;
                            }
                            // 括弧付き宣言 (*var) の場合、中身の pointer_declarator などに進む
                            if (temp.type === 'parenthesized_declarator') {
                                temp = temp.childForFieldName('declarator') || temp.child(1)!;
                            } 
                            // 関数宣言 (引数リスト付き) の場合、関数名部分に進む
                            else if (temp.type === 'function_declarator') {
                                temp = temp.childForFieldName('declarator') || temp.child(0)!;
                            }
                            // 配列宣言の場合、配列名部分に進む
                            else if (temp.type === 'array_declarator') {
                                temp = temp.childForFieldName('declarator') || temp.child(0)!;
                            }
                            else {
                                temp = temp.childForFieldName('declarator') || temp.child(0)!;
                            }
                        }
                        
                        if (varName && !localVars.has(varName)) {
                            const fullType = typeText + (isPtr ? '*' : '');
                            localVars.set(varName, fullType);
                        }
                    }
                }
            }

            // B. 関数呼び出しの抽出 (call_expression)
            if (node.type === 'call_expression') {
                const funcNameNode = node.childForFieldName('function') || node.child(0);
                // 直接の識別子呼び出し（関数ポインタ経由でないもの）
                if (funcNameNode && funcNameNode.type === 'identifier') {
                    calledFunctionsSet.add(funcNameNode.text);
                }
            }

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
                    // ポインタ引数の読み取りをチェック
                    const targetParam = params.find(p => p.name === name);
                    if (targetParam && targetParam.isPointer) {
                        if (!isLhsNode(node)) {
                            pointerReads.add(name);
                        }
                    }

                    // 引数、ローカル変数、呼び出し関数、ブラックリストのいずれにも属さない場合
                    const isParam = targetParam !== undefined;
                    const isLocal = localVars.has(name);
                    const isCall = calledFunctionsSet.has(name);
                    
                    if (!isParam && !isLocal && !isCall && !EXCLUDE_LIST.has(name)) {
                        // 読み取り（右辺等）で出現しているかチェック
                        // 代入式の左辺として既に書き込み判定されていなければ、読み取り（入力）とみなす
                        if (!isLhsNode(node)) {
                            globalVarReads.add(name);
                        }
                    }
                }
            }
        }); // walk の閉じ括弧

            // 呼び出し関数リストから、ローカル変数や引数として定義されている名前（関数ポインタなど）を除外
            calledFunctionsSet.forEach(func => {
                const isLocal = localVars.has(func);
                const isParam = params.some(p => p.name === func);
                if (isLocal || isParam) {
                    calledFunctionsSet.delete(func);
                }
            });
        }

    // 5. 解析結果を inputs / outputs / internalVariables に分類・統合
    const inputs: VariableInfo[] = [];
    const outputs: VariableInfo[] = [];
    const macroVariables: VariableInfo[] = [];
    const macroFunctions: string[] = [];
    const normalCalledFunctions: string[] = [];

    // 呼び出し関数の大文字マクロ分類
    calledFunctionsSet.forEach(func => {
        if (classifyAllUppercaseAsMacros && isAllUppercase(func)) {
            macroFunctions.push(func);
        } else {
            normalCalledFunctions.push(func);
        }
    });

    // 値渡しの引数、および読み取りが行われているポインタ引数は「入力変数」
    // 書き込みが行われているポインタ引数は「出力変数」
    params.forEach(p => {
        // すでに型テキストの末尾に '*' がある場合は重ねて付与しない
        const fullType = p.type.endsWith('*') ? p.type : (p.type + (p.isPointer ? '*' : ''));
        
        let isInput = false;
        let isOutput = false;

        if (p.isPointer) {
            if (pointerWrites.has(p.name)) {
                isOutput = true;
            }
            if (pointerReads.has(p.name)) {
                isInput = true;
            }
            // どちらも検出されなかった場合のセーフティガード（ポインタ引数としての存在）
            if (!isInput && !isOutput) {
                isInput = true;
            }
        } else {
            // 値渡し引数は常に入力
            isInput = true;
        }

        if (isInput) {
            inputs.push({
                name: p.name,
                type: fullType,
                details: p.isPointer ? '入力引数（ポインタ読み取りあり）' : '入力引数（値渡し）'
            });
        }
        if (isOutput) {
            outputs.push({
                name: p.name,
                type: fullType,
                details: '出力引数（ポインタ書き込みあり）'
            });
        }
    });

    // 戻り値がある場合は、出力変数リストに追加
    const cleanReturnType = returnType.replace(/\b(static|extern|inline)\b/g, '').trim();
    if (cleanReturnType !== 'void') {
        outputs.push({
            name: '戻り値 (return)',
            type: returnType,
            details: '関数の戻り値'
        });
    }

    // グローバル変数の分類
    // 書き込みが行われているものは「グローバル変数（出力）」
    // 読み取りが行われているものは「グローバル変数（入力）」
    globalVarWrites.forEach(name => {
        if (classifyAllUppercaseAsMacros && isAllUppercase(name)) {
            macroVariables.push({
                name,
                type: 'macro (推定)',
                details: 'マクロ変数への書き込み'
            });
        } else {
            const fileVarType = fileScopeVars.get(name);
            outputs.push({
                name,
                type: fileVarType || 'global (推定)',
                details: 'グローバル変数への書き込み'
            });
        }
    });

    globalVarReads.forEach(name => {
        // 制限を解除し、読み取りがあれば常に入力（Inputs）に分類する
        if (classifyAllUppercaseAsMacros && isAllUppercase(name)) {
            macroVariables.push({
                name,
                type: 'macro (推定)',
                details: 'マクロ変数からの読み取り'
            });
        } else {
            const fileVarType = fileScopeVars.get(name);
            inputs.push({
                name,
                type: fileVarType || 'global (推定)',
                details: 'グローバル変数からの読み取り'
            });
        }
    });

    // 内部（ローカル）変数のリスト化
    const internalVariables: VariableInfo[] = [];
    localVars.forEach((type, name) => {
        internalVariables.push({ name, type });
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
        startLine,
        endLine
    };
}

/**
 * 代入式の左辺（LHS）のノードを再帰的に掘り下げ、根元の変数名（識別子）と、
 * ポインタ書き込み（デレファレンス * やアロー演算子 -> の有無）を解決します。
 */
function resolveLhsVariable(node: Parser.SyntaxNode): { name: string; isPointerWrite: boolean } | null {
    let current: Parser.SyntaxNode | null = node;
    let isPointerWrite = false;

    while (current) {
        if (current.type === 'pointer_expression') {
            isPointerWrite = true;
            current = current.childForFieldName('argument') || current.child(1);
        }
        else if (current.type === 'field_expression') {
            const operator = current.child(1);
            if (operator && operator.text === '->') {
                isPointerWrite = true;
            }
            current = current.childForFieldName('argument') || current.child(0);
        }
        else if (current.type === 'subscript_expression') {
            isPointerWrite = true;
            current = current.childForFieldName('argument') || current.child(0);
        }
        else if (current.type === 'parenthesized_declarator') {
            current = current.childForFieldName('declarator') || current.child(1);
        }
        else if (current.type === 'parenthesized_expression') {
            current = current.childForFieldName('expression') || current.child(1);
        }
        else if (current.type === 'update_expression') {
            current = current.childForFieldName('argument') || current.child(0);
        }
        else if (current.type === 'identifier') {
            return { name: current.text, isPointerWrite };
        }
        else {
            break;
        }
    }
    return null;
}

/**
 * 代入式の左辺（LHS）のノードをチェックし、ポインタ引数またはグローバル変数への書き込みを判定します。
 */
function checkLhsWrites(
    node: Parser.SyntaxNode,
    params: { name: string; type: string; isPointer: boolean }[],
    localVars: Map<string, string>,
    pointerWrites: Set<string>,
    globalVarWrites: Set<string>
) {
    const resolved = resolveLhsVariable(node);
    if (!resolved) {
        return;
    }

    const { name, isPointerWrite } = resolved;

    if (isPointerWrite) {
        const param = params.find(p => p.name === name);
        if (param && param.isPointer) {
            pointerWrites.add(name);
        }
    } else {
        const isLocal = localVars.has(name);
        const isParam = params.some(p => p.name === name);
        // ローカル変数でも引数でもない場合はグローバル変数への書き込み
        if (!isLocal && !isParam && !EXCLUDE_LIST.has(name)) {
            globalVarWrites.add(name);
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
