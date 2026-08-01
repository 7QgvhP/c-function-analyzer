/**
 * 宣言の先頭に付く「修飾子マクロ」によるパース崩れを修復するモジュールです。
 *
 * 組み込み系のCコードでは、記憶域クラスをマクロで隠す記法が広く使われます。
 *
 * ```c
 * #define GLOBAL extern
 * GLOBAL BYTE hoge;
 * ```
 *
 * tree-sitter はプリプロセッサを展開しないため、`GLOBAL` を型名と解釈し、
 * 本来の型である `BYTE` を ERROR ノードへ追いやってしまいます。その結果、
 * 型名が `GLOBAL` と表示されたり、`BYTE` が変数として誤検出されたりします。
 *
 * 崩れ方は記述パターン（ポインタ・配列・初期化子・`unsigned` の有無など）ごとに
 * 大きく異なるため、崩れたASTを個別に補正するのは現実的ではありません。
 * 本モジュールでは **先頭のマクロ部分を同じ長さの空白へ置き換えて再パースする**
 * 方式を採ります。文字数が変わらないため、行・列・オフセットはすべて元のまま保たれ、
 * 定義位置ジャンプなど下流の処理に影響しません。
 */
import Parser = require('web-tree-sitter');

/** 修飾子マクロの候補を探す対象のノード種別 */
const TARGET_NODE_TYPES = new Set(['declaration', 'function_definition', 'field_declaration']);

/** 先頭のマクロとみなしうるノード種別 */
const LEADING_TYPE_NODE_TYPES = new Set(['type_identifier', 'identifier']);

/** 一度に空白化する候補の上限（異常なソースで処理が膨らむのを防ぐ） */
const MAX_REPAIR_SPANS = 5000;

/** ソース上の範囲（終端は含まない） */
interface SourceSpan {
    startIndex: number;
    endIndex: number;
}

/**
 * ソースをパースし、修飾子マクロによるパース崩れがあれば修復したASTを返します。
 *
 * 修復は次の2段階で行います。誤検出により状態が悪化することはありません。
 *
 * | 段階 | 対象 | 採用条件 |
 * |---|---|---|
 * | 1 | `VOLATILE unsigned long x;` のように型名へ吸収されたマクロ | エラーが増えないこと |
 * | 2 | `GLOBAL BYTE hoge;` のようにパースが崩れたマクロ | エラーが実際に減ること |
 *
 * 段階1は構文的に不正な形（`unsigned` の前に素の識別子が来る）のみを対象とするため、
 * パースエラーが出ていなくても安全に除去できます。段階2は推定を含むため、
 * エラーが減った場合のみ採用します。
 *
 * @param parser 言語設定済みのパーサー
 * @param source 解析対象のCソースコード
 * @returns AST（必要に応じて修復済み）
 */
export function parseWithModifierMacroRepair(parser: Parser, source: string): Parser.Tree {
    let current: RepairState = { tree: parser.parse(source), source };

    // 段階1: 型名へ吸収されたマクロ（エラーにならないため、エラーの有無によらず判定する）
    current = applyRepair(parser, current, collectAbsorbedMacroSpans, true);

    // 段階2: パースが崩れたマクロ
    if (current.tree.rootNode.hasError()) {
        current = applyRepair(parser, current, collectModifierMacroSpans, false);
    }

    return current.tree;
}

/** 修復の途中経過（ソースとその解析結果） */
interface RepairState {
    tree: Parser.Tree;
    source: string;
}

/**
 * 指定した収集方法で範囲を空白化し、改善した場合のみ結果を採用します。
 *
 * @param parser 言語設定済みのパーサー
 * @param state 現在のソースとAST
 * @param collect 空白化する範囲の収集方法
 * @param allowEqualErrors エラー数が同じでも採用するか（確実な修復の場合に true）
 * @returns 採用後のソースとAST（採用しない場合は入力のまま）
 */
function applyRepair(
    parser: Parser,
    state: RepairState,
    collect: (rootNode: Parser.SyntaxNode) => SourceSpan[],
    allowEqualErrors: boolean
): RepairState {
    const spans = collect(state.tree.rootNode);
    if (spans.length === 0) {
        return state;
    }

    const repairedSource = blankSpans(state.source, spans);
    let repaired: Parser.Tree;
    try {
        repaired = parser.parse(repairedSource);
    } catch {
        // 再パースに失敗した場合は現在のASTで解析を継続する
        return state;
    }

    const before = countErrors(state.tree.rootNode);
    const after = countErrors(repaired.rootNode);
    const improved = allowEqualErrors ? after <= before : after < before;

    if (improved) {
        deleteTree(state.tree);
        return { tree: repaired, source: repairedSource };
    }

    deleteTree(repaired);
    return state;
}

/**
 * 型名へ吸収された修飾子マクロの範囲を収集します。
 *
 * `VOLATILE unsigned long x;` は `sized_type_specifier` として**エラーなく**パースされ、
 * 型名が `VOLATILE unsigned long` になってしまいます。C言語では `unsigned` などの前に
 * 素の識別子が来ることはないため、この形は必ず修飾子マクロです。
 *
 * @param rootNode ASTのルートノード
 * @returns 空白化すべき範囲の一覧
 */
function collectAbsorbedMacroSpans(rootNode: Parser.SyntaxNode): SourceSpan[] {
    const spans: SourceSpan[] = [];

    walk(rootNode, node => {
        if (spans.length >= MAX_REPAIR_SPANS || node.type !== 'sized_type_specifier') {
            return;
        }
        const first = node.child(0);
        // 素の識別子で始まり、後ろに unsigned などが続く場合のみが対象
        if (!first || first.type !== 'type_identifier' || node.childCount < 2) {
            return;
        }
        spans.push({ startIndex: first.startIndex, endIndex: first.endIndex });
    });

    return spans;
}

/**
 * 修飾子マクロとみなせる先頭トークンの範囲を収集します。
 *
 * 宣言・関数定義のうち、先頭が素の識別子でありながらパースエラーを含むものを対象とします。
 * 関数定義については、ボディ内のエラーは無関係のため判定から除外します
 * （`MyType func(void) { 壊れたボディ }` のような正常な型名を誤って除去しないため）。
 *
 * @param rootNode ASTのルートノード
 * @returns 空白化すべき範囲の一覧
 */
function collectModifierMacroSpans(rootNode: Parser.SyntaxNode): SourceSpan[] {
    const spans: SourceSpan[] = [];

    walk(rootNode, node => {
        if (spans.length >= MAX_REPAIR_SPANS || !TARGET_NODE_TYPES.has(node.type)) {
            return;
        }
        if (!hasErrorOutsideBody(node)) {
            return;
        }
        const span = findLeadingMacroSpan(node);
        if (span) {
            spans.push(span);
        }
    });

    return spans;
}

/**
 * 宣言・関数定義の先頭にある、マクロとみなせる識別子の範囲を返します。
 *
 * `GLOBAL unsigned char uc;` のように `sized_type_specifier` へ取り込まれる場合があるため、
 * その内側の先頭要素も対象とします。
 *
 * @param node 宣言または関数定義のノード
 * @returns 該当する範囲。先頭が識別子でない場合は null
 */
function findLeadingMacroSpan(node: Parser.SyntaxNode): SourceSpan | null {
    const first = node.child(0);
    if (!first) {
        return null;
    }

    // GLOBAL unsigned char uc; → sized_type_specifier(type_identifier GLOBAL, unsigned)
    const leading = first.type === 'sized_type_specifier' ? first.child(0) : first;
    if (!leading || !LEADING_TYPE_NODE_TYPES.has(leading.type)) {
        return null;
    }

    // 型指定子が1語しかない宣言（Foo bar; など）は正常なため対象外
    if (leading === node.child(0) && node.childCount < 3) {
        return null;
    }

    return { startIndex: leading.startIndex, endIndex: leading.endIndex };
}

/**
 * ノードがボディ（`compound_statement`）の外側にパースエラーを含むかを判定します。
 *
 * @param node 判定対象のノード
 * @returns ボディ外にエラーまたは欠落トークンがあれば true
 */
function hasErrorOutsideBody(node: Parser.SyntaxNode): boolean {
    let found = false;

    const visit = (current: Parser.SyntaxNode): void => {
        if (found || current.type === 'compound_statement') {
            return;
        }
        if (current !== node && isErrorNode(current)) {
            found = true;
            return;
        }
        for (let i = 0; i < current.childCount; i++) {
            visit(current.child(i)!);
        }
    };

    visit(node);
    return found;
}

/**
 * ノードがパースエラー、または欠落トークンかを判定します。
 *
 * @param node 判定対象のノード
 * @returns エラーノードまたは欠落トークンであれば true
 */
function isErrorNode(node: Parser.SyntaxNode): boolean {
    return node.type === 'ERROR' || node.isMissing();
}

/**
 * AST内のパースエラー・欠落トークンの数を数えます。
 *
 * @param rootNode ASTのルートノード
 * @returns エラーノードと欠落トークンの合計数
 */
function countErrors(rootNode: Parser.SyntaxNode): number {
    let count = 0;
    walk(rootNode, node => {
        if (isErrorNode(node)) {
            count++;
        }
    });
    return count;
}

/**
 * 指定範囲を同じ長さの空白へ置き換えます。
 *
 * 文字数を変えないことで、元のソースと位置情報（行・列・オフセット）を一致させます。
 *
 * @param source 元のソースコード
 * @param spans 空白化する範囲の一覧
 * @returns 置き換え後のソースコード
 */
function blankSpans(source: string, spans: SourceSpan[]): string {
    const sorted = [...spans].sort((a, b) => a.startIndex - b.startIndex);
    const parts: string[] = [];
    let cursor = 0;

    for (const span of sorted) {
        if (span.startIndex < cursor) {
            continue; // 範囲が重複する場合は後続を無視する
        }
        parts.push(source.substring(cursor, span.startIndex));
        parts.push(' '.repeat(span.endIndex - span.startIndex));
        cursor = span.endIndex;
    }
    parts.push(source.substring(cursor));

    return parts.join('');
}

/**
 * ASTを再帰的に走査します。
 *
 * @param node 起点ノード
 * @param callback 各ノードに対して呼び出す処理
 */
function walk(node: Parser.SyntaxNode, callback: (node: Parser.SyntaxNode) => void): void {
    callback(node);
    for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i)!, callback);
    }
}

/**
 * ASTを解放します。解放に失敗しても処理は継続します。
 *
 * @param tree 解放対象のAST
 */
function deleteTree(tree: Parser.Tree): void {
    try {
        tree.delete();
    } catch {
        // 解放に失敗しても解析処理は継続する
    }
}
