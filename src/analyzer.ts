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
    /**
     * 同名のファイルが複数見つかった状態で解決された定義かどうか。
     * true の場合、意図と異なるファイルを参照している可能性があります。
     */
    ambiguous?: boolean;
}

/**
 * シンボルの収集元ファイルの情報です。
 * 解析対象ファイル自身から収集する場合は省略します。
 */
interface SymbolOrigin {
    /** 収集元ファイルのパス */
    filePath: string;
    /** 同名ファイルが複数見つかった状態で解決されたか */
    ambiguous?: boolean;
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
    /**
     * 定義値（マクロの `#define` 値）。型名とは別の欄として表示されます。
     * 値を持たない項目では未設定です。
     */
    value?: string;
    /** 宣言の右側に書かれたコメント（説明書き）。無い場合は未設定 */
    comment?: string;
    /**
     * 現在のファイル内での参照位置。
     *
     * 定義位置を VS Code の定義プロバイダで解決する際の起点として使います。
     * 参照位置を持たない項目（戻り値など）では未設定です。
     */
    usage?: SourcePosition;
    /**
     * アクセスパスの各セグメントの参照位置（根元から順）。
     *
     * 配列の次元はセグメントごとに宣言が異なるため、`g_tbl[].member` の `g_tbl` の
     * 次元を埋めるのに使います。
     */
    segments?: SourcePosition[];
}

/** インクルードファイルの解決結果 */
export interface ResolvedInclude {
    /** 解析済みのAST */
    tree: Parser.Tree;
    /** 実際に読み込んだファイルのパス（定義位置の filePath として使用されます） */
    filePath: string;
    /**
     * 同名のファイルが探索対象に複数存在したかどうか。
     * true の場合、このファイル由来の定義には「候補が複数ある」印が付きます。
     */
    ambiguous?: boolean;
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
    /**
     * 型名欄に表示する文字列。
     * 呼び出し関数は戻り値の型（`void` を含む）、マクロ関数は `macro` です。
     * 宣言が見つからず戻り値の型を特定できない場合は未設定です。
     */
    type?: string;
    /** 定義値（マクロ関数の展開内容）。持たない場合は未設定 */
    value?: string;
    /** 宣言の右側に書かれたコメント（説明書き）。無い場合は未設定 */
    comment?: string;
    /**
     * 現在のファイル内での参照位置。
     *
     * 定義位置を VS Code の定義プロバイダで解決する際の起点として使います。
     * 参照位置を持たない項目（戻り値など）では未設定です。
     */
    usage?: SourcePosition;
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
    /** 宣言の右側に書かれたコメント（説明書き）。無い場合は未設定 */
    comment?: string;
}

/** 宣言された変数の情報（ローカル変数・ファイルスコープ変数で共用） */
interface DeclaredVar {
    /** 型名（ポインタのアスタリスクを含む。配列の次元は含まない） */
    type: string;
    /** 配列の各次元のサイズ（内側から順）。配列でない場合は空配列 */
    arrayDimensions: string[];
    /** 宣言されている位置 */
    definition: DefinitionLocation;
    /** 宣言の右側に書かれたコメント（説明書き）。無い場合は未設定 */
    comment?: string;
    /**
     * 型がその場で定義された無名の構造体・共用体である場合のメンバ一覧です。
     *
     * `struct { int inner; } nest;` のようなメンバはタグ名を持たないため、
     * 型名から構造体定義を引くことができません。メンバ一覧を直接持たせることで
     * `g.nest.inner` のような多段のアクセスパスを解決できるようにします。
     */
    inlineMembers?: StructMembers;
}

/** 関数の宣言・定義の情報 */
interface FunctionDeclaration {
    /** 宣言・定義されている位置 */
    definition: DefinitionLocation;
    /** 戻り値の型（例: `int`、`void`、`static char*`） */
    returnType: string;
    /** 宣言の右側に書かれたコメント（説明書き）。無い場合は未設定 */
    comment?: string;
}

/** マクロ定義の情報 */
interface MacroDefinition {
    /** 定義値（`#define MAX_LIMIT 10` の `10`）。値を持たないマクロは空文字列 */
    value: string;
    /** 定義されている位置 */
    definition: DefinitionLocation;
    /**
     * 定義の種別。型名欄の表示に使います。
     * `#define` は `macro`、`enum` の列挙子は `enum` です。
     */
    kind: 'macro' | 'enum';
    /** 定義の右側に書かれたコメント（説明書き）。無い場合は未設定 */
    comment?: string;
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
    /** 関数（名前 → 定義位置と戻り値の型） */
    functions: Map<string, FunctionDeclaration>;
    /** マクロ（名前 → 定義値と定義位置） */
    macros: Map<string, MacroDefinition>;
    /**
     * 構造体・共用体の定義（型名 → メンバ一覧）。
     * タグ名（`struct Config`）と typedef 名（`HogeStruct`）の双方で引けるよう登録します。
     */
    structs: Map<string, StructMembers>;
    /**
     * `typedef` の別名（別名 → 元の型名）。
     * 定義と typedef を別に書いた場合に、別名から実体を辿るために使用します。
     */
    typeAliases: Map<string, string>;
}

/** インクルードを辿る深さの上限（循環や過剰な探索を防ぐ） */
export const MAX_INCLUDE_DEPTH = 8;

/**
 * 定義が見つからず、型を特定できなかった場合に型名欄へ表示する文字列です。
 *
 * グローバル変数・マクロ・呼び出し関数のいずれも同じ表記にそろえています。
 * 変数か関数か、マクロかどうかは所属するセクションで判別できるため、
 * 型名欄では「型が分からない」ことだけを示します。
 */
const UNKNOWN_TYPE = '(推定)';

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
    /**
     * 各シンボルが現在のファイルで最初に現れる位置。
     *
     * 定義位置の解決（VS Code の定義プロバイダ呼び出し）の起点として使います。
     * アクセスパスの場合は**最後のメンバ**の位置を記録し、`g_cfg.mode` なら
     * `mode` の位置から直接メンバの宣言へ辿れるようにします。
     */
    usagePositions: Map<string, SourcePosition>;
    /**
     * アクセスパスの各セグメントの位置（根元から順）。
     *
     * 配列の次元はセグメントごとに宣言が異なるため、`g_tbl[].member` の `g_tbl` の
     * 次元を埋めるには、そのセグメントの定義を別途辿る必要があります。
     */
    segmentPositions: Map<string, SourcePosition[]>;
}

/** ソース上の位置（0始まり） */
export interface SourcePosition {
    line: number;
    column: number;
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
    /**
     * 関数ポインタ変数の宣言か（`int (*fp)(int);`）。
     *
     * ポインタが function_declarator の内側にある場合に true になります。
     * ポインタを返す関数（`char *fetch(void);`）はポインタが外側にあるため false です。
     * どちらもポインタ深さは 1 になるため、この位置関係で判別します。
     */
    isFunctionPointer: boolean;
    /** 識別子ノードの位置。名前が解決できなかった場合は null */
    position: DefinitionLocation | null;
}

/**
 * 宣言の右側に書かれたコメントを取得します。
 *
 * 組込みコードでは、変数やメンバの宣言の右にその説明を書く習慣が広くあります。
 *
 * ```c
 * extern U8 g_mode;    // 動作モード
 * struct Config {
 *     S16 offset;      // 補正値
 * };
 * ```
 *
 * ブロックコメント（`/` + `* ... *` + `/`）も同様に扱います。
 *
 * コメントは宣言ノードの**後続の兄弟**として現れるため、同じ行にある限り
 * 兄弟を辿り、見つからなければ親（同じ行で終わるものに限る）へ上がって探します。
 * 行が変わった時点で打ち切るため、次の行のコメントを拾うことはありません。
 *
 * @param node 宣言位置を示すノード（識別子など）
 * @returns コメント本文（記号と余分な空白を除いたもの）。無い場合は undefined
 */
function findTrailingComment(node: Parser.SyntaxNode): string | undefined {
    const row = node.startPosition.row;
    let current: Parser.SyntaxNode | null = node;

    while (current) {
        for (let sibling = current.nextSibling; sibling; sibling = sibling.nextSibling) {
            // 行が変わったら、その宣言に付随するコメントではない
            if (sibling.startPosition.row !== row) {
                return undefined;
            }
            if (sibling.type === 'comment') {
                return normalizeComment(sibling.text);
            }
        }

        // 同じ行で終わる親に限り、一段上の階層でも探す
        const parent: Parser.SyntaxNode | null = current.parent;
        if (!parent || parent.endPosition.row !== row) {
            return undefined;
        }
        current = parent;
    }
    return undefined;
}

/**
 * コメントのテキストから記号と余分な空白を取り除きます。
 *
 * 通常のコメント記号に加え、Doxygen 形式の目印（`!` と、直前の要素を指す `<`）も
 * 取り除きます。組込みコードでは宣言の右側に `//!<` や `/**< ... *``/` と書く習慣があるためです。
 *
 * | 記述 | 取り出される本文 |
 * |---|---|
 * | `// 説明` | `説明` |
 * | `//!< 説明` | `説明` |
 * | `///< 説明` | `説明` |
 * | `/`+`* 説明 *`+`/` | `説明` |
 * | `/`+`**< 説明 *`+`/` | `説明` |
 *
 * @param text コメントノードのテキスト（ブロックコメント／行コメントのいずれも可）
 * @returns 表示用のコメント本文
 */
function normalizeComment(text: string): string {
    // 開始記号（`/*` `/**` `/*!`）と Doxygen の `<`、終端記号で挟まれた本文を取り出す。
    // 置換を重ねる方式では、空のコメント（記号だけ）で記号が残ってしまうため。
    const block = text.match(/^\/\*+!?<?([\s\S]*?)\**\/$/);
    if (block) {
        return collapseSpaces(block[1]);
    }

    // 行コメントの開始記号（`//` `///` `//!`）と Doxygen の `<`
    const line = text.match(/^\/\/+!?<?([\s\S]*)$/);
    return collapseSpaces(line ? line[1] : text);
}

/**
 * 連続する空白を1つにまとめ、前後の空白を取り除きます。
 *
 * @param text 対象のテキスト
 * @returns 整形後のテキスト
 */
function collapseSpaces(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * ASTノードの開始位置を定義位置として取り出します。
 *
 * @param node 対象ノード
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 * @returns 定義位置
 */
function toDefinitionLocation(node: Parser.SyntaxNode, origin?: SymbolOrigin): DefinitionLocation {
    const location: DefinitionLocation = {
        line: node.startPosition.row,
        column: node.startPosition.column
    };
    if (origin) {
        location.filePath = origin.filePath;
        if (origin.ambiguous) {
            location.ambiguous = true;
        }
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
 * 2つのノードが同一かを判定します。
 *
 * web-tree-sitter は `child()` や `childForFieldName()` を呼ぶたびに新しい
 * ラッパーオブジェクトを返すため、`===` による比較は同じノードでも false になります。
 * ノードの識別には `id` を使う必要があります。
 *
 * @param a 比較するノード
 * @param b 比較するノード
 * @returns 同一のノードであれば true
 */
function isSameNode(a: Parser.SyntaxNode | null, b: Parser.SyntaxNode | null): boolean {
    return a !== null && b !== null && a.id === b.id;
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
function resolveDeclarator(node: Parser.SyntaxNode, origin?: SymbolOrigin): DeclaratorInfo {
    let name = '';
    let pointerDepth = 0;
    let arrayDepth = 0;
    let ownerFunctionDeclarator: Parser.SyntaxNode | null = null;
    let isFunctionPointer = false;
    let position: DefinitionLocation | null = null;
    // 配列の各次元のサイズ。外側の次元から順に見つかるため、最後に反転して並べ直す
    const arrayDimensions: string[] = [];

    let current: Parser.SyntaxNode | null = node;
    while (current) {
        if (current.type === 'pointer_declarator') {
            pointerDepth++;
            // function_declarator を通過した後に現れるポインタは、関数ポインタ変数を示す
            // （int (*fp)(int) は内側、char *fetch(void) は外側にポインタがある）
            if (ownerFunctionDeclarator) {
                isFunctionPointer = true;
            }
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
            position = toDefinitionLocation(current, origin);
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

    return { name, pointerDepth, arrayDepth, arrayDimensions, ownerFunctionDeclarator, isFunctionPointer, position };
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

/** 型解決に用いるシンボル情報 */
interface TypeResolutionContext {
    /** 構造体・共用体の定義（型名 → メンバ一覧） */
    structs: Map<string, StructMembers>;
    /** typedef の別名（別名 → 元の型名） */
    typeAliases: Map<string, string>;
}

/**
 * 型名から構造体・共用体のメンバ一覧を引きます。
 *
 * 直接見つからない場合は `typedef` の別名を辿ります。
 * `typedef struct TagC SeparateAlias;` のように定義と typedef を別に書いた場合、
 * 別名からは中身を直接引けないためです。多段の typedef にも対応します。
 *
 * @param type 型名（ポインタ表記を含んでいてもかまいません）
 * @param types 構造体定義と typedef 別名
 * @returns メンバ一覧。解決できない場合は undefined
 */
function findStructMembers(type: string, types: TypeResolutionContext): StructMembers | undefined {
    let key = normalizeStructKey(type);
    const visited = new Set<string>();

    while (key && !visited.has(key)) {
        visited.add(key);

        const members = types.structs.get(key);
        if (members) {
            return members;
        }
        const alias = types.typeAliases.get(key);
        if (!alias) {
            return undefined;
        }
        key = normalizeStructKey(alias);
    }
    return undefined;
}

/** アクセスパスの解決結果 */
interface ResolvedAccessPath {
    /** 表示用の名前（各セグメントの添字に宣言された次元を反映したもの） */
    name: string;
    /** 表示用の型名 */
    type: string;
    /**
     * 最終的に参照している変数・メンバの宣言位置。
     * 解決できなかった場合は undefined（「定義へ」ボタンを表示しません）。
     */
    definition?: DefinitionLocation;
    /** 最終的に参照している変数・メンバのコメント */
    comment?: string;
}

/** アクセスパスの起点となる変数の情報 */
interface AccessPathRoot {
    type: string;
    arrayDimensions: string[];
    definition?: DefinitionLocation;
    comment?: string;
    inlineMembers?: StructMembers;
}

/**
 * アクセスパスを解析し、表示用の名前・型・定義位置を解決します。
 *
 * 構造体・共用体のメンバアクセスを辿り、**最終的に参照しているメンバ**の型と
 * 宣言位置を返します。例: `tbl[].id`（`HogeStruct tbl[5]`、`HogeStruct` に `int id`）は
 * 名前 `tbl[5].id`、型 `int`、定義位置は `int id;` の宣言行に解決されます。
 *
 * 構造体定義やメンバが見つからない場合は、根元の型で代用せず
 * 型を `(推定)`、定義位置を未設定にします。誤った型や無関係な場所へのジャンプを
 * 提示するより、解決できていないことを明示する方が誤解を招かないためです。
 *
 * @param accessPath アクセスパス（例: `hoge[]`、`tbl[].id`、`var_ptr->sub.member`）
 * @param rootVar 根元の変数の型情報と宣言位置
 * @param types 構造体定義と typedef 別名
 * @returns 表示用の名前・型・定義位置
 */
function resolveAccessPath(
    accessPath: string,
    rootVar: AccessPathRoot,
    types: TypeResolutionContext
): ResolvedAccessPath {
    // 区切り文字（. と ->）を保持したまま分割する
    const parts = accessPath.split(/(\.|->)/);

    let current: AccessPathRoot = rootVar;
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
        // その場で定義された無名の構造体・共用体は型名から引けないため、
        // メンバが直接持っている一覧を優先して使う
        const members = resolved
            ? (current.inlineMembers || findStructMembers(current.type, types))
            : undefined;
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

    // 解決できなかった場合は、根元の型で代用せず「型が分からない」ことを示す
    if (!resolved) {
        return { name, type: UNKNOWN_TYPE };
    }

    // 配列の次元は名前と型のどちらか一方にのみ出す。
    // 末尾セグメントが添字を伴う場合は名前側に出ているため、型には付けない。
    const lastHasSubscript = /\[[^\]]*\]/.test(lastSegment);
    const type = lastHasSubscript
        ? current.type
        : formatArrayType(current.type, current.arrayDimensions);

    return { name, type, definition: current.definition, comment: current.comment };
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
    origin?: SymbolOrigin
): void {
    const typeNode = declNode.childForFieldName('type') || declNode.child(0);
    if (!typeNode) {
        return;
    }

    const typeText = cleanTypeText(typeNode.text);

    for (let i = 0; i < declNode.childCount; i++) {
        const child = declNode.child(i)!;
        if (isSameNode(child, typeNode) || child.type === ',' || child.type === ';') {
            continue;
        }

        // init_declarator（初期化子付き宣言）の場合は declarator 部分のみを対象にする
        let decl = child;
        if (child.type === 'init_declarator') {
            decl = child.childForFieldName('declarator') || child.child(0)!;
        }

        const info = resolveDeclarator(decl, origin);
        if (!info.name || !info.position) {
            continue;
        }

        // 関数プロトタイプ宣言（int foo(int);）は変数ではないため除外する。
        // 関数ポインタ変数（int (*fp)(int);）はポインタ宣言を経由するため区別できる。
        if (info.ownerFunctionDeclarator && !info.isFunctionPointer) {
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
            definition: info.position,
            comment: findTrailingComment(decl)
        });
    }
}

/**
 * フェーズ1: ファイル直下の変数宣言をスキャンし、グローバル変数の型情報と宣言位置を収集します。
 *
 * @param rootNode ASTのルートノード
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 * @returns 変数名 → 型名と宣言位置 のマップ
 */
function collectFileScopeVars(
    rootNode: Parser.SyntaxNode,
    origin?: SymbolOrigin
): Map<string, DeclaredVar> {
    const fileScopeVars = new Map<string, DeclaredVar>();
    forEachFileScopeNode(rootNode, node => {
        if (node.type === 'declaration') {
            collectDeclaredVars(node, fileScopeVars, origin);
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
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 * @returns 関数名 → 定義位置 のマップ
 */
function collectFileScopeFunctions(
    rootNode: Parser.SyntaxNode,
    origin?: SymbolOrigin
): Map<string, FunctionDeclaration> {
    const functions = new Map<string, FunctionDeclaration>();

    forEachFileScopeNode(rootNode, node => {
        // 関数定義: int helper(int x) { ... }
        if (node.type === 'function_definition') {
            const declaratorNode = node.childForFieldName('declarator');
            if (declaratorNode) {
                const info = resolveDeclarator(declaratorNode, origin);
                if (info.name && info.position) {
                    // 定義は宣言より優先するため上書きする
                    functions.set(info.name, {
                        definition: info.position,
                        returnType: extractReturnType(node, declaratorNode, info.pointerDepth),
                        comment: findTrailingComment(declaratorNode)
                    });
                }
            }
            return;
        }

        // 関数プロトタイプ宣言: int helper(int x); / char *fetch(void);
        // （function_declarator を経由し、かつ関数ポインタ変数でないものが該当する。
        //   int (*fp)(int); のような関数ポインタ変数は isFunctionPointer で除外される）
        if (node.type === 'declaration') {
            const typeNode = node.childForFieldName('type') || node.child(0);
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i)!;
                // 型指定子・区切り文字、および初期化子付き宣言（＝変数）は対象外
                if (isSameNode(child, typeNode) || child.type === ',' || child.type === ';' || child.type === 'init_declarator') {
                    continue;
                }
                const info = resolveDeclarator(child, origin);
                if (!info.name || !info.position || !info.ownerFunctionDeclarator || info.isFunctionPointer) {
                    continue;
                }
                if (!functions.has(info.name)) {
                    functions.set(info.name, {
                        definition: info.position,
                        returnType: extractReturnType(node, child, info.pointerDepth),
                        comment: findTrailingComment(child)
                    });
                }
            }
        }
    });

    return functions;
}

/** マクロの定義値を、値の部分と末尾のコメントに分けた結果 */
interface MacroValueParts {
    /** 表示用の定義値（コメントを除き、空白を正規化したもの） */
    value: string;
    /** 値の末尾に書かれていたコメント（記号を除いたもの）。無い場合は undefined */
    comment?: string;
}

/**
 * マクロの定義値を、値の部分と末尾のコメントへ分けます。
 *
 * `#define` の値は**行末までの生テキスト**として取得されるため、末尾に書かれた
 * 行コメントが値に含まれてしまいます。
 *
 * ```
 * preproc_def
 *   identifier   |LIMIT|
 *   preproc_arg  |100    // 上限値|    ← 行コメントが値に取り込まれる
 * ```
 *
 * ブロックコメントは独立した `comment` ノードになるため `findTrailingComment` で
 * 取得できますが、行コメントは独立したノードにならないためここで取り出します。
 *
 * 文字列リテラル・文字リテラルの内側にある `//`（`"http://..."` など）は
 * コメントではないため、リテラルの内外を判定しながら走査します。
 *
 * @param text 定義値の生テキスト
 * @returns 値の部分と、末尾に書かれていたコメント
 */
function splitMacroValue(text: string): MacroValueParts {
    let inString = false;
    let inChar = false;
    let commentStart = -1;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString || inChar) {
            // エスケープされた次の1文字は判定対象から外す
            if (ch === '\\') {
                i++;
                continue;
            }
            if (inString && ch === '"') {
                inString = false;
            } else if (inChar && ch === '\'') {
                inChar = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '\'') {
            inChar = true;
            continue;
        }
        // 行コメントとブロックコメントの開始位置で打ち切る
        if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            commentStart = i;
            break;
        }
    }

    if (commentStart < 0) {
        return { value: collapseSpaces(text) };
    }

    const comment = normalizeComment(text.substring(commentStart).trim());
    return {
        value: collapseSpaces(text.substring(0, commentStart)),
        comment: comment || undefined
    };
}

/**
 * フェーズ1: マクロ定義（`#define`）を収集します。
 *
 * `#ifdef` ブロック内の定義も拾うため、AST全体を走査します。
 * オブジェクト形式（`#define MAX 10`）と関数形式（`#define SQ(x) ((x)*(x))`）の双方に対応します。
 *
 * @param rootNode ASTのルートノード
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 * @returns マクロ名 → 定義値と定義位置 のマップ
 */
function collectMacros(
    rootNode: Parser.SyntaxNode,
    origin?: SymbolOrigin
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
        const parts: MacroValueParts = valueNode ? splitMacroValue(valueNode.text) : { value: '' };
        macros.set(nameNode.text, {
            value: parts.value,
            definition: toDefinitionLocation(nameNode, origin),
            kind: 'macro',
            // 行コメントは値に取り込まれるため、そちらを優先して使う
            comment: parts.comment || findTrailingComment(nameNode)
        });
    });

    collectEnumConstants(rootNode, macros, origin);

    return macros;
}

/**
 * `enum` の列挙子を収集し、マクロと同じ扱いで登録します。
 *
 * 列挙子は `#define` と同じく「名前に値が結び付いた定数」であるため、
 * マクロ変数のセクションに定義値付きで表示します。型名欄では `enum` と表示して
 * `#define` 由来のものと区別します。
 *
 * 値が省略された列挙子は、C言語の規則に従って直前の値から求めます。
 *
 * ```c
 * enum Color { RED = 1, GREEN, BLUE = 10 };   // RED=1, GREEN=2, BLUE=10
 * enum { ANON_A, ANON_B };                    // ANON_A=0, ANON_B=1
 * enum Mode { MODE_OFF = OFFSET, MODE_ON };   // MODE_OFF=OFFSET, MODE_ON=OFFSET + 1
 * ```
 *
 * `#define` が同名で先に登録されている場合は上書きしません（プリプロセッサが先に展開するため）。
 * 関数ボディ内で定義されたローカルな `enum` は対象外です。
 *
 * @param rootNode ASTのルートノード
 * @param into 登録先のマップ
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 */
function collectEnumConstants(
    rootNode: Parser.SyntaxNode,
    into: Map<string, MacroDefinition>,
    origin?: SymbolOrigin
): void {
    forEachFileScopeNode(rootNode, node => {
        // 関数ボディ内で定義されたローカルな enum は対象外とする
        if (node.type === 'function_definition') {
            return;
        }

        walk(node, inner => {
            if (inner.type !== 'enumerator_list') {
                return;
            }

            // 直前に明示された値と、そこからの加算量。
            // 先頭から値が省略された場合に最初の列挙子が 0 になるよう -1 から始める。
            let previousValue = '-1';
            let offsetFromPrevious = 0;

            for (let i = 0; i < inner.childCount; i++) {
                const child = inner.child(i)!;
                if (child.type !== 'enumerator') {
                    continue;
                }
                const nameNode = child.childForFieldName('name') || child.child(0);
                if (!nameNode) {
                    continue;
                }

                const valueNode = child.childForFieldName('value');
                if (valueNode) {
                    previousValue = valueNode.text.replace(/\s+/g, ' ').trim();
                    offsetFromPrevious = 0;
                } else {
                    offsetFromPrevious++;
                }

                const value = formatEnumeratorValue(previousValue, offsetFromPrevious);
                if (!into.has(nameNode.text)) {
                    into.set(nameNode.text, {
                        value,
                        definition: toDefinitionLocation(nameNode, origin),
                        kind: 'enum',
                        comment: findTrailingComment(nameNode)
                    });
                }
            }
        });
    });
}

/**
 * 値が省略された列挙子の定義値を組み立てます。
 *
 * 直前の値が10進・16進の整数であれば加算した結果を返します。数値として解釈できない
 * 場合（`MODE_OFF = OFFSET` のようにマクロや式を指定した場合）は、式に加算量を
 * 付けた形（`OFFSET + 1`）を返します。
 *
 * @param previousValue 直前に明示された値
 * @param offset 直前の値からの加算量（明示された値そのものの場合は 0）
 * @returns 表示用の定義値
 */
function formatEnumeratorValue(previousValue: string, offset: number): string {
    if (offset === 0) {
        return previousValue;
    }

    const numeric = parseIntegerLiteral(previousValue);
    if (numeric !== null) {
        return String(numeric + offset);
    }
    // 数値として解釈できない場合は式のまま加算量を示す
    return `${previousValue} + ${offset}`;
}

/**
 * 整数リテラル（10進・16進・8進）を数値へ変換します。
 *
 * @param text 変換対象のテキスト
 * @returns 変換できた場合は数値、できない場合は null
 */
function parseIntegerLiteral(text: string): number | null {
    // 末尾の型サフィックス（U / L / UL など）は取り除く
    const literal = text.trim().replace(/[uUlL]+$/, '');
    if (!/^[+-]?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/.test(literal)) {
        return null;
    }
    const value = Number(literal);
    return Number.isSafeInteger(value) ? value : null;
}

/**
 * `field_declaration` が宣言子（メンバ名）を持つかを判定します。
 *
 * `union { int a; };` のような無名メンバは型指定子だけで構成され、宣言子を持ちません。
 *
 * @param fieldNode field_declaration ノード
 * @param typeNode 型指定子ノード
 * @returns 宣言子を持つ場合は true
 */
function hasFieldDeclarator(
    fieldNode: Parser.SyntaxNode,
    typeNode: Parser.SyntaxNode | null
): boolean {
    for (let i = 0; i < fieldNode.childCount; i++) {
        const child = fieldNode.child(i)!;
        if (!isSameNode(child, typeNode) && child.type !== ',' && child.type !== ';') {
            return true;
        }
    }
    return false;
}

/**
 * 構造体・共用体のメンバ一覧を収集します。
 *
 * 次の記法に対応します。
 *
 * | 記法 | 扱い |
 * |---|---|
 * | `int plain;` | そのまま登録 |
 * | `#ifdef X` の内側のメンバ | プリプロセッサ条件を透過的に降りて登録 |
 * | `union { int a; };`（無名メンバ） | 中身のメンバを親へ展開 |
 * | `struct { int inner; } nest;` | `nest` に中身のメンバ一覧を持たせる |
 *
 * @param bodyNode field_declaration_list ノード
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 * @returns メンバ名 → 型情報 のマップ
 */
function collectStructMembers(bodyNode: Parser.SyntaxNode, origin?: SymbolOrigin): StructMembers {
    const members: StructMembers = new Map();
    collectStructMembersInto(bodyNode, members, origin);
    return members;
}

/**
 * 構造体本体を走査し、メンバを登録先のマップへ追加します。
 *
 * @param bodyNode field_declaration_list ノード、またはその内側のプリプロセッサ条件ブロック
 * @param members 登録先のマップ
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 */
function collectStructMembersInto(
    bodyNode: Parser.SyntaxNode,
    members: StructMembers,
    origin?: SymbolOrigin
): void {
    for (let i = 0; i < bodyNode.childCount; i++) {
        const child = bodyNode.child(i)!;

        // #ifdef / #if などの内側にもメンバが書かれるため、透過的に降りる
        if (PREPROC_BLOCK_TYPES.has(child.type)) {
            collectStructMembersInto(child, members, origin);
            continue;
        }
        if (child.type !== 'field_declaration') {
            continue;
        }

        // その場で定義された構造体・共用体は、中身のメンバも解決できるようにする
        // （型指定子の取得方法は collectDeclaredVars と揃える）
        const typeNode = child.childForFieldName('type') || child.child(0);
        const nestedBody =
            typeNode && (typeNode.type === 'struct_specifier' || typeNode.type === 'union_specifier')
                ? typeNode.childForFieldName('body')
                : null;

        if (nestedBody && !hasFieldDeclarator(child, typeNode)) {
            // union { int a; }; のような無名メンバは、中身が親のメンバそのものになる
            collectStructMembersInto(nestedBody, members, origin);
            continue;
        }

        // field_declaration は declaration と同じ構造（type + declarator）のため共通処理を使う
        const before = new Set(members.keys());
        collectDeclaredVars(child, members, origin);

        if (!nestedBody) {
            continue;
        }
        // struct { int inner; } nest; のように名前付きの場合は、その名前に中身を持たせる
        const nestedMembers = collectStructMembers(nestedBody, origin);
        members.forEach((member, name) => {
            if (!before.has(name)) {
                member.inlineMembers = nestedMembers;
            }
        });
    }
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
 * 関数の戻り値の型を取り出します。
 *
 * 宣言子（declarator）の手前までのテキストが戻り値の型にあたるため、
 * その範囲を切り出してポインタ深さ分のアスタリスクを付与します。
 * 関数定義（`function_definition`）とプロトタイプ宣言（`declaration`）の双方に使えます。
 *
 * @param node 関数定義またはプロトタイプ宣言のノード
 * @param declaratorNode 宣言子ノード
 * @param pointerDepth 戻り値のポインタ深さ
 * @returns 戻り値の型（例: `int`、`static void`、`char*`）
 */
function extractReturnType(
    node: Parser.SyntaxNode,
    declaratorNode: Parser.SyntaxNode,
    pointerDepth: number
): string {
    // 型指定子のフィールドを使うことで、記憶域クラス（static / extern / inline）と
    // 型修飾子（const / volatile）を除いた型だけを取り出す。変数側の表示と揃えるため。
    const typeNode = node.childForFieldName('type');
    if (typeNode) {
        return cleanTypeText(typeNode.text) + '*'.repeat(pointerDepth);
    }

    // フィールドが取得できない形では、宣言子の手前までのテキストで代用する
    const rawType = node.text
        .substring(0, declaratorNode.startIndex - node.startIndex)
        .trim()
        .replace(/\s+/g, ' '); // 改行や余分な空白を除去
    return rawType + '*'.repeat(pointerDepth);
}

/**
 * フェーズ1: `typedef` の別名を収集します。
 *
 * `typedef struct TagC SeparateAlias;` のように定義と typedef を別に書いた場合、
 * 別名からは構造体の中身を直接引けません。別名 → 元の型名の対応を持つことで、
 * メンバの型解決時に実体まで辿れるようにします。
 *
 * @param rootNode ASTのルートノード
 * @returns 別名 → 元の型名 のマップ
 */
function collectTypeAliases(rootNode: Parser.SyntaxNode): Map<string, string> {
    const aliases = new Map<string, string>();

    forEachFileScopeNode(rootNode, node => {
        // 関数ボディ内のローカルな型定義は対象外とする
        if (node.type === 'function_definition') {
            return;
        }

        walk(node, inner => {
            if (inner.type !== 'type_definition') {
                return;
            }
            const aliasName = resolveTypedefName(inner);
            const typeNode = inner.childForFieldName('type');
            if (!aliasName || !typeNode || aliases.has(aliasName)) {
                return;
            }
            const underlying = cleanTypeText(typeNode.text);
            // 自分自身を指す指定は辿れないため登録しない
            if (underlying && underlying !== aliasName) {
                aliases.set(aliasName, underlying);
            }
        });
    });

    return aliases;
}

/**
 * フェーズ1: 構造体・共用体の定義を収集します。
 *
 * タグ名（`struct Config`）と typedef 名（`HogeStruct`）の双方をキーとして登録し、
 * どちらの表記からもメンバを引けるようにします。関数ボディ内のローカルな型定義は対象外です。
 *
 * @param rootNode ASTのルートノード
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 * @returns 型名 → メンバ一覧 のマップ
 */
function collectStructDefinitions(
    rootNode: Parser.SyntaxNode,
    origin?: SymbolOrigin
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

            const members = collectStructMembers(bodyNode, origin);
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
 * @param origin 収集元ファイルの情報（解析対象ファイル自身の場合は省略）
 * @returns 収集したシンボル情報
 */
function collectFileScopeSymbols(
    rootNode: Parser.SyntaxNode,
    origin?: SymbolOrigin
): FileScopeSymbols {
    return {
        vars: collectFileScopeVars(rootNode, origin),
        functions: collectFileScopeFunctions(rootNode, origin),
        macros: collectMacros(rootNode, origin),
        structs: collectStructDefinitions(rootNode, origin),
        typeAliases: collectTypeAliases(rootNode)
    };
}

export function extractIncludePaths(rootNode: Parser.SyntaxNode): string[] {
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

    return includePaths;
}

/**
 * AST から構造体・共用体の定義名を取り出します。
 *
 * インクルード探索の診断で「探索されないヘッダにどの型定義があるか」を示すために使います。
 *
 * @param rootNode ASTのルートノード
 * @returns 定義されている型名の一覧（`struct Config`、typedef 名など）
 */
export function listStructDefinitionNames(rootNode: Parser.SyntaxNode): string[] {
    return [...collectStructDefinitions(rootNode).keys()];
}

/**
 * シンボルをマクロとして分類すべきか判定します。
 *
 * 収集した定義が見つかった場合はそれに従います（マクロ定義はプリプロセッサ段階で
 * 展開されるため、変数・関数の宣言より優先します）。
 * 定義が見つからない場合のみ、名前が大文字のみかどうかで推定します
 * （システムヘッダ内の定義など、探索対象外のシンボルが該当します）。
 *
 * @param name シンボル名
 * @param hasMacroDefinition 同名のマクロ定義が見つかったか
 * @param hasSymbolDeclaration 同名の変数宣言または関数宣言が見つかったか
 * @param classifyAllUppercaseAsMacros 定義不明時に大文字のみの識別子をマクロとみなすか
 * @returns マクロとして分類する場合は true
 */
function shouldClassifyAsMacro(
    name: string,
    hasMacroDefinition: boolean,
    hasSymbolDeclaration: boolean,
    classifyAllUppercaseAsMacros: boolean
): boolean {
    if (hasMacroDefinition) {
        return true;
    }
    if (hasSymbolDeclaration) {
        return false;
    }
    return classifyAllUppercaseAsMacros && isAllUppercase(name);
}

/** 型指定子・型修飾子として現れるC言語のキーワード */
const TYPE_KEYWORDS = new Set([
    'void', 'char', 'short', 'int', 'long', 'float', 'double',
    'signed', 'unsigned', '_Bool', 'bool',
    'const', 'volatile', 'restrict', 'register',
    'struct', 'union', 'enum'
]);

/** `struct` などの直後に来るタグ名を受け付けるためのキーワード */
const TAG_KEYWORDS = new Set(['struct', 'union', 'enum']);

/**
 * テキストが型指定子だけで構成されているかを判定します。
 *
 * `unsigned char`、`struct Config *`、他の型マクロの名前などを型とみなします。
 * 数値や演算子を含むもの（`(10)`、`BASE + 1`）は型ではありません。
 *
 * @param text 判定対象のテキスト
 * @param symbols 収集済みのシンボル情報
 * @param visited 参照済みの名前（マクロが循環する場合の停止用）
 * @returns 型指定子だけで構成されていれば true
 */
function isTypeLikeText(text: string, symbols: FileScopeSymbols, visited: Set<string>): boolean {
    // ポインタのアスタリスクは区切りとして扱う
    const tokens = text.replace(/\*/g, ' ').trim().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) {
        return false;
    }

    let expectTag = false;
    for (const token of tokens) {
        if (expectTag) {
            // struct / union / enum の直後は任意のタグ名を受け付ける
            if (!/^[A-Za-z_]\w*$/.test(token)) {
                return false;
            }
            expectTag = false;
            continue;
        }
        if (TAG_KEYWORDS.has(token)) {
            expectTag = true;
            continue;
        }
        if (TYPE_KEYWORDS.has(token)) {
            continue;
        }
        if (!isKnownTypeName(token, symbols, visited)) {
            return false;
        }
    }

    // タグ名を待ったまま終わった場合（`struct` だけ）は型として扱わない
    return !expectTag;
}

/**
 * 名前が既知の型名かを判定します。
 *
 * `typedef` の別名、構造体・共用体の登録名、および型を表すマクロが対象です。
 * 型マクロが別の型マクロを参照している場合（`#define U8 BYTE`）も辿ります。
 *
 * @param name 判定対象の名前
 * @param symbols 収集済みのシンボル情報
 * @param visited 参照済みの名前（マクロが循環する場合の停止用）
 * @returns 型名であれば true
 */
function isKnownTypeName(name: string, symbols: FileScopeSymbols, visited: Set<string>): boolean {
    if (visited.has(name)) {
        return false;
    }
    visited.add(name);

    if (symbols.typeAliases.has(name) || symbols.structs.has(name)) {
        return true;
    }

    const macro = symbols.macros.get(name);
    // 列挙子は値であって型ではないため対象外
    if (macro && macro.kind === 'macro' && macro.value) {
        return isTypeLikeText(macro.value, symbols, visited);
    }
    return false;
}

/**
 * 型として使われている名前の一覧を収集します。
 *
 * 組込みコードでは `#define BYTE unsigned char` のように型をマクロで定義することが多く、
 * `a = (BYTE)(hoge + 1);` のようなキャストは tree-sitter が**キャストと解釈できません**
 * （`(x)(y)` は `x` が変数なら関数呼び出し、`(x)-y` は引き算として正しいC言語の式であり、
 * `x` が型名かどうかを知らなければ区別できないため）。その結果 `BYTE` が変数参照として
 * AST に現れ、マクロ変数として誤検出されます。
 *
 * 収集済みの定義から型名を洗い出し、分類時に除外することで誤検出を防ぎます。
 *
 * @param symbols 収集済みのシンボル情報
 * @returns 型として使われている名前の集合
 */
function collectTypeNames(symbols: FileScopeSymbols): Set<string> {
    const typeNames = new Set<string>(symbols.typeAliases.keys());

    symbols.macros.forEach((macro, name) => {
        if (macro.kind !== 'macro' || !macro.value) {
            return;
        }
        // 自分自身を参照して無限に辿らないよう、起点の名前を訪問済みにしておく
        if (isTypeLikeText(macro.value, symbols, new Set([name]))) {
            typeNames.add(name);
        }
    });

    return typeNames;
}

/**
 * マクロ・列挙子の型名欄に表示する文字列を返します。
 *
 * 定義値は型名には含めず、別の欄（`VariableInfo.value`）として表示します。
 * `#define` 由来は `macro`、`enum` の列挙子は `enum` と表示して区別します。
 *
 * @param macro マクロ定義（未解決の場合は undefined）
 * @returns 型名欄の表示文字列
 */
function formatMacroType(macro?: MacroDefinition): string {
    // 定義が見つからない場合のみ、推定であることを示す
    return macro ? macro.kind : UNKNOWN_TYPE;
}

/** 定義位置にある宣言の種別 */
export type DefinitionKind = 'macro' | 'enum' | 'function' | 'variable' | 'type' | 'unknown';

/** 定義位置から読み取った宣言の情報 */
export interface DefinitionInfo {
    /** 宣言の種別 */
    kind: DefinitionKind;
    /** 型名（変数はその型、関数は戻り値の型。マクロ・列挙子は空） */
    type: string;
    /** 配列の各次元のサイズ（内側から順）。配列でない場合は空配列 */
    arrayDimensions: string[];
    /** 定義値（マクロ・列挙子のみ） */
    value?: string;
    /** 宣言の右側に書かれたコメント */
    comment?: string;
}

/** 宣言の種別を判定する際に遡る対象のノード */
const DEFINITION_NODE_TYPES = new Set([
    'preproc_def',
    'preproc_function_def',
    'enumerator',
    'function_definition',
    'type_definition',
    'declaration',
    'field_declaration',
    'parameter_declaration'
]);

/**
 * 定義位置にある宣言を読み取り、型名・コメント・定義値を返します。
 *
 * VS Code の定義プロバイダ（F12）が返した位置を渡すことを想定しています。
 * その位置を含む宣言まで遡り、種別に応じて情報を取り出します。
 *
 * @param tree 定義があるファイルのAST
 * @param line 定義位置の行（0始まり）
 * @param column 定義位置の列（0始まり）
 * @returns 読み取った宣言の情報。判別できない場合は kind が `unknown`
 */
export function describeDefinitionSite(
    tree: Parser.Tree,
    line: number,
    column: number
): DefinitionInfo {
    const unknown: DefinitionInfo = { kind: 'unknown', type: '', arrayDimensions: [] };

    const nameNode = tree.rootNode.descendantForPosition({ row: line, column });
    if (!nameNode) {
        return unknown;
    }

    // 位置を含む宣言まで遡る
    let declNode: Parser.SyntaxNode | null = nameNode;
    while (declNode && !DEFINITION_NODE_TYPES.has(declNode.type)) {
        declNode = declNode.parent;
    }
    if (!declNode) {
        return unknown;
    }

    const comment = findTrailingComment(nameNode) || findTrailingComment(declNode);

    // マクロ定義
    if (declNode.type === 'preproc_def' || declNode.type === 'preproc_function_def') {
        const valueNode = declNode.childForFieldName('value');
        const parts = valueNode ? splitMacroValue(valueNode.text) : { value: '' };

        // 型をマクロで定義している場合（`#define BYTE unsigned char`）は型として扱う。
        // キャストが変数参照と解釈されることがあり、変数として表示すると誤解を招くため。
        if (parts.value && isTypeMacroValue(parts.value, tree)) {
            return { kind: 'type', type: parts.value, arrayDimensions: [], comment: parts.comment || comment };
        }

        return {
            kind: 'macro',
            type: '',
            arrayDimensions: [],
            value: parts.value || undefined,
            comment: parts.comment || comment
        };
    }

    // enum の列挙子
    if (declNode.type === 'enumerator') {
        return {
            kind: 'enum',
            type: '',
            arrayDimensions: [],
            value: describeEnumeratorValue(declNode),
            comment
        };
    }

    // typedef（型名そのもの）
    if (declNode.type === 'type_definition') {
        const typeNode = declNode.childForFieldName('type');
        return {
            kind: 'type',
            type: typeNode ? cleanTypeText(typeNode.text) : '',
            arrayDimensions: [],
            comment
        };
    }

    // 関数定義
    if (declNode.type === 'function_definition') {
        const declaratorNode = declNode.childForFieldName('declarator');
        const info = declaratorNode ? resolveDeclarator(declaratorNode) : null;
        return {
            kind: 'function',
            type: declaratorNode
                ? extractReturnType(declNode, declaratorNode, info ? info.pointerDepth : 0)
                : '',
            arrayDimensions: [],
            comment
        };
    }

    // 変数宣言・構造体メンバ・引数・関数プロトタイプ宣言
    return describeDeclaration(declNode, nameNode, comment);
}

/**
 * マクロの定義値が型指定子だけで構成されているかを判定します。
 *
 * `#define BYTE U8` のように別のマクロや `typedef` を参照している場合に備え、
 * **同じファイル内**の定義を1段階だけ辿ります。
 *
 * @param value マクロの定義値
 * @param tree 定義があるファイルのAST
 * @param visited 参照済みの名前（循環の停止用）
 * @returns 型指定子だけで構成されていれば true
 */
function isTypeMacroValue(
    value: string,
    tree: Parser.Tree,
    visited: Set<string> = new Set()
): boolean {
    // ポインタのアスタリスクは区切りとして扱う
    const tokens = value.replace(/\*/g, ' ').trim().split(/\s+/).filter(t => t.length > 0);
    if (tokens.length === 0) {
        return false;
    }

    let expectTag = false;
    let hasTypeKeyword = false;
    const names: string[] = [];

    for (const token of tokens) {
        if (expectTag) {
            if (!/^[A-Za-z_]\w*$/.test(token)) {
                return false;
            }
            expectTag = false;
            continue;
        }
        if (TAG_KEYWORDS.has(token)) {
            expectTag = true;
            hasTypeKeyword = true;
            continue;
        }
        if (TYPE_KEYWORDS.has(token)) {
            hasTypeKeyword = true;
            continue;
        }
        if (!/^[A-Za-z_]\w*$/.test(token)) {
            return false;
        }
        names.push(token);
    }
    if (expectTag) {
        return false;
    }
    // 型キーワードだけで構成されていれば型とみなす
    if (hasTypeKeyword && names.length === 0) {
        return true;
    }
    // 識別子のみの場合は、同じファイル内の typedef / 型マクロを辿って判定する
    return names.length > 0 && names.every(name => isTypeNameInFile(name, tree, visited));
}

/**
 * 名前が、同じファイル内で型として定義されているかを判定します。
 *
 * @param name 判定する名前
 * @param tree 定義があるファイルのAST
 * @param visited 参照済みの名前（循環の停止用）
 * @returns `typedef` の別名、または型を表すマクロであれば true
 */
function isTypeNameInFile(name: string, tree: Parser.Tree, visited: Set<string>): boolean {
    if (visited.has(name)) {
        return false;
    }
    visited.add(name);

    if (collectTypeAliases(tree.rootNode).has(name)) {
        return true;
    }
    const macro = collectMacros(tree.rootNode).get(name);
    if (macro && macro.kind === 'macro' && macro.value) {
        return isTypeMacroValue(macro.value, tree, visited);
    }
    return false;
}

/**
 * 宣言ノードから、指定された名前に対応する型情報を取り出します。
 *
 * カンマ区切りで複数宣言されている場合に備え、名前が一致する宣言子を選びます。
 *
 * @param declNode 宣言ノード
 * @param nameNode 定義位置にあるノード（名前の識別子）
 * @param comment 宣言の右側に書かれたコメント
 * @returns 読み取った宣言の情報
 */
function describeDeclaration(
    declNode: Parser.SyntaxNode,
    nameNode: Parser.SyntaxNode,
    comment?: string
): DefinitionInfo {
    const typeNode = declNode.childForFieldName('type') || declNode.child(0);
    const typeText = typeNode ? cleanTypeText(typeNode.text) : '';

    for (let i = 0; i < declNode.childCount; i++) {
        const child = declNode.child(i)!;
        if (isSameNode(child, typeNode) || child.type === ',' || child.type === ';') {
            continue;
        }
        const decl = child.type === 'init_declarator'
            ? (child.childForFieldName('declarator') || child.child(0)!)
            : child;
        const info = resolveDeclarator(decl);
        if (!info.name || info.name !== nameNode.text) {
            continue;
        }

        // 関数プロトタイプ宣言は戻り値の型を返す
        if (info.ownerFunctionDeclarator && !info.isFunctionPointer) {
            return {
                kind: 'function',
                type: extractReturnType(declNode, decl, info.pointerDepth),
                arrayDimensions: [],
                comment
            };
        }
        return {
            kind: 'variable',
            type: typeText + (info.pointerDepth > 0 ? '*' : ''),
            arrayDimensions: info.arrayDimensions,
            comment
        };
    }

    // 宣言子を特定できない場合は型名だけ返す
    return { kind: 'variable', type: typeText, arrayDimensions: [], comment };
}

/**
 * 列挙子の値を求めます。
 *
 * 値が省略されている場合は、同じ `enum` 内の直前の値から算出します。
 *
 * @param enumeratorNode enumerator ノード
 * @returns 表示用の定義値
 */
function describeEnumeratorValue(enumeratorNode: Parser.SyntaxNode): string | undefined {
    const list = enumeratorNode.parent;
    if (!list || list.type !== 'enumerator_list') {
        const valueNode = enumeratorNode.childForFieldName('value');
        return valueNode ? collapseSpaces(valueNode.text) : undefined;
    }

    // 先頭から順に値を求め、対象の列挙子に到達した時点の値を返す
    let previousValue = '-1';
    let offset = 0;
    for (let i = 0; i < list.childCount; i++) {
        const child = list.child(i)!;
        if (child.type !== 'enumerator') {
            continue;
        }
        const valueNode = child.childForFieldName('value');
        if (valueNode) {
            previousValue = collapseSpaces(valueNode.text);
            offset = 0;
        } else {
            offset++;
        }
        if (isSameNode(child, enumeratorNode)) {
            return formatEnumeratorValue(previousValue, offset);
        }
    }
    return undefined;
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

    // 戻り値の型は型指定子から取得する（例: "int", "void", "struct Data*"）
    if (declaratorNode) {
        returnType = extractReturnType(
            funcNode,
            declaratorNode,
            declaratorInfo ? declaratorInfo.pointerDepth : 0
        );
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
                definition: info.position,
                comment: findTrailingComment(child)
            });
        }
    }

    return { functionName, returnType, params };
}

/**
 * アクセス式のうち、定義位置の解決に使うノードを返します。
 *
 * `g_cfg.mode` は `mode`、`g_tbl[0].value` は `value` のように**最後のメンバ**を
 * 対象とします。そこから定義を辿ることで、メンバの宣言へ直接到達できます。
 *
 * @param node アクセス式の最も外側のノード
 * @returns 定義位置の解決に使うノード
 */
function accessTargetNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
    if (node.type === 'field_expression') {
        return node.childForFieldName('field') || node;
    }
    if (node.type === 'subscript_expression') {
        const argument = node.childForFieldName('argument');
        return argument ? accessTargetNode(argument) : node;
    }
    // デリファレンス（`*p`）や括弧（`(*p)`）は記号を指してしまうため、内側へ降りる
    if (node.type === 'pointer_expression' || node.type === 'parenthesized_expression') {
        const inner = node.childForFieldName('argument') || findFirstIdentifierChild(node);
        return inner ? accessTargetNode(inner) : node;
    }
    return node;
}

/**
 * ノードの子から、最初の識別子を含む要素を返します。
 *
 * @param node 対象ノード
 * @returns 見つかった子ノード。無い場合は null
 */
function findFirstIdentifierChild(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type !== '(' && child.type !== ')' && child.type !== '*' && child.type !== '&') {
            return child;
        }
    }
    return null;
}

/**
 * アクセス式を構成する各セグメントの識別子ノードを、記述順に返します。
 *
 * `g_tbl[0].member` なら `[g_tbl, member]` を返します。配列の次元は
 * **そのセグメント自身の宣言**から得る必要があるため、セグメントごとの位置が要ります。
 *
 * @param node アクセス式の最も外側のノード
 * @returns 各セグメントの識別子ノード（根元から順）
 */
function accessSegmentNodes(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
    if (node.type === 'field_expression') {
        const base = node.childForFieldName('argument');
        const field = node.childForFieldName('field');
        return [...(base ? accessSegmentNodes(base) : []), ...(field ? [field] : [])];
    }
    if (node.type === 'subscript_expression') {
        const argument = node.childForFieldName('argument');
        return argument ? accessSegmentNodes(argument) : [];
    }
    if (node.type === 'pointer_expression' || node.type === 'parenthesized_expression') {
        const inner = node.childForFieldName('argument') || findFirstIdentifierChild(node);
        return inner ? accessSegmentNodes(inner) : [];
    }
    return [node];
}

/**
 * アクセスパスの各セグメントの位置を記録します（同じパスでは最初の位置を残します）。
 *
 * @param into 記録先
 * @param path アクセスパス
 * @param node アクセス式の最も外側のノード
 */
function rememberSegments(
    into: Map<string, SourcePosition[]>,
    path: string,
    node: Parser.SyntaxNode
): void {
    if (into.has(path)) {
        return;
    }
    into.set(
        path,
        accessSegmentNodes(node).map(segment => ({
            line: segment.startPosition.row,
            column: segment.startPosition.column
        }))
    );
}

/**
 * シンボルの参照位置を記録します（同じ名前では最初の位置を残します）。
 *
 * @param into 記録先
 * @param name シンボル名またはアクセスパス
 * @param node 位置を取り出すノード
 */
function rememberUsage(
    into: Map<string, SourcePosition>,
    name: string,
    node: Parser.SyntaxNode
): void {
    if (into.has(name)) {
        return;
    }
    into.set(name, { line: node.startPosition.row, column: node.startPosition.column });
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
    fileScopeFunctions: Map<string, FunctionDeclaration>
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

    // 定義位置の解決に使う、各シンボルの参照位置
    const usagePositions = new Map<string, SourcePosition>();

    // 配列の次元を埋めるための、アクセスパスの各セグメントの位置
    const segmentPositions = new Map<string, SourcePosition[]>();

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
                    rememberUsage(usagePositions, funcNameNode.text, funcNameNode);
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
                checkLhsWrites(leftNode, params, localVars, pointerWrites, globalVarWrites, usagePositions, segmentPositions);
            }
            // インクリメント・デクリメント式: i++ や --p など
            if (node.type === 'update_expression') {
                const argumentNode = node.childForFieldName('argument') || node.child(0)!;
                checkLhsWrites(argumentNode, params, localVars, pointerWrites, globalVarWrites, usagePositions, segmentPositions);
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
                    // 定義位置の解決は、アクセスパスの最後のメンバから辿る
                    const targetNode = accessTargetNode(outerNode);

                    const targetParam = params.find(p => p.name === rootName);
                    if (targetParam && targetParam.isPointer) {
                        if (!isLhsNode(node)) {
                            pointerReads.add(accessPath);
                            rememberUsage(usagePositions, accessPath, targetNode);
                            rememberSegments(segmentPositions, accessPath, outerNode);
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
                            rememberUsage(usagePositions, accessPath, targetNode);
                            rememberSegments(segmentPositions, accessPath, outerNode);
                        }
                    }
                }
            }
        });
    }

    return {
        localVars,
        calledFunctions: calledFunctionsSet,
        usagePositions,
        segmentPositions,
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
    const {
        localVars, calledFunctions, usagePositions, segmentPositions,
        globalVarReads, globalVarWrites, pointerReads, pointerWrites
    } = body;

    const inputs: VariableInfo[] = [];
    const outputs: VariableInfo[] = [];
    const macroVariables: VariableInfo[] = [];
    const macroFunctions: FunctionInfo[] = [];
    const normalCalledFunctions: FunctionInfo[] = [];

    // 型として使われている名前（キャストの誤解釈で変数・関数に紛れ込むため除外する）
    const typeNames = collectTypeNames(symbols);

    // 呼び出し関数を、マクロ関数と通常の関数に振り分ける
    calledFunctions.forEach(func => {
        // 型名は関数ではない（`(BYTE)(x)` が関数呼び出しと解釈される場合がある）
        if (!symbols.functions.has(func) && typeNames.has(func)) {
            return;
        }
        const info: FunctionInfo = { name: func, usage: usagePositions.get(func) };
        // 関数定義・プロトタイプ宣言、またはマクロ定義があれば、その位置をジャンプ先として持たせる
        const macro = symbols.macros.get(func);
        const declared = symbols.functions.get(func);
        const definition = declared ? declared.definition : (macro ? macro.definition : undefined);
        if (definition) {
            info.definition = definition;
        }

        // 宣言の右側のコメントは、マクロ定義よりも宣言側を優先する
        const comment = (declared && declared.comment) || (macro && macro.comment);
        if (comment) {
            info.comment = comment;
        }

        // 定義が見つかればそれに従い、見つからなければ大文字かどうかで推定する
        if (shouldClassifyAsMacro(func, macro !== undefined, declared !== undefined, classifyAllUppercaseAsMacros)) {
            // マクロ関数には戻り値の型がないため、変数側と同じく macro と表示する
            info.type = formatMacroType(macro);
            if (macro && macro.value) {
                info.value = macro.value;
            }
            macroFunctions.push(info);
        } else {
            // 宣言が見つかれば戻り値の型（void も明示）、見つからなければ推定表示
            info.type = declared ? declared.returnType : UNKNOWN_TYPE;
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
            const paramVar = {
                type: fullType,
                arrayDimensions: [] as string[],
                definition: p.definition,
                comment: p.comment
            };

            if (matchingWrites.length > 0) {
                matchingWrites.forEach(path => {
                    const resolvedPath = resolveAccessPath(path, paramVar, symbols);
                    outputs.push({
                        name: resolvedPath.name,
                        type: resolvedPath.type,
                        details: '出力引数（ポインタ書き込みあり）',
                        definition: resolvedPath.definition,
                        comment: resolvedPath.comment,
                        usage: usagePositions.get(path),
                        segments: segmentPositions.get(path)
                    });
                });
            }

            if (matchingReads.length > 0) {
                matchingReads.forEach(path => {
                    const resolvedPath = resolveAccessPath(path, paramVar, symbols);
                    inputs.push({
                        name: resolvedPath.name,
                        type: resolvedPath.type,
                        details: '入力引数（ポインタ読み取りあり）',
                        definition: resolvedPath.definition,
                        comment: resolvedPath.comment,
                        usage: usagePositions.get(path),
                        segments: segmentPositions.get(path)
                    });
                });
            }

            if (matchingWrites.length === 0 && matchingReads.length === 0) {
                inputs.push({
                    name: p.name,
                    type: fullType,
                    details: '入力引数（ポインタ読み取りあり）',
                    definition: p.definition,
                    comment: p.comment
                });
            }
        } else {
            inputs.push({
                name: p.name,
                type: fullType,
                details: '入力引数（値渡し）',
                definition: p.definition,
                comment: p.comment
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
            const macro = symbols.macros.get(rootName);
            const declared = symbols.vars.get(rootName);

            // 型名は変数ではない（キャストの誤解釈で紛れ込むため除外する）。
            // 変数として宣言されている場合は、そちらを優先して表示する。
            if (!declared && typeNames.has(rootName)) {
                return;
            }

            // 定義が見つかればそれに従い、見つからなければ大文字かどうかで推定する
            if (shouldClassifyAsMacro(rootName, macro !== undefined, declared !== undefined, classifyAllUppercaseAsMacros)) {
                const entry: VariableInfo = {
                    name: path,
                    type: formatMacroType(macro),
                    details: macroDetails,
                    usage: usagePositions.get(path)
                };
                if (macro) {
                    entry.definition = macro.definition;
                    // 定義値は型名ではなく専用の欄に表示する
                    if (macro.value) {
                        entry.value = macro.value;
                    }
                    if (macro.comment) {
                        entry.comment = macro.comment;
                    }
                }
                macroVariables.push(entry);
            } else {
                if (declared) {
                    // 構造体メンバのアクセスを辿って型を解決し、
                    // 配列の次元は名前と型のどちらか一方にのみ表示する
                    const resolvedPath = resolveAccessPath(path, declared, symbols);
                    target.push({
                        name: resolvedPath.name,
                        type: resolvedPath.type,
                        details,
                        definition: resolvedPath.definition,
                        comment: resolvedPath.comment,
                        usage: usagePositions.get(path),
                        segments: segmentPositions.get(path)
                    });
                } else {
                    target.push({
                        name: path,
                        type: UNKNOWN_TYPE,
                        details,
                        usage: usagePositions.get(path),
                        segments: segmentPositions.get(path)
                    });
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
            definition: declared.definition,
            comment: declared.comment
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
 *   1. ファイルスコープのシンボル収集 (collectFileScopeSymbols)
 *   2. カーソル位置の関数同定         (findFunctionAtCursor)
 *   3. 関数シグネチャの解析           (parseSignature)
 *   4. 関数ボディの走査               (analyzeBody)
 *   5. 解析結果の分類・統合           (buildResult)
 *
 * ここで扱うのは**解析対象ファイルの中だけで分かる情報**です。他ファイルで宣言された
 * シンボルの型・コメント・定義位置は、各項目に記録した参照位置（`usage`）をもとに
 * `definitionResolver.ts` が VS Code の定義プロバイダ経由で補います。
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

    // 解析対象ファイル自身のシンボルを収集する
    const symbols = collectFileScopeSymbols(rootNode);

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
    globalVarWrites: Set<string>,
    usagePositions: Map<string, SourcePosition>,
    segmentPositions: Map<string, SourcePosition[]>
) {
    const resolved = resolveLhsVariable(node);
    if (!resolved) {
        return;
    }

    const { rootName, path, isPointerWrite } = resolved;
    // 定義位置の解決は、アクセスパスの最後のメンバから辿る
    const targetNode = accessTargetNode(node);

    const param = params.find(p => p.name === rootName);
    if (param) {
        // 引数の場合: ポインタ/配列引数であり、かつデレファレンス（*, ->, []）を伴う書き込みであれば追加
        if (param.isPointer && isPointerWrite) {
            pointerWrites.add(path);
            rememberUsage(usagePositions, path, targetNode);
            rememberSegments(segmentPositions, path, node);
        }
    } else {
        // 引数以外（＝グローバル変数、またはローカル変数）の場合:
        const isLocal = localVars.has(rootName);
        // ローカル変数でも除外リストでもない場合のみ、グローバル変数への書き込み（出力）とする
        if (!isLocal && !EXCLUDE_LIST.has(rootName)) {
            globalVarWrites.add(path);
            rememberUsage(usagePositions, path, targetNode);
            rememberSegments(segmentPositions, path, node);
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
