/**
 * analyzer.ts の解析・分類ロジックに対する回帰テストです。
 *
 * 各テストは CHANGELOG に記録された過去の不具合修正と対応しており、
 * リファクタリング時に同じ不具合を再発させないための安全網として機能します。
 * テスト名の末尾にある (vX.Y.Z) は、その挙動が確定したバージョンを示します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, analyzeOrThrow, names, findVar } from './support/parse';

describe('フェーズ3: シグネチャ解析', () => {
    test('関数名と戻り値の型を取得する', async () => {
        const r = await analyzeOrThrow(`
int add(int a, int b) {
    return a + b;
}
`, 'int add(');
        assert.equal(r.functionName, 'add');
        assert.equal(r.returnType, 'int');
    });

    test('void 関数では「戻り値 (return)」を出力に含めない', async () => {
        const r = await analyzeOrThrow(`
void nothing(int a) {
    (void)a;
}
`, 'void nothing(');
        assert.ok(!names(r.outputs).includes('戻り値 (return)'));
    });

    test('static void でも「戻り値 (return)」を出力に含めない (v1.13.2)', async () => {
        const r = await analyzeOrThrow(`
static void quiet(int a) {
    (void)a;
}
`, 'static void quiet(');
        assert.ok(!names(r.outputs).includes('戻り値 (return)'));
    });

    test('戻り値がある関数では「戻り値 (return)」を出力に含める', async () => {
        const r = await analyzeOrThrow(`
int one(void) {
    return 1;
}
`, 'int one(');
        const ret = findVar(r.outputs, '戻り値 (return)');
        assert.ok(ret, '「戻り値 (return)」が出力に存在すること');
        assert.equal(ret.type, 'int');
    });

    test('ポインタ引数の型に * が二重付与されない (v1.1.1)', async () => {
        const r = await analyzeOrThrow(`
void writer(int *out) {
    *out = 1;
}
`, 'void writer(');
        const out = findVar(r.outputs, 'out');
        assert.ok(out, '引数 out が出力に存在すること');
        assert.ok(!out.type.includes('**'), `型に * が二重付与されている: ${out.type}`);
    });

    test('ポインタ戻り値の型にアスタリスクを付与する', async () => {
        const r = await analyzeOrThrow(`
char *fetch(void) {
    return 0;
}
`, 'char *fetch(');
        assert.equal(r.functionName, 'fetch');
        assert.ok(r.returnType.includes('*'), `戻り値型に * が含まれること: ${r.returnType}`);
    });

    test('引数名が型名に含まれる場合も型名を正しく取得する (v1.16.1)', async () => {
        // 「struct data data」のように引数名が型名の一部と一致するケース
        const r = await analyzeOrThrow(`
struct data { int v; };

int read_value(struct data data) {
    return data.v;
}
`, 'int read_value(');
        const p = findVar(r.inputs, 'data');
        assert.ok(p, '入力に data が含まれること');
        assert.equal(p.type, 'struct data');
    });

    test('関数ポインタを返す関数では本来の引数リストを採用する (v1.16.1)', async () => {
        const r = await analyzeOrThrow(`
void (*get_handler(int id))(char *msg) {
    return 0;
}
`, 'void (*get_handler(');
        assert.equal(r.functionName, 'get_handler');
        assert.ok(names(r.inputs).includes('id'), `入力に id が含まれること: ${names(r.inputs)}`);
        assert.ok(!names(r.inputs).includes('msg'), `入力に msg が含まれないこと: ${names(r.inputs)}`);
    });

    test('ポインタ・配列引数の型をアスタリスク付きで正規化する (v1.16.1)', async () => {
        const r = await analyzeOrThrow(`
void update(int *single, int **doubled, int arr[]) {
    *single = 1;
    **doubled = 2;
    arr[0] = 3;
}
`, 'void update(');
        assert.equal(findVar(r.outputs, 'single')?.type, 'int*');
        assert.equal(findVar(r.outputs, 'doubled')?.type, 'int**');
        assert.equal(findVar(r.outputs, 'arr[]')?.type, 'int*');
    });

    test('関数ポインタ引数の名前を解決する (v1.16.1)', async () => {
        const r = await analyzeOrThrow(`
void register_cb(int (*cb)(int)) {
    (void)cb;
}
`, 'void register_cb(');
        assert.ok(names(r.inputs).includes('cb'), `入力に cb が含まれること: ${names(r.inputs)}`);
    });
});

describe('フェーズ2: カーソル位置判定', () => {
    test('シグネチャ行では解析が成功する', async () => {
        const r = await analyze(`
int target(int a) {
    return a;
}
`, 'int target(');
        assert.ok(r, 'シグネチャ行では解析結果が返ること');
    });

    test('関数ボディ内の行では null を返す', async () => {
        const r = await analyze(`
int target(int a) {
    int local = a;
    return local;
}
`, 'int local = a');
        assert.equal(r, null);
    });

    test('複数行にまたがるシグネチャの引数行でも解析が成功する', async () => {
        const r = await analyze(`
int multi(
    int alpha,
    int beta
) {
    return alpha + beta;
}
`, 'int beta');
        assert.ok(r, '引数行でも解析結果が返ること');
        assert.equal(r.functionName, 'multi');
    });
});

describe('フェーズ5: 引数の入出力分類', () => {
    test('値渡し引数は入力に分類される', async () => {
        const r = await analyzeOrThrow(`
int calc(int base) {
    return base * 2;
}
`, 'int calc(');
        const base = findVar(r.inputs, 'base');
        assert.ok(base, '引数 base が入力に存在すること');
        assert.equal(base.details, '入力引数（値渡し）');
    });

    test('書き込みのみのポインタ引数は出力に分類される', async () => {
        const r = await analyzeOrThrow(`
void writer(int *out) {
    *out = 5;
}
`, 'void writer(');
        assert.ok(names(r.outputs).includes('out'));
        assert.ok(!names(r.inputs).includes('out'));
    });

    test('読み書き両方のポインタ引数は入力と出力の双方に分類される (v1.8.0)', async () => {
        const r = await analyzeOrThrow(`
void bump(int *p) {
    *p = *p + 1;
}
`, 'void bump(');
        assert.ok(names(r.inputs).includes('p'), '入力に p が含まれること');
        assert.ok(names(r.outputs).includes('p'), '出力に p が含まれること');
    });

    test('配列引数への書き込みは出力になり、グローバル変数として誤検出されない (v1.1.1)', async () => {
        const r = await analyzeOrThrow(`
void fill(int a[], int *b) {
    a[5] = 10;
    b[0] = 20;
}
`, 'void fill(');
        assert.ok(names(r.outputs).includes('a[]'), `出力に a[] が含まれること: ${names(r.outputs)}`);
        assert.ok(names(r.outputs).includes('b[]'), `出力に b[] が含まれること: ${names(r.outputs)}`);

        // 引数由来のため「グローバル変数への書き込み」として分類されてはならない
        const globalWrites = r.outputs.filter(v => v.details === 'グローバル変数への書き込み');
        assert.deepEqual(names(globalWrites), [], 'グローバル変数として誤検出されないこと');
    });
});

describe('フェーズ4/5: グローバル変数の分類', () => {
    test('読み取りのみのグローバル変数は入力に分類される', async () => {
        const r = await analyzeOrThrow(`
int threshold = 100;

int check(int v) {
    return v > threshold;
}
`, 'int check(');
        const g = findVar(r.inputs, 'threshold');
        assert.ok(g, '入力に threshold が含まれること');
        assert.equal(g.details, 'グローバル変数からの読み取り');
    });

    test('書き込みのみのグローバル変数は出力に分類される', async () => {
        const r = await analyzeOrThrow(`
int status = 0;

void reset(void) {
    status = 0;
}
`, 'void reset(');
        const g = findVar(r.outputs, 'status');
        assert.ok(g, '出力に status が含まれること');
        assert.equal(g.details, 'グローバル変数への書き込み');
    });

    test('代入の左辺は入力に重複して分類されない (v1.11.1)', async () => {
        const r = await analyzeOrThrow(`
int gval;

void store(void) {
    gval = 1;
}
`, 'void store(');
        assert.ok(names(r.outputs).includes('gval'), '出力に gval が含まれること');
        assert.ok(!names(r.inputs).includes('gval'), '入力に gval が重複しないこと');
    });

    test('複合代入 (+=) は入力と出力の双方に分類される (v1.13.3)', async () => {
        const r = await analyzeOrThrow(`
int total;

void accumulate(void) {
    total += 5;
}
`, 'void accumulate(');
        assert.ok(names(r.inputs).includes('total'), '入力に total が含まれること');
        assert.ok(names(r.outputs).includes('total'), '出力に total が含まれること');
    });

    test('インクリメント (++) は入力と出力の双方に分類される (v1.13.3)', async () => {
        const r = await analyzeOrThrow(`
int counter;

void tick(void) {
    counter++;
}
`, 'void tick(');
        assert.ok(names(r.inputs).includes('counter'), '入力に counter が含まれること');
        assert.ok(names(r.outputs).includes('counter'), '出力に counter が含まれること');
    });

    test('グローバル配列への書き込みを検出しアクセスパスを正規化する (v1.13.4)', async () => {
        const r = await analyzeOrThrow(`
int hoge[10];

void fill(void) {
    hoge[0] = 3;
}
`, 'void fill(');
        assert.ok(names(r.outputs).includes('hoge[]'), `出力に hoge[] が含まれること: ${names(r.outputs)}`);
    });

    test('グローバル構造体配列のメンバ書き込みを検出する (v1.13.4 / v1.15.0)', async () => {
        const r = await analyzeOrThrow(`
typedef struct { int a; int b; } HOGESTRUCT;
HOGESTRUCT hogestruct[5];

void update(void) {
    hogestruct[0].a = 100;
}
`, 'void update(');
        assert.ok(names(r.outputs).includes('hogestruct[].a'), `出力に hogestruct[].a が含まれること: ${names(r.outputs)}`);
    });

    test('多次元配列のアクセスパスを [][] に正規化する (v1.15.0)', async () => {
        const r = await analyzeOrThrow(`
int grid[3][4];

void fill(void) {
    grid[1][2] = 20;
}
`, 'void fill(');
        assert.ok(names(r.outputs).includes('grid[][]'), `出力に grid[][] が含まれること: ${names(r.outputs)}`);
    });

    test('アロー演算子とメンバアクセスのパスを保持する (v1.15.0)', async () => {
        const r = await analyzeOrThrow(`
struct Sub { int member; };
struct Outer { struct Sub sub; };
struct Outer *var_ptr;

void update(void) {
    var_ptr->sub.member = 30;
}
`, 'void update(');
        assert.ok(names(r.outputs).includes('var_ptr->sub.member'), `出力に var_ptr->sub.member が含まれること: ${names(r.outputs)}`);
    });

    test('ファイル内で定義されたグローバル変数の型を適用する (v1.13.0)', async () => {
        const r = await analyzeOrThrow(`
float ratio = 1.5;

float scale(float v) {
    return v * ratio;
}
`, 'float scale(');
        const g = findVar(r.inputs, 'ratio');
        assert.ok(g, '入力に ratio が含まれること');
        assert.equal(g.type, 'float');
    });

    test('ファイル内に定義がないグローバル変数は global (推定) とする (v1.13.0)', async () => {
        const r = await analyzeOrThrow(`
void publish(void) {
    external_flag = 1;
}
`, 'void publish(');
        const g = findVar(r.outputs, 'external_flag');
        assert.ok(g, '出力に external_flag が含まれること');
        assert.equal(g.type, 'global (推定)');
    });

    test('インライン構造体定義を含むグローバル変数の型名から波括弧を除去する (v1.13.3)', async () => {
        const r = await analyzeOrThrow(`
struct Data { int x; } global_data;

void update(void) {
    global_data.x = 1;
}
`, 'void update(');
        const g = findVar(r.outputs, 'global_data.x');
        assert.ok(g, `出力に global_data.x が含まれること: ${names(r.outputs)}`);
        assert.ok(!g.type.includes('{'), `型名に波括弧が含まれないこと: ${g.type}`);
    });

    test('ファイルスコープの関数ポインタ変数の型情報を取得する (v1.16.1)', async () => {
        const r = await analyzeOrThrow(`
int (*handler)(int);

void reset_handler(void) {
    handler = 0;
}
`, 'void reset_handler(');
        const g = findVar(r.outputs, 'handler');
        assert.ok(g, `出力に handler が含まれること: ${names(r.outputs)}`);
        assert.equal(g.type, 'int*', '関数ポインタ変数として型が解決されること');
    });

    test('関数プロトタイプ宣言はグローバル変数として扱わない (v1.16.1)', async () => {
        const r = await analyzeOrThrow(`
int compute(int v);

int run(void) {
    return compute(1);
}
`, 'int run(');
        assert.ok(!names(r.inputs).includes('compute'), `入力に compute が含まれないこと: ${names(r.inputs)}`);
        assert.ok(r.calledFunctions.includes('compute'), `呼び出し関数に compute が含まれること: ${r.calledFunctions}`);
    });

    test('除外リストの識別子 (NULL など) は入力に分類されない', async () => {
        const r = await analyzeOrThrow(`
int check(const char *s) {
    if (s == NULL) {
        return 0;
    }
    return 1;
}
`, 'int check(');
        assert.ok(!names(r.inputs).includes('NULL'), '入力に NULL が含まれないこと');
        assert.ok(!names(r.outputs).includes('NULL'), '出力に NULL が含まれないこと');
    });
});

describe('フェーズ4: ローカル変数の抽出', () => {
    test('単純なローカル変数の宣言を抽出する', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int temp = 10;
}
`, 'void work(');
        const v = findVar(r.internalVariables, 'temp');
        assert.ok(v, '内部変数に temp が含まれること');
        assert.equal(v.type, 'int');
    });

    test('カンマ区切りの複数宣言をすべて抽出する', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int a = 1, b = 2, c;
}
`, 'void work(');
        const got = names(r.internalVariables);
        assert.ok(got.includes('a') && got.includes('b') && got.includes('c'), `a/b/c すべて抽出されること: ${got}`);
    });

    test('関数ポインタ変数の宣言を内部変数として抽出する (v1.5.2)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int (*math_func)(int, float) = 0;
}
`, 'void work(');
        assert.ok(names(r.internalVariables).includes('math_func'), `内部変数に math_func が含まれること: ${names(r.internalVariables)}`);
    });

    test('配列および多重ポインタのローカル宣言を抽出する', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int buf[16];
    char **argv_copy;
}
`, 'void work(');
        const got = names(r.internalVariables);
        assert.ok(got.includes('buf'), `内部変数に buf が含まれること: ${got}`);
        assert.ok(got.includes('argv_copy'), `内部変数に argv_copy が含まれること: ${got}`);
    });

    test('ローカル変数のインライン構造体型名から波括弧を除去する (v1.16.1)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    struct Named { int x; } named;
    struct { int y; } anonymous;
    named.x = 1;
    anonymous.y = 2;
}
`, 'void work(');
        const named = findVar(r.internalVariables, 'named');
        assert.ok(named, '内部変数に named が含まれること');
        assert.equal(named.type, 'struct Named');

        const anonymous = findVar(r.internalVariables, 'anonymous');
        assert.ok(anonymous, '内部変数に anonymous が含まれること');
        assert.ok(!anonymous.type.includes('{'), `型名に波括弧が含まれないこと: ${anonymous.type}`);
    });
});

describe('フェーズ4: 関数呼び出しの抽出', () => {
    test('直接呼び出しを検出する', async () => {
        const r = await analyzeOrThrow(`
void log_message(const char *m);

void work(void) {
    log_message("hello");
}
`, 'void work(');
        assert.ok(r.calledFunctions.includes('log_message'), `呼び出し関数に log_message が含まれること: ${r.calledFunctions}`);
    });

    test('関数ポインタ経由の呼び出しは呼び出し関数から除外する (v1.5.2)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int (*fp)(int) = 0;
    int result = fp(1);
}
`, 'void work(');
        assert.ok(!r.calledFunctions.includes('fp'), `呼び出し関数に fp が含まれないこと: ${r.calledFunctions}`);
        assert.ok(!names(r.inputs).includes('fp'), `入力に fp が含まれないこと: ${names(r.inputs)}`);
    });

    test('同一関数の複数回呼び出しを重複排除する', async () => {
        const r = await analyzeOrThrow(`
void helper(int v);

void work(void) {
    helper(1);
    helper(2);
    helper(3);
}
`, 'void work(');
        const occurrences = r.calledFunctions.filter(f => f === 'helper');
        assert.equal(occurrences.length, 1, `helper が1件のみであること: ${r.calledFunctions}`);
    });
});

describe('フェーズ5: 大文字マクロ分類', () => {
    test('大文字のみの呼び出しをマクロ関数に分類する (v1.3.0)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    LOG_MSG("hello");
}
`, 'void work(');
        assert.ok(r.macroFunctions?.includes('LOG_MSG'), `マクロ関数に LOG_MSG が含まれること: ${r.macroFunctions}`);
        assert.ok(!r.calledFunctions.includes('LOG_MSG'), '通常の呼び出し関数には含まれないこと');
    });

    test('大文字のみのグローバル参照をマクロ変数に分類する (v1.3.0)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int v = MAX_LIMIT;
}
`, 'void work(');
        assert.ok(names(r.macroVariables ?? []).includes('MAX_LIMIT'), `マクロ変数に MAX_LIMIT が含まれること: ${names(r.macroVariables ?? [])}`);
        assert.ok(!names(r.inputs).includes('MAX_LIMIT'), '入力変数には含まれないこと');
    });

    test('オプション無効時は大文字識別子を通常分類する (v1.3.0)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int v = MAX_LIMIT;
    LOG_MSG("hello");
}
`, 'void work(', false);
        assert.ok(names(r.inputs).includes('MAX_LIMIT'), `入力に MAX_LIMIT が含まれること: ${names(r.inputs)}`);
        assert.ok(r.calledFunctions.includes('LOG_MSG'), `呼び出し関数に LOG_MSG が含まれること: ${r.calledFunctions}`);
        assert.deepEqual(r.macroVariables, [], 'マクロ変数は空であること');
        assert.deepEqual(r.macroFunctions, [], 'マクロ関数は空であること');
    });
});

describe('既知の不具合（段階3で修正予定）', () => {
    test('C-1: 呼び出し前に参照された関数名をグローバル変数と誤分類しない', { todo: '宣言・呼び出しの収集と読み書き分類を2パスに分離する必要がある' }, async () => {
        const r = await analyzeOrThrow(`
int helper(int x);

void work(void) {
    int (*fp)(int) = helper;
    int result = fp(1);
}
`, 'void work(');
        assert.ok(!names(r.inputs).includes('helper'), `入力に helper が含まれないこと: ${names(r.inputs)}`);
    });
});
