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
        assert.ok(html.includes('data-name="value" data-highlightable="true"'), 'ハイライト対象として出力されること');
    });

    test('highlightable が false の項目は data-highlightable="false" となる', () => {
        const html = renderAnalysisHtml(makeResult({
            outputs: [{ name: '戻り値 (return)', type: 'int', details: '', highlightable: false }]
        }), 'N');
        assert.ok(
            html.includes('data-name="戻り値 (return)" data-highlightable="false"'),
            'ハイライト対象外として出力されること'
        );
    });

    test('呼び出し関数の data-name から末尾の () を取り除く', () => {
        const html = renderAnalysisHtml(makeResult({ calledFunctions: [{ name: 'log_message()' }] }), 'N');
        assert.ok(html.includes('data-name="log_message"'), 'data-name は () なしであること');
        assert.ok(html.includes('>log_message()<'), '表示名は () 付きのままであること');
    });

    test('コピーボタンにも data-name を出力する', () => {
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'value', type: 'int', details: '' }]
        }), 'N');
        assert.ok(html.includes('<button class="var-copy-button" data-name="value">'), 'コピーボタンに data-name が付くこと');
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
        // Webview 内スクリプトが生成する連結処理を取り出して評価する
        const html = renderAnalysisHtml(makeResult({
            inputs: [{ name: 'a', type: 'int', details: '' }]
        }), 'N');
        const start = html.indexOf('names.join');
        assert.ok(start >= 0, '連結処理が出力されること');
        const snippet = html.substring(start, html.indexOf(')', start) + 1);

        // 生成された式をそのまま関数化して評価する（区切り文字が改行であることを確認する）
        const joinNames = new Function('names', `return ${snippet};`) as (names: string[]) => string;
        assert.equal(joinNames(['alpha', 'beta', 'gamma']), 'alpha\nbeta\ngamma', '改行で区切られること');
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
