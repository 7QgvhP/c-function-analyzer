/**
 * 定義位置の候補を除外する処理（excludePaths.ts）のテストです。
 *
 * パス文字列の操作のみを行う純関数のため、ファイルシステムなしで検証できます。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { createExcludeFilter } from '../src/excludePaths';

// Windows でもドライブレター付きの絶対パスになるよう resolve で組み立てる
const WORKSPACE = path.resolve('/proj');

describe('createExcludeFilter: 指定なし', () => {
    test('何も除外しない', () => {
        const isExcluded = createExcludeFilter([], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'hed', 'a.h')), false);
    });

    test('空文字列の指定は無視する', () => {
        const isExcluded = createExcludeFilter(['', ''], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'hed', 'a.h')), false);
    });
});

describe('createExcludeFilter: ディレクトリ指定', () => {
    test('指定したディレクトリの配下を除外する', () => {
        const isExcluded = createExcludeFilter(['legacy/old'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'legacy', 'old', 'a.h')), true);
        assert.equal(isExcluded(path.join(WORKSPACE, 'legacy', 'new', 'a.h')), false);
    });

    test('さらに深い階層にも及ぶ', () => {
        const isExcluded = createExcludeFilter(['legacy'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'legacy', 'a', 'b', 'c.h')), true);
    });

    test('絶対パスでの指定に対応する', () => {
        const sdk = path.resolve('/sdk/old');
        const isExcluded = createExcludeFilter([sdk], [WORKSPACE]);
        assert.equal(isExcluded(path.join(sdk, 'driver.h')), true);
    });

    test('前方一致では除外しない', () => {
        // "./variant" は区切りを含むためディレクトリ指定として扱われる
        const isExcluded = createExcludeFilter(['./variant'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'variantA', 'a.h')), false);
    });
});

describe('createExcludeFilter: フォルダ名指定', () => {
    test('名前に指定文字列を含むフォルダの配下を除外する', () => {
        const isExcluded = createExcludeFilter(['variantB'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'hed', 'variantB', 'a.h')), true);
        assert.equal(isExcluded(path.join(WORKSPACE, 'hed', 'variantA', 'a.h')), false);
    });

    test('階層の途中にあっても除外する', () => {
        const isExcluded = createExcludeFilter(['variantB'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'a', 'b', 'variantB', 'c', 'd.h')), true);
    });

    test('部分一致で判定する', () => {
        const isExcluded = createExcludeFilter(['old'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'old_backup', 'a.h')), true);
        assert.equal(isExcluded(path.join(WORKSPACE, 'current', 'a.h')), false);
    });

    test('大文字・小文字を区別しない', () => {
        const isExcluded = createExcludeFilter(['variantb'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'VariantB', 'a.h')), true);
    });

    test('ファイル名は判定対象に含めない', () => {
        const isExcluded = createExcludeFilter(['variantB'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'variantB.h')), false);
    });

    test('ワークスペース外のパスは判定対象にしない', () => {
        const sdk = path.resolve('/sdk/old_lib');
        const isExcluded = createExcludeFilter(['old'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(sdk, 'driver.h')), false);
    });

    test('ワークスペースフォルダ自体の名前は判定対象にしない', () => {
        const workspace = path.resolve('/work/old_project');
        const isExcluded = createExcludeFilter(['old'], [workspace]);
        assert.equal(isExcluded(path.join(workspace, 'a.h')), false);
    });

    test('ディレクトリ指定とフォルダ名指定を併用できる', () => {
        const isExcluded = createExcludeFilter(['legacy/inc', 'variantB'], [WORKSPACE]);
        assert.equal(isExcluded(path.join(WORKSPACE, 'legacy', 'inc', 'a.h')), true);
        assert.equal(isExcluded(path.join(WORKSPACE, 'hed', 'variantB', 'a.h')), true);
        assert.equal(isExcluded(path.join(WORKSPACE, 'hed', 'variantA', 'a.h')), false);
    });
});
