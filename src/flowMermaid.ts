/**
 * 関数の構造から、Mermaid のフローチャート記法を生成する処理です。
 *
 * 生成したテキストは、GitHub・Notion・mermaid.live など Mermaid に対応した場所へ
 * 貼り付けると図として表示されます。
 *
 * 流れのつなぎ方は、要素ごとに「入ってくる線」を受け取り「出ていく線」を返す形で
 * 組み立てます。分岐の合流やループの戻りは、この出口の集合として扱います。
 *
 * VS Code API には触れないため、ヘッドレス環境でテストできます。
 */
import {
    FlowBranch,
    Flowchart,
    FlowLoop,
    FlowNode,
    FlowSwitch
} from './flowModel';

/** 図から出ていく線（次の要素へつなぐ線） */
interface Exit {
    /** 線の起点となる要素のID */
    from: string;
    /** 線に添える文字（`真` `偽` `case 1` など） */
    label?: string;
}

/** ループ・`switch` の内側で `break` `continue` の飛び先を伝えるための情報 */
interface JumpContext {
    /** `continue` の飛び先（ループの条件）。ループの外では未設定 */
    continueTo?: string;
    /** `break` でループ・`switch` を抜ける線の集まり。外では未設定 */
    breakExits?: Exit[];
}

/**
 * 関数の構造から Mermaid のフローチャート記法を生成します。
 *
 * @param flow 関数の構造
 * @returns Mermaid のテキスト
 */
export function toMermaid(flow: Flowchart): string {
    return new MermaidBuilder(flow).build();
}

/** Mermaid のテキストを組み立てる処理 */
class MermaidBuilder {
    /** 要素の定義（`n1["..."]` の並び） */
    private readonly definitions: string[] = [];

    /** 線の定義（`n1 --> n2` の並び） */
    private readonly edges: string[] = [];

    /** 要素IDの連番 */
    private counter = 0;

    /** `goto` の飛び先ラベル名 → 要素ID */
    private readonly labelIds = new Map<string, string>();

    /** 定義済みのラベルの要素ID */
    private readonly definedLabels = new Set<string>();

    /** 終了の要素ID */
    private readonly endId = 'fin';

    /** 直後に作られる要素のIDを控えるか（`do-while` の戻り先を知るために使う） */
    private capturing = false;

    /** 控えた要素ID */
    private captured: string | null = null;

    /**
     * @param flow 関数の構造
     */
    constructor(private readonly flow: Flowchart) {}

    /**
     * Mermaid のテキストを組み立てます。
     *
     * @returns Mermaid のテキスト
     */
    public build(): string {
        collectLabels(this.flow.nodes, name => this.reserveLabel(name));

        const startId = this.define('([' + quote(this.flow.functionName) + '])');
        const exits = this.emitAll(this.flow.nodes, [{ from: startId }], {});

        if (this.flow.truncated) {
            const omitted = this.define('[' + quote('以下省略（要素数の上限に達しました）') + ']');
            this.connect(exits, omitted);
            this.connect([{ from: omitted }], this.endId);
        } else {
            this.connect(exits, this.endId);
        }

        this.definitions.push(`    ${this.endId}([${quote('終了')}])`);

        const header = ['flowchart TD'];
        if (this.flow.hasParseError) {
            header.unshift(
                '%% 注意: 解析時に構文エラーがあるため、一部の制御構造が図に含まれていない可能性があります',
                '%% （制御構造をマクロで隠している場合などに起こります）'
            );
        }
        return [...header, ...this.definitions, ...this.edges].join('\n') + '\n';
    }

    /**
     * 流れの並びを順につなぎます。
     *
     * @param nodes 図の要素の並び
     * @param incoming 入ってくる線
     * @param context `break` `continue` の飛び先
     * @returns 出ていく線
     */
    private emitAll(nodes: FlowNode[], incoming: Exit[], context: JumpContext): Exit[] {
        let current = incoming;
        for (const node of nodes) {
            current = this.emitNode(node, current, context);
        }
        return current;
    }

    /**
     * 要素1つ分を図に加えます。
     *
     * @param node 図の要素
     * @param incoming 入ってくる線
     * @param context `break` `continue` の飛び先
     * @returns 出ていく線
     */
    private emitNode(node: FlowNode, incoming: Exit[], context: JumpContext): Exit[] {
        switch (node.kind) {
            case 'block': {
                const lines = [...node.lines];
                if (node.omittedLines > 0) {
                    lines.push(`ほか${node.omittedLines}行`);
                }
                const id = this.define('[' + quoteLines(lines) + ']');
                this.connect(incoming, id);
                return [{ from: id }];
            }
            case 'branch':
                return this.emitBranch(node, incoming, context);
            case 'loop':
                return this.emitLoop(node, incoming, context);
            case 'switch':
                return this.emitSwitch(node, incoming, context);
            case 'return': {
                const id = this.define('[' + quote(node.text) + ']');
                this.connect(incoming, id);
                this.connect([{ from: id }], this.endId);
                return [];
            }
            case 'break':
                // ループ・switch を抜ける線として、外側へ渡す
                (context.breakExits ?? []).push(...incoming);
                return [];
            case 'continue':
                if (context.continueTo) {
                    this.connect(incoming, context.continueTo);
                }
                return [];
            case 'goto': {
                const target = node.target ? this.labelIds.get(node.target) : undefined;
                if (target) {
                    this.connect(incoming, target);
                }
                return [];
            }
            case 'label': {
                const id = this.reserveLabel(node.name);
                this.defineLabel(id, node.name);
                this.connect(incoming, id);
                return [{ from: id }];
            }
        }
    }

    /**
     * 分岐を図に加えます。
     *
     * @param node 分岐の要素
     * @param incoming 入ってくる線
     * @param context `break` `continue` の飛び先
     * @returns 出ていく線
     */
    private emitBranch(node: FlowBranch, incoming: Exit[], context: JumpContext): Exit[] {
        // 条件を持たない入れ子（単なる `{ ... }`）は、そのまま並べる
        if (!node.condition) {
            return this.emitAll(node.consequence, incoming, context);
        }

        const id = this.define('{' + quote(node.condition) + '}');
        this.connect(incoming, id);

        const consequence = this.emitAll(node.consequence, [{ from: id, label: '真' }], context);
        const alternative = node.alternative.length > 0
            ? this.emitAll(node.alternative, [{ from: id, label: '偽' }], context)
            : [{ from: id, label: '偽' }];

        return [...consequence, ...alternative];
    }

    /**
     * ループを図に加えます。
     *
     * `while` と `for` は条件を先に、`do-while` は本体を先に置きます。
     *
     * @param node ループの要素
     * @param incoming 入ってくる線
     * @param context 外側の `break` `continue` の飛び先
     * @returns 出ていく線
     */
    private emitLoop(node: FlowLoop, incoming: Exit[], context: JumpContext): Exit[] {
        const breakExits: Exit[] = [];
        let entry = incoming;

        // for の初期化は、条件の手前に置く
        if (node.initializer) {
            const id = this.define('[' + quote(node.initializer) + ']');
            this.connect(entry, id);
            entry = [{ from: id }];
        }

        if (node.style === 'do') {
            // 本体を先に置き、その後ろの条件から本体の先頭へ戻す
            const bodyEntry = this.startCapture();
            const bodyExits = this.emitAll(node.body, entry, { continueTo: undefined, breakExits });
            const bodyEntryId = this.endCapture(bodyEntry);

            const conditionId = this.define('{' + quote(node.condition || '繰り返し') + '}');
            this.connect(bodyExits, conditionId);
            if (bodyEntryId) {
                this.edges.push(edge(conditionId, bodyEntryId, '真'));
            }
            return [{ from: conditionId, label: '偽' }, ...breakExits];
        }

        const conditionId = this.define('{' + quote(node.condition || '繰り返し') + '}');
        this.connect(entry, conditionId);

        const bodyExits = this.emitAll(node.body, [{ from: conditionId, label: '真' }], {
            continueTo: conditionId,
            breakExits
        });

        // for の更新は、本体の後ろに置いてから条件へ戻す
        if (node.update) {
            const updateId = this.define('[' + quote(node.update) + ']');
            this.connect(bodyExits, updateId);
            this.connect([{ from: updateId }], conditionId);
        } else {
            this.connect(bodyExits, conditionId);
        }

        return [{ from: conditionId, label: '偽' }, ...breakExits];
    }

    /**
     * `switch` を図に加えます。
     *
     * `break` で終わっていない `case` は、次の `case` へ線をつなぎます（フォールスルー）。
     *
     * @param node 多分岐の要素
     * @param incoming 入ってくる線
     * @param context 外側の `break` `continue` の飛び先
     * @returns 出ていく線
     */
    private emitSwitch(node: FlowSwitch, incoming: Exit[], context: JumpContext): Exit[] {
        const id = this.define('{' + quote(node.condition) + '}');
        this.connect(incoming, id);

        const breakExits: Exit[] = [];
        /** 直前の `case` から流れ落ちてくる線 */
        let fallThrough: Exit[] = [];

        node.cases.forEach(item => {
            const entry: Exit[] = [{ from: id, label: item.label }, ...fallThrough];
            const exits = this.emitAll(item.body, entry, {
                continueTo: context.continueTo,
                breakExits
            });
            fallThrough = item.fallsThrough ? exits : [];
        });

        const exits = [...fallThrough, ...breakExits];
        // default が無い場合は、どの case にも当たらない経路がある
        if (!node.cases.some(item => item.label === 'default')) {
            exits.push({ from: id, label: '該当なし' });
        }
        return exits;
    }

    /**
     * 要素を定義して、そのIDを返します。
     *
     * @param shape `["..."]` のような形の定義
     * @returns 要素ID
     */
    private define(shape: string): string {
        this.counter++;
        const id = `n${this.counter}`;
        this.definitions.push(`    ${id}${shape}`);
        if (this.capturing && this.captured === null) {
            this.captured = id;
        }
        return id;
    }

    /**
     * `goto` の飛び先ラベルに、要素IDを割り当てます。
     *
     * @param name ラベル名
     * @returns 要素ID
     */
    private reserveLabel(name: string): string {
        const existing = this.labelIds.get(name);
        if (existing) {
            return existing;
        }
        const id = `lbl${this.labelIds.size + 1}`;
        this.labelIds.set(name, id);
        return id;
    }

    /**
     * ラベルの要素を定義します（同じラベルは一度だけ定義します）。
     *
     * @param id 要素ID
     * @param name ラベル名
     */
    private defineLabel(id: string, name: string): void {
        if (this.definedLabels.has(id)) {
            return;
        }
        this.definedLabels.add(id);
        this.definitions.push(`    ${id}(${quote(name + ':')})`);
    }

    /**
     * 入ってくる線を、指定した要素へつなぎます。
     *
     * @param incoming 入ってくる線
     * @param to つなぎ先の要素ID
     */
    private connect(incoming: Exit[], to: string): void {
        incoming.forEach(exit => this.edges.push(edge(exit.from, to, exit.label)));
    }

    /**
     * 次に作られる要素のIDを控え始めます（`do-while` の戻り先に使います）。
     *
     * @returns 控える前の状態
     */
    private startCapture(): { capturing: boolean; captured: string | null } {
        const previous = { capturing: this.capturing, captured: this.captured };
        this.capturing = true;
        this.captured = null;
        return previous;
    }

    /**
     * 控えた要素IDを取り出し、元の状態へ戻します。
     *
     * @param previous 控える前の状態
     * @returns 控えた要素ID。無ければ null
     */
    private endCapture(previous: { capturing: boolean; captured: string | null }): string | null {
        const captured = this.captured;
        this.capturing = previous.capturing;
        this.captured = previous.captured;
        return captured;
    }
}

/**
 * 流れの中にあるラベルを集めて、先に要素IDを割り当てます。
 *
 * `goto` が、まだ現れていないラベルを指す場合に備えます。
 *
 * @param nodes 図の要素の並び
 * @param reserve ラベル名に要素IDを割り当てる処理
 */
function collectLabels(nodes: FlowNode[], reserve: (name: string) => string): void {
    nodes.forEach(node => {
        switch (node.kind) {
            case 'label':
                reserve(node.name);
                break;
            case 'branch':
                collectLabels(node.consequence, reserve);
                collectLabels(node.alternative, reserve);
                break;
            case 'loop':
                collectLabels(node.body, reserve);
                break;
            case 'switch':
                node.cases.forEach(item => collectLabels(item.body, reserve));
                break;
            default:
                break;
        }
    });
}

/**
 * 線の定義を作ります。
 *
 * @param from 起点の要素ID
 * @param to 終点の要素ID
 * @param label 線に添える文字
 * @returns 線の定義
 */
function edge(from: string, to: string, label?: string): string {
    return label ? `    ${from} -->|${quote(label)}| ${to}` : `    ${from} --> ${to}`;
}

/**
 * 複数行の文字列を、Mermaid のラベル（改行付き）にします。
 *
 * 改行の指定（`<br/>`）は記法として残す必要があるため、各行を変換してから連結します。
 *
 * @param lines 行の一覧
 * @returns 引用符で囲んだラベル
 */
function quoteLines(lines: string[]): string {
    if (lines.length === 0) {
        return quote('（処理なし）');
    }
    return `"${lines.map(escapeLabel).join('<br/>')}"`;
}

/**
 * 文字列を Mermaid のラベルとして安全な形にします。
 *
 * C言語のコードには Mermaid が記法として解釈する文字（`"` `#` `<` `>` `&`）が
 * 含まれるため、実体参照へ置き換えたうえで引用符で囲みます。
 *
 * @param text 対象のテキスト
 * @returns 引用符で囲んだラベル
 */
function quote(text: string): string {
    return `"${escapeLabel(text)}"`;
}

/**
 * Mermaid が記法として解釈する文字を、実体参照へ置き換えます。
 *
 * @param text 対象のテキスト
 * @returns 置き換え後のテキスト（引用符では囲みません）
 */
function escapeLabel(text: string): string {
    return text
        .replace(/#/g, '#35;')
        .replace(/&/g, '#amp;')
        .replace(/"/g, '#quot;')
        .replace(/</g, '#lt;')
        .replace(/>/g, '#gt;');
}
