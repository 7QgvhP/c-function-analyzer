/**
 * 関数の構造の組み立て（flowModel.ts）のテストです。
 *
 * 実際のCソースを解析し、分岐・ループ・多分岐などが図にしやすい形へ
 * 取り出せているかを検証します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { flowOf } from './support/parse';
import { FlowBranch, FlowLoop, FlowNode, FlowSwitch } from '../src/flowModel';

/**
 * 指定した位置の要素を、種別を確かめたうえで取り出します。
 *
 * @param nodes 図の要素の並び
 * @param index 位置
 * @param kind 期待する種別
 * @returns その要素
 */
function at<T extends FlowNode>(nodes: FlowNode[], index: number, kind: FlowNode['kind']): T {
    const node = nodes[index];
    assert.ok(node, `要素 ${index} が存在すること（実際: ${nodes.map(n => n.kind).join(', ')}）`);
    assert.equal(node.kind, kind);
    return node as T;
}

describe('buildFlowchart: 処理のまとめ方 (v3.7.0)', () => {
    test('連続する文を1つの処理にまとめる (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(void)
{
    a = 1;
    b = 2;
}
`, 'void work(');
        assert.equal(flow.nodes.length, 1);
        const block = at<any>(flow.nodes, 0, 'block');
        assert.deepEqual(block.lines, ['a = 1;', 'b = 2;']);
        assert.equal(block.omittedLines, 0);
    });

    test('3行を超える場合は件数だけ示す (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(void)
{
    a = 1;
    b = 2;
    c = 3;
    d = 4;
    e = 5;
}
`, 'void work(');
        const block = at<any>(flow.nodes, 0, 'block');
        assert.deepEqual(block.lines, ['a = 1;', 'b = 2;', 'c = 3;']);
        assert.equal(block.omittedLines, 2);
    });

    test('コメントは取り除く (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(void)
{
    a = 1;   /* 初期化する */
}
`, 'void work(');
        const block = at<any>(flow.nodes, 0, 'block');
        assert.deepEqual(block.lines, ['a = 1;']);
    });

    test('長い記述は末尾を省略する (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(void)
{
    if (aaaaaaaaaa > bbbbbbbbbb && cccccccccc < dddddddddd && eeeeeeeeee) { a = 1; }
}
`, 'void work(');
        const branch = at<FlowBranch>(flow.nodes, 0, 'branch');
        assert.ok(branch.condition.endsWith('…'), `末尾が省略されること: ${branch.condition}`);
        assert.equal(branch.condition.length, 40);
    });

    test('関数名と開始行を記録する (v3.7.0)', async () => {
        const flow = await flowOf(`
int calc(int n)
{
    return n;
}
`, 'int calc(');
        assert.equal(flow.functionName, 'calc');
        assert.equal(flow.startLine, 1);
    });
});

describe('buildFlowchart: 分岐 (v3.7.0)', () => {
    test('条件と真偽それぞれの流れを取り出す (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    if (n > 0) { a = 1; } else { b = 2; }
}
`, 'void work(');
        const branch = at<FlowBranch>(flow.nodes, 0, 'branch');
        assert.equal(branch.condition, 'n > 0');
        assert.equal(branch.preprocessor, false);
        assert.deepEqual((branch.consequence[0] as any).lines, ['a = 1;']);
        assert.deepEqual((branch.alternative[0] as any).lines, ['b = 2;']);
    });

    test('else if は偽の側の入れ子になる (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    if (n > 0) { a = 1; } else if (n == 0) { b = 2; } else { c = 3; }
}
`, 'void work(');
        const outer = at<FlowBranch>(flow.nodes, 0, 'branch');
        const inner = at<FlowBranch>(outer.alternative, 0, 'branch');
        assert.equal(inner.condition, 'n == 0');
        assert.deepEqual((inner.alternative[0] as any).lines, ['c = 3;']);
    });

    test('else が無い場合は偽の側が空になる (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    if (n) { a = 1; }
}
`, 'void work(');
        assert.deepEqual(at<FlowBranch>(flow.nodes, 0, 'branch').alternative, []);
    });

    test('波括弧の無い本体も扱える (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    if (n) a = 1;
}
`, 'void work(');
        const branch = at<FlowBranch>(flow.nodes, 0, 'branch');
        assert.deepEqual((branch.consequence[0] as any).lines, ['a = 1;']);
    });

    test('プリプロセッサの条件分岐も分岐として扱う (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(void)
{
#ifdef USE_EXTRA
    a = 1;
#else
    b = 2;
#endif
}
`, 'void work(');
        const branch = at<FlowBranch>(flow.nodes, 0, 'branch');
        assert.equal(branch.preprocessor, true);
        assert.equal(branch.condition, '#ifdef USE_EXTRA');
        assert.deepEqual((branch.consequence[0] as any).lines, ['a = 1;']);
        assert.deepEqual((branch.alternative[0] as any).lines, ['b = 2;']);
    });

    test('#elif は偽の側の入れ子になる (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(void)
{
#if (MODE == 1)
    a = 1;
#elif (MODE == 2)
    b = 2;
#else
    c = 3;
#endif
}
`, 'void work(');
        const outer = at<FlowBranch>(flow.nodes, 0, 'branch');
        assert.equal(outer.condition, '#if (MODE == 1)');
        const inner = at<FlowBranch>(outer.alternative, 0, 'branch');
        assert.equal(inner.condition, '#elif (MODE == 2)');
        assert.deepEqual((inner.alternative[0] as any).lines, ['c = 3;']);
    });
});

describe('buildFlowchart: ループ (v3.7.0)', () => {
    test('while の条件と本体を取り出す (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    while (n > 0) { n--; }
}
`, 'void work(');
        const loop = at<FlowLoop>(flow.nodes, 0, 'loop');
        assert.equal(loop.style, 'while');
        assert.equal(loop.condition, 'n > 0');
        assert.deepEqual((loop.body[0] as any).lines, ['n--;']);
    });

    test('for の初期化と更新を取り出す (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    for (i = 0; i < n; i++) { a = i; }
}
`, 'void work(');
        const loop = at<FlowLoop>(flow.nodes, 0, 'loop');
        assert.equal(loop.style, 'for');
        assert.equal(loop.condition, 'i < n');
        assert.equal(loop.initializer, 'i = 0');
        assert.equal(loop.update, 'i++');
    });

    test('do-while を区別する (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    do { n++; } while (n < 5);
}
`, 'void work(');
        const loop = at<FlowLoop>(flow.nodes, 0, 'loop');
        assert.equal(loop.style, 'do');
        assert.equal(loop.condition, 'n < 5');
    });

    test('break と continue を取り出す (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    while (n) {
        if (n == 1) { continue; }
        if (n == 2) { break; }
    }
}
`, 'void work(');
        const loop = at<FlowLoop>(flow.nodes, 0, 'loop');
        const first = at<FlowBranch>(loop.body, 0, 'branch');
        const second = at<FlowBranch>(loop.body, 1, 'branch');
        assert.equal(first.consequence[0].kind, 'continue');
        assert.equal(second.consequence[0].kind, 'break');
    });
});

describe('buildFlowchart: 多分岐 (v3.7.0)', () => {
    test('case ごとの流れと、次へ流れ落ちるかを取り出す (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    switch (n) {
        case 1:
        case 2:
            a = 1;
            break;
        default:
            b = 2;
    }
}
`, 'void work(');
        const node = at<FlowSwitch>(flow.nodes, 0, 'switch');
        assert.equal(node.condition, 'n');
        assert.deepEqual(node.cases.map(c => c.label), ['case 1', 'case 2', 'default']);
        assert.equal(node.cases[0].fallsThrough, true, '中身が無い case は次へ流れること');
        assert.equal(node.cases[1].fallsThrough, false, 'break で終わる case は流れないこと');
        assert.equal(node.cases[2].fallsThrough, true, 'break が無い default は流れること');
    });

    test('return で終わる case は次へ流れない (v3.7.0)', async () => {
        const flow = await flowOf(`
int work(int n)
{
    switch (n) {
        case 1:
            return 1;
        default:
            return 0;
    }
}
`, 'int work(');
        const node = at<FlowSwitch>(flow.nodes, 0, 'switch');
        assert.equal(node.cases[0].fallsThrough, false);
    });
});

describe('buildFlowchart: 流れを移す文 (v3.7.0)', () => {
    test('return の記述を保つ (v3.7.0)', async () => {
        const flow = await flowOf(`
int work(void)
{
    return ret;
}
`, 'int work(');
        const node = at<any>(flow.nodes, 0, 'return');
        assert.equal(node.text, 'return ret;');
    });

    test('goto の飛び先と、ラベルに続く文を取り出す (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    if (n) { goto done; }
done:
    a = 1;
}
`, 'void work(');
        const branch = at<FlowBranch>(flow.nodes, 0, 'branch');
        const jump = at<any>(branch.consequence, 0, 'goto');
        assert.equal(jump.target, 'done');

        const label = at<any>(flow.nodes, 1, 'label');
        assert.equal(label.name, 'done');
        assert.deepEqual((flow.nodes[2] as any).lines, ['a = 1;'], 'ラベルに続く文が残ること');
    });
});

describe('buildFlowchart: 上限と注意 (v3.7.0)', () => {
    test('要素数の上限に達したら省略する (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    if (n == 1) { a = 1; }
    if (n == 2) { b = 2; }
    if (n == 3) { c = 3; }
}
`, 'void work(', { maxNodes: 3 });
        assert.equal(flow.truncated, true);
        assert.ok(flow.nodes.length <= 3);
    });

    test('上限に達しなければ省略しない (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(void)
{
    a = 1;
}
`, 'void work(');
        assert.equal(flow.truncated, false);
    });

    test('マクロに隠れた制御構造は構文エラーとして検出する (v3.7.0)', async () => {
        const flow = await flowOf(`
#define FOREVER for(;;)
void work(void)
{
    FOREVER {
        a = 1;
    }
}
`, 'void work(');
        assert.equal(flow.hasParseError, true, 'ループとして認識できないことを知らせること');
    });

    test('通常の関数では構文エラーを報告しない (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(void)
{
    a = 1;
}
`, 'void work(');
        assert.equal(flow.hasParseError, false);
    });
});
