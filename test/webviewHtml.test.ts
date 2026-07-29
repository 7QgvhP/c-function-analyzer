/**
 * webviewHtml.ts の HTML 生成に対するテストです。
 *
 * Webview は VS Code 上でしか目視確認できないため、
 * 生成される HTML の構造・エスケープ・データ属性をここで機械的に検証します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisResult } from '../src/analyzer';
import { createNonce, escapeHtml, renderAnalysisHtml } from '../src/webviewHtml';

/**
 * テスト用の解析結果を生成します。
 *
 * @param overrides 上書きしたいフィールド
 * @returns 解析結果
 */
function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
    return {
        functionName: 'sample',
        returnType: 'int',
        inputs: [],
        outputs: [],
        internalVariables: [],
        calledFunctions: [],
        macroVariables: [],
        macroFunctions: [],
        startLine: 0,
        endLine: 10,
        ...overrides
    };
}

/** buildCopyText へ渡す `.variable-item` 相当のダミー要素 */
interface FakeItem {
    getAttribute(name: string): string | null;
}

/**
 * データ属性のみを持つダミーの項目要素を作ります。
 *
 * @param type data-type の値
 * @param name data-name の値
 * @returns ダミー要素
 */
function fakeItem(type: string, name: string): FakeItem {
    return {
        getAttribute: (attr: string) => {
            if (attr === 'data-type') { return type; }
            if (attr === 'data-name') { return name; }
            return null;
        }
    };
}

/**
 * 生成されたHTML内の buildCopyText 関数を取り出し、呼び出せる形にします。
 *
 * Webview 内スクリプトはブラウザ上で動くため直接は実行できませんが、
 * 関数定義を切り出して評価することで連結ロジックのみを検証できます。
 *
 * @param html renderAnalysisHtml の出力
 * @param copyFormat 評価時に用いるコピー形式
 * @returns 項目リストから連結文字列を作る関数
 */
function extractBuildCopyText(
    html: string,
    copyFormat: string
): (items: FakeItem[]) => string {
    const start = html.indexOf('function buildCopyText(items) {');
    assert.ok(start >= 0, 'buildCopyText の定義が出力されること');
    // 関数本体の終端（インデント8桁の閉じ括弧）まで切り出す
    const end = html.indexOf('\n        }', start);
    assert.ok(end > start, 'buildCopyText の終端が見つかること');
    const source = html.substring(start, end + '\n        }'.length);

    return new Function('copyFormat', `${source}; return buildCopyText;`)(copyFormat);
}

describe('escapeHtml', () => {
    test('HTMLの特殊文字をエスケープする', () => {
        assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
        assert.equal(escapeHtml('a & b'), 'a &amp; b');
        assert.equal(escapeHtml('say "hi"'), 'say &quot;hi&quot;');
        assert.equal(escapeHtml("it's"), 'it&#039;s');
    });

    test('アンパサンドを二重エスケープしない', () => {
        // & を先に置換しているため <  は &lt; となる（&amp;lt; にはならない）
        assert.equal(escapeHtml('<'), '&lt;');
    });
});

describe('createNonce', () => {
    test('英数字32文字を生成する', () => {
        const nonce = createNonce();
        assert.equal(nonce.length, 32);
        assert.match(nonce, /^[A-Za-z0-9]{32}$/);
    });

    test('呼び出しごとに異なる値を生成する', () => {
        const values = new Set(Array.from({ length: 20 }, () => createNonce()));
        assert.equal(values.size, 20, '20回の生成がすべて異なること');
    });
});

describe('renderAnalysisHtml: セキュリティ', () => {
    test('Content-Security-Policy メタタグに nonce を埋め込む', () => {
        const html = renderAnalysisHtml(makeResult(), 'TESTNONCE123');
        assert.ok(html.includes('http-equiv="Content-Security-Policy"'), 'CSPメタタグが存在すること');
        assert.ok(html.includes("default-src 'none'"), 'default-src none が指定されていること');
        assert.ok(html.includes("script-src 'nonce-TESTNONCE123'"), 'script-src に nonce が指定されていること');
        assert.ok(html.includes("style-src 'nonce-TESTNONCE123'"), 'style-src に nonce が指定されていること');
    });

    test('style タグと script タグに nonce を付与する', () => {
        const html = renderAnalysisHtml(makeResult(), 'TESTNONCE123');
        assert.ok(html.includes('<style nonce="TESTNONCE123">'), 'styleタグに nonce が付くこと');
        assert.ok(html.includes('<script nonce="TESTNONCE123">'), 'scriptタグに nonce が付くこと');
    });

    test('変数名と型名をHTMLエスケープする', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: '<img src=x>', type: 'struct A & B', details: '' }]
        }), 'N');
        assert.ok(!html.includes('<img src=x>'), '生のHTMLタグが混入しないこと');
        assert.ok(html.includes('&lt;img src=x&gt;'), 'エスケープされた形で出力されること');
        assert.ok(html.includes('struct A &amp; B'), '型名もエスケープされること');
    });

    test('関数名をHTMLエスケープする', () => {
        const html = renderAnalysisHtml(makeResult({ functionName: '<b>x</b>' }), 'N');
        assert.ok(!html.includes('<b>x</b>'), '生のHTMLタグが混入しないこと');
        assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'), 'エスケープされた形で出力されること');
    });
});

describe('renderAnalysisHtml: データ属性', () => {
    test('変数項目に data-name 属性を出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'hogestruct[].a', type: 'int', details: '' }]
        }), 'N');
        assert.ok(html.includes('data-name="hogestruct[].a"'), `data-name が出力されること`);
    });

    test('通常の項目は data-highlightable="true" となる', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'value', type: 'int', details: '' }]
        }), 'N');
        assert.ok(
            html.includes('data-name="value" data-type="int" data-highlightable="true"'),
            'ハイライト対象として出力されること'
        );
    });

    test('highlightable が false の項目は data-highlightable="false" となる', () => {
        const html = renderAnalysisHtml(makeResult({
            outputs: [{ name: '戻り値 (return)', type: 'int', details: '', highlightable: false }]
        }), 'N');
        assert.ok(
            html.includes('data-name="戻り値 (return)" data-type="int" data-highlightable="false"'),
            'ハイライト対象外として出力されること'
        );
    });

    test('項目に data-type 属性を出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'ratio', type: 'float', details: '' }]
        }), 'N');
        assert.ok(html.includes('data-type="float"'), '型名がデータ属性として出力されること');
    });

    test('呼び出し関数の data-type は空文字列となる', () => {
        // 呼び出し関数には型がないため、型名列は空になる
        const html = renderAnalysisHtml(makeResult({ calledFunctions: [{ name: 'helper' }] }), 'N');
        assert.ok(html.includes('data-name="helper" data-type=""'), '空の型名が出力されること');
    });

    test('呼び出し関数の data-name から末尾の () を取り除く', () => {
        const html = renderAnalysisHtml(makeResult({ calledFunctions: [{ name: 'log_message()' }] }), 'N');
        assert.ok(html.includes('data-name="log_message"'), 'data-name は () なしであること');
        assert.ok(html.includes('>log_message()<'), '表示名は () 付きのままであること');
    });

    test('個別コピーボタンは項目のデータ属性を参照する', () => {
        // コピー対象は親の .variable-item から取得するため、ボタン自身に属性は持たせない
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'value', type: 'int', details: '' }]
        }), 'N');
        assert.ok(html.includes('<button class="var-copy-button">コピー</button>'), 'ボタンは属性を持たないこと');
    });
});

describe('renderAnalysisHtml: 定義位置とジャンプボタン', () => {
    test('定義位置がある項目に「定義へ」ボタンとデータ属性を出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'threshold', type: 'int', details: '', definition: { line: 5, column: 4 } }]
        }), 'N');
        assert.ok(html.includes('data-def-line="5"'), '行番号が出力されること');
        assert.ok(html.includes('data-def-column="4"'), '列番号が出力されること');
        assert.ok(html.includes('class="var-def-button"'), '「定義へ」ボタンが出力されること');
    });

    test('定義位置がない項目には「定義へ」ボタンを出力しない', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'unknown_global', type: 'global (推定)', details: '' }]
        }), 'N');
        // Webview 内スクリプトにもクラス名・属性名が現れるため、属性の記述形式で判定する
        assert.ok(!html.includes('class="var-def-button"'), 'ボタンが出力されないこと');
        assert.ok(!html.includes('data-def-line="'), '行番号の属性も出力されないこと');
    });

    test('インクルードファイル内の定義には data-def-file を出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{
                name: 'shared_counter',
                type: 'int',
                details: '',
                definition: { line: 3, column: 11, filePath: 'file:///c:/proj/config.h' }
            }]
        }), 'N');
        assert.ok(html.includes('data-def-file="file:///c:/proj/config.h"'), 'ファイルパスが出力されること');
    });

    test('同一ファイル内の定義では data-def-file を出力しない', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'local_val', type: 'int', details: '', definition: { line: 2, column: 8 } }]
        }), 'N');
        assert.ok(html.includes('data-def-line="2"'), '行番号は出力されること');
        assert.ok(!html.includes('data-def-file="'), 'ファイルパスは出力されないこと');
    });

    test('定義位置のファイルパスをHTMLエスケープする', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{
                name: 'x',
                type: 'int',
                details: '',
                definition: { line: 0, column: 0, filePath: 'a"><script>alert(1)</script>' }
            }]
        }), 'N');
        assert.ok(!html.includes('<script>alert(1)</script>'), '生のスクリプトタグが混入しないこと');
        assert.ok(html.includes('&lt;script&gt;'), 'エスケープされること');
    });

    test('呼び出し関数の定義位置も出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            calledFunctions: [{ name: 'helper', definition: { line: 12, column: 4 } }]
        }), 'N');
        assert.ok(html.includes('data-def-line="12"'), '行番号が出力されること');
        assert.ok(html.includes('class="var-def-button"'), '「定義へ」ボタンが出力されること');
    });

    test('定義位置がない呼び出し関数にはボタンを出力しない', () => {
        const html = renderAnalysisHtml(makeResult({
            calledFunctions: [{ name: 'printf' }]
        }), 'N');
        assert.ok(!html.includes('class="var-def-button"'), 'ボタンが出力されないこと');
    });
});

describe('renderAnalysisHtml: 分類ごとの一括コピー', () => {
    test('項目があるセクションに一括コピーボタンを出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'a', type: 'int', details: '' }]
        }), 'N');
        assert.ok(html.includes('class="section-copy-button"'), '一括コピーボタンが出力されること');
    });

    test('項目がないセクションには一括コピーボタンを出力しない', () => {
        const html = renderAnalysisHtml(makeResult(), 'N');
        assert.ok(!html.includes('class="section-copy-button"'), 'ボタンが出力されないこと');
    });

    test('一括コピーボタンを件数バッジと同じ操作領域に配置する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'a', type: 'int', details: '' }]
        }), 'N');
        // section-actions 内に件数バッジとコピーボタンが並ぶ
        assert.ok(
            /<span class="section-actions">\s*<span class="section-count">1<\/span>\s*<button class="section-copy-button"/.test(html),
            '件数バッジの直後にコピーボタンが配置されること'
        );
    });

    test('コピー対象の名前を data-name から収集できる', () => {
        // 一括コピーは各項目の data-name を集めて改行で連結する
        const html = renderAnalysisHtml(makeResult({
            inputs: [
                { name: 'hoge[N]', type: 'int', details: '' },
                { name: 'fuga', type: 'float', details: '' }
            ]
        }), 'N');
        const collected = [...html.matchAll(/class="variable-item" data-name="([^"]*)"/g)].map(m => m[1]);
        assert.deepEqual(collected, ['hoge[N]', 'fuga'], '全項目の data-name が取得できること');
    });

    test('一括コピーは改行区切りで連結する', () => {
        const build = extractBuildCopyText(renderAnalysisHtml(makeResult({
            inputs: [{ name: 'a', type: 'int', details: '' }]
        }), 'N'), 'name');

        const items = [fakeItem('int', 'alpha'), fakeItem('char*', 'beta'), fakeItem('U8', 'gamma')];
        assert.equal(build(items), 'alpha\nbeta\ngamma', '改行で区切られること');
    });
});

describe('renderAnalysisHtml: コピー形式の切り替え', () => {
    test('コピー形式の切り替えUIを出力する', () => {
        const html = renderAnalysisHtml(makeResult(), 'N');
        assert.ok(html.includes('class="copy-format"'), '切り替えUIが出力されること');
        assert.ok(html.includes('data-format="name"'), '「変数名」の選択肢があること');
        assert.ok(html.includes('data-format="typeAndName"'), '「型名 + 変数名」の選択肢があること');
    });

    test('既定では「変数名」が選択状態となる', () => {
        const html = renderAnalysisHtml(makeResult(), 'N');
        assert.ok(
            html.includes('class="copy-format-option is-active" data-format="name"'),
            '「変数名」が選択状態であること'
        );
        assert.ok(
            html.includes('class="copy-format-option" data-format="typeAndName"'),
            '「型名 + 変数名」は非選択であること'
        );
    });

    test('指定した形式が選択状態として描画される', () => {
        const html = renderAnalysisHtml(makeResult(), 'N', 'typeAndName');
        assert.ok(
            html.includes('class="copy-format-option is-active" data-format="typeAndName"'),
            '「型名 + 変数名」が選択状態であること'
        );
        assert.ok(
            html.includes('class="copy-format-option" data-format="name"'),
            '「変数名」は非選択であること'
        );
    });

    test('形式が「変数名」のときは名前のみを連結する', () => {
        const build = extractBuildCopyText(renderAnalysisHtml(makeResult(), 'N', 'name'), 'name');
        const items = [fakeItem('int', 'sensor_id'), fakeItem('char*', 'name')];
        assert.equal(build(items), 'sensor_id\nname');
    });

    test('形式が「型名 + 変数名」のときはタブ区切りで連結する', () => {
        const build = extractBuildCopyText(renderAnalysisHtml(makeResult(), 'N', 'typeAndName'), 'typeAndName');
        const items = [fakeItem('int', 'sensor_id'), fakeItem('char*', 'name')];
        assert.equal(build(items), 'int\tsensor_id\nchar*\tname', '型名とタブで区切られること');
    });

    test('型名がない項目（呼び出し関数）はタブのみが前置される', () => {
        // 表計算ソフトで列がずれないよう、型名が空でもタブは維持する
        const build = extractBuildCopyText(renderAnalysisHtml(makeResult(), 'N', 'typeAndName'), 'typeAndName');
        assert.equal(build([fakeItem('', 'log_message')]), '\tlog_message');
    });
});

describe('renderAnalysisHtml: 同名ファイルの注意表示', () => {
    test('ambiguous な定義の項目に注意マークを出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{
                name: 'g_mode', type: 'int', details: '',
                definition: { line: 3, column: 11, filePath: 'file:///variantA/config.h', ambiguous: true }
            }]
        }), 'N');
        assert.ok(html.includes('class="ambiguous-mark"'), '注意マークが出力されること');
    });

    test('ambiguous でない定義には注意マークを出力しない', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{
                name: 'g_mode', type: 'int', details: '',
                definition: { line: 3, column: 11, filePath: 'file:///only/config.h' }
            }]
        }), 'N');
        assert.ok(!html.includes('class="ambiguous-mark"'), '注意マークが出力されないこと');
    });

    test('該当があるときヘッダに注意の帯を出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            outputs: [{
                name: 'g_mode', type: 'int', details: '',
                definition: { line: 3, column: 11, ambiguous: true }
            }]
        }), 'N');
        assert.ok(html.includes('class="ambiguous-notice"'), '注意の帯が出力されること');
        assert.ok(html.includes('excludePaths'), '対処方法として設定名が案内されること');
    });

    test('該当がなければヘッダに注意の帯を出力しない', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'v', type: 'int', details: '', definition: { line: 1, column: 0 } }]
        }), 'N');
        assert.ok(!html.includes('class="ambiguous-notice"'), '注意の帯が出力されないこと');
    });

    test('呼び出し関数の ambiguous も検出する', () => {
        const html = renderAnalysisHtml(makeResult({
            calledFunctions: [{
                name: 'helper',
                definition: { line: 5, column: 0, filePath: 'file:///a/util.h', ambiguous: true }
            }]
        }), 'N');
        assert.ok(html.includes('class="ambiguous-mark"'), '注意マークが出力されること');
        assert.ok(html.includes('class="ambiguous-notice"'), '注意の帯も出力されること');
    });

    test('マクロ変数の ambiguous も検出する', () => {
        const html = renderAnalysisHtml(makeResult({
            macroVariables: [{
                name: 'MAX_LIMIT', type: 'macro (10)', details: '',
                definition: { line: 2, column: 8, filePath: 'file:///a/limits.h', ambiguous: true }
            }]
        }), 'N');
        assert.ok(html.includes('class="ambiguous-notice"'), '注意の帯が出力されること');
    });
});

describe('renderAnalysisHtml: セクション構成', () => {
    test('各セクションの件数を表示する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [
                { name: 'a', type: 'int', details: '' },
                { name: 'b', type: 'int', details: '' }
            ],
            outputs: [{ name: 'c', type: 'int', details: '' }]
        }), 'N');
        assert.ok(html.includes('<span class="section-title-text">入力変数</span>'), '入力変数セクションが存在すること');
        assert.ok(
            /入力変数<\/span>\s*<span class="section-actions">\s*<span class="section-count">2<\/span>/.test(html),
            '入力変数の件数が2であること'
        );
        assert.ok(
            /出力変数<\/span>\s*<span class="section-actions">\s*<span class="section-count">1<\/span>/.test(html),
            '出力変数の件数が1であること'
        );
    });

    test('該当がないセクションはプレースホルダを表示する', () => {
        const html = renderAnalysisHtml(makeResult(), 'N');
        assert.ok(html.includes('検出された変数はありません'), '変数のプレースホルダが表示されること');
        assert.ok(html.includes('関数呼び出しはありません'), '関数呼び出しのプレースホルダが表示されること');
    });

    test('マクロ変数・マクロ関数は該当がある場合のみセクションを表示する', () => {
        // HTMLコメント内にも同じ文字列が現れるため、見出し要素の有無で判定する
        const macroVarHeading = '<span class="section-title-text">マクロ変数</span>';
        const macroFnHeading = '<span class="section-title-text">マクロ関数</span>';

        const without = renderAnalysisHtml(makeResult(), 'N');
        assert.ok(!without.includes(macroVarHeading), '該当がなければマクロ変数セクションは出力されないこと');
        assert.ok(!without.includes(macroFnHeading), '該当がなければマクロ関数セクションは出力されないこと');

        const withMacros = renderAnalysisHtml(makeResult({
            macroVariables: [{ name: 'MAX_LIMIT', type: 'macro (推定)', details: '' }],
            macroFunctions: [{ name: 'LOG_MSG' }]
        }), 'N');
        assert.ok(withMacros.includes(macroVarHeading), 'マクロ変数セクションが出力されること');
        assert.ok(withMacros.includes(macroFnHeading), 'マクロ関数セクションが出力されること');
    });

    test('macroVariables / macroFunctions が未定義でも例外を投げない', () => {
        const result = makeResult();
        delete result.macroVariables;
        delete result.macroFunctions;
        assert.doesNotThrow(() => renderAnalysisHtml(result, 'N'));
    });

    test('関数名をタイトルとヘッダーに表示する', () => {
        const html = renderAnalysisHtml(makeResult({ functionName: 'process_data' }), 'N');
        assert.ok(html.includes('<title>Function Analysis: process_data</title>'), 'タイトルに関数名が入ること');
        assert.ok(html.includes('<span>process_data</span>'), 'ヘッダーに関数名が入ること');
    });
});
