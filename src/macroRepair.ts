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
const TARGET_NODE_TYPES = new Set(['declaration', 'function_definition']);

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
 * 修復後のASTはエラー数が減った場合のみ採用します。誤検出により状態が悪化することは
 * ありません。修復が不要・不可能な場合は通常のパース結果をそのまま返します。
 *
 * @param parser 言語設定済みのパーサー
 * @param source 解析対象のCソースコード
 * @returns AST（必要に応じて修復済み）
 */
export function parseWithModifierMacroRepair(parser: Parser, source: string): Parser.Tree {
    const tree = parser.parse(source);
    if (!tree.rootNode.hasError()) {
        return tree;
    }

    const spans = collectModifierMacroSpans(tree.rootNode);
    if (spans.length === 0) {
        return tree;
    }

    let repaired: Parser.Tree;
    try {
        repaired = parser.parse(blankSpans(source, spans));
    } catch {
        // 再パースに失敗した場合は元のASTで解析を継続する
        return tree;
    }

    // 誤検出で状態を悪化させないよう、エラーが実際に減った場合のみ採用する
    if (countErrors(repaired.rootNode) < countErrors(tree.rootNode)) {
        deleteTree(tree);
        return repaired;
    }

    deleteTree(repaired);
    return tree;
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
