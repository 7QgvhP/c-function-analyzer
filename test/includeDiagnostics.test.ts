/**
 * インクルード探索の診断（includeDiagnostics.ts）のテストです。
 *
 * ファイルシステムに触れない純関数のため、依存をメモリ上のマップで注入して検証します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    buildIncludeReport,
    formatIncludeReport,
    IncludeDiagnosticsDeps
} from '../src/includeDiagnostics';

/** テスト用の仮想ファイル構成 */
interface VirtualFiles {
    /** ファイルパス → そのファイルが include しているパス一覧 */
    includes: Record<string, string[]>;
    /** インクルードパス → 実在する候補一覧（先頭が採用される） */
    resolution: Record<string, string[]>;
    /** ファイルパス → 定義されている構造体名一覧 */
    structs?: Record<string, string[]>;
    /** 索引に登録されているファイル数 */
    indexedCount?: number;
}

/**
 * 仮想ファイル構成から診断用の依存を組み立てます。
 *
 * @param files 仮想ファイル構成
 * @returns 診断に注入する依存
 */
function makeDeps(files: VirtualFiles): IncludeDiagnosticsDeps {
    return {
        readIncludePaths: (fsPath) => files.includes[fsPath] || [],
        inspectInclude: (includePath) => {
            const candidates = files.resolution[includePath] || [];
            return { resolved: candidates.length > 0 ? candidates[0] : null, candidates };
        },
        readStructNames: (fsPath) => (files.structs || {})[fsPath] || [],
        countIndexedFiles: () => files.indexedCount ?? 0
    };
}

describe('buildIncludeReport: 到達状況', () => {
    test('深さごとに到達したファイルを記録する', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({
            includes: { 'main.c': ['a.h'], 'a.h': ['b.h'], 'b.h': ['c.h'] },
            resolution: { 'a.h': ['a.h'], 'b.h': ['b.h'], 'c.h': ['c.h'] }
        }));

        assert.deepEqual(report.reached, [
            { fsPath: 'a.h', depth: 1 },
            { fsPath: 'b.h', depth: 2 },
            { fsPath: 'c.h', depth: 3 }
        ]);
        assert.equal(report.maxDepth, 3);
        assert.deepEqual(report.skipped, [], '上限内のため打ち切りはないこと');
    });

    test('同じファイルへ複数の経路がある場合は最短の深さを採る', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({
            // main.c → deep.h（深さ1）と、main.c → a.h → b.h → deep.h（深さ3）
            includes: { 'main.c': ['a.h', 'deep.h'], 'a.h': ['b.h'], 'b.h': ['deep.h'] },
            resolution: { 'a.h': ['a.h'], 'b.h': ['b.h'], 'deep.h': ['deep.h'] }
        }));

        assert.equal(report.reached.find(r => r.fsPath === 'deep.h')?.depth, 1);
    });

    test('循環インクルードでも停止する', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({
            includes: { 'main.c': ['a.h'], 'a.h': ['b.h'], 'b.h': ['a.h'] },
            resolution: { 'a.h': ['a.h'], 'b.h': ['b.h'] }
        }));

        assert.equal(report.reached.length, 2);
        assert.equal(report.maxDepth, 2);
    });

    test('インクルードがない場合は到達ファイルなしとする', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({ includes: {}, resolution: {} }));

        assert.deepEqual(report.reached, []);
        assert.equal(report.maxDepth, 0);
    });
});

describe('buildIncludeReport: 深さ上限', () => {
    /** 深さ n までの直列なインクルード構成を作ります */
    function makeChain(depth: number): VirtualFiles {
        const includes: Record<string, string[]> = { 'main.c': ['h1.h'] };
        const resolution: Record<string, string[]> = {};
        for (let i = 1; i <= depth; i++) {
            resolution[`h${i}.h`] = [`h${i}.h`];
            if (i < depth) {
                includes[`h${i}.h`] = [`h${i + 1}.h`];
            }
        }
        return { includes, resolution };
    }

    test('上限を超える深さのファイルを打ち切りとして報告する', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps(makeChain(10)));

        assert.equal(report.maxDepth, 10);
        assert.deepEqual(
            report.skipped.map(s => s.fsPath),
            ['h9.h', 'h10.h'],
            '深さ9以降が打ち切りとなること'
        );
    });

    test('ちょうど上限の深さは打ち切りに含めない', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps(makeChain(8)));

        assert.equal(report.maxDepth, 8);
        assert.deepEqual(report.skipped, []);
    });

    test('打ち切られたファイルの構造体定義名を含める', () => {
        const files = makeChain(9);
        files.structs = { 'h9.h': ['struct Config', 'ConfigAlias'] };
        const report = buildIncludeReport('main.c', 8, makeDeps(files));

        assert.deepEqual(report.skipped.map(s => s.structNames), [['struct Config', 'ConfigAlias']]);
    });
});

describe('buildIncludeReport: 解決できないインクルードと同名ファイル', () => {
    test('解決できなかったインクルードを記録する', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({
            includes: { 'main.c': ['found.h', 'missing.h'] },
            resolution: { 'found.h': ['found.h'] }
        }));

        assert.deepEqual(report.unresolved, [{ includePath: 'missing.h', fromFsPath: 'main.c' }]);
    });

    test('候補が複数あったインクルードを記録する', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({
            includes: { 'main.c': ['config.h'] },
            resolution: { 'config.h': ['a/config.h', 'b/config.h'] }
        }));

        assert.deepEqual(report.ambiguous, [{
            includePath: 'config.h',
            fromFsPath: 'main.c',
            candidates: ['a/config.h', 'b/config.h']
        }]);
        assert.equal(report.reached[0].fsPath, 'a/config.h', '先頭の候補が採用されること');
    });

    test('候補が1つだけなら曖昧として記録しない', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({
            includes: { 'main.c': ['config.h'] },
            resolution: { 'config.h': ['a/config.h'] }
        }));

        assert.deepEqual(report.ambiguous, []);
    });
});

describe('formatIncludeReport: 出力の整形', () => {
    /** テスト用にパスをそのまま返します */
    const asIs = (p: string) => p;

    test('問題がない場合は「なし」と表示する', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({
            includes: { 'main.c': ['a.h'] },
            resolution: { 'a.h': ['a.h'] },
            indexedCount: 42
        }));
        const text = formatIncludeReport(report, asIs);

        assert.ok(text.includes('索引ファイル数: 42 件'));
        assert.ok(text.includes('最大の深さ    : 1 段（上限 8 段）'));
        assert.ok(text.includes('----- 深さ上限で探索されないヘッダ（0 件）-----\n  なし'));
        assert.ok(text.includes('----- 解決できなかった #include（0 件）-----\n  なし'));
    });

    test('打ち切られたヘッダと構造体定義を表示する', () => {
        const includes: Record<string, string[]> = { 'main.c': ['h1.h'] };
        const resolution: Record<string, string[]> = {};
        for (let i = 1; i <= 9; i++) {
            resolution[`h${i}.h`] = [`h${i}.h`];
            if (i < 9) { includes[`h${i}.h`] = [`h${i + 1}.h`]; }
        }
        const report = buildIncludeReport('main.c', 8, makeDeps({
            includes, resolution, structs: { 'h9.h': ['struct Config'] }
        }));
        const text = formatIncludeReport(report, asIs);

        assert.ok(text.includes('深さ 9  h9.h'), `打ち切りヘッダが出ること:\n${text}`);
        assert.ok(text.includes('構造体定義: struct Config'));
        assert.ok(text.includes('上限を超えるため探索されません'));
    });

    test('解決できなかったインクルードと採用された候補を表示する', () => {
        const report = buildIncludeReport('main.c', 8, makeDeps({
            includes: { 'main.c': ['missing.h', 'config.h'] },
            resolution: { 'config.h': ['a/config.h', 'b/config.h'] }
        }));
        const text = formatIncludeReport(report, asIs);

        assert.ok(text.includes('"missing.h"  (main.c から)'));
        assert.ok(text.includes('→ 採用 a/config.h'));
        assert.ok(text.includes('       b/config.h'));
    });

    test('表示用のパス変換を適用する', () => {
        const report = buildIncludeReport('C:/proj/main.c', 8, makeDeps({
            includes: { 'C:/proj/main.c': ['a.h'] },
            resolution: { 'a.h': ['C:/proj/hed/a.h'] }
        }));
        const text = formatIncludeReport(report, p => p.replace('C:/proj/', ''));

        assert.ok(text.includes('解析対象      : main.c'));
        assert.ok(!text.includes('C:/proj/'), `絶対パスが残らないこと:\n${text}`);
    });
});
