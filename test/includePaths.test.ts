/**
 * includePaths.ts の探索候補パス構築に対するテストです。
 *
 * パス文字列の操作のみを行う純関数のため、ファイルシステムや VS Code なしで検証できます。
 * 期待値は実行環境の区切り文字に合わせて正規化して比較します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { buildFileNameSearchCandidates, buildIncludeCandidates } from '../src/includePaths';

/**
 * 期待値を実行環境のパス表記へ正規化します。
 *
 * @param paths 比較したいパスの配列
 * @returns 正規化後の配列
 */
function normalize(paths: string[]): string[] {
    return paths.map(p => path.normalize(p));
}

// Windows でもドライブレター付きの絶対パスになるよう resolve で組み立てる
const WORKSPACE = path.resolve('/proj');
const FROM_FILE = path.join(WORKSPACE, 'src', 'main.c');

describe('buildIncludeCandidates: 基本の探索順', () => {
    test('インクルード元ディレクトリ → ワークスペース直下 の順で候補を並べる', () => {
        const candidates = buildIncludeCandidates('config.h', FROM_FILE, [WORKSPACE]);
        assert.deepEqual(candidates, normalize([
            path.join(WORKSPACE, 'src', 'config.h'),
            path.join(WORKSPACE, 'config.h')
        ]));
    });

    test('インクルード元が不明な場合はワークスペース直下のみを候補とする', () => {
        const candidates = buildIncludeCandidates('config.h', null, [WORKSPACE]);
        assert.deepEqual(candidates, normalize([path.join(WORKSPACE, 'config.h')]));
    });

    test('サブディレクトリ付きのインクルードパスを解決する', () => {
        const candidates = buildIncludeCandidates('sub/types.h', FROM_FILE, [WORKSPACE]);
        assert.equal(candidates[0], path.join(WORKSPACE, 'src', 'sub', 'types.h'));
    });

    test('親ディレクトリを含むインクルードパスを解決する', () => {
        const candidates = buildIncludeCandidates('../common/defs.h', FROM_FILE, [WORKSPACE]);
        assert.equal(candidates[0], path.join(WORKSPACE, 'common', 'defs.h'));
    });

    test('ワークスペースフォルダが複数ある場合はすべて候補にする', () => {
        const second = path.resolve('/other');
        const candidates = buildIncludeCandidates('config.h', null, [WORKSPACE, second]);
        assert.deepEqual(candidates, normalize([
            path.join(WORKSPACE, 'config.h'),
            path.join(second, 'config.h')
        ]));
    });
});

describe('buildIncludeCandidates: excludePaths のディレクトリ指定', () => {
    test('除外したディレクトリ配下の候補を取り除く', () => {
        const candidates = buildIncludeCandidates(
            'variantB/config.h', null, [WORKSPACE], ['variantB']
        );
        assert.deepEqual(candidates, [], 'variantB 配下は候補に残らないこと');
    });

    test('除外はサブディレクトリにも及ぶ', () => {
        const candidates = buildIncludeCandidates(
            'legacy/old/inc/config.h', null, [WORKSPACE], ['legacy']
        );
        assert.deepEqual(candidates, [], 'legacy 配下はすべて除外されること');
    });

    test('除外していないディレクトリは残る', () => {
        const candidates = buildIncludeCandidates(
            'variantA/config.h', null, [WORKSPACE], ['variantB']
        );
        assert.deepEqual(candidates, normalize([path.join(WORKSPACE, 'variantA', 'config.h')]));
    });

    test('インクルード元ディレクトリの候補も除外できる', () => {
        const fromFile = path.join(WORKSPACE, 'variantB', 'main.c');
        const candidates = buildIncludeCandidates('config.h', fromFile, [WORKSPACE], ['variantB']);
        assert.ok(
            !candidates.includes(path.join(WORKSPACE, 'variantB', 'config.h')),
            'インクルード元と同じディレクトリでも除外されること'
        );
    });

    test('絶対パスでの除外指定に対応する', () => {
        const sdk = path.resolve('/sdk/old');
        const fromFile = path.join(sdk, 'main.c');
        const candidates = buildIncludeCandidates('driver.h', fromFile, [WORKSPACE], [sdk]);
        assert.ok(!candidates.includes(path.join(sdk, 'driver.h')), '絶対パスで除外されること');
    });

    test('除外指定がなければ従来どおり動作する', () => {
        const withEmpty = buildIncludeCandidates('config.h', FROM_FILE, [WORKSPACE], []);
        const withoutArg = buildIncludeCandidates('config.h', FROM_FILE, [WORKSPACE]);
        assert.deepEqual(withEmpty, withoutArg);
    });

    test('区切り文字付きで指定すればディレクトリ単位で判定する', () => {
        // "./variant" は区切りを含むためディレクトリ指定として扱われ、部分一致しない
        const candidates = buildIncludeCandidates(
            'variantA/config.h', null, [WORKSPACE], ['./variant']
        );
        assert.ok(
            candidates.includes(path.join(WORKSPACE, 'variantA', 'config.h')),
            'ディレクトリ指定では前方一致で除外されないこと'
        );
    });
});

describe('buildIncludeCandidates: excludePaths のフォルダ名指定', () => {
    test('名前に指定文字列を含むフォルダの配下を除外する', () => {
        const excluded = buildIncludeCandidates(
            'hed/variantB/config.h', null, [WORKSPACE], ['variantB']
        );
        const kept = buildIncludeCandidates(
            'hed/variantA/config.h', null, [WORKSPACE], ['variantB']
        );
        assert.deepEqual(excluded, [], '階層の途中にあっても除外されること');
        assert.deepEqual(kept, normalize([path.join(WORKSPACE, 'hed', 'variantA', 'config.h')]));
    });

    test('部分一致で判定する', () => {
        const excluded = buildIncludeCandidates('old_backup/config.h', null, [WORKSPACE], ['old']);
        const kept = buildIncludeCandidates('current/config.h', null, [WORKSPACE], ['old']);
        assert.deepEqual(excluded, [], '名前に old を含むフォルダは除外されること');
        assert.deepEqual(kept, normalize([path.join(WORKSPACE, 'current', 'config.h')]));
    });

    test('大文字・小文字を区別しない', () => {
        const candidates = buildIncludeCandidates(
            'VariantB/config.h', null, [WORKSPACE], ['variantb']
        );
        assert.deepEqual(candidates, []);
    });

    test('ファイル名は判定対象に含めない', () => {
        // フォルダのみを対象とするため、variantB.h というファイルは除外されない
        const candidates = buildIncludeCandidates('variantB.h', null, [WORKSPACE], ['variantB']);
        assert.ok(candidates.includes(path.join(WORKSPACE, 'variantB.h')), 'ファイル名では除外されないこと');
    });

    test('ワークスペース外のパスは判定対象にしない', () => {
        // C:\sdk\old_lib のようなワークスペース外のディレクトリに巻き込まれないこと
        const sdk = path.resolve('/sdk/old_lib');
        const fromFile = path.join(sdk, 'main.c');
        const candidates = buildIncludeCandidates('driver.h', fromFile, [WORKSPACE], ['old']);
        assert.ok(
            candidates.includes(path.join(sdk, 'driver.h')),
            'ワークスペース外は名前指定の影響を受けないこと'
        );
    });

    test('ワークスペースフォルダ自体の名前は判定対象にしない', () => {
        // ワークスペースが C:\work\old_project でも、その中身は除外されないこと
        const workspace = path.resolve('/work/old_project');
        const candidates = buildIncludeCandidates('config.h', null, [workspace], ['old']);
        assert.deepEqual(candidates, normalize([path.join(workspace, 'config.h')]));
    });

    test('インクルード元ディレクトリの候補も除外できる', () => {
        const fromFile = path.join(WORKSPACE, 'control', 'variantB', 'main.c');
        const candidates = buildIncludeCandidates('config.h', fromFile, [WORKSPACE], ['variantB']);
        assert.ok(
            !candidates.includes(path.join(WORKSPACE, 'control', 'variantB', 'config.h')),
            'インクルード元と同じディレクトリでも除外されること'
        );
    });

    test('ディレクトリ指定とフォルダ名指定を併用できる', () => {
        const byDirectory = buildIncludeCandidates(
            'legacy/inc/config.h', null, [WORKSPACE], ['legacy/inc', 'variantB']
        );
        const byName = buildIncludeCandidates(
            'hed/variantB/config.h', null, [WORKSPACE], ['legacy/inc', 'variantB']
        );
        const kept = buildIncludeCandidates(
            'hed/variantA/config.h', null, [WORKSPACE], ['legacy/inc', 'variantB']
        );
        assert.deepEqual(byDirectory, [], 'ディレクトリ指定が効くこと');
        assert.deepEqual(byName, [], 'フォルダ名指定が効くこと');
        assert.deepEqual(kept, normalize([path.join(WORKSPACE, 'hed', 'variantA', 'config.h')]));
    });
});

describe('buildFileNameSearchCandidates: ファイル名検索', () => {
    /**
     * ワークスペース相対のパス一覧から、ファイル名索引を作ります。
     *
     * @param relativePaths ワークスペースからの相対パス一覧
     * @returns ファイル名 → 絶対パス一覧 の索引
     */
    function makeIndex(relativePaths: string[]): Map<string, string[]> {
        const index = new Map<string, string[]>();
        relativePaths.forEach(relative => {
            const absolute = path.join(WORKSPACE, path.normalize(relative));
            const name = path.basename(absolute);
            const existing = index.get(name);
            if (existing) {
                existing.push(absolute);
            } else {
                index.set(name, [absolute]);
            }
        });
        return index;
    }

    test('ファイル名が一致するファイルを見つける', () => {
        const index = makeIndex(['hed/6room_multi/hoge.h', 'control/other.h']);
        const found = buildFileNameSearchCandidates('hoge.h', index, [WORKSPACE]);
        assert.deepEqual(found, [path.join(WORKSPACE, 'hed', '6room_multi', 'hoge.h')]);
    });

    test('一致しないファイル名では空配列を返す', () => {
        const index = makeIndex(['hed/hoge.h']);
        assert.deepEqual(buildFileNameSearchCandidates('missing.h', index, [WORKSPACE]), []);
    });

    test('複数一致した場合は階層の浅い順に並べる', () => {
        const index = makeIndex([
            'a/b/c/config.h',
            'config.h',
            'a/config.h'
        ]);
        const found = buildFileNameSearchCandidates('config.h', index, [WORKSPACE]);
        assert.deepEqual(found, [
            path.join(WORKSPACE, 'config.h'),
            path.join(WORKSPACE, 'a', 'config.h'),
            path.join(WORKSPACE, 'a', 'b', 'c', 'config.h')
        ]);
    });

    test('同じ深さではパス順に並べる', () => {
        const index = makeIndex(['zz/config.h', 'aa/config.h']);
        const found = buildFileNameSearchCandidates('config.h', index, [WORKSPACE]);
        assert.deepEqual(found, [
            path.join(WORKSPACE, 'aa', 'config.h'),
            path.join(WORKSPACE, 'zz', 'config.h')
        ]);
    });

    test('ディレクトリを含む記述はそのディレクトリ構成を満たすものだけを採用する', () => {
        const index = makeIndex([
            'hed/types.h',          // sub/ 配下ではないため対象外
            'hed/sub/types.h',      // 一致
            'other/sub/types.h'     // 一致
        ]);
        const found = buildFileNameSearchCandidates('sub/types.h', index, [WORKSPACE]);
        assert.deepEqual(found, [
            path.join(WORKSPACE, 'hed', 'sub', 'types.h'),
            path.join(WORKSPACE, 'other', 'sub', 'types.h')
        ]);
    });

    test('除外したディレクトリ配下は検索結果から取り除く', () => {
        const index = makeIndex(['variantA/config.h', 'variantB/config.h']);
        const found = buildFileNameSearchCandidates('config.h', index, [WORKSPACE], ['variantB']);
        assert.deepEqual(found, [path.join(WORKSPACE, 'variantA', 'config.h')]);
    });

    test('除外はサブディレクトリにも及ぶ', () => {
        const index = makeIndex(['legacy/old/inc/config.h', 'inc/config.h']);
        const found = buildFileNameSearchCandidates('config.h', index, [WORKSPACE], ['legacy']);
        assert.deepEqual(found, [path.join(WORKSPACE, 'inc', 'config.h')]);
    });

    test('空の索引では空配列を返す', () => {
        assert.deepEqual(buildFileNameSearchCandidates('config.h', new Map(), [WORKSPACE]), []);
    });

    test('フォルダ名指定は階層の途中にも及ぶ', () => {
        const index = makeIndex([
            'control/variantA/config.h',
            'control/sub/variantB/config.h',
            'hed/variantB_old/config.h'
        ]);
        const found = buildFileNameSearchCandidates('config.h', index, [WORKSPACE], ['variantB']);
        assert.deepEqual(
            found,
            [path.join(WORKSPACE, 'control', 'variantA', 'config.h')],
            '名前に variantB を含むフォルダの配下がすべて除外されること'
        );
    });
});

describe('buildIncludeCandidates: 重複の除去', () => {
    test('インクルード元ディレクトリとワークスペース直下が同じ場所でも1度だけ並べる', () => {
        const fromFile = path.join(WORKSPACE, 'main.c');
        const candidates = buildIncludeCandidates('config.h', fromFile, [WORKSPACE]);
        assert.deepEqual(candidates, normalize([path.join(WORKSPACE, 'config.h')]));
    });

    test('ワークスペースフォルダが重複していても候補は1つにまとめる', () => {
        const candidates = buildIncludeCandidates('config.h', null, [WORKSPACE, WORKSPACE]);
        assert.deepEqual(candidates, normalize([path.join(WORKSPACE, 'config.h')]));
    });
});
