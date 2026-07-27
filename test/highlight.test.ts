/**
 * highlight.ts のハイライト検索用正規表現生成に対するテストです。
 *
 * v1.15.1 で修正した「配列アクセスのみの項目 (hoge[]) がハイライトされない」不具合の
 * 回帰防止を主目的としています。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildHighlightRegex } from '../src/highlight';

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

    test('宣言された次元を含む項目名でも任意の添字にマッチする (v2.3.0)', () => {
        // 表示名が hoge[N] でも、コード上の実際の添字にマッチする必要がある
        assert.deepEqual(matchAll('hoge[N]', '    hoge[2] = 10;'), ['hoge[2]']);
        assert.deepEqual(matchAll('hoge[N]', '    hoge[i] = 20;'), ['hoge[i]']);
        assert.deepEqual(matchAll('hoge[N]', '    val = hoge[N - 1];'), ['hoge[N - 1]']);
        assert.deepEqual(matchAll('hoge[N]', '    int hoge[N];'), ['hoge[N]']);
    });

    test('宣言された次元を含む多次元・構造体パスにもマッチする (v2.3.0)', () => {
        assert.deepEqual(matchAll('grid[3][4]', '    grid[1][2] = 20;'), ['grid[1][2]']);
        assert.deepEqual(matchAll('tbl[5].id', '    tbl[0].id = 1;'), ['tbl[0].id']);
    });

    test('添字を含む項目名は添字なしの参照にはマッチしない (v2.3.0)', () => {
        // 配列全体を渡す用法は対象外（従来の [] 表記と同じ挙動）
        assert.deepEqual(matchAll('hoge[N]', '    memcpy(dst, hoge, n);'), []);
    });

    test('添字の中に空白や演算子を含む項目名でもマッチする (v2.3.0)', () => {
        // int buf[MAX + 1]; のように次元が式である場合、表示名にも空白が含まれる
        assert.deepEqual(matchAll('buf[MAX + 1]', '    buf[0] = 1;'), ['buf[0]']);
        assert.deepEqual(matchAll('buf[MAX + 1]', '    buf[idx] = 2;'), ['buf[idx]']);
    });

    test('添字の退避処理が角括弧を含まない名前に影響しない (v2.3.0)', () => {
        assert.deepEqual(matchAll('data.x', '    dataXx = 1;'), []);
        assert.deepEqual(matchAll('data.x', '    data.x = 1;'), ['data.x']);
        assert.deepEqual(matchAll('ptr->member', '    ptr->member = 1;'), ['ptr->member']);
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
