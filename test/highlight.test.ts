/**
 * highlight.ts のハイライト検索用正規表現生成に対するテストです。
 *
 * v1.15.1 で修正した「配列アクセスのみの項目 (hoge[]) がハイライトされない」不具合の
 * 回帰防止を主目的としています。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildHighlightRegex, isHighlightableName } from '../src/highlight';

/**
 * 指定コード行に対して、生成した正規表現がマッチした文字列をすべて返します。
 *
 * @param name Webview 上の項目名
 * @param line 検索対象のコード行
 * @returns マッチした文字列の配列
 */
function matchAll(name: string, line: string): string[] {
    const regex = buildHighlightRegex(name);
    return line.match(regex) ?? [];
}

describe('isHighlightableName', () => {
    test('通常の変数名はハイライト対象とする', () => {
        assert.equal(isHighlightableName('hoge'), true);
        assert.equal(isHighlightableName('hoge[]'), true);
        assert.equal(isHighlightableName('var_ptr->sub.member'), true);
    });

    test('「戻り値 (return)」はハイライト対象外とする (v1.13.3)', () => {
        assert.equal(isHighlightableName('戻り値 (return)'), false);
    });
});

describe('buildHighlightRegex', () => {
    test('単純な変数名にマッチする', () => {
        assert.deepEqual(matchAll('hoge', '    hoge = 1;'), ['hoge']);
    });

    test('部分一致する別の識別子にはマッチしない', () => {
        assert.deepEqual(matchAll('hoge', '    hogehoge = 1;'), []);
        assert.deepEqual(matchAll('hoge', '    my_hoge = 1;'), []);
    });

    test('配列アクセスのみの項目が添字付きのコードにマッチする (v1.15.1)', () => {
        assert.deepEqual(matchAll('hoge[]', '    hoge[0] = 50;'), ['hoge[0]']);
        assert.deepEqual(matchAll('hoge[]', '    hoge[i] = i;'), ['hoge[i]']);
        assert.deepEqual(matchAll('hoge[]', '    hoge[idx + 1] = 5;'), ['hoge[idx + 1]']);
    });

    test('配列アクセスのみの項目が行末・関数引数内でもマッチする (v1.15.1)', () => {
        assert.deepEqual(matchAll('hoge[]', '    return hoge[0];'), ['hoge[0]']);
        assert.deepEqual(matchAll('hoge[]', '    use(hoge[2]);'), ['hoge[2]']);
    });

    test('添字なしの記述にはマッチしない', () => {
        assert.deepEqual(matchAll('hoge[]', '    hoge = 1;'), []);
    });

    test('構造体配列のメンバアクセスパスにマッチする (v1.15.0)', () => {
        assert.deepEqual(matchAll('hogestruct[].a', '    hogestruct[0].a = 100;'), ['hogestruct[0].a']);
        assert.deepEqual(matchAll('hogestruct[].a', '    hogestruct[i].a = 100;'), ['hogestruct[i].a']);
    });

    test('構造体配列のメンバ名が異なる場合はマッチしない', () => {
        assert.deepEqual(matchAll('hogestruct[].a', '    hogestruct[0].b = 200;'), []);
    });

    test('多次元配列のアクセスパスにマッチする (v1.15.0)', () => {
        assert.deepEqual(matchAll('grid[][]', '    grid[1][2] = 20;'), ['grid[1][2]']);
    });

    test('アロー演算子とメンバアクセスを含むパスにマッチする (v1.15.0)', () => {
        assert.deepEqual(matchAll('var_ptr->sub.member', '    var_ptr->sub.member = 30;'), ['var_ptr->sub.member']);
    });

    test('ドットが任意の1文字として扱われない（メタ文字がエスケープされている）', () => {
        assert.deepEqual(matchAll('data.x', '    dataXx = 1;'), []);
    });

    test('同一行に複数出現する場合はすべてマッチする', () => {
        assert.deepEqual(matchAll('hoge[]', '    hoge[0] = hoge[1];'), ['hoge[0]', 'hoge[1]']);
    });
});
