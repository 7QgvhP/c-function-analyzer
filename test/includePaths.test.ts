/**
 * includePaths.ts の探索候補パス構築に対するテストです。
 *
 * パス文字列の操作のみを行う純関数のため、ファイルシステムや VS Code なしで検証できます。
 * 期待値は実行環境の区切り文字に合わせて正規化して比較します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { buildIncludeCandidates } from '../src/includePaths';

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
