/**
 * 定義ジャンプの原因判定（definitionDiagnosis.ts）のテストです。
 *
 * 定義検索の経過と、C/C++ 拡張のエラー・警告を模したデータを渡し、
 * 項目ごとの分類が期待どおりになるかを検証します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    CandidateLocation,
    diagnoseDefinition,
    EditorSignals,
    findIncludeErrors,
    formatDiagnosisReport,
    lastSegmentName,
    LookupRecord,
    SignalDiagnostic
} from '../src/definitionDiagnosis';

/** 参照位置（5行目の4列目） */
const USAGE = { line: 5, column: 4 };

/**
 * 定義位置の候補を作ります。
 *
 * @param file ファイル名
 * @param line 行（0始まり）
 * @returns 候補
 */
function candidate(file: string, line: number = 0): CandidateLocation {
    return { filePath: `file:///c%3A/proj/${file}`, line, column: 0 };
}

/**
 * 定義検索の経過を作ります。
 *
 * @param overrides 上書きしたいフィールド
 * @returns 経過
 */
function record(overrides: Partial<LookupRecord> = {}): LookupRecord {
    return { outcome: 'noCandidate', candidates: [], excluded: [], ...overrides };
}

/**
 * C/C++ 拡張のエラー・警告を作ります。
 *
 * @param overrides 上書きしたいフィールド
 * @returns エラー・警告
 */
function diag(overrides: Partial<SignalDiagnostic>): SignalDiagnostic {
    return {
        line: 0,
        column: 0,
        endLine: 0,
        endColumn: 10,
        severity: 'error',
        source: 'C/C++',
        message: '',
        ...overrides
    };
}

/** include エラー（1行目の #include "sensor_hal.h"） */
const INCLUDE_ERROR = diag({ code: '1696', message: 'cannot open source file "sensor_hal.h"' });

/**
 * エディタ側の手がかりを作ります。
 *
 * @param diagnostics エラー・警告
 * @param overrides 上書きしたいフィールド
 * @returns 手がかり
 */
function signals(diagnostics: SignalDiagnostic[] = [], overrides: Partial<EditorSignals> = {}): EditorSignals {
    return { diagnostics, errorSquiggles: 'enabledIfIncludesResolve', cppToolsActive: true, ...overrides };
}

describe('diagnoseDefinition: 正常', () => {
    test('候補が1件で読み取れた場合は正常', () => {
        const c = candidate('app_config.h', 11);
        const d = diagnoseDefinition('g_config.mode', USAGE, record({ outcome: 'resolved', candidates: [c], chosen: c, tokenAtUsage: 'mode' }), signals());
        assert.equal(d.category, 'ok');
        assert.equal(d.label, '正常');
        assert.match(d.summary, /app_config\.h:12/);
    });
});

describe('diagnoseDefinition: 原因1（本アプリ）', () => {
    test('問い合わせ位置の単語が項目名と違う場合は ① 位置のずれ', () => {
        const d = diagnoseDefinition('g_tbl[].value', USAGE, record({ outcome: 'noCandidate', tokenAtUsage: 'g_tbl' }), signals([INCLUDE_ERROR]));
        assert.equal(d.category, 'app');
        assert.equal(d.appCause, 'position');
        assert.match(d.summary, /「g_tbl」.*「value」/);
    });

    test('単語が取得できない場合は位置のずれとは判定しない', () => {
        const c = candidate('a.h');
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'resolved', candidates: [c], chosen: c }), signals());
        assert.equal(d.category, 'ok');
    });

    test('候補がすべて除外された場合は ② excludePaths', () => {
        const a = candidate('variantB/a.h');
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'allExcluded', candidates: [a], excluded: [a], tokenAtUsage: 'g_count' }), signals());
        assert.equal(d.category, 'app');
        assert.equal(d.appCause, 'excluded');
        assert.match(d.summary, /a\.h/);
    });

    test('候補が複数ある場合は ③ 候補が複数', () => {
        const a = candidate('a.h'), b = candidate('b.h');
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'ambiguous', candidates: [a, b], chosen: a, tokenAtUsage: 'g_count' }), signals());
        assert.equal(d.category, 'app');
        assert.equal(d.appCause, 'multiple');
        assert.match(d.summary, /候補が2件/);
    });

    test('除外後に1件だけ残った場合は正常', () => {
        const a = candidate('variantA/a.h'), b = candidate('variantB/a.h');
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'resolved', candidates: [a, b], excluded: [b], chosen: a, tokenAtUsage: 'g_count' }), signals());
        assert.equal(d.category, 'ok');
    });

    test('宣言を読み取れなかった場合は ④', () => {
        const a = candidate('a.h');
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'unreadable', candidates: [a], chosen: a, tokenAtUsage: 'g_count' }), signals());
        assert.equal(d.category, 'app');
        assert.equal(d.appCause, 'unreadable');
    });
});

describe('diagnoseDefinition: 原因2（推測ジャンプ）', () => {
    test('候補はあるが include エラーがある場合', () => {
        const a = candidate('a.h');
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'resolved', candidates: [a], chosen: a }), signals([INCLUDE_ERROR]));
        assert.equal(d.category, 'guess');
        assert.match(d.summary, /"sensor_hal\.h" を開けません/);
        assert.deepEqual(d.evidence, [INCLUDE_ERROR]);
    });

    test('候補が複数で include エラーがある場合は、複数候補ではなく推測と判定する', () => {
        const a = candidate('a.h'), b = candidate('b.h');
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'ambiguous', candidates: [a, b], chosen: a }), signals([INCLUDE_ERROR]));
        assert.equal(d.category, 'guess');
    });

    test('候補はあるが参照箇所で識別子が未定義の場合', () => {
        const a = candidate('a.h');
        const undefinedError = diag({ line: 5, column: 4, endLine: 5, endColumn: 11, code: '20', message: 'identifier "g_count" is undefined' });
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'resolved', candidates: [a], chosen: a }), signals([undefinedError]));
        assert.equal(d.category, 'guess');
    });
});

describe('diagnoseDefinition: 原因3（インクルード設定）', () => {
    test('候補が無く include エラーがある場合', () => {
        const d = diagnoseDefinition('g_offset', USAGE, record(), signals([INCLUDE_ERROR]));
        assert.equal(d.category, 'config');
        assert.equal(d.label, '原因3: インクルード設定');
        assert.match(d.summary, /"sensor_hal\.h" を開けません/);
    });

    test('候補が無く、参照箇所で識別子が未定義の場合（-D の不一致の可能性）', () => {
        const undefinedError = diag({ line: 5, column: 4, endLine: 5, endColumn: 12, code: '20', message: 'identifier "g_offset" is undefined' });
        const d = diagnoseDefinition('g_offset', USAGE, record(), signals([undefinedError]));
        assert.equal(d.category, 'config');
        assert.match(d.summary, /-D/);
    });

    test('別の行の「識別子が未定義」は手がかりにしない', () => {
        const other = diag({ line: 9, column: 4, endLine: 9, endColumn: 12, code: '20', message: 'identifier "g_offset" is undefined' });
        const d = diagnoseDefinition('g_offset', USAGE, record(), signals([other]));
        assert.equal(d.category, 'unknown');
    });
});

describe('diagnoseDefinition: 原因4（プロトタイプなし）', () => {
    test('呼び出し箇所に暗黙の宣言の警告がある場合（候補なし）', () => {
        const implicit = diag({ line: 5, column: 4, endLine: 5, endColumn: 11, severity: 'warning', code: '223', message: 'function "init_hw" declared implicitly' });
        const d = diagnoseDefinition('init_hw', USAGE, record(), signals([implicit]));
        assert.equal(d.category, 'implicit');
        assert.match(d.summary, /定義は見つかりませんでした/);
    });

    test('候補がある場合も、名前だけで探した推測の可能性として原因4に分類する', () => {
        const a = candidate('hw.c');
        const implicit = diag({ line: 5, column: 4, endLine: 5, endColumn: 11, severity: 'warning', code: '223', message: 'function "init_hw" declared implicitly' });
        const d = diagnoseDefinition('init_hw', USAGE, record({ outcome: 'resolved', candidates: [a], chosen: a }), signals([implicit]));
        assert.equal(d.category, 'implicit');
        assert.match(d.summary, /推測の可能性/);
    });

    test('範囲がずれていても、同じ行でメッセージに名前があれば該当とみなす', () => {
        const implicit = diag({ line: 5, column: 0, endLine: 5, endColumn: 2, severity: 'warning', code: '223', message: 'function "init_hw" declared implicitly' });
        const d = diagnoseDefinition('init_hw()', USAGE, record(), signals([implicit]));
        assert.equal(d.category, 'implicit');
    });
});

describe('diagnoseDefinition: 判定できず', () => {
    test('候補が無く手がかりも無い場合', () => {
        const d = diagnoseDefinition('g_unknown', USAGE, record(), signals());
        assert.equal(d.category, 'unknown');
        assert.match(d.summary, /手がかりとなるエラーはありません/);
    });

    test('エラー表示が無効に設定されている場合はその旨を出す', () => {
        const d = diagnoseDefinition('g_unknown', USAGE, record(), signals([], { errorSquiggles: 'disabled' }));
        assert.equal(d.category, 'unknown');
        assert.match(d.summary, /errorSquiggles: disabled/);
    });

    test('C/C++ 拡張が有効でない場合はその旨を出す', () => {
        const d = diagnoseDefinition('g_unknown', USAGE, record(), signals([], { cppToolsActive: false }));
        assert.match(d.summary, /C\/C\+\+ 拡張が有効になっていません/);
    });

    test('定義プロバイダがエラーを返した場合', () => {
        const d = diagnoseDefinition('g_count', USAGE, record({ outcome: 'providerError' }), signals([INCLUDE_ERROR]));
        assert.equal(d.category, 'unknown');
        assert.match(d.summary, /定義プロバイダがエラー/);
    });
});

describe('findIncludeErrors: エラーの照合', () => {
    test('日本語表示のメッセージも照合する', () => {
        const ja = diag({ code: undefined, message: 'ソース ファイル "hal.h" を開けません' });
        assert.equal(findIncludeErrors([ja]).length, 1);
    });

    test('番号が一致すれば、メッセージの文言が違っても照合する', () => {
        const byCode = diag({ code: '1696', message: 'unexpected wording' });
        assert.equal(findIncludeErrors([byCode]).length, 1);
    });

    test('番号の照合は C/C++ 拡張のものに限る（他の発行元の同じ番号は対象外）', () => {
        const other = diag({ source: 'eslint', code: '1696', message: 'unrelated' });
        assert.equal(findIncludeErrors([other]).length, 0);
    });

    test('clangd の file not found も照合する', () => {
        const clangd = diag({ source: 'clang', code: 'pp_file_not_found', message: "'hal.h' file not found" });
        assert.equal(findIncludeErrors([clangd]).length, 1);
    });
});

describe('lastSegmentName', () => {
    test('アクセスパスの最後の名前を取り出す', () => {
        assert.equal(lastSegmentName('g_tbl[N].value'), 'value');
        assert.equal(lastSegmentName('p->next'), 'next');
        assert.equal(lastSegmentName('g_tbl[].sub[4]'), 'sub');
        assert.equal(lastSegmentName('func()'), 'func');
        assert.equal(lastSegmentName('g_count'), 'g_count');
    });
});

describe('formatDiagnosisReport', () => {
    const context = {
        timestamp: '2026/9/22 12:00:00',
        filePath: 'C:\\proj\\sensor_main.c',
        functionName: 'update_sensor_status',
        cppToolsStatus: 'ms-vscode.cpptools 1.22.0（有効）'
    };

    test('ヘッダ・集計・分類ごとの一覧・根拠を出力する', () => {
        const ok = diagnoseDefinition('g_config.mode', USAGE, record({ outcome: 'resolved', candidates: [candidate('a.h')], chosen: candidate('a.h') }), signals());
        const config = diagnoseDefinition('g_offset', USAGE, record(), signals([INCLUDE_ERROR]));
        const text = formatDiagnosisReport([
            { section: '入力変数', name: 'g_config.mode', diagnosis: ok },
            { section: '出力変数', name: 'g_offset', diagnosis: config }
        ], signals([INCLUDE_ERROR]), context);

        assert.match(text, /定義ジャンプの診断 2026\/9\/22 12:00:00/);
        assert.match(text, /関数 {10}: update_sensor_status/);
        assert.match(text, /include エラー: 1件/);
        assert.match(text, /集計: 正常 1 \/ 原因1: 本アプリ 0 \/ 原因2: 推測ジャンプ 0 \/ 原因3: インクルード設定 1/);
        assert.match(text, /\[入力変数\]\n {2}\[正常\] g_config.mode/);
        assert.match(text, /\[出力変数\]\n {2}\[原因3: インクルード設定\] g_offset/);
        assert.match(text, /--- 判定に使ったエラー・警告 ---\n {2}1行1列 \[C\/C\+\+\(1696\)\] cannot open source file "sensor_hal\.h"/);
    });

    test('根拠が無い場合は根拠の欄を出さない', () => {
        const ok = diagnoseDefinition('g_a', USAGE, record({ outcome: 'resolved', candidates: [candidate('a.h')], chosen: candidate('a.h') }), signals());
        const text = formatDiagnosisReport([{ section: '入力変数', name: 'g_a', diagnosis: ok }], signals(), context);
        assert.doesNotMatch(text, /判定に使ったエラー・警告/);
    });
});
