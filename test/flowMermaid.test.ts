/**
 * Mermaid 記法の生成（flowMermaid.ts）のテストです。
 *
 * 生成したテキストは外部のツールで図として解釈されるため、
 * 要素のつながりと、記法として解釈される文字の扱いを検証します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { flowOf } from './support/parse';
import { toMermaid } from '../src/flowMermaid';

/**
 * ソースから Mermaid のテキストを生成します。
 *
 * @param body 関数本体の中身
 * @param returnType 戻り値の型
 * @returns Mermaid のテキスト
 */
async function mermaidOf(body: string, returnType: string = 'void'): Promise<string> {
    const flow = await flowOf(`
${returnType} work(int n)
{
${body}
}
`, `${returnType} work(`);
    return toMermaid(flow);
}

/**
 * 指定した文字を含む要素のIDを取り出します。
 *
 * @param mermaid Mermaid のテキスト
 * @param text 要素に含まれる文字
 * @returns 要素ID
 */
function idOf(mermaid: string, text: string): string {
    const line = mermaid.split('\n').find(l => l.includes(text) && !l.includes('-->'));
    assert.ok(line, `「${text}」を含む要素があること`);
    return line.trim().split(/[[({]/)[0];
}

describe('toMermaid: 全体の構成 (v3.7.0)', () => {
    test('flowchart TD で始まり、開始と終了を持つ (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    a = 1;');
        assert.ok(mermaid.startsWith('flowchart TD\n'), '先頭が flowchart TD であること');
        assert.ok(mermaid.includes('(["work"])'), '関数名の開始ノードがあること');
        assert.ok(mermaid.includes('fin(["終了"])'), '終了ノードがあること');
        assert.ok(mermaid.trimEnd().split('\n').pop()!.includes('--> fin'), '最後に終了へつながること');
    });

    test('構文エラーがある場合は注意をコメントで添える (v3.7.0)', async () => {
        const flow = await flowOf(`
#define FOREVER for(;;)
void work(void)
{
    FOREVER { a = 1; }
}
`, 'void work(');
        const mermaid = toMermaid(flow);
        assert.ok(mermaid.startsWith('%% 注意:'), '先頭に注意のコメントがあること');
        assert.ok(mermaid.includes('flowchart TD'), '図の定義も含むこと');
    });

    test('要素数の上限に達した場合は省略の要素を置く (v3.7.0)', async () => {
        const flow = await flowOf(`
void work(int n)
{
    if (n == 1) { a = 1; }
    if (n == 2) { b = 2; }
    if (n == 3) { c = 3; }
}
`, 'void work(', { maxNodes: 3 });
        const mermaid = toMermaid(flow);
        assert.ok(mermaid.includes('以下省略'), '省略を示す要素があること');
    });
});

describe('toMermaid: 分岐とループ (v3.7.0)', () => {
    test('分岐は菱形になり、真と偽の線が出る (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    if (n) { a = 1; } else { b = 2; }');
        const id = idOf(mermaid, '{"n"}');
        assert.ok(mermaid.includes(`${id} -->|"真"|`), '真の線があること');
        assert.ok(mermaid.includes(`${id} -->|"偽"|`), '偽の線があること');
    });

    test('else が無い分岐は、偽の線が後続へつながる (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    if (n) { a = 1; }\n    b = 2;');
        const branch = idOf(mermaid, '{"n"}');
        const after = idOf(mermaid, '"b = 2;"');
        assert.ok(mermaid.includes(`${branch} -->|"偽"| ${after}`), '偽の線が後続へつながること');
    });

    test('while はループの戻り線を持つ (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    while (n > 0) { n--; }');
        const condition = idOf(mermaid, '{"n #gt; 0"}');
        const body = idOf(mermaid, '"n--;"');
        assert.ok(mermaid.includes(`${condition} -->|"真"| ${body}`), '条件から本体へ');
        assert.ok(mermaid.includes(`${body} --> ${condition}`), '本体から条件へ戻ること');
    });

    test('for は初期化を手前に、更新を本体の後ろに置く (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    for (i = 0; i < n; i++) { a = i; }');
        const initializer = idOf(mermaid, '"i = 0"');
        const condition = idOf(mermaid, '{"i #lt; n"}');
        const body = idOf(mermaid, '"a = i;"');
        const update = idOf(mermaid, '"i++"');
        assert.ok(mermaid.includes(`${initializer} --> ${condition}`), '初期化から条件へ');
        assert.ok(mermaid.includes(`${body} --> ${update}`), '本体から更新へ');
        assert.ok(mermaid.includes(`${update} --> ${condition}`), '更新から条件へ戻ること');
    });

    test('do-while は本体を先に置き、条件から本体へ戻る (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    do { n++; } while (n < 5);');
        const body = idOf(mermaid, '"n++;"');
        const condition = idOf(mermaid, '{"n #lt; 5"}');
        assert.ok(mermaid.includes(`${body} --> ${condition}`), '本体から条件へ');
        assert.ok(mermaid.includes(`${condition} -->|"真"| ${body}`), '条件から本体へ戻ること');
    });

    test('break はループを抜け、continue は条件へ戻る (v3.7.0)', async () => {
        const mermaid = await mermaidOf(`    while (n) {
        if (n == 1) { continue; }
        if (n == 2) { break; }
    }
    a = 1;`);
        const condition = idOf(mermaid, '{"n"}');
        const continueBranch = idOf(mermaid, '{"n == 1"}');
        const breakBranch = idOf(mermaid, '{"n == 2"}');
        const after = idOf(mermaid, '"a = 1;"');
        assert.ok(mermaid.includes(`${continueBranch} -->|"真"| ${condition}`), 'continue が条件へ戻ること');
        assert.ok(mermaid.includes(`${breakBranch} -->|"真"| ${after}`), 'break がループの外へ出ること');
    });
});

describe('toMermaid: 多分岐 (v3.7.0)', () => {
    test('case ごとに線を出し、フォールスルーは次の case へつなぐ (v3.7.0)', async () => {
        const mermaid = await mermaidOf(`    switch (n) {
        case 1:
        case 2:
            a = 1;
            break;
        default:
            b = 2;
    }`);
        const condition = idOf(mermaid, '{"n"}');
        const first = idOf(mermaid, '"a = 1;"');
        assert.ok(mermaid.includes(`${condition} -->|"case 1"| ${first}`), 'case 1 が case 2 の処理へ流れること');
        assert.ok(mermaid.includes(`${condition} -->|"case 2"| ${first}`), 'case 2 の線があること');
        assert.ok(mermaid.includes(`${condition} -->|"default"|`), 'default の線があること');
    });

    test('default が無い場合は該当なしの線を出す (v3.7.0)', async () => {
        const mermaid = await mermaidOf(`    switch (n) {
        case 1:
            a = 1;
            break;
    }
    b = 2;`);
        const condition = idOf(mermaid, '{"n"}');
        const after = idOf(mermaid, '"b = 2;"');
        assert.ok(mermaid.includes(`${condition} -->|"該当なし"| ${after}`), '該当なしの線があること');
    });
});

describe('toMermaid: 流れを移す文 (v3.7.0)', () => {
    test('return は終了へつながる (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    return n;', 'int');
        const id = idOf(mermaid, '"return n;"');
        assert.ok(mermaid.includes(`${id} --> fin`), '終了へつながること');
    });

    test('goto はラベルの要素へつながる (v3.7.0)', async () => {
        const mermaid = await mermaidOf(`    if (n) { goto done; }
    a = 1;
done:
    b = 2;`);
        const branch = idOf(mermaid, '{"n"}');
        assert.ok(mermaid.includes('lbl1("done:")'), 'ラベルの要素があること');
        assert.ok(mermaid.includes(`${branch} -->|"真"| lbl1`), 'goto がラベルへつながること');
    });
});

describe('toMermaid: 記法として解釈される文字 (v3.7.0)', () => {
    test('比較演算子とアンパサンドを実体参照にする (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    if (a > b && c < d) { x = 1; }');
        assert.ok(mermaid.includes('{"a #gt; b #amp;#amp; c #lt; d"}'), `変換されること: ${mermaid}`);
    });

    test('引用符と # を実体参照にする (v3.7.0)', async () => {
        const mermaid = await mermaidOf(`    print("hi");
#ifdef USE_X
    a = 1;
#endif`);
        assert.ok(mermaid.includes('#quot;hi#quot;'), '引用符が変換されること');
        assert.ok(mermaid.includes('#35;ifdef USE_X'), '# が変換されること');
    });

    test('複数行の処理は改行の指定を残す (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    a = 1;\n    b = 2;');
        assert.ok(mermaid.includes('"a = 1;<br/>b = 2;"'), `改行の指定が残ること: ${mermaid}`);
    });

    test('省略した行数を添える (v3.7.0)', async () => {
        const mermaid = await mermaidOf('    a = 1;\n    b = 2;\n    c = 3;\n    d = 4;');
        assert.ok(mermaid.includes('<br/>ほか1行"'), `省略の表示が入ること: ${mermaid}`);
    });
});
