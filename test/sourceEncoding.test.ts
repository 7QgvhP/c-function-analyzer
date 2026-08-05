/**
 * ソースファイルの文字コード判別（sourceEncoding.ts）のテストです。
 *
 * 日本語圏の組込みプロジェクトでは Shift-JIS で保存されたソースが珍しくないため、
 * UTF-8 固定で読むとコメントの日本語が文字化けします。判別が正しく働くことを検証します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeSource, DEFAULT_FALLBACK_ENCODING } from '../src/sourceEncoding';

/**
 * 指定の文字コードでエンコードしたバイト列を作ります。
 *
 * Node に Shift-JIS のエンコーダはないため、既知のバイト列を直接指定します。
 */
const SJIS_SAMPLE = {
    /** Shift-JIS の「動作モード」 */
    bytes: Buffer.from([0x93, 0xae, 0x8d, 0xec, 0x83, 0x82, 0x81, 0x5b, 0x83, 0x68]),
    text: '動作モード'
};

describe('decodeSource: UTF-8', () => {
    test('ASCII のみのファイルをそのまま読む', () => {
        const buffer = Buffer.from('extern int g_count;    /* count */\n', 'utf8');
        assert.equal(decodeSource(buffer), 'extern int g_count;    /* count */\n');
    });

    test('UTF-8 の日本語コメントを読む', () => {
        const source = 'extern int g_count;    /* 実行回数 */\n';
        assert.equal(decodeSource(Buffer.from(source, 'utf8')), source);
    });

    test('UTF-8 の BOM を取り除く', () => {
        const source = 'extern int g_count;\n';
        const buffer = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, 'utf8')]);
        assert.equal(decodeSource(buffer), source, 'BOM が本文に混ざらないこと');
    });

    test('空のファイルを空文字列にする', () => {
        assert.equal(decodeSource(Buffer.alloc(0)), '');
    });
});

describe('decodeSource: Shift-JIS へのフォールバック', () => {
    test('Shift-JIS の日本語を正しく読む', () => {
        assert.equal(decodeSource(SJIS_SAMPLE.bytes), SJIS_SAMPLE.text);
    });

    test('UTF-8 固定で読むと文字化けすることを確認する（前提の確認）', () => {
        assert.notEqual(SJIS_SAMPLE.bytes.toString('utf8'), SJIS_SAMPLE.text);
    });

    test('Shift-JIS のコメントを含む宣言を読む', () => {
        // 「extern int g_mode;    /* 動作モード */」を Shift-JIS で表したもの
        const buffer = Buffer.concat([
            Buffer.from('extern int g_mode;    /* ', 'ascii'),
            SJIS_SAMPLE.bytes,
            Buffer.from(' */\n', 'ascii')
        ]);
        assert.equal(decodeSource(buffer), `extern int g_mode;    /* ${SJIS_SAMPLE.text} */\n`);
    });

    test('既定のフォールバック先は Shift-JIS とする', () => {
        assert.equal(DEFAULT_FALLBACK_ENCODING, 'shift_jis');
        assert.equal(
            decodeSource(SJIS_SAMPLE.bytes),
            decodeSource(SJIS_SAMPLE.bytes, DEFAULT_FALLBACK_ENCODING)
        );
    });

    test('フォールバック先を指定できる', () => {
        // EUC-JP の「あ」（Shift-JIS としては別の文字になる）
        const eucJp = Buffer.from([0xa4, 0xa2]);
        assert.equal(decodeSource(eucJp, 'euc-jp'), 'あ');
    });

    test('対応していない文字コード名を指定されても例外にしない', () => {
        assert.doesNotThrow(() => decodeSource(SJIS_SAMPLE.bytes, 'not-a-real-encoding'));
    });

    test('空文字列を指定された場合は既定の文字コードを使う', () => {
        assert.equal(decodeSource(SJIS_SAMPLE.bytes, ''), SJIS_SAMPLE.text);
    });
});

describe('decodeSource: UTF-16', () => {
    test('UTF-16 LE の BOM 付きファイルを読む', () => {
        const source = 'extern int g_count;    /* 実行回数 */\n';
        const buffer = Buffer.concat([
            Buffer.from([0xff, 0xfe]),
            Buffer.from(source, 'utf16le')
        ]);
        assert.equal(decodeSource(buffer), source);
    });

    test('UTF-16 BE の BOM 付きファイルを読む', () => {
        const source = 'int a;\n';
        const le = Buffer.from(source, 'utf16le');
        // バイト順を入れ替えてビッグエンディアンにする
        const be = Buffer.alloc(le.length);
        for (let i = 0; i < le.length; i += 2) {
            be[i] = le[i + 1];
            be[i + 1] = le[i];
        }
        const buffer = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
        assert.equal(decodeSource(buffer), source);
    });
});
