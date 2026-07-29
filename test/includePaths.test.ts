/**
 * includePaths.ts の探索候補パス構築に対するテストです。
 *
 * パス文字列の操作のみを行う純関数のため、ファイルシステムや VS Code なしで検証できます。
 * 期待値は実行環境の区切り文字に合わせて正規化して比較します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { buildIncludeCandidates, parseSearchPathEntry } from '../src/includePaths';

/**
 * 仮想的なディレクトリ構成からサブディレクトリを列挙する関数を作ります。
 *
 * @param tree 親ディレクトリ → 直下のサブディレクトリ名 のマップ
 * @returns サブディレクトリを列挙する関数
 */
function fakeLister(tree: Record<string, string[]>): (dir: string) => string[] {
    return (dir: string) => {
        const names = tree[path.normalize(dir)] ?? [];
        return names.map(name => path.join(dir, name));
    };
}

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

describe('parseSearchPathEntry: 再帰指定の判定', () => {
    test('末尾が ** の指定を再帰として扱う', () => {
        assert.deepEqual(parseSearchPathEntry('hed/**'), { base: 'hed', recursive: true });
        assert.deepEqual(parseSearchPathEntry('hed\\**'), { base: 'hed', recursive: true });
        assert.deepEqual(parseSearchPathEntry('a/b/**'), { base: path.join('a', 'b'), recursive: true });
    });

    test('末尾の区切り文字を無視して判定する', () => {
        assert.deepEqual(parseSearchPathEntry('hed/**/'), { base: 'hed', recursive: true });
        assert.deepEqual(parseSearchPathEntry('hed/'), { base: 'hed', recursive: false });
    });

    test('** がない指定は再帰扱いしない', () => {
        assert.deepEqual(parseSearchPathEntry('hed'), { base: 'hed', recursive: false });
        assert.deepEqual(parseSearchPathEntry('include/hal'), { base: 'include/hal', recursive: false });
    });

    test('** 単独はワークスペース全体の再帰指定となる', () => {
        assert.deepEqual(parseSearchPathEntry('**'), { base: '', recursive: true });
    });
});

describe('buildIncludeCandidates: 再帰探索', () => {
    // proj/hed/{6room_multi, common/{sub}}
    const TREE = {
        [path.join(WORKSPACE, 'hed')]: ['6room_multi', 'common'],
        [path.join(WORKSPACE, 'hed', 'common')]: ['sub']
    };

    test('配下のディレクトリを浅い順に候補へ加える', () => {
        const candidates = buildIncludeCandidates(
            'hoge.h', null, [WORKSPACE], ['hed/**'], [], fakeLister(TREE)
        );
        assert.deepEqual(candidates, normalize([
            path.join(WORKSPACE, 'hed', 'hoge.h'),
            path.join(WORKSPACE, 'hed', '6room_multi', 'hoge.h'),
            path.join(WORKSPACE, 'hed', 'common', 'hoge.h'),
            path.join(WORKSPACE, 'hed', 'common', 'sub', 'hoge.h'),
            path.join(WORKSPACE, 'hoge.h')
        ]), '浅いディレクトリが先に並ぶこと');
    });

    test('再帰指定でないディレクトリは直下のみを探索する', () => {
        const candidates = buildIncludeCandidates(
            'hoge.h', null, [WORKSPACE], ['hed'], [], fakeLister(TREE)
        );
        assert.deepEqual(candidates, normalize([
            path.join(WORKSPACE, 'hed', 'hoge.h'),
            path.join(WORKSPACE, 'hoge.h')
        ]), 'サブディレクトリは含まれないこと');
    });

    test('列挙関数がない場合は再帰指定を基準ディレクトリとして扱う', () => {
        // 後方互換のため、展開できない場合も設定が無効にはならない
        const candidates = buildIncludeCandidates('hoge.h', null, [WORKSPACE], ['hed/**']);
        assert.ok(
            candidates.includes(path.join(WORKSPACE, 'hed', 'hoge.h')),
            '基準ディレクトリは候補に残ること'
        );
    });

    test('除外ディレクトリは再帰展開の対象から外れる', () => {
        const candidates = buildIncludeCandidates(
            'hoge.h', null, [WORKSPACE], ['hed/**'], ['hed/common'], fakeLister(TREE)
        );
        assert.ok(candidates.includes(path.join(WORKSPACE, 'hed', '6room_multi', 'hoge.h')));
        assert.ok(
            !candidates.some(c => c.includes(path.join('hed', 'common'))),
            'hed/common とその配下が展開されないこと'
        );
    });

    test('絶対パスの再帰指定に対応する', () => {
        const sdk = path.resolve('/sdk');
        const tree = { [sdk]: ['inc'] };
        const candidates = buildIncludeCandidates(
            'driver.h', null, [WORKSPACE], [sdk + path.sep + '**'], [], fakeLister(tree)
        );
        assert.ok(candidates.includes(path.join(sdk, 'driver.h')));
        assert.ok(candidates.includes(path.join(sdk, 'inc', 'driver.h')));
    });

    test('同じディレクトリを二重に辿らない', () => {
        // 循環するような列挙を返しても停止すること
        const cyclic = (dir: string) => [path.join(dir, 'loop')];
        const candidates = buildIncludeCandidates(
            'hoge.h', null, [WORKSPACE], ['hed/**'], [], cyclic
        );
        // 深さ上限で打ち切られ、有限個で終わる
        assert.ok(candidates.length > 1, '展開されること');
        assert.ok(candidates.length < 100, `無限に増えないこと: ${candidates.length}`);
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

    test('除外ディレクトリと同名の別ディレクトリは除外しない', () => {
        // "variant" を除外しても "variantA" は対象外にならないこと
        const candidates = buildIncludeCandidates(
            'config.h', null, [WORKSPACE], ['variantA'], ['variant']
        );
        assert.ok(
            candidates.includes(path.join(WORKSPACE, 'variantA', 'config.h')),
            '前方一致ではなくディレクトリ単位で判定されること'
        );
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
