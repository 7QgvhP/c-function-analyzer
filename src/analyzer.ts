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

/** インクルードファイルの解決結果 */
export interface ResolvedInclude {
    /** 解析済みのAST */
    tree: Parser.Tree;
    /** 実際に読み込んだファイルのパス（定義位置の filePath として使用されます） */
    filePath: string;
}

/**
 * `#include "..."` を解決してASTを返すインターフェースです。
 *
 * ファイルの読み込みは環境依存の処理であるため、実装は拡張機能ホスト側
 * （`includeResolver.ts`）が提供し、解析ロジックからは注入して使用します。
 */
export interface IncludeResolver {
    /**
     * インクルードパスを解決します。
     *
     * @param includePath `#include "..."` に記述されたパス（例: `config.h`, `sub/types.h`）
     * @param fromFilePath そのインクルードが記述されているファイルのパス
     * @returns 解決できた場合はASTとファイルパス、できなければ null
     */
    resolve(includePath: string, fromFilePath?: string): ResolvedInclude | null;
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
    /** 型名（ポインタのアスタリスクを含む。配列の次元は含まない） */
    type: string;
    /** 配列の各次元のサイズ（内側から順）。配列でない場合は空配列 */
    arrayDimensions: string[];
    /** 宣言されている位置 */
    definition: DefinitionLocation;
}

/** マクロ定義の情報 */
interface MacroDefinition {
    /** 定義値（`#define MAX_LIMIT 10` の `10`）。値を持たないマクロは空文字列 */
    value: string;
    /** 定義されている位置 */
    definition: DefinitionLocation;
}

/** 構造体・共用体のメンバ一覧（メンバ名 → 型情報） */
type StructMembers = Map<string, DeclaredVar>;

/**
 * フェーズ1で収集したファイルスコープのシンボル情報です。
 * 解析対象ファイル自身とインクルードファイルの内容がマージされます。
 */
interface FileScopeSymbols {
    /** グローバル変数（名前 → 型名と宣言位置） */
    vars: Map<string, DeclaredVar>;
    /** 関数（名前 → 定義位置） */
    functions: Map<string, DefinitionLocation>;
    /** マクロ（名前 → 定義値と定義位置） */
    macros: Map<string, MacroDefinition>;
    /**
     * 構造体・共用体の定義（型名 → メンバ一覧）。
     * タグ名（`struct Config`）と typedef 名（`HogeStruct`）の双方で引けるよう登録します。
     */
    structs: Map<string, StructMembers>;
}

/** インクルードを辿る深さの上限（循環や過剰な探索を防ぐ） */
const MAX_INCLUDE_DEPTH = 8;

/** マクロ定義値を型名バッジに表示する際の最大文字数 */
const MACRO_VALUE_MAX_LENGTH = 24;

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
     * 配列の各次元のサイズ（内側から順、例: `int grid[3][4]` なら `['3', '4']`）。
     * サイズ指定のない次元（`int buf[]`）は空文字列になります。配列でない場合は空配列です。
     */
    arrayDimensions: string[];
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
 * プリプロセッサ条件ブロックのノード種別です。
 * これらの内側もファイルスコープと同じ階層として扱います。
 */
const PREPROC_BLOCK_TYPES = new Set([
    'preproc_ifdef',
    'preproc_if',
    'preproc_elif',
    'preproc_else'
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
 * ファイルスコープに属するノードを列挙します。
 *
 * インクルードガード（`#ifndef HEADER_H`）や条件コンパイルの内側にある宣言も
 * ファイルスコープの宣言として扱うため、プリプロセッサ条件ブロックは
 * 透過的に降りて走査します。関数ボディの内側には入りません。
 *
 * @param node 起点ノード（通常は translation_unit）
 * @param callback 各ノードに対して呼ばれるコールバック
 */
function forEachFileScopeNode(
    node: Parser.SyntaxNode,
    callback: (node: Parser.SyntaxNode) => void
): void {
    node.children.forEach(child => {
        if (PREPROC_BLOCK_TYPES.has(child.type)) {
            forEachFileScopeNode(child, callback);
            return;
        }
        callback(child);
    });
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
    // 配列の各次元のサイズ。外側の次元から順に見つかるため、最後に反転して並べ直す
    const arrayDimensions: string[] = [];

    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (current.type === 'pointer_declarator') {
            pointerDepth++;
        } else if (current.type === 'array_declarator') {
            arrayDepth++;
            // サイズ指定がない宣言（int buf[]）では size フィールドを持たない
            const sizeNode = current.childForFieldName('size');
            arrayDimensions.push(sizeNode ? sizeNode.text.replace(/\s+/g, ' ').trim() : '');
        } else if (current.type === 'function_declarator') {
            // 識別子に最も近い function_declarator が実際の引数リストを保持する
            ownerFunctionDeclarator = current;
        } else if (current.type === 'identifier' || current.type === 'field_identifier') {
            // field_identifier は構造体・共用体のメンバ宣言における識別子
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

    // 宣言と同じ並び（内側の次元が先）に戻す（int grid[3][4] → ['3', '4']）
    arrayDimensions.reverse();

    return { name, pointerDepth, arrayDepth, arrayDimensions, ownerFunctionDeclarator, position };
}

/**
 * 型名に配列の次元を付与します。
 *
 * @param baseType 配列表記を含まない型名（例: `int`、`int*`）
 * @param dimensions 配列の各次元のサイズ
 * @returns 配列表記を付与した型名（例: `int[5]`、`int[3][4]`、`char[]`）
 */
function formatArrayType(baseType: string, dimensions: string[]): string {
    return baseType + dimensions.map(size => `[${size}]`).join('');
}

/**
 * アクセスパスの1セグメント内にある正規化された添字 `[]` を、宣言された次元で置き換えます。
 *
 * @param segment アクセスパスのセグメント（例: `hoge[]`、`grid[][]`）
 * @param dimensions 宣言された配列の各次元のサイズ
 * @returns 次元を反映したセグメント
 */
function substituteSubscripts(segment: string, dimensions: string[]): string {
    if (dimensions.length === 0) {
        return segment;
    }
    let index = 0;
    return segment.replace(/\[\]/g, () => {
        const size = index < dimensions.length ? dimensions[index] : '';
        index++;
        return `[${size}]`;
    });
}

/**
 * 型名から構造体定義を引くためのキーを作ります（末尾のポインタ表記を除去します）。
 *
 * @param type 型名（例: `struct Outer*`、`HogeStruct`）
 * @returns 構造体定義の検索キー（例: `struct Outer`、`HogeStruct`）
 */
function normalizeStructKey(type: string): string {
    return type.replace(/\*+$/, '').trim();
}

/** アクセスパスの解決結果 */
interface ResolvedAccessPath {
    /** 表示用の名前（各セグメントの添字に宣言された次元を反映したもの） */
    name: string;
    /** 表示用の型名 */
    type: string;
}

/**
 * アクセスパスを解析し、表示用の名前と型を解決します。
 *
 * 構造体・共用体のメンバアクセスを辿り、**最終的に参照しているメンバの型**を返します。
 * 例: `tbl[].id`（`HogeStruct tbl[5]`、`HogeStruct` に `int id`）は
 *     名前 `tbl[5].id`、型 `int` に解決されます。
 *
 * 構造体定義やメンバが見つからない場合は、根元の変数の型をそのまま用います
 * （無理に解決するより、根元の型が見えている方が手がかりになるため）。
 *
 * @param accessPath アクセスパス（例: `hoge[]`、`tbl[].id`、`var_ptr->sub.member`）
 * @param rootVar 根元の変数の型情報
 * @param structs 構造体・共用体の定義
 * @returns 表示用の名前と型
 */
function resolveAccessPath(
    accessPath: string,
    rootVar: { type: string; arrayDimensions: string[] },
    structs: Map<string, StructMembers>
): ResolvedAccessPath {
    // 区切り文字（. と ->）を保持したまま分割する
    const parts = accessPath.split(/(\.|->)/);

    let current: { type: string; arrayDimensions: string[] } = rootVar;
    let name = substituteSubscripts(parts[0], current.arrayDimensions);
    let lastSegment = parts[0];
    let resolved = true;

    for (let i = 1; i < parts.length; i += 2) {
        const separator = parts[i];
        const segment = parts[i + 1];
        if (segment === undefined) {
            break;
        }
        lastSegment = segment;

        // 添字を除いた部分がメンバ名
        const memberName = segment.replace(/\[[^\]]*\]/g, '');
        const members = resolved ? structs.get(normalizeStructKey(current.type)) : undefined;
        const member = members ? members.get(memberName) : undefined;

        if (member) {
            current = member;
            name += separator + substituteSubscripts(segment, member.arrayDimensions);
        } else {
            // 解決できない場合は表記をそのまま残し、以降の型解決も打ち切る
            resolved = false;
            name += separator + segment;
        }
    }

    // 型の決定に用いる変数（解決できた場合は最終メンバ、できなければ根元）
    const target = resolved ? current : rootVar;
    // 配列の次元は名前と型のどちらか一方にのみ出す。
    // 末尾セグメントが添字を伴う場合は名前側に出ているため、型には付けない。
    const lastHasSubscript = /\[[^\]]*\]/.test(lastSegment);
    const type = lastHasSubscript
        ? target.type
        : formatArrayType(target.type, target.arrayDimensions);

    return { name, type };
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

        // 配列の次元は型名に含めず別途保持する。
        // 表示時に、名前（アクセスパス）側と型名側のどちらへ次元を出すかを切り替えるため。
        into.set(info.name, {
            type: typeText + (info.pointerDepth > 0 ? '*' : ''),
            arrayDimensions: info.arrayDimensions,
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
    forEachFileScopeNode(rootNode, node => {
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

    forEachFileScopeNode(rootNode, node => {
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
 * フェーズ1: マクロ定義（`#define`）を収集します。
 *
 * `#ifdef` ブロック内の定義も拾うため、AST全体を走査します。
 * オブジェクト形式（`#define MAX 10`）と関数形式（`#define SQ(x) ((x)*(x))`）の双方に対応します。
 *
 * @param rootNode ASTのルートノード
 * @param filePath インクルードファイルの場合はそのパス
 * @returns マクロ名 → 定義値と定義位置 のマップ
 */
function collectMacros(
    rootNode: Parser.SyntaxNode,
    filePath?: string
): Map<string, MacroDefinition> {
    const macros = new Map<string, MacroDefinition>();

    walk(rootNode, (node) => {
        if (node.type !== 'preproc_def' && node.type !== 'preproc_function_def') {
            return;
        }
        const nameNode = node.childForFieldName('name');
        if (!nameNode || macros.has(nameNode.text)) {
            return;
        }
        const valueNode = node.childForFieldName('value');
        macros.set(nameNode.text, {
            value: valueNode ? valueNode.text.replace(/\s+/g, ' ').trim() : '',
            definition: toDefinitionLocation(nameNode, filePath)
        });
    });

    return macros;
}

/**
 * 構造体・共用体のメンバ一覧を収集します。
 *
 * @param bodyNode field_declaration_list ノード
 * @param filePath インクルードファイルの場合はそのパス
 * @returns メンバ名 → 型情報 のマップ
 */
function collectStructMembers(bodyNode: Parser.SyntaxNode, filePath?: string): StructMembers {
    const members: StructMembers = new Map();
    for (let i = 0; i < bodyNode.childCount; i++) {
        const child = bodyNode.child(i)!;
        if (child.type === 'field_declaration') {
            // field_declaration は declaration と同じ構造（type + declarator）のため共通処理を使う
            collectDeclaredVars(child, members, filePath);
        }
    }
    return members;
}

/**
 * type_definition（typedef）から型名を取り出します。
 *
 * @param typedefNode type_definition ノード
 * @returns typedef で付けられた型名。取得できない場合は空文字列
 */
function resolveTypedefName(typedefNode: Parser.SyntaxNode): string {
    let current: Parser.SyntaxNode | null = typedefNode.childForFieldName('declarator');
    while (current) {
        if (current.type === 'type_identifier') {
            return current.text;
        }
        const next: Parser.SyntaxNode | null =
            current.childForFieldName('declarator') || current.child(0);
        if (!next || next.id === current.id) {
            break;
        }
        current = next;
    }
    return '';
}

/**
 * フェーズ1: 構造体・共用体の定義を収集します。
 *
 * タグ名（`struct Config`）と typedef 名（`HogeStruct`）の双方をキーとして登録し、
 * どちらの表記からもメンバを引けるようにします。関数ボディ内のローカルな型定義は対象外です。
 *
 * @param rootNode ASTのルートノード
 * @param filePath インクルードファイルの場合はそのパス
 * @returns 型名 → メンバ一覧 のマップ
 */
function collectStructDefinitions(
    rootNode: Parser.SyntaxNode,
    filePath?: string
): Map<string, StructMembers> {
    const structs = new Map<string, StructMembers>();

    forEachFileScopeNode(rootNode, node => {
        // 関数ボディ内で定義されたローカルな型は対象外とする
        if (node.type === 'function_definition') {
            return;
        }

        walk(node, inner => {
            if (inner.type !== 'struct_specifier' && inner.type !== 'union_specifier') {
                return;
            }
            // body を持たないもの（struct Sub sub; のような型参照）は定義ではない
            const bodyNode = inner.childForFieldName('body');
            if (!bodyNode) {
                return;
            }

            const members = collectStructMembers(bodyNode, filePath);
            if (members.size === 0) {
                return;
            }

            // タグ名がある場合は「struct Tag」「union Tag」として登録する
            const nameNode = inner.childForFieldName('name');
            if (nameNode) {
                const keyword = inner.type === 'union_specifier' ? 'union' : 'struct';
                const tagKey = `${keyword} ${nameNode.text}`;
                if (!structs.has(tagKey)) {
                    structs.set(tagKey, members);
                }
            }

            // typedef の場合は付けられた型名でも引けるようにする
            const parent = inner.parent;
            if (parent && parent.type === 'type_definition') {
                const typedefName = resolveTypedefName(parent);
                if (typedefName && !structs.has(typedefName)) {
                    structs.set(typedefName, members);
                }
            }
        });
    });

    return structs;
}

/**
 * フェーズ1: 1つのファイルからファイルスコープのシンボル（変数・関数・マクロ）を収集します。
 *
 * @param rootNode ASTのルートノード
 * @param filePath インクルードファイルの場合はそのパス
 * @returns 収集したシンボル情報
 */
function collectFileScopeSymbols(
    rootNode: Parser.SyntaxNode,
    filePath?: string
): FileScopeSymbols {
    return {
        vars: collectFileScopeVars(rootNode, filePath),
        functions: collectFileScopeFunctions(rootNode, filePath),
        macros: collectMacros(rootNode, filePath),
        structs: collectStructDefinitions(rootNode, filePath)
    };
}

/**
 * シンボル情報をマージします。
 *
 * 既に登録されている定義（＝解析対象ファイル自身、またはより浅いインクルード）を優先し、
 * 未登録のものだけを補います。
 *
 * @param into マージ先
 * @param from マージ元
 */
function mergeSymbols(into: FileScopeSymbols, from: FileScopeSymbols): void {
    from.vars.forEach((value, key) => {
        if (!into.vars.has(key)) {
            into.vars.set(key, value);
        }
    });
    from.functions.forEach((value, key) => {
        if (!into.functions.has(key)) {
            into.functions.set(key, value);
        }
    });
    from.macros.forEach((value, key) => {
        if (!into.macros.has(key)) {
            into.macros.set(key, value);
        }
    });
    from.structs.forEach((value, key) => {
        if (!into.structs.has(key)) {
            into.structs.set(key, value);
        }
    });
}

/**
 * フェーズ1: `#include "..."` を再帰的に辿り、インクルードファイル内のシンボルを収集します。
 *
 * システムインクルード（`#include <...>`）は対象外です。
 * 循環インクルードは解決済みファイルパスの集合で検出し、探索の深さにも上限を設けています。
 *
 * @param rootNode 走査対象のASTルートノード
 * @param resolver インクルードパスの解決を担うリゾルバ
 * @param fromFilePath 走査対象ファイルのパス（相対パス解決の起点）
 * @param into 収集先のシンボル情報
 * @param visited 既に解決したファイルパスの集合
 * @param depth 現在の探索深さ
 */
function collectIncludedSymbols(
    rootNode: Parser.SyntaxNode,
    resolver: IncludeResolver,
    fromFilePath: string | undefined,
    into: FileScopeSymbols,
    visited: Set<string>,
    depth: number
): void {
    if (depth >= MAX_INCLUDE_DEPTH) {
        return;
    }

    // 先にインクルードパスを集める（#ifdef 内のものも拾うため AST 全体を走査）
    const includePaths: string[] = [];
    walk(rootNode, (node) => {
        if (node.type !== 'preproc_include') {
            return;
        }
        const pathNode = node.childForFieldName('path');
        // system_lib_string（<stdio.h>）はシステムインクルードのため対象外
        if (!pathNode || pathNode.type !== 'string_literal') {
            return;
        }
        // 前後のダブルクォートを取り除く
        const raw = pathNode.text;
        const inner = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
            ? raw.slice(1, -1)
            : raw;
        if (inner) {
            includePaths.push(inner);
        }
    });

    for (const includePath of includePaths) {
        let resolved: ResolvedInclude | null = null;
        try {
            resolved = resolver.resolve(includePath, fromFilePath);
        } catch {
            // 読み込み失敗やパースエラーは解析全体を止めず、そのインクルードのみ諦める
            resolved = null;
        }
        if (!resolved || visited.has(resolved.filePath)) {
            continue;
        }
        visited.add(resolved.filePath);

        const included = collectFileScopeSymbols(resolved.tree.rootNode, resolved.filePath);
        mergeSymbols(into, included);

        // さらに深いインクルードを辿る
        collectIncludedSymbols(resolved.tree.rootNode, resolver, resolved.filePath, into, visited, depth + 1);
    }
}

/**
 * マクロ定義を型名バッジ用の表示文字列に整形します。
 *
 * @param macro マクロ定義（未解決の場合は undefined）
 * @returns 表示用の文字列
 */
function formatMacroType(macro?: MacroDefinition): string {
    if (!macro) {
        return 'macro (推定)';
    }
    if (!macro.value) {
        return 'macro';
    }
    const value = macro.value.length > MACRO_VALUE_MAX_LENGTH
        ? macro.value.slice(0, MACRO_VALUE_MAX_LENGTH) + '…'
        : macro.value;
    return `macro (${value})`;
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
 * @param symbols フェーズ1で収集したファイルスコープのシンボル情報
 * @param classifyAllUppercaseAsMacros 大文字のみの識別子をマクロとして分類するか
 * @returns 最終的な解析結果
 */
function buildResult(
    funcNode: Parser.SyntaxNode,
    signature: SignatureInfo,
    body: BodyAnalysis,
    symbols: FileScopeSymbols,
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
        // 関数定義・プロトタイプ宣言、またはマクロ定義があれば、その位置をジャンプ先として持たせる
        const macro = symbols.macros.get(func);
        const definition = symbols.functions.get(func) || (macro ? macro.definition : undefined);
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

            // 引数の配列はポインタへ減衰するため、次元は型名の '*' で表現済み（次元リストは空）
            const paramVar = { type: fullType, arrayDimensions: [] as string[] };

            if (matchingWrites.length > 0) {
                matchingWrites.forEach(path => {
                    const resolvedPath = resolveAccessPath(path, paramVar, symbols.structs);
                    outputs.push({
                        name: resolvedPath.name,
                        type: resolvedPath.type,
                        details: '出力引数（ポインタ書き込みあり）',
                        definition: p.definition
                    });
                });
            }

            if (matchingReads.length > 0) {
                matchingReads.forEach(path => {
                    const resolvedPath = resolveAccessPath(path, paramVar, symbols.structs);
                    inputs.push({
                        name: resolvedPath.name,
                        type: resolvedPath.type,
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
                const macro = symbols.macros.get(rootName);
                const entry: VariableInfo = {
                    name: path,
                    type: formatMacroType(macro),
                    details: macroDetails
                };
                if (macro) {
                    entry.definition = macro.definition;
                }
                macroVariables.push(entry);
            } else {
                const declared = symbols.vars.get(rootName);
                if (declared) {
                    // 構造体メンバのアクセスを辿って型を解決し、
                    // 配列の次元は名前と型のどちらか一方にのみ表示する
                    const resolvedPath = resolveAccessPath(path, declared, symbols.structs);
                    target.push({
                        name: resolvedPath.name,
                        type: resolvedPath.type,
                        details,
                        definition: declared.definition
                    });
                } else {
                    target.push({ name: path, type: 'global (推定)', details });
                }
            }
        });
    };

    classifyGlobalVars(globalVarWrites, outputs, 'マクロ変数への書き込み', 'グローバル変数への書き込み');
    classifyGlobalVars(globalVarReads, inputs, 'マクロ変数からの読み取り', 'グローバル変数からの読み取り');

    // 内部（ローカル）変数のリスト化
    // 名前は宣言名そのもの（添字を含まない）のため、配列の次元は型名側へ表示する
    const internalVariables: VariableInfo[] = [];
    localVars.forEach((declared, name) => {
        internalVariables.push({
            name,
            type: formatArrayType(declared.type, declared.arrayDimensions),
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
 *   1. ファイルスコープのシンボル収集 (collectFileScopeSymbols / collectIncludedSymbols)
 *   2. カーソル位置の関数同定         (findFunctionAtCursor)
 *   3. 関数シグネチャの解析           (parseSignature)
 *   4. 関数ボディの走査               (analyzeBody)
 *   5. 解析結果の分類・統合           (buildResult)
 *
 * @param tree 解析対象のASTツリー
 * @param cursorLine ユーザーがカーソルを置いている行（0始まり）
 * @param classifyAllUppercaseAsMacros 大文字のみの識別子をマクロとして分類するか
 * @param options インクルード探索の設定。省略した場合は解析対象ファイル内のみを参照します
 * @returns 解析結果、またはカーソルが関数名部分にない場合は null
 */
export function analyzeCFunction(
    tree: Parser.Tree,
    cursorLine: number,
    classifyAllUppercaseAsMacros: boolean = true,
    options?: {
        /** `#include "..."` を解決するリゾルバ */
        includeResolver?: IncludeResolver;
        /** 解析対象ファイルのパス（相対インクルードの解決起点） */
        currentFilePath?: string;
    }
): AnalysisResult | null {
    const rootNode = tree.rootNode;

    // 解析対象ファイル自身のシンボルを先に収集し、インクルード側は不足分のみを補う
    const symbols = collectFileScopeSymbols(rootNode);
    if (options && options.includeResolver) {
        collectIncludedSymbols(
            rootNode,
            options.includeResolver,
            options.currentFilePath,
            symbols,
            new Set<string>(),
            0
        );
    }

    const funcNode = findFunctionAtCursor(rootNode, cursorLine);
    if (!funcNode) {
        return null;
    }

    const signature = parseSignature(funcNode);
    const body = analyzeBody(funcNode.childForFieldName('body'), signature.params, symbols.functions);

    return buildResult(funcNode, signature, body, symbols, classifyAllUppercaseAsMacros);
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
