/**
 * 関数の構造（分岐・ループ・分岐の合流など）を、図にしやすい形へ組み立てる処理です。
 *
 * 入れ子構造はASTがそのまま持っているため、ここでは次の整理だけを行います。
 *
 * - 分岐やループに挟まれた**連続する文を1つの処理ブロックにまとめる**（図が大きくなりすぎないため）
 * - 分岐・ループ・`switch` を、条件と本体を持つ要素として取り出す
 * - `return` `break` `continue` `goto` を、流れの飛び先として取り出す
 *
 * 表示する文字列はコードの記述をそのまま使います（コメントと余分な空白のみ取り除きます）。
 *
 * VS Code API には触れないため、ヘッドレス環境でテストできます。
 */
import Parser = require('web-tree-sitter');
import { findFunctionAtCursor } from './analyzer';

/** 1つのラベルに表示する最大文字数（超えた分は省略します） */
export const MAX_LABEL_LENGTH = 40;

/** 1つの処理ブロックに表示する最大行数（超えた分は件数だけ示します） */
export const MAX_BLOCK_LINES = 3;

/** 図に含める要素数の上限（巨大な関数で図が破綻しないようにします） */
export const DEFAULT_MAX_NODES = 300;

/** 連続する文をまとめた処理 */
export interface FlowBlock {
    kind: 'block';
    /** 先頭の文がある行（0始まり） */
    line: number;
    /** 表示する文（最大 `MAX_BLOCK_LINES` 行） */
    lines: string[];
    /** 表示しきれず省略した文の数 */
    omittedLines: number;
}

/** 分岐（`if` と、プリプロセッサの条件分岐） */
export interface FlowBranch {
    kind: 'branch';
    /** 分岐がある行（0始まり） */
    line: number;
    /** 条件の記述（`#ifdef XXX` のようなプリプロセッサの条件も含む） */
    condition: string;
    /** プリプロセッサの条件分岐か */
    preprocessor: boolean;
    /** 条件が成り立つ場合の流れ */
    consequence: FlowNode[];
    /** 条件が成り立たない場合の流れ（`else` が無い場合は空） */
    alternative: FlowNode[];
}

/** 繰り返し */
export interface FlowLoop {
    kind: 'loop';
    /** ループがある行（0始まり） */
    line: number;
    /** 繰り返しの種類 */
    style: 'while' | 'for' | 'do';
    /** 継続条件の記述（`for(;;)` のように条件が無い場合は空） */
    condition: string;
    /** `for` の初期化式（持たない場合は未設定） */
    initializer?: string;
    /** `for` の更新式（持たない場合は未設定） */
    update?: string;
    /** 本体の流れ */
    body: FlowNode[];
}

/** `switch` の分岐先1つ分 */
export interface FlowCase {
    /** `case` がある行（0始まり） */
    line: number;
    /** `case 1` や `default` の記述 */
    label: string;
    /** その分岐の流れ */
    body: FlowNode[];
    /** 次の `case` へ処理が流れ落ちるか（`break` などで終わっていない） */
    fallsThrough: boolean;
}

/** 多分岐 */
export interface FlowSwitch {
    kind: 'switch';
    /** `switch` がある行（0始まり） */
    line: number;
    /** 判定対象の記述 */
    condition: string;
    /** 分岐先の一覧 */
    cases: FlowCase[];
}

/** 流れを移す文 */
export interface FlowJump {
    kind: 'return' | 'break' | 'continue' | 'goto';
    /** その文がある行（0始まり） */
    line: number;
    /** 文の記述（`return ret;` や `goto done;` など） */
    text: string;
    /** `goto` の飛び先のラベル名（`goto` 以外では未設定） */
    target?: string;
}

/** `goto` の飛び先 */
export interface FlowLabel {
    kind: 'label';
    /** ラベルがある行（0始まり） */
    line: number;
    /** ラベル名 */
    name: string;
}

/** 図の要素 */
export type FlowNode = FlowBlock | FlowBranch | FlowLoop | FlowSwitch | FlowJump | FlowLabel;

/** 関数1つ分の構造 */
export interface Flowchart {
    /** 関数名 */
    functionName: string;
    /** 関数の先頭の行（0始まり） */
    startLine: number;
    /** 流れ */
    nodes: FlowNode[];
    /** 要素数の上限に達して、以降を省略したか */
    truncated: boolean;
    /**
     * 関数の解析で構文エラーが出ているか。
     *
     * `#define FOREVER for(;;)` のように制御構造をマクロで隠していると、
     * ループとして認識できず、図から抜け落ちます。その可能性を利用者へ知らせます。
     */
    hasParseError: boolean;
}

/** 組み立て時の設定 */
export interface FlowOptions {
    /** 図に含める要素数の上限 */
    maxNodes?: number;
}

/**
 * カーソル位置の関数から、図にするための構造を組み立てます。
 *
 * @param tree 解析対象のAST
 * @param cursorLine カーソルがある行（0始まり）
 * @param options 組み立て時の設定
 * @returns 関数の構造。カーソル位置に関数が無い場合は null
 */
export function buildFlowchart(
    tree: Parser.Tree,
    cursorLine: number,
    options: FlowOptions = {}
): Flowchart | null {
    const funcNode = findFunctionAtCursor(tree.rootNode, cursorLine);
    if (!funcNode) {
        return null;
    }

    const declarator = funcNode.childForFieldName('declarator');
    const nameNode = declarator ? findFunctionName(declarator) : null;
    const body = funcNode.childForFieldName('body');

    const builder = new FlowBuilder(options.maxNodes ?? DEFAULT_MAX_NODES);
    const nodes = body ? builder.buildStatements(body) : [];

    return {
        functionName: nameNode ? nameNode.text : '(名前不明)',
        startLine: funcNode.startPosition.row,
        nodes,
        truncated: builder.truncated,
        hasParseError: funcNode.hasError()
    };
}

/**
 * 宣言子から関数名の識別子を取り出します。
 *
 * ポインタを返す関数（`char *fn(void)`）では宣言子が入れ子になるため、
 * 内側へ辿って最初の識別子を探します。
 *
 * @param declarator 宣言子ノード
 * @returns 関数名のノード。見つからない場合は null
 */
function findFunctionName(declarator: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (declarator.type === 'identifier') {
        return declarator;
    }
    const inner = declarator.childForFieldName('declarator');
    return inner ? findFunctionName(inner) : null;
}

/** 要素数の上限を見ながら、文の並びを図の要素へ変換する組み立て器 */
class FlowBuilder {
    /** 上限に達して省略したか */
    public truncated = false;

    /** これまでに作った要素の数 */
    private count = 0;

    /**
     * @param maxNodes 図に含める要素数の上限
     */
    constructor(private readonly maxNodes: number) {}

    /**
     * 文の並び（`{ ... }` の中身など）を図の要素へ変換します。
     *
     * @param container 文を子に持つノード
     * @returns 図の要素の並び
     */
    public buildStatements(container: Parser.SyntaxNode): FlowNode[] {
        return this.buildFromChildren(childStatements(container));
    }

    /**
     * 文の一覧を図の要素へ変換します。
     *
     * 連続する単純な文はまとめて1つの処理ブロックにします。
     *
     * @param statements 対象の文
     * @returns 図の要素の並び
     */
    private buildFromChildren(statements: Parser.SyntaxNode[]): FlowNode[] {
        const nodes: FlowNode[] = [];
        /** まとめ途中の単純な文 */
        let pending: Parser.SyntaxNode[] = [];

        const flush = () => {
            if (pending.length === 0) {
                return;
            }
            const block = toBlock(pending);
            pending = [];
            if (this.canAdd()) {
                nodes.push(block);
            }
        };

        for (const statement of statements) {
            // ラベルは「ラベルの要素」と「続く文」の2つになるため、ここで扱う
            if (statement.type === 'labeled_statement') {
                flush();
                if (this.canAdd()) {
                    nodes.push(this.buildLabel(statement));
                }
                nodes.push(...this.buildFromChildren(labeledStatements(statement)));
                continue;
            }

            const structured = this.buildStructured(statement, flush);
            if (structured === null) {
                // 制御構造ではない文は、まとめる対象として控える
                pending.push(statement);
                continue;
            }
            if (this.canAdd()) {
                nodes.push(structured);
            }
        }
        flush();

        return nodes;
    }

    /**
     * 制御構造の文を、対応する図の要素へ変換します。
     *
     * @param statement 対象の文
     * @param flush まとめ途中の文を確定させる処理（制御構造の手前で呼びます）
     * @returns 図の要素。制御構造でない場合は null
     */
    private buildStructured(statement: Parser.SyntaxNode, flush: () => void): FlowNode | null {
        switch (statement.type) {
            case 'if_statement':
                flush();
                return this.buildBranch(statement);
            case 'while_statement':
            case 'do_statement':
            case 'for_statement':
                flush();
                return this.buildLoop(statement);
            case 'switch_statement':
                flush();
                return this.buildSwitch(statement);
            case 'return_statement':
            case 'break_statement':
            case 'continue_statement':
            case 'goto_statement':
                flush();
                return buildJump(statement);
            case 'preproc_if':
            case 'preproc_ifdef':
                flush();
                return this.buildPreprocBranch(statement);
            case 'compound_statement':
                // 単なるブロック（`{ ... }`）は、中身をその場に展開する
                flush();
                return this.buildNested(statement);
            default:
                return null;
        }
    }

    /**
     * `if` を分岐の要素へ変換します。
     *
     * `else if` は、偽の側に分岐が入れ子になった形で表されます。
     *
     * @param statement `if_statement` ノード
     * @returns 分岐の要素
     */
    private buildBranch(statement: Parser.SyntaxNode): FlowBranch {
        const alternativeNode = statement.childForFieldName('alternative');
        return {
            kind: 'branch',
            line: statement.startPosition.row,
            condition: conditionText(statement),
            preprocessor: false,
            consequence: this.buildChild(statement.childForFieldName('consequence')),
            alternative: this.buildChild(elseBody(alternativeNode))
        };
    }

    /**
     * プリプロセッサの条件分岐を、分岐の要素へ変換します。
     *
     * `#elif` は、偽の側に分岐が入れ子になった形で表されます。
     *
     * @param statement `preproc_if` または `preproc_ifdef` ノード
     * @returns 分岐の要素
     */
    private buildPreprocBranch(statement: Parser.SyntaxNode): FlowBranch {
        const alternative = statement.childForFieldName('alternative');
        return {
            kind: 'branch',
            line: statement.startPosition.row,
            condition: preprocConditionText(statement),
            preprocessor: true,
            consequence: this.buildFromChildren(preprocBody(statement)),
            alternative: alternative ? this.buildPreprocAlternative(alternative) : []
        };
    }

    /**
     * `#elif` `#else` 以降の流れを変換します。
     *
     * @param alternative `preproc_elif` または `preproc_else` ノード
     * @returns 図の要素の並び
     */
    private buildPreprocAlternative(alternative: Parser.SyntaxNode): FlowNode[] {
        if (alternative.type === 'preproc_else') {
            return this.buildFromChildren(preprocBody(alternative));
        }
        // #elif は、入れ子の分岐として表す
        const branch = this.buildPreprocBranch(alternative);
        return this.canAdd() ? [branch] : [];
    }

    /**
     * ループを図の要素へ変換します。
     *
     * @param statement `while_statement` / `do_statement` / `for_statement` ノード
     * @returns ループの要素
     */
    private buildLoop(statement: Parser.SyntaxNode): FlowLoop {
        const style = statement.type === 'while_statement' ? 'while'
            : statement.type === 'do_statement' ? 'do' : 'for';

        const loop: FlowLoop = {
            kind: 'loop',
            line: statement.startPosition.row,
            style,
            condition: conditionText(statement),
            body: this.buildChild(statement.childForFieldName('body'))
        };

        if (style === 'for') {
            const initializer = statement.childForFieldName('initializer');
            const update = statement.childForFieldName('update');
            if (initializer) {
                loop.initializer = label(initializer);
            }
            if (update) {
                loop.update = label(update);
            }
        }

        return loop;
    }

    /**
     * `switch` を多分岐の要素へ変換します。
     *
     * @param statement `switch_statement` ノード
     * @returns 多分岐の要素
     */
    private buildSwitch(statement: Parser.SyntaxNode): FlowSwitch {
        const body = statement.childForFieldName('body');
        const cases: FlowCase[] = [];

        if (body) {
            for (const child of childStatements(body)) {
                if (child.type !== 'case_statement') {
                    continue;
                }
                const value = child.childForFieldName('value');
                const caseBody = this.buildFromChildren(caseStatements(child));
                cases.push({
                    line: child.startPosition.row,
                    label: value ? `case ${label(value)}` : 'default',
                    body: caseBody,
                    fallsThrough: !endsWithJump(caseBody)
                });
            }
        }

        return {
            kind: 'switch',
            line: statement.startPosition.row,
            condition: conditionText(statement),
            cases
        };
    }

    /**
     * ラベル付きの文から、ラベルの要素を作ります。
     *
     * ラベルに続く文は、呼び出し側が後続の流れとして取り込みます。
     *
     * @param statement `labeled_statement` ノード
     * @returns ラベルの要素
     */
    private buildLabel(statement: Parser.SyntaxNode): FlowLabel {
        const name = statement.childForFieldName('label');
        return {
            kind: 'label',
            line: statement.startPosition.row,
            name: name ? name.text : '(ラベル)'
        };
    }

    /**
     * 単なるブロック（`{ ... }`）の中身を、1つの要素としてまとめます。
     *
     * 中身が1つだけならその要素を、複数ある場合は最初の要素を返し、
     * 残りは上限の管理のうえで取り込みます。
     *
     * @param statement `compound_statement` ノード
     * @returns 図の要素。中身が無い場合は空の処理ブロック
     */
    private buildNested(statement: Parser.SyntaxNode): FlowNode {
        const nodes = this.buildStatements(statement);
        if (nodes.length === 1) {
            return nodes[0];
        }
        if (nodes.length === 0) {
            return { kind: 'block', line: statement.startPosition.row, lines: [], omittedLines: 0 };
        }
        // 複数ある場合は、分岐の無い入れ子として扱う（条件が常に真の分岐で包む）
        return {
            kind: 'branch',
            line: statement.startPosition.row,
            condition: '',
            preprocessor: false,
            consequence: nodes,
            alternative: []
        };
    }

    /**
     * 分岐やループの本体を変換します。
     *
     * 本体が `{ }` で囲まれていない場合（`if (x) y = 1;`）にも対応します。
     *
     * @param node 本体のノード
     * @returns 図の要素の並び
     */
    private buildChild(node: Parser.SyntaxNode | null): FlowNode[] {
        if (!node) {
            return [];
        }
        if (node.type === 'compound_statement') {
            return this.buildStatements(node);
        }
        return this.buildFromChildren([node]);
    }

    /**
     * 要素を追加できるか（上限に達していないか）を判定します。
     *
     * @returns 追加できる場合は true
     */
    private canAdd(): boolean {
        if (this.count >= this.maxNodes) {
            this.truncated = true;
            return false;
        }
        this.count++;
        return true;
    }
}

/**
 * ノードの子から、文として扱う要素を取り出します。
 *
 * 記号（`{` `}` `;`）とコメントは除きます。
 *
 * @param container 対象のノード
 * @returns 文のノード
 */
function childStatements(container: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const statements: Parser.SyntaxNode[] = [];
    for (let i = 0; i < container.namedChildCount; i++) {
        const child = container.namedChild(i)!;
        if (child.type !== 'comment') {
            statements.push(child);
        }
    }
    return statements;
}

/**
 * `case` ラベルに属する文を取り出します。
 *
 * `case 1:` の `1` はラベルの値なので除きます。
 *
 * @param caseNode `case_statement` ノード
 * @returns その `case` に属する文
 */
function caseStatements(caseNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const value = caseNode.childForFieldName('value');
    return childStatements(caseNode).filter(child => !(value && child.id === value.id));
}

/**
 * プリプロセッサの条件分岐に属する文を取り出します。
 *
 * 条件（`#if` の式、`#ifdef` の名前）と、`#elif` `#else` 以降は含めません。
 *
 * @param node `preproc_if` / `preproc_ifdef` / `preproc_else` / `preproc_elif` ノード
 * @returns その条件に属する文
 */
function preprocBody(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const condition = node.childForFieldName('condition');
    const name = node.childForFieldName('name');
    const alternative = node.childForFieldName('alternative');

    return childStatements(node).filter(child => {
        if (condition && child.id === condition.id) {
            return false;
        }
        if (name && child.id === name.id) {
            return false;
        }
        return !(alternative && child.id === alternative.id);
    });
}

/**
 * ラベルに続く文を取り出します。
 *
 * `done: *out = n;` のラベル名を除いた部分が対象です。
 *
 * @param statement `labeled_statement` ノード
 * @returns ラベルに続く文
 */
function labeledStatements(statement: Parser.SyntaxNode): Parser.SyntaxNode[] {
    const name = statement.childForFieldName('label');
    return childStatements(statement).filter(child => !(name && child.id === name.id));
}

/**
 * `else` の中身を取り出します。
 *
 * `else if` の場合は `if` の文そのものを返します。
 *
 * @param alternative `else_clause` ノード（無い場合は null）
 * @returns 中身のノード。無い場合は null
 */
function elseBody(alternative: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
    if (!alternative) {
        return null;
    }
    if (alternative.type !== 'else_clause') {
        return alternative;
    }
    const statements = childStatements(alternative);
    return statements.length > 0 ? statements[0] : null;
}

/**
 * 流れを移す文を、図の要素へ変換します。
 *
 * @param statement `return` / `break` / `continue` / `goto` のノード
 * @returns 飛び先の要素
 */
function buildJump(statement: Parser.SyntaxNode): FlowJump {
    const kind = statement.type === 'return_statement' ? 'return'
        : statement.type === 'break_statement' ? 'break'
            : statement.type === 'continue_statement' ? 'continue' : 'goto';

    const jump: FlowJump = {
        kind,
        line: statement.startPosition.row,
        text: label(statement)
    };

    if (kind === 'goto') {
        const target = statement.childForFieldName('label');
        if (target) {
            jump.target = target.text;
        }
    }

    return jump;
}

/**
 * 連続する文を、1つの処理ブロックへまとめます。
 *
 * @param statements まとめる文
 * @returns 処理ブロック
 */
function toBlock(statements: Parser.SyntaxNode[]): FlowBlock {
    const lines = statements.slice(0, MAX_BLOCK_LINES).map(label);
    return {
        kind: 'block',
        line: statements[0].startPosition.row,
        lines,
        omittedLines: Math.max(0, statements.length - MAX_BLOCK_LINES)
    };
}

/**
 * 流れがその場で終わるか（後続へ進まないか）を判定します。
 *
 * `switch` の `case` が次の `case` へ流れ落ちるかの判定に使います。
 *
 * @param nodes 対象の流れ
 * @returns 最後が `return` `break` `goto` `continue` の場合は true
 */
function endsWithJump(nodes: FlowNode[]): boolean {
    const last = nodes[nodes.length - 1];
    return last !== undefined && last.kind !== 'block' && last.kind !== 'branch'
        && last.kind !== 'loop' && last.kind !== 'switch' && last.kind !== 'label';
}

/**
 * 条件の記述を取り出します（外側の括弧は取り除きます）。
 *
 * @param statement 条件を持つノード
 * @returns 条件の記述。条件が無い場合は空文字列
 */
function conditionText(statement: Parser.SyntaxNode): string {
    const condition = statement.childForFieldName('condition');
    if (!condition) {
        return '';
    }
    const text = label(condition);
    return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1).trim() : text;
}

/**
 * プリプロセッサの条件の記述を組み立てます。
 *
 * @param statement `preproc_if` / `preproc_ifdef` / `preproc_elif` ノード
 * @returns `#ifdef XXX` のような記述
 */
function preprocConditionText(statement: Parser.SyntaxNode): string {
    const directive = statement.child(0);
    const name = statement.childForFieldName('name') || statement.childForFieldName('condition');
    const keyword = directive ? directive.text : '#if';
    return truncate(`${keyword} ${name ? collapse(textWithoutComments(name)) : ''}`.trim());
}

/**
 * ノードの記述を、表示用の1行の文字列にします。
 *
 * コメントと余分な空白を取り除き、長すぎる場合は末尾を省略します。
 *
 * @param node 対象のノード
 * @returns 表示用の文字列
 */
function label(node: Parser.SyntaxNode): string {
    return truncate(collapse(textWithoutComments(node)));
}

/**
 * ノードの記述から、コメントを取り除きます。
 *
 * コメントの範囲を空白に置き換えるため、前後の字句がつながることはありません。
 *
 * @param node 対象のノード
 * @returns コメントを除いた記述
 */
function textWithoutComments(node: Parser.SyntaxNode): string {
    const comments = node.descendantsOfType('comment');
    if (comments.length === 0) {
        return node.text;
    }

    const characters = Array.from(node.text);
    comments.forEach(comment => {
        const from = comment.startIndex - node.startIndex;
        const to = comment.endIndex - node.startIndex;
        for (let i = from; i < to && i < characters.length; i++) {
            characters[i] = ' ';
        }
    });
    return characters.join('');
}

/**
 * 連続する空白を1つにまとめ、前後の空白を取り除きます。
 *
 * @param text 対象のテキスト
 * @returns 整形後のテキスト
 */
function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * 長すぎる文字列の末尾を省略します。
 *
 * @param text 対象のテキスト
 * @returns 省略後のテキスト
 */
function truncate(text: string): string {
    return text.length > MAX_LABEL_LENGTH ? text.slice(0, MAX_LABEL_LENGTH - 1) + '…' : text;
}
