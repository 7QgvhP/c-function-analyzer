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

describe('buildIncludeCandidates: includePaths 設定', () => {
    test('相対パスの設定をワークスペースからの相対として解決する', () => {
        // src/main.c から #include "types.h"、実体は include/types.h という構成
        const candidates = buildIncludeCandidates('types.h', FROM_FILE, [WORKSPACE], ['include']);
        assert.ok(
            candidates.includes(path.join(WORKSPACE, 'include', 'types.h')),
            `include/types.h が候補に含まれること: ${candidates}`
        );
    });

    test('絶対パスの設定はそのまま使用する', () => {
        const sdk = path.resolve('/sdk/include');
        const candidates = buildIncludeCandidates('driver.h', FROM_FILE, [WORKSPACE], [sdk]);
        assert.ok(
            candidates.includes(path.join(sdk, 'driver.h')),
            `絶対パスの候補が含まれること: ${candidates}`
        );
    });

    test('設定は記述順に、インクルード元ディレクトリの次・ワークスペース直下の前に並ぶ', () => {
        const candidates = buildIncludeCandidates(
            'types.h', FROM_FILE, [WORKSPACE], ['include', 'common/inc']
        );
        assert.deepEqual(candidates, normalize([
            path.join(WORKSPACE, 'src', 'types.h'),          // 1. インクルード元
            path.join(WORKSPACE, 'include', 'types.h'),      // 2. 設定（1つ目）
            path.join(WORKSPACE, 'common', 'inc', 'types.h'),// 2. 設定（2つ目）
            path.join(WORKSPACE, 'types.h')                  // 3. ワークスペース直下
        ]));
    });

    test('相対パスの設定は各ワークスペースフォルダに対して展開する', () => {
        const second = path.resolve('/other');
        const candidates = buildIncludeCandidates('types.h', null, [WORKSPACE, second], ['include']);
        assert.ok(candidates.includes(path.join(WORKSPACE, 'include', 'types.h')));
        assert.ok(candidates.includes(path.join(second, 'include', 'types.h')));
    });

    test('親ディレクトリを指す設定も解決する', () => {
        const candidates = buildIncludeCandidates('shared.h', null, [WORKSPACE], ['../shared']);
        assert.ok(
            candidates.includes(path.resolve(WORKSPACE, '../shared', 'shared.h')),
            `親ディレクトリの候補が含まれること: ${candidates}`
        );
    });

    test('空文字列の設定は無視する', () => {
        const candidates = buildIncludeCandidates('config.h', null, [WORKSPACE], ['', 'include']);
        assert.deepEqual(candidates, normalize([
            path.join(WORKSPACE, 'include', 'config.h'),
            path.join(WORKSPACE, 'config.h')
        ]));
    });

    test('設定が未指定でも従来どおり動作する', () => {
        const withEmpty = buildIncludeCandidates('config.h', FROM_FILE, [WORKSPACE], []);
        const withoutArg = buildIncludeCandidates('config.h', FROM_FILE, [WORKSPACE]);
        assert.deepEqual(withEmpty, withoutArg);
    });
});

describe('buildIncludeCandidates: excludePaths 設定', () => {
    test('除外したディレクトリ配下の候補を取り除く', () => {
        const candidates = buildIncludeCandidates(
            'config.h', null, [WORKSPACE], ['variantA', 'variantB'], ['variantB']
        );
        assert.ok(candidates.includes(path.join(WORKSPACE, 'variantA', 'config.h')), 'variantA は残ること');
        assert.ok(
            !candidates.includes(path.join(WORKSPACE, 'variantB', 'config.h')),
            'variantB は除外されること'
        );
    });

    test('除外はサブディレクトリにも及ぶ', () => {
        const candidates = buildIncludeCandidates(
            'config.h', null, [WORKSPACE], ['legacy/old/inc'], ['legacy']
        );
        assert.deepEqual(
            candidates,
            normalize([path.join(WORKSPACE, 'config.h')]),
            'legacy 配下はすべて除外されること'
        );
    });

    test('インクルード元ディレクトリの候補も除外できる', () => {
        const fromFile = path.join(WORKSPACE, 'variantB', 'main.c');
        const candidates = buildIncludeCandidates(
            'config.h', fromFile, [WORKSPACE], [], ['variantB']
        );
        assert.ok(
            !candidates.includes(path.join(WORKSPACE, 'variantB', 'config.h')),
            'インクルード元と同じディレクトリでも除外されること'
        );
    });

    test('絶対パスでの除外指定に対応する', () => {
        const sdk = path.resolve('/sdk/old');
        const candidates = buildIncludeCandidates(
            'driver.h', null, [WORKSPACE], [sdk], [sdk]
        );
        assert.ok(!candidates.includes(path.join(sdk, 'driver.h')), '絶対パスで除外されること');
    });

    test('除外指定がなければ従来どおり動作する', () => {
        const withEmpty = buildIncludeCandidates('config.h', FROM_FILE, [WORKSPACE], ['include'], []);
        const withoutArg = buildIncludeCandidates('config.h', FROM_FILE, [WORKSPACE], ['include']);
        assert.deepEqual(withEmpty, withoutArg);
    });

    test('区切り文字付きで指定すればディレクトリ単位で判定する', () => {
        // "./variantA" は区切りを含むためディレクトリ指定として扱われ、部分一致しない
        const candidates = buildIncludeCandidates(
            'config.h', null, [WORKSPACE], ['variantA'], ['./variant']
        );
        assert.ok(
            candidates.includes(path.join(WORKSPACE, 'variantA', 'config.h')),
            'ディレクトリ指定では前方一致で除外されないこと'
        );
    });
});

describe('buildIncludeCandidates: excludePaths のフォルダ名指定', () => {
    test('名前に指定文字列を含むフォルダの配下を除外する', () => {
        const candidates = buildIncludeCandidates(
            'config.h',
            null,
            [WORKSPACE],
            ['hed/variantB', 'hed/variantA'],
            ['variantB']
        );
        assert.ok(
            candidates.includes(path.join(WORKSPACE, 'hed', 'variantA', 'config.h')),
            'variantA は残ること'
        );
        assert.ok(
            !candidates.includes(path.join(WORKSPACE, 'hed', 'variantB', 'config.h')),
            '階層の途中にあっても除外されること'
        );
    });

    test('部分一致で判定する', () => {
        const candidates = buildIncludeCandidates(
            'config.h', null, [WORKSPACE], ['old_backup', 'current'], ['old']
        );
        assert.ok(candidates.includes(path.join(WORKSPACE, 'current', 'config.h')), 'current は残ること');
        assert.ok(
            !candidates.includes(path.join(WORKSPACE, 'old_backup', 'config.h')),
            '名前に old を含むフォルダは除外されること'
        );
    });

    test('大文字・小文字を区別しない', () => {
        const candidates = buildIncludeCandidates(
            'config.h', null, [WORKSPACE], ['VariantB'], ['variantb']
        );
        assert.ok(!candidates.includes(path.join(WORKSPACE, 'VariantB', 'config.h')));
    });

    test('ファイル名は判定対象に含めない', () => {
        // フォルダのみを対象とするため、variantB.h というファイルは除外されない
        const candidates = buildIncludeCandidates(
            'variantB.h', null, [WORKSPACE], [], ['variantB']
        );
        assert.ok(candidates.includes(path.join(WORKSPACE, 'variantB.h')), 'ファイル名では除外されないこと');
    });

    test('ワークスペース外のパスは判定対象にしない', () => {
        // C:\sdk\old_lib のようなワークスペース外のディレクトリに巻き込まれないこと
        const sdk = path.resolve('/sdk/old_lib');
        const candidates = buildIncludeCandidates(
            'driver.h', null, [WORKSPACE], [sdk], ['old']
        );
        assert.ok(
            candidates.includes(path.join(sdk, 'driver.h')),
            'ワークスペース外は名前指定の影響を受けないこと'
        );
    });

    test('ワークスペースフォルダ自体の名前は判定対象にしない', () => {
        // ワークスペースが C:\work\old_project でも、その中身は除外されないこと
        const workspace = path.resolve('/work/old_project');
        const candidates = buildIncludeCandidates('config.h', null, [workspace], [], ['old']);
        assert.deepEqual(candidates, normalize([path.join(workspace, 'config.h')]));
    });

    test('インクルード元ディレクトリの候補も除外できる', () => {
        const fromFile = path.join(WORKSPACE, 'control', 'variantB', 'main.c');
        const candidates = buildIncludeCandidates('config.h', fromFile, [WORKSPACE], [], ['variantB']);
        assert.ok(
            !candidates.includes(path.join(WORKSPACE, 'control', 'variantB', 'config.h')),
            'インクルード元と同じディレクトリでも除外されること'
        );
    });

    test('ディレクトリ指定とフォルダ名指定を併用できる', () => {
        const candidates = buildIncludeCandidates(
            'config.h',
            null,
            [WORKSPACE],
            ['legacy/inc', 'hed/variantB', 'hed/variantA'],
            ['legacy/inc', 'variantB']
        );
        assert.deepEqual(
            candidates,
            normalize([
                path.join(WORKSPACE, 'hed', 'variantA', 'config.h'),
                path.join(WORKSPACE, 'config.h')
            ])
        );
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

describe('buildIncludeCandidates: 旧設定との互換', () => {
    test('末尾の /** は基準ディレクトリとして扱う', () => {
        // 再帰探索を削除したため、旧設定が残っていても直下の探索として機能させる
        const candidates = buildIncludeCandidates('types.h', null, [WORKSPACE], ['hed/**']);
        assert.ok(
            candidates.includes(path.join(WORKSPACE, 'hed', 'types.h')),
            `hed 直下が候補に含まれること: ${candidates}`
        );
    });

    test('** のみの指定は無視する', () => {
        const candidates = buildIncludeCandidates('config.h', null, [WORKSPACE], ['**']);
        assert.deepEqual(candidates, normalize([path.join(WORKSPACE, 'config.h')]));
    });
});

describe('buildIncludeCandidates: 重複の除去', () => {
    test('同じ候補が複数回現れても1度だけ並べる', () => {
        // 設定 "." はワークスペース直下と同じ場所を指す
        const candidates = buildIncludeCandidates('config.h', null, [WORKSPACE], ['.']);
        assert.deepEqual(candidates, normalize([path.join(WORKSPACE, 'config.h')]));
    });

    test('インクルード元ディレクトリと同じ設定を重複させない', () => {
        const candidates = buildIncludeCandidates('config.h', FROM_FILE, [WORKSPACE], ['src']);
        const target = path.join(WORKSPACE, 'src', 'config.h');
        assert.equal(candidates.filter(c => c === target).length, 1, '重複しないこと');
    });
});
