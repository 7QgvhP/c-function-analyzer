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

    test('複数の関数定義がある場合にカーソル行の関数を同定する', async () => {
        const src = `
int first(int a) {
    return a;
}

int second(int b) {
    return b;
}
`;
        assert.equal((await analyzeOrThrow(src, 'int first(')).functionName, 'first');
        assert.equal((await analyzeOrThrow(src, 'int second(')).functionName, 'second');
    });

    test('プリプロセッサ条件 (#ifdef) 内の関数定義も同定する', async () => {
        const r = await analyzeOrThrow(`
#ifdef DEBUG
void debug_func(int level) {
    (void)level;
}
#endif
`, 'void debug_func(');
        assert.equal(r.functionName, 'debug_func');
        assert.ok(names(r.inputs).includes('level'), `入力に level が含まれること: ${names(r.inputs)}`);
    });

    test('関数の外側（グローバル宣言の行）では null を返す', async () => {
        const r = await analyze(`
int global_var = 0;

int fn(void) {
    return global_var;
}
`, 'int global_var = 0');
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

    test('グローバル配列への書き込みを検出し宣言された次元を表示する (v1.13.4 / v2.3.0)', async () => {
        const r = await analyzeOrThrow(`
int hoge[10];

void fill(void) {
    hoge[0] = 3;
}
`, 'void fill(');
        assert.ok(names(r.outputs).includes('hoge[10]'), `出力に hoge[10] が含まれること: ${names(r.outputs)}`);
        assert.equal(findVar(r.outputs, 'hoge[10]')?.type, 'int', '名前側に次元があるため型は int とすること');
    });

    test('グローバル構造体配列のメンバ書き込みを検出する (v1.13.4 / v1.15.0)', async () => {
        const r = await analyzeOrThrow(`
typedef struct { int a; int b; } HOGESTRUCT;
HOGESTRUCT hogestruct[5];

void update(void) {
    hogestruct[0].a = 100;
}
`, 'void update(');
        assert.ok(names(r.outputs).includes('hogestruct[5].a'), `出力に hogestruct[5].a が含まれること: ${names(r.outputs)}`);
    });

    test('多次元配列のアクセスパスに宣言された次元を反映する (v1.15.0 / v2.3.0)', async () => {
        const r = await analyzeOrThrow(`
int grid[3][4];

void fill(void) {
    grid[1][2] = 20;
}
`, 'void fill(');
        assert.ok(names(r.outputs).includes('grid[3][4]'), `出力に grid[3][4] が含まれること: ${names(r.outputs)}`);
    });

    test('マクロ定数で宣言された配列の次元をそのまま表示する (v2.3.0)', async () => {
        const r = await analyzeOrThrow(`
#define N 16
int hoge[N];

void fill(int i) {
    hoge[2] = 3;
    hoge[i] = 4;
}
`, 'void fill(');
        // 添字の値によらず、宣言された次元 N で1件に集約される
        const matched = names(r.outputs).filter(n => n.startsWith('hoge'));
        assert.deepEqual(matched, ['hoge[N]'], `hoge[N] の1件に集約されること: ${names(r.outputs)}`);
    });

    test('宣言の次元が不明な配列は [] のままとする (v2.3.0)', async () => {
        const r = await analyzeOrThrow(`
extern int buf[];
int *ptr;

void fill(void) {
    buf[0] = 1;
    ptr[0] = 2;
}
`, 'void fill(');
        assert.ok(names(r.outputs).includes('buf[]'), `サイズ省略の配列は buf[] のままであること: ${names(r.outputs)}`);
        assert.ok(names(r.outputs).includes('ptr[]'), `ポインタは ptr[] のままであること: ${names(r.outputs)}`);
    });

    test('添字なしで参照される配列は型名側に次元を表示する (v2.3.0)', async () => {
        const r = await analyzeOrThrow(`
int table[8];

int sum(void) {
    return total(table);
}
`, 'int sum(');
        const g = findVar(r.inputs, 'table');
        assert.ok(g, `入力に table が含まれること: ${names(r.inputs)}`);
        assert.equal(g.type, 'int[8]', '名前に添字がないため型側に次元を出すこと');
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

    test('ファイル内に定義がないグローバル変数は (推定) とする (v1.13.0)', async () => {
        const r = await analyzeOrThrow(`
void publish(void) {
    external_flag = 1;
}
`, 'void publish(');
        const g = findVar(r.outputs, 'external_flag');
        assert.ok(g, '出力に external_flag が含まれること');
        assert.equal(g.type, '(推定)');
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

    test('引数の配列はポインタ表記のままとする (v2.2.1)', async () => {
        // 引数の配列は C の仕様上ポインタへ減衰するため、宣言変数とは表記を分ける
        const r = await analyzeOrThrow(`
void fill(int param_arr[5]) {
    param_arr[0] = 1;
}
`, 'void fill(');
        assert.equal(findVar(r.outputs, 'param_arr[]')?.type, 'int*', '角括弧ではなくアスタリスク表記であること');
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
        assert.ok(names(r.calledFunctions).includes('compute'), `呼び出し関数に compute が含まれること: ${names(r.calledFunctions)}`);
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

    test('配列宣言の型に次元とサイズを表示する (v2.2.1)', async () => {
        const r = await analyzeOrThrow(`
#define MAX_LEN 32

void work(void) {
    int hoge_array[5] = {0};
    int grid[3][4];
    char buf[] = "x";
    char sized[MAX_LEN];
    int *ptrs[8];
    int plain;
}
`, 'void work(');
        assert.equal(findVar(r.internalVariables, 'hoge_array')?.type, 'int[5]');
        assert.equal(findVar(r.internalVariables, 'grid')?.type, 'int[3][4]', '多次元は宣言と同じ順序で並ぶこと');
        assert.equal(findVar(r.internalVariables, 'buf')?.type, 'char[]', 'サイズ省略時は空の角括弧とすること');
        assert.equal(findVar(r.internalVariables, 'sized')?.type, 'char[MAX_LEN]', 'マクロ定数のサイズもそのまま表示すること');
        assert.equal(findVar(r.internalVariables, 'ptrs')?.type, 'int*[8]', 'ポインタ配列はアスタリスクと角括弧の両方が付くこと');
        assert.equal(findVar(r.internalVariables, 'plain')?.type, 'int', '配列でない変数には角括弧を付けないこと');
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
        assert.ok(names(r.calledFunctions).includes('log_message'), `呼び出し関数に log_message が含まれること: ${names(r.calledFunctions)}`);
    });

    test('関数ポインタ経由の呼び出しは呼び出し関数から除外する (v1.5.2)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int (*fp)(int) = 0;
    int result = fp(1);
}
`, 'void work(');
        assert.ok(!names(r.calledFunctions).includes('fp'), `呼び出し関数に fp が含まれないこと: ${names(r.calledFunctions)}`);
        assert.ok(!names(r.inputs).includes('fp'), `入力に fp が含まれないこと: ${names(r.inputs)}`);
    });

    test('呼び出し関数に戻り値の型を持たせる (v2.14.0)', async () => {
        const r = await analyzeOrThrow(`
int compute(int v);
void log_message(const char *m);
char *fetch(void);

void work(void) {
    compute(1);
    log_message("hello");
    fetch();
}
`, 'void work(');
        const typeOf = (name: string) => r.calledFunctions.find(f => f.name === name)?.type;
        assert.equal(typeOf('compute'), 'int');
        assert.equal(typeOf('log_message'), 'void', 'void も明示すること');
        assert.equal(typeOf('fetch'), 'char*', 'ポインタ戻り値はアスタリスク付きとなること');
    });

    test('関数定義からも戻り値の型を取得する (v2.14.0)', async () => {
        const r = await analyzeOrThrow(`
static void helper(int x) {
    (void)x;
}

void work(void) {
    helper(1);
}
`, 'void work(');
        assert.equal(
            r.calledFunctions.find(f => f.name === 'helper')?.type,
            'void',
            '記憶域クラス（static）は含めず型のみを表示すること'
        );
    });

    test('ポインタを返す関数と関数ポインタ変数を判別する (v2.14.0)', async () => {
        // どちらもポインタ深さ1になるため、宣言子の構造で判別する必要がある
        const r = await analyzeOrThrow(`
char *fetch(void);   /* ポインタを返す関数 */
int (*fp)(int);      /* 関数ポインタ変数 */

void work(void) {
    fetch();
    fp(1);
}
`, 'void work(');
        const fetch = r.calledFunctions.find(f => f.name === 'fetch');
        assert.ok(fetch, `呼び出し関数に fetch が含まれること: ${names(r.calledFunctions)}`);
        assert.equal(fetch.type, 'char*', 'ポインタ戻り値の型が取得できること');
        assert.ok(fetch.definition, '関数として定義位置が記録されること');

        // 関数ポインタ変数は関数宣言ではないため、戻り値の型を特定できない
        assert.equal(r.calledFunctions.find(f => f.name === 'fp')?.type, '(推定)');
    });

    test('宣言が見つからない呼び出し関数は (推定) と表示する (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    printf("hello");
}
`, 'void work(');
        const fn = r.calledFunctions.find(f => f.name === 'printf');
        assert.ok(fn, '呼び出し関数に printf が含まれること');
        assert.equal(fn.type, '(推定)', '戻り値の型は特定できないこと');
    });

    test('マクロ関数は型を macro とし定義値を持たせる (v2.14.0)', async () => {
        const r = await analyzeOrThrow(`
#define LOG_MSG(m) printf(m)

void work(void) {
    LOG_MSG("hello");
}
`, 'void work(');
        const fn = (r.macroFunctions ?? []).find(f => f.name === 'LOG_MSG');
        assert.ok(fn, `マクロ関数に LOG_MSG が含まれること: ${names(r.macroFunctions ?? [])}`);
        assert.equal(fn.type, 'macro');
        assert.equal(fn.value, 'printf(m)');
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
        const occurrences = names(r.calledFunctions).filter(f => f === 'helper');
        assert.equal(occurrences.length, 1, `helper が1件のみであること: ${names(r.calledFunctions)}`);
    });
});

describe('フェーズ5: 大文字マクロ分類', () => {
    test('大文字のみの呼び出しをマクロ関数に分類する (v1.3.0)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    LOG_MSG("hello");
}
`, 'void work(');
        assert.ok(names(r.macroFunctions ?? []).includes('LOG_MSG'), `マクロ関数に LOG_MSG が含まれること: ${names(r.macroFunctions ?? [])}`);
        assert.ok(!names(r.calledFunctions).includes('LOG_MSG'), '通常の呼び出し関数には含まれないこと');
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

    test('マクロ値の末尾の行コメントを型名に含めない (v2.10.1)', async () => {
        // #define の値は行末までの生テキストとして取得されるため、
        // 行コメントを取り除かないと型名バッジに混入する
        const r = await analyzeOrThrow(`
#define HOGE (10) // ここはコメント

int check(int v) {
    return v > HOGE;
}
`, 'int check(');
        const hoge = findVar(r.macroVariables ?? [], 'HOGE');
        assert.equal(hoge?.type, 'macro', '型名欄は macro のみとなること');
        assert.equal(hoge?.value, '(10)', '定義値はコメントを含まないこと');
    });

    test('マクロ値の末尾のブロックコメントを型名に含めない (v2.10.1)', async () => {
        const r = await analyzeOrThrow(`
#define LIMIT 100 /* 最大値 */

int check(int v) {
    return v > LIMIT;
}
`, 'int check(');
        assert.equal(findVar(r.macroVariables ?? [], 'LIMIT')?.value, '100');
    });

    test('文字列リテラル内の // をコメントとして扱わない (v2.10.1)', async () => {
        const r = await analyzeOrThrow(`
#define URL "http://example.com"

int check(int v) {
    return use(URL) + v;
}
`, 'int check(');
        assert.equal(
            findVar(r.macroVariables ?? [], 'URL')?.value,
            '"http://example.com"',
            '文字列内の // は残ること'
        );
    });

    test('除算の / をコメントとして扱わない (v2.10.1)', async () => {
        const r = await analyzeOrThrow(`
#define HALF (100/2)

int check(int v) {
    return v > HALF;
}
`, 'int check(');
        assert.equal(findVar(r.macroVariables ?? [], 'HALF')?.value, '(100/2)');
    });

    test('文字リテラルの後ろの行コメントを除去する (v2.10.1)', async () => {
        const r = await analyzeOrThrow(`
#define DELIM 'a' // 区切り文字

int check(int v) {
    return v + DELIM;
}
`, 'int check(');
        assert.equal(findVar(r.macroVariables ?? [], 'DELIM')?.value, "'a'");
    });

    test('小文字を含むマクロもマクロ変数として分類する (v2.11.0)', async () => {
        // 名前の大小ではなく、収集した #define の有無で判定する
        const r = await analyzeOrThrow(`
#define hoge (10) // コメント

int check(int v) {
    return v > hoge;
}
`, 'int check(');
        const m = findVar(r.macroVariables ?? [], 'hoge');
        assert.ok(m, `マクロ変数に hoge が含まれること: ${names(r.macroVariables ?? [])}`);
        assert.equal(m.type, 'macro', '型名欄は macro のみとなること');
        assert.equal(m.value, '(10)', '定義値は別の欄に入ること');
        assert.ok(m.definition, '定義位置も記録されること');
        assert.equal(m.definition.line, 1);
        assert.ok(!names(r.inputs).includes('hoge'), '入力変数には含まれないこと');
    });

    test('マクロ定義がないグローバル変数は推定表示のままとする (v2.10.1)', async () => {
        const r = await analyzeOrThrow(`
int check(int v) {
    return v > unknown_global;
}
`, 'int check(');
        assert.equal(findVar(r.inputs, 'unknown_global')?.type, '(推定)');
    });

    test('コメントのみの値はマクロ（値なし）として扱う (v2.10.1)', async () => {
        const r = await analyzeOrThrow(`
#define ENABLED // 有効化フラグ

int check(int v) {
    return v + ENABLED;
}
`, 'int check(');
        assert.equal(findVar(r.macroVariables ?? [], 'ENABLED')?.type, 'macro');
    });

    test('大文字でも変数宣言があればマクロ変数に分類しない (v2.11.0)', async () => {
        // 定義を収集済みなら、名前が大文字でも変数として扱う
        const r = await analyzeOrThrow(`
extern int GLOBAL_COUNTER;

void work(int v) {
    GLOBAL_COUNTER = v;
}
`, 'void work(');
        const g = findVar(r.outputs, 'GLOBAL_COUNTER');
        assert.ok(g, `出力に GLOBAL_COUNTER が含まれること: ${names(r.outputs)}`);
        assert.equal(g.type, 'int', '(推定) ではなく宣言された型になること');
        assert.ok(
            !names(r.macroVariables ?? []).includes('GLOBAL_COUNTER'),
            'マクロ変数には含まれないこと'
        );
    });

    test('大文字でも関数宣言があればマクロ関数に分類しない (v2.11.0)', async () => {
        const r = await analyzeOrThrow(`
void INIT_ALL(void);

void work(void) {
    INIT_ALL();
}
`, 'void work(');
        assert.ok(
            names(r.calledFunctions).includes('INIT_ALL'),
            `呼び出し関数に INIT_ALL が含まれること: ${names(r.calledFunctions)}`
        );
        assert.ok(
            !names(r.macroFunctions ?? []).includes('INIT_ALL'),
            'マクロ関数には含まれないこと'
        );
    });

    test('定義が見つからない大文字識別子は従来どおり推定でマクロとする (v2.11.0)', async () => {
        const r = await analyzeOrThrow(`
void work(int v) {
    use(v + UNKNOWN_LIMIT);
}
`, 'void work(');
        const m = findVar(r.macroVariables ?? [], 'UNKNOWN_LIMIT');
        assert.ok(m, `マクロ変数に UNKNOWN_LIMIT が含まれること: ${names(r.macroVariables ?? [])}`);
        assert.equal(m.type, '(推定)');
    });

    test('マクロ定義は変数宣言より優先する (v2.11.0)', async () => {
        // プリプロセッサ段階で展開されるため、同名の宣言があってもマクロとして扱う
        const r = await analyzeOrThrow(`
extern int DUAL;
#define DUAL 7

int check(int v) {
    return v + DUAL;
}
`, 'int check(');
        assert.equal(findVar(r.macroVariables ?? [], 'DUAL')?.value, '7');
        assert.ok(!names(r.inputs).includes('DUAL'), '入力変数には含まれないこと');
    });

    test('オプション無効時も定義に基づく分類は行う (v2.11.0)', async () => {
        // 設定は「定義が不明なときの推定方針」のみを制御する
        const r = await analyzeOrThrow(`
#define KNOWN_MACRO 1

int check(int v) {
    return v + KNOWN_MACRO + UNKNOWN_MACRO;
}
`, 'int check(', false);
        assert.ok(
            names(r.macroVariables ?? []).includes('KNOWN_MACRO'),
            `定義があるものはマクロ変数となること: ${names(r.macroVariables ?? [])}`
        );
        assert.ok(
            names(r.inputs).includes('UNKNOWN_MACRO'),
            '定義がないものは推定せず入力変数となること'
        );
    });

    test('オプション無効時は大文字識別子を通常分類する (v1.3.0)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int v = MAX_LIMIT;
    LOG_MSG("hello");
}
`, 'void work(', false);
        assert.ok(names(r.inputs).includes('MAX_LIMIT'), `入力に MAX_LIMIT が含まれること: ${names(r.inputs)}`);
        assert.ok(names(r.calledFunctions).includes('LOG_MSG'), `呼び出し関数に LOG_MSG が含まれること: ${names(r.calledFunctions)}`);
        assert.deepEqual(r.macroVariables, [], 'マクロ変数は空であること');
        assert.deepEqual(r.macroFunctions, [], 'マクロ関数は空であること');
    });
});

describe('フェーズ5: 定義位置の記録', () => {
    test('引数の宣言位置を記録する', async () => {
        const r = await analyzeOrThrow(`
int calc(int base, float ratio) {
    return base;
}
`, 'int calc(');
        // シグネチャは2行目（0始まりで1行目）。"int calc(int base" の base は列13
        const base = findVar(r.inputs, 'base');
        assert.ok(base?.definition, 'base に定義位置が記録されること');
        assert.equal(base.definition.line, 1);
        assert.equal(base.definition.column, 13);
        assert.equal(base.definition.filePath, undefined, '同一ファイル内のため filePath は未設定');

        const ratio = findVar(r.inputs, 'ratio');
        assert.ok(ratio?.definition, 'ratio に定義位置が記録されること');
        assert.equal(ratio.definition.line, 1);
    });

    test('ローカル変数の宣言位置を記録する', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    int first = 1;
    int second = 2;
}
`, 'void work(');
        assert.equal(findVar(r.internalVariables, 'first')?.definition?.line, 2);
        assert.equal(findVar(r.internalVariables, 'second')?.definition?.line, 3);
    });

    test('グローバル変数の宣言位置を記録する', async () => {
        const r = await analyzeOrThrow(`
int threshold = 100;

int check(int v) {
    return v > threshold;
}
`, 'int check(');
        const g = findVar(r.inputs, 'threshold');
        assert.ok(g?.definition, 'threshold に定義位置が記録されること');
        assert.equal(g.definition.line, 1);
        assert.equal(g.definition.column, 4, '型名 "int " の後ろの列を指すこと');
    });

    test('ファイル内に定義がないグローバル変数には定義位置を記録しない', async () => {
        const r = await analyzeOrThrow(`
void publish(void) {
    external_flag = 1;
}
`, 'void publish(');
        const g = findVar(r.outputs, 'external_flag');
        assert.ok(g, '出力に external_flag が含まれること');
        assert.equal(g.definition, undefined, '定義位置は未設定であること');
    });

    test('「戻り値 (return)」には定義位置を記録しない', async () => {
        const r = await analyzeOrThrow(`
int one(void) {
    return 1;
}
`, 'int one(');
        const ret = findVar(r.outputs, '戻り値 (return)');
        assert.ok(ret, '「戻り値 (return)」が存在すること');
        assert.equal(ret.definition, undefined);
    });

    test('同一ファイル内で定義された呼び出し関数の定義位置を記録する', async () => {
        const r = await analyzeOrThrow(`
int helper(int x) {
    return x;
}

int work(void) {
    return helper(1);
}
`, 'int work(');
        const helper = r.calledFunctions.find(f => f.name === 'helper');
        assert.ok(helper?.definition, 'helper に定義位置が記録されること');
        assert.equal(helper.definition.line, 1);
    });

    test('プロトタイプ宣言のみの呼び出し関数はその宣言位置を記録する', async () => {
        const r = await analyzeOrThrow(`
void log_message(const char *m);

void work(void) {
    log_message("hello");
}
`, 'void work(');
        const fn = r.calledFunctions.find(f => f.name === 'log_message');
        assert.ok(fn?.definition, 'log_message に定義位置が記録されること');
        assert.equal(fn.definition.line, 1);
    });

    test('定義が見つからない呼び出し関数には定義位置を記録しない', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    printf("hello");
}
`, 'void work(');
        const fn = r.calledFunctions.find(f => f.name === 'printf');
        assert.ok(fn, '呼び出し関数に printf が含まれること');
        assert.equal(fn.definition, undefined, '定義位置は未設定であること');
    });

    test('定義とプロトタイプ宣言の両方がある場合は定義側を優先する', async () => {
        const r = await analyzeOrThrow(`
int helper(int x);

int helper(int x) {
    return x;
}

int work(void) {
    return helper(1);
}
`, 'int work(');
        const helper = r.calledFunctions.find(f => f.name === 'helper');
        assert.ok(helper?.definition, 'helper に定義位置が記録されること');
        assert.equal(helper.definition.line, 3, 'プロトタイプ(1行目)ではなく定義(3行目)を指すこと');
    });
});

describe('フェーズ5: 構造体メンバの型解決', () => {
    test('名前付き構造体のメンバ型を解決する', async () => {
        const r = await analyzeOrThrow(`
struct Config { int mode; float ratio; };
struct Config g_config;

void setup(void) {
    g_config.mode = 1;
    g_config.ratio = 0.5;
}
`, 'void setup(');
        assert.equal(findVar(r.outputs, 'g_config.mode')?.type, 'int');
        assert.equal(findVar(r.outputs, 'g_config.ratio')?.type, 'float');
    });

    test('無名構造体の typedef のメンバ型を解決する', async () => {
        const r = await analyzeOrThrow(`
typedef struct { int id; float score; } HogeStruct;
HogeStruct hoge_data;

void setup(void) {
    hoge_data.id = 1;
    hoge_data.score = 2.0;
}
`, 'void setup(');
        assert.equal(findVar(r.outputs, 'hoge_data.id')?.type, 'int');
        assert.equal(findVar(r.outputs, 'hoge_data.score')?.type, 'float');
    });

    test('タグ付き typedef はタグ名・typedef 名の双方から解決する', async () => {
        const r = await analyzeOrThrow(`
typedef struct Tag { int x; } TagAlias;
struct Tag by_tag;
TagAlias by_alias;

void setup(void) {
    by_tag.x = 1;
    by_alias.x = 2;
}
`, 'void setup(');
        assert.equal(findVar(r.outputs, 'by_tag.x')?.type, 'int', 'タグ名から解決されること');
        assert.equal(findVar(r.outputs, 'by_alias.x')?.type, 'int', 'typedef 名から解決されること');
    });

    test('構造体配列の要素のメンバ型を解決する', async () => {
        const r = await analyzeOrThrow(`
typedef struct { int id; } HogeStruct;
HogeStruct tbl[5];

void setup(void) {
    tbl[0].id = 1;
}
`, 'void setup(');
        const v = findVar(r.outputs, 'tbl[5].id');
        assert.ok(v, `出力に tbl[5].id が含まれること: ${names(r.outputs)}`);
        assert.equal(v.type, 'int', '根元の HogeStruct[5] ではなくメンバの型になること');
    });

    test('ネストした構造体メンバとアロー演算子を辿る', async () => {
        const r = await analyzeOrThrow(`
struct Sub { int member; };
struct Outer { struct Sub sub; };
struct Outer *var_ptr;

void setup(void) {
    var_ptr->sub.member = 30;
}
`, 'void setup(');
        const v = findVar(r.outputs, 'var_ptr->sub.member');
        assert.ok(v, `出力に var_ptr->sub.member が含まれること: ${names(r.outputs)}`);
        assert.equal(v.type, 'int', '2段階辿ってメンバの型になること');
    });

    test('配列型・ポインタ型のメンバも型を解決する', async () => {
        const r = await analyzeOrThrow(`
struct Config { char name[8]; int *ptr; };
struct Config cfg;

void setup(void) {
    cfg.ptr = 0;
    cfg.name[0] = 'a';
}
`, 'void setup(');
        assert.equal(findVar(r.outputs, 'cfg.ptr')?.type, 'int*', 'ポインタメンバの型');
        assert.equal(findVar(r.outputs, 'cfg.name[8]')?.type, 'char',
            `配列メンバは名前側に次元が出ること: ${names(r.outputs)}`);
    });

    test('添字なしで参照される配列メンバは型名側に次元を出す', async () => {
        const r = await analyzeOrThrow(`
struct Config { char name[8]; };
struct Config cfg;

int setup(void) {
    return total(cfg.name);
}
`, 'int setup(');
        assert.equal(findVar(r.inputs, 'cfg.name')?.type, 'char[8]');
    });

    test('共用体のメンバ型を解決する', async () => {
        const r = await analyzeOrThrow(`
union Value { int i; float f; };
union Value val;

void setup(void) {
    val.f = 1.0;
}
`, 'void setup(');
        assert.equal(findVar(r.outputs, 'val.f')?.type, 'float');
    });

    test('変数宣言と同時に定義された構造体のメンバ型を解決する', async () => {
        const r = await analyzeOrThrow(`
struct Data { int x; } global_data;

void setup(void) {
    global_data.x = 1;
}
`, 'void setup(');
        assert.equal(findVar(r.outputs, 'global_data.x')?.type, 'int');
    });

    test('ポインタ引数のメンバ型も解決する', async () => {
        const r = await analyzeOrThrow(`
typedef struct { int id; } HogeStruct;

void update(HogeStruct *data) {
    data->id = 1;
}
`, 'void update(');
        const v = findVar(r.outputs, 'data->id');
        assert.ok(v, `出力に data->id が含まれること: ${names(r.outputs)}`);
        assert.equal(v.type, 'int', '引数の型 HogeStruct* ではなくメンバの型になること');
    });

    test('定義と typedef を分けて書いた構造体のメンバ型を解決する (v2.12.1)', async () => {
        // typedef の位置に構造体の中身がないため、別名から実体を辿る必要がある
        const r = await analyzeOrThrow(`
struct TagC { int c; };
typedef struct TagC SeparateAlias;
SeparateAlias g_c;

void work(void) {
    g_c.c = 3;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_c.c')?.type, 'int');
    });

    test('前方宣言してから定義した構造体のメンバ型を解決する (v2.12.1)', async () => {
        const r = await analyzeOrThrow(`
struct TagD;
typedef struct TagD LateAlias;
struct TagD { int d; };
LateAlias *g_d;

void work(void) {
    g_d->d = 4;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_d->d')?.type, 'int');
    });

    test('多段の typedef を辿ってメンバ型を解決する (v2.12.1)', async () => {
        const r = await analyzeOrThrow(`
struct TagC { int c; };
typedef struct TagC SeparateAlias;
typedef SeparateAlias NestedAlias;
NestedAlias g_e;

void work(void) {
    g_e.c = 5;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_e.c')?.type, 'int');
    });

    test('分けて typedef した共用体のメンバ型を解決する (v2.12.1)', async () => {
        const r = await analyzeOrThrow(`
union TagF { int f; float g; };
typedef union TagF UnionAlias;
UnionAlias g_f;

void work(void) {
    g_f.g = 6.0;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_f.g')?.type, 'float');
    });

    test('実体のない typedef では推定表示にする (v2.17.0)', async () => {
        // 循環する typedef でも停止し、解決できない場合は (推定) を表示する
        const r = await analyzeOrThrow(`
typedef struct TagG CycleA;
typedef CycleA CycleB;
CycleB g_g;

void work(void) {
    g_g.unknown = 7;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_g.unknown')?.type, '(推定)');
        assert.equal(findVar(r.outputs, 'g_g.unknown')?.definition, undefined, '定義位置は表示しないこと');
    });

    test('インクルードファイル内で分けて typedef された構造体も解決する (v2.12.1)', async () => {
        const r = await analyzeOrThrow(`
struct TagH { short h; };
typedef struct TagH AliasH;
AliasH g_h;

void work(void) {
    g_h.h = 8;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_h.h')?.type, 'short');
    });

    test('構造体定義が見つからない場合は推定表示にする (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
extern struct Unknown ext_data;

void setup(void) {
    ext_data.field = 1;
}
`, 'void setup(');
        const v = findVar(r.outputs, 'ext_data.field');
        assert.ok(v, '出力に ext_data.field が含まれること');
        assert.equal(v.type, '(推定)', '解決できない場合は推定表示にすること');
        assert.equal(v.definition, undefined, '定義位置は表示しないこと');
    });

    test('存在しないメンバ名の場合は推定表示にする (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
struct Config { int mode; };
struct Config cfg;

void setup(void) {
    cfg.unknown_field = 1;
}
`, 'void setup(');
        const v = findVar(r.outputs, 'cfg.unknown_field');
        assert.ok(v, '出力に cfg.unknown_field が含まれること');
        assert.equal(v.type, '(推定)', '解決できない場合は推定表示にすること');
        assert.equal(v.definition, undefined, '定義位置は表示しないこと');
    });

    test('関数内で定義された構造体は収集対象外とする', async () => {
        const r = await analyzeOrThrow(`
struct Config cfg;

void setup(void) {
    struct Config { int only_local; };
    cfg.only_local = 1;
}
`, 'void setup(');
        // 関数ボディ内のローカルな型定義は使わないため、メンバを解決できない
        assert.equal(findVar(r.outputs, 'cfg.only_local')?.type, '(推定)');
    });
});

describe('フェーズ4: 走査順序に依存しない分類', () => {
    test('呼び出しより前に参照された関数名を入力に重複させない', async () => {
        // 識別子 helper が call_expression より先に出現するケース。
        // 単一パス走査では「まだ呼び出しとして登録されていない」ため誤って入力に分類されていた。
        const r = await analyzeOrThrow(`
void helper(void);

void work(void) {
    void (*p)(void) = helper;
    helper();
}
`, 'void work(');
        assert.ok(names(r.calledFunctions).includes('helper'), `呼び出し関数に helper が含まれること: ${names(r.calledFunctions)}`);
        assert.ok(!names(r.inputs).includes('helper'), `入力に helper が含まれないこと: ${names(r.inputs)}`);
    });

    test('参照されるだけで呼び出されない関数名をグローバル変数と誤分類しない', async () => {
        // helper は値として参照されるのみで呼び出されない。
        // 関数名は変数ではないため、グローバル変数の読み取りとして扱ってはならない。
        const r = await analyzeOrThrow(`
int helper(int x);

void work(void) {
    int (*fp)(int) = helper;
    int result = fp(1);
}
`, 'void work(');
        assert.ok(!names(r.inputs).includes('helper'), `入力に helper が含まれないこと: ${names(r.inputs)}`);
    });

    test('同一ファイル内で定義された関数の参照も誤分類しない', async () => {
        // プロトタイプ宣言ではなく関数定義として存在するケース
        const r = await analyzeOrThrow(`
int helper(int x) {
    return x;
}

void work(void) {
    int (*fp)(int) = helper;
    int result = fp(1);
}
`, 'void work(');
        assert.ok(!names(r.inputs).includes('helper'), `入力に helper が含まれないこと: ${names(r.inputs)}`);
    });

    test('ローカル変数の宣言より前に同名の識別子が出現しても入力に分類しない', async () => {
        // 宣言と使用の収集がパス1で完了しているため、出現順の影響を受けない
        const r = await analyzeOrThrow(`
int compute(int v);

void work(void) {
    int total = compute(1);
    total = total + 1;
}
`, 'void work(');
        assert.ok(!names(r.inputs).includes('total'), `入力に total が含まれないこと: ${names(r.inputs)}`);
        assert.ok(names(r.internalVariables).includes('total'), '内部変数に total が含まれること');
    });
});

describe('修飾子マクロ付きのグローバル変数', () => {
    test('GLOBAL BYTE hoge; の型はマクロ名ではなく BYTE になる', async () => {
        const r = await analyzeOrThrow(`
#define GLOBAL extern
typedef unsigned char BYTE;

GLOBAL BYTE hoge;

void work(void) {
    hoge = 1;
}
`, 'void work(');
        const v = findVar(r.outputs, 'hoge');
        assert.ok(v, `出力に hoge が含まれること: ${names(r.outputs)}`);
        assert.equal(v!.type, 'BYTE');
    });

    test('マクロ名が変数として誤検出されない', async () => {
        const r = await analyzeOrThrow(`
#define GLOBAL extern
GLOBAL BYTE hoge;

void work(void) {
    hoge = 1;
}
`, 'void work(');
        const all = [...names(r.inputs), ...names(r.outputs), ...names(r.internalVariables)];
        assert.ok(!all.includes('GLOBAL'), `GLOBAL が変数として現れないこと: ${all}`);
        assert.ok(!all.includes('BYTE'), `BYTE が変数として現れないこと: ${all}`);
    });

    test('ポインタ・配列の修飾子マクロ付き宣言も型が取れる', async () => {
        const r = await analyzeOrThrow(`
#define GLOBAL extern
GLOBAL BYTE *p_data;
GLOBAL BYTE buffer[16];

void work(void) {
    p_data = 0;
    buffer[0] = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'p_data')!.type, 'BYTE*');
        // 配列は宣言時の次元で表記される（既存仕様）
        assert.equal(findVar(r.outputs, 'buffer[16]')!.type, 'BYTE');
    });

    test('修飾子マクロ付きの関数プロトタイプから戻り値の型が取れる', async () => {
        const r = await analyzeOrThrow(`
#define GLOBAL extern
GLOBAL S16 hal_read(void);

void work(void) {
    hal_read();
}
`, 'void work(');
        const f = r.calledFunctions.find(x => x.name === 'hal_read');
        assert.ok(f, `呼び出し関数に hal_read が含まれること: ${names(r.calledFunctions)}`);
        assert.equal(f!.type, 'S16');
    });
});

describe('フェーズ5: 構造体メンバの収集範囲', () => {
    test('#ifdef の内側で宣言されたメンバの型を解決する', async () => {
        const r = await analyzeOrThrow(`
struct Config {
#ifdef USE_EXTRA
    int guarded;
#endif
    int plain;
};
struct Config g_cfg;

void work(void) {
    g_cfg.guarded = 1;
    g_cfg.plain = 2;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_cfg.guarded')!.type, 'int');
        assert.equal(findVar(r.outputs, 'g_cfg.plain')!.type, 'int');
    });

    test('#if / #else の内側で宣言されたメンバの型を解決する', async () => {
        const r = await analyzeOrThrow(`
struct Config {
#if defined(MODE_A)
    short mode_a;
#else
    long mode_b;
#endif
};
struct Config g_cfg;

void work(void) {
    g_cfg.mode_a = 1;
    g_cfg.mode_b = 2;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_cfg.mode_a')!.type, 'short');
        assert.equal(findVar(r.outputs, 'g_cfg.mode_b')!.type, 'long');
    });

    test('無名共用体のメンバは親構造体のメンバとして扱う', async () => {
        const r = await analyzeOrThrow(`
struct Packet {
    union {
        int   as_int;
        float as_float;
    };
    int tag;
};
struct Packet g_packet;

void work(void) {
    g_packet.as_int = 1;
    g_packet.tag = 2;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_packet.as_int')!.type, 'int');
        assert.equal(findVar(r.outputs, 'g_packet.tag')!.type, 'int', '無名メンバの後に続くメンバも収集されること');
    });

    test('無名構造体を型に持つメンバは中身まで辿れる', async () => {
        const r = await analyzeOrThrow(`
struct Outer {
    struct {
        unsigned char inner;
    } nest;
};
struct Outer g_outer;

void work(void) {
    g_outer.nest.inner = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_outer.nest.inner')!.type, 'unsigned char');
    });

    test('無名構造体メンバが配列でも中身まで辿れる', async () => {
        const r = await analyzeOrThrow(`
struct Outer {
    struct {
        int value;
    } items[4];
};
struct Outer g_outer;

void work(void) {
    g_outer.items[0].value = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_outer.items[4].value')!.type, 'int');
    });

    test('修飾子マクロ付きのメンバの型を解決する', async () => {
        const r = await analyzeOrThrow(`
#define VOLATILE volatile

struct Registers {
    VOLATILE unsigned long status;
};
struct Registers g_regs;

void work(void) {
    g_regs.status = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_regs.status')!.type, 'unsigned long');
    });

    test('ビットフィールドのメンバの型を解決する', async () => {
        const r = await analyzeOrThrow(`
struct Flags {
    unsigned int enabled : 1;
    unsigned int level   : 3;
};
struct Flags g_flags;

void work(void) {
    g_flags.enabled = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_flags.enabled')!.type, 'unsigned int');
    });
});

describe('フェーズ5: 定義が見つからない場合の型表示', () => {
    test('変数・関数・マクロで同じ表記になる (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    unknown_fn();
    UNKNOWN_MACRO_FN();
    unknown_global = 1;
    UNKNOWN_MACRO_VAR = 2;
}
`, 'void work(');
        const types = [
            r.calledFunctions.find(f => f.name === 'unknown_fn')?.type,
            r.macroFunctions?.find(f => f.name === 'UNKNOWN_MACRO_FN')?.type,
            findVar(r.outputs, 'unknown_global')?.type,
            r.macroVariables?.find(v => v.name === 'UNKNOWN_MACRO_VAR')?.type
        ];
        assert.deepEqual(types, ['(推定)', '(推定)', '(推定)', '(推定)']);
    });

    test('定義が見つかる場合は従来どおり実際の型を表示する (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
#define KNOWN_MACRO 10

extern int known_global;
void known_fn(void);

void work(void) {
    known_fn();
    known_global = KNOWN_MACRO;
}
`, 'void work(');
        assert.equal(r.calledFunctions.find(f => f.name === 'known_fn')!.type, 'void');
        assert.equal(findVar(r.outputs, 'known_global')!.type, 'int');
        assert.equal(r.macroVariables?.find(v => v.name === 'KNOWN_MACRO')!.type, 'macro');
    });
});

describe('フェーズ5: 構造体メンバの定義位置', () => {
    test('解決できたメンバは根元の変数ではなくメンバの宣言位置を指す (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
struct Outer {
    int top;
};
struct Outer g_outer;

void work(void) {
    g_outer.top = 1;
}
`, 'void work(');
        const v = findVar(r.outputs, 'g_outer.top');
        assert.ok(v?.definition, '定義位置が記録されること');
        // 1行目が struct Outer {、2行目が int top;（0始まり）
        assert.equal(v.definition.line, 2, 'メンバ int top; の行を指すこと');
    });

    test('多段のメンバアクセスでは最終メンバの宣言位置を指す (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
struct Inner {
    int leaf;
};
struct Outer {
    struct Inner nest;
};
struct Outer g_outer;

void work(void) {
    g_outer.nest.leaf = 1;
}
`, 'void work(');
        const v = findVar(r.outputs, 'g_outer.nest.leaf');
        assert.ok(v?.definition, '定義位置が記録されること');
        assert.equal(v.definition.line, 2, 'メンバ int leaf; の行を指すこと');
    });

    test('メンバを伴わない変数は従来どおり自身の宣言位置を指す (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
extern int g_plain;

void work(void) {
    g_plain = 1;
}
`, 'void work(');
        const v = findVar(r.outputs, 'g_plain');
        assert.ok(v?.definition, '定義位置が記録されること');
        assert.equal(v.definition.line, 1);
    });

    test('ポインタ引数のメンバもメンバの宣言位置を指す (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
struct Reading {
    int measured_at;
};

void work(struct Reading *reading) {
    reading->measured_at = 1;
}
`, 'void work(');
        const v = findVar(r.outputs, 'reading->measured_at');
        assert.ok(v?.definition, '定義位置が記録されること');
        assert.equal(v.definition.line, 2, 'メンバ int measured_at; の行を指すこと');
    });

    test('ポインタ引数そのものは引数の宣言位置を指す (v2.17.0)', async () => {
        const r = await analyzeOrThrow(`
void work(int *out) {
    *out = 1;
}
`, 'void work(');
        const v = findVar(r.outputs, 'out');
        assert.ok(v?.definition, '定義位置が記録されること');
        assert.equal(v.definition.line, 1, '引数の宣言行を指すこと');
    });
});

describe('フェーズ5: enum 列挙子の収集', () => {
    test('明示された値をそのまま表示する (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
enum Color { RED = 1, BLUE = 10 };

void work(void) {
    int a = RED;
    int b = BLUE;
}
`, 'void work(');
        const red = r.macroVariables?.find(v => v.name === 'RED');
        assert.ok(red, `マクロ変数に RED が含まれること: ${names(r.macroVariables || [])}`);
        assert.equal(red.type, 'enum', '型名欄は enum とすること');
        assert.equal(red.value, '1');
        assert.equal(r.macroVariables?.find(v => v.name === 'BLUE')?.value, '10');
    });

    test('値が省略された列挙子は直前の値から求める (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
enum Color { RED = 1, GREEN, YELLOW };

void work(void) {
    int a = GREEN;
    int b = YELLOW;
}
`, 'void work(');
        assert.equal(r.macroVariables?.find(v => v.name === 'GREEN')?.value, '2');
        assert.equal(r.macroVariables?.find(v => v.name === 'YELLOW')?.value, '3');
    });

    test('先頭から値が省略された場合は 0 から始まる (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
enum { ANON_A, ANON_B, ANON_C };

void work(void) {
    int a = ANON_A;
    int b = ANON_B;
    int c = ANON_C;
}
`, 'void work(');
        assert.equal(r.macroVariables?.find(v => v.name === 'ANON_A')?.value, '0');
        assert.equal(r.macroVariables?.find(v => v.name === 'ANON_B')?.value, '1');
        assert.equal(r.macroVariables?.find(v => v.name === 'ANON_C')?.value, '2');
    });

    test('16進の値も加算して10進で表示する (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
enum Tag { T_X = 0x10, T_Y };

void work(void) {
    int a = T_X;
    int b = T_Y;
}
`, 'void work(');
        assert.equal(r.macroVariables?.find(v => v.name === 'T_X')?.value, '0x10', '明示値は記述のまま');
        assert.equal(r.macroVariables?.find(v => v.name === 'T_Y')?.value, '17');
    });

    test('数値でない値が指定された場合は式のまま加算量を示す (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
enum Mode { MODE_OFF = BASE_OFFSET, MODE_ON };

void work(void) {
    int a = MODE_OFF;
    int b = MODE_ON;
}
`, 'void work(');
        assert.equal(r.macroVariables?.find(v => v.name === 'MODE_OFF')?.value, 'BASE_OFFSET');
        assert.equal(r.macroVariables?.find(v => v.name === 'MODE_ON')?.value, 'BASE_OFFSET + 1');
    });

    test('typedef enum の列挙子も収集する (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
typedef enum { STATE_IDLE = 5, STATE_RUN } State;

void work(void) {
    int a = STATE_RUN;
}
`, 'void work(');
        assert.equal(r.macroVariables?.find(v => v.name === 'STATE_RUN')?.value, '6');
    });

    test('小文字の列挙子もマクロ変数として扱う (v2.18.0)', async () => {
        // 定義が見つかっているため、大文字かどうかによらず分類される
        const r = await analyzeOrThrow(`
enum Color { red = 3 };

void work(void) {
    int a = red;
}
`, 'void work(', false);
        const v = r.macroVariables?.find(x => x.name === 'red');
        assert.ok(v, `マクロ変数に red が含まれること: ${names(r.macroVariables || [])}`);
        assert.equal(v.value, '3');
    });

    test('列挙子の定義位置を記録する (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
enum Color {
    RED = 1
};

void work(void) {
    int a = RED;
}
`, 'void work(');
        const v = r.macroVariables?.find(x => x.name === 'RED');
        assert.ok(v?.definition, '定義位置が記録されること');
        assert.equal(v.definition.line, 2, '列挙子 RED の行を指すこと');
    });

    test('同名の #define がある場合はマクロ定義を優先する (v2.18.0)', async () => {
        // プリプロセッサが先に展開するため #define が勝つ
        const r = await analyzeOrThrow(`
#define DUP 100
enum Dup { DUP = 1 };

void work(void) {
    int a = DUP;
}
`, 'void work(');
        const v = r.macroVariables?.find(x => x.name === 'DUP');
        assert.equal(v?.type, 'macro');
        assert.equal(v?.value, '100');
    });

    test('関数内で定義された enum は収集対象外とする (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
void work(void) {
    enum Local { LOCAL_ONLY = 9 };
    int a = LOCAL_ONLY;
}
`, 'void work(');
        const v = r.macroVariables?.find(x => x.name === 'LOCAL_ONLY');
        assert.equal(v?.type, '(推定)', 'ローカルな enum は定義として使わない');
    });

    test('#ifdef の内側の enum も収集する (v2.18.0)', async () => {
        const r = await analyzeOrThrow(`
#ifdef USE_COLOR
enum Color { RED = 7 };
#endif

void work(void) {
    int a = RED;
}
`, 'void work(');
        assert.equal(r.macroVariables?.find(x => x.name === 'RED')?.value, '7');
    });
});

describe('フェーズ5: 型として使われている名前の除外', () => {
    /** キャストの直後の文字によって tree-sitter がキャストと解釈できない書き方 */
    const CAST_FORMS = [
        'a = (BYTE)(hoge + 1);',
        'a = (BYTE)-hoge;',
        'a = (BYTE)*q;',
        'a = (BYTE)&hoge;'
    ];

    for (const stmt of CAST_FORMS) {
        test(`#define で定義した型は変数として表示しない: ${stmt} (v2.18.1)`, async () => {
            const r = await analyzeOrThrow(`
#define BYTE unsigned char

int hoge;
int a;
unsigned char *q;

void work(void) {
    ${stmt}
}
`, 'void work(');
            const all = [
                ...names(r.inputs), ...names(r.outputs),
                ...names(r.macroVariables || []), ...names(r.macroFunctions || []),
                ...names(r.calledFunctions)
            ];
            assert.ok(!all.includes('BYTE'), `BYTE が表示されないこと: ${all}`);
        });
    }

    test('typedef で定義した型も除外する (v2.18.1)', async () => {
        const r = await analyzeOrThrow(`
typedef unsigned char BYTE;

int hoge;
int a;

void work(void) {
    a = (BYTE)-hoge;
}
`, 'void work(');
        const all = [...names(r.inputs), ...names(r.outputs), ...names(r.macroVariables || [])];
        assert.ok(!all.includes('BYTE'), `BYTE が表示されないこと: ${all}`);
    });

    test('型マクロが別の型マクロを参照していても除外する (v2.18.1)', async () => {
        const r = await analyzeOrThrow(`
#define U8   unsigned char
#define BYTE U8

int hoge;
int a;

void work(void) {
    a = (BYTE)-hoge;
}
`, 'void work(');
        const all = [...names(r.inputs), ...names(r.outputs), ...names(r.macroVariables || [])];
        assert.ok(!all.includes('BYTE'), `BYTE が表示されないこと: ${all}`);
    });

    test('ポインタ型のマクロも除外する (v2.18.1)', async () => {
        const r = await analyzeOrThrow(`
#define PBYTE unsigned char *

unsigned char *q;
unsigned char *a;

void work(void) {
    a = (PBYTE)(q + 1);
}
`, 'void work(');
        const all = [...names(r.inputs), ...names(r.outputs), ...names(r.macroVariables || [])];
        assert.ok(!all.includes('PBYTE'), `PBYTE が表示されないこと: ${all}`);
    });

    test('構造体を指す型マクロも除外する (v2.18.1)', async () => {
        const r = await analyzeOrThrow(`
struct Foo { int x; };
#define FOO_T struct Foo

int hoge;
int a;

void work(void) {
    a = (FOO_T)-hoge;
}
`, 'void work(');
        const all = [...names(r.inputs), ...names(r.outputs), ...names(r.macroVariables || [])];
        assert.ok(!all.includes('FOO_T'), `FOO_T が表示されないこと: ${all}`);
    });

    test('値を持つマクロは従来どおり表示する (v2.18.1)', async () => {
        const r = await analyzeOrThrow(`
#define MAX_LIMIT 100
#define BASE      (10)
#define OFFSET    hoge + 1

int hoge;
int a;

void work(void) {
    a = MAX_LIMIT + BASE + OFFSET;
}
`, 'void work(');
        const macroNames = names(r.macroVariables || []);
        assert.ok(macroNames.includes('MAX_LIMIT'), `MAX_LIMIT が表示されること: ${macroNames}`);
        assert.ok(macroNames.includes('BASE'), `BASE が表示されること: ${macroNames}`);
        assert.ok(macroNames.includes('OFFSET'), `OFFSET が表示されること: ${macroNames}`);
    });

    test('型名と同名の変数が宣言されている場合は変数として表示する (v2.18.1)', async () => {
        // 宣言が見つかる場合は、そちらを優先する
        const r = await analyzeOrThrow(`
typedef int counter;
extern int counter_value;

void work(void) {
    counter_value = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'counter_value')?.type, 'int');
    });

    test('列挙子は型ではないため除外しない (v2.18.1)', async () => {
        const r = await analyzeOrThrow(`
enum State { STATE_RUN = 1 };

int a;

void work(void) {
    a = STATE_RUN;
}
`, 'void work(');
        const macroNames = names(r.macroVariables || []);
        assert.ok(macroNames.includes('STATE_RUN'), `STATE_RUN が表示されること: ${macroNames}`);
    });
});

describe('フェーズ5: 型名欄の修飾子の扱い', () => {
    /** 宣言と、期待する型名（記憶域クラス・型修飾子を含まない） */
    const FUNCTION_CASES: { decl: string; name: string; expected: string }[] = [
        { decl: 'static void s_fn(void);', name: 's_fn', expected: 'void' },
        { decl: 'extern int e_fn(void);', name: 'e_fn', expected: 'int' },
        { decl: 'const char *c_fn(void);', name: 'c_fn', expected: 'char*' },
        { decl: 'volatile int v_fn(void);', name: 'v_fn', expected: 'int' },
        { decl: 'static const char *sc_fn(void);', name: 'sc_fn', expected: 'char*' },
        { decl: 'unsigned char u_fn(void);', name: 'u_fn', expected: 'unsigned char' },
        { decl: 'struct Foo *st_fn(void);', name: 'st_fn', expected: 'struct Foo*' }
    ];

    for (const c of FUNCTION_CASES) {
        test(`呼び出し関数の型は修飾子を含まない: ${c.decl} (v2.19.0)`, async () => {
            const r = await analyzeOrThrow(`
${c.decl}

void work(void) {
    ${c.name}();
}
`, 'void work(');
            assert.equal(r.calledFunctions.find(f => f.name === c.name)?.type, c.expected);
        });
    }

    test('解析対象の関数の戻り値も修飾子を含まない (v2.19.0)', async () => {
        const r = await analyzeOrThrow(`
static const char *build(void) {
    return 0;
}
`, 'static const char *build(');
        assert.equal(r.returnType, 'char*');
        assert.equal(findVar(r.outputs, '戻り値 (return)')?.type, 'char*');
    });

    test('static void 関数では「戻り値 (return)」を出力に含めない (v2.19.0)', async () => {
        const r = await analyzeOrThrow(`
static void quiet(int a) {
    (void)a;
}
`, 'static void quiet(');
        assert.ok(!names(r.outputs).includes('戻り値 (return)'));
    });

    test('変数側の表示は従来どおり修飾子を含まない (v2.19.0)', async () => {
        const r = await analyzeOrThrow(`
static int   s_var;
const int    c_var;
volatile int v_var;

void work(void) {
    s_var = 1;
    c_var = 1;
    v_var = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 's_var')?.type, 'int');
        assert.equal(findVar(r.outputs, 'c_var')?.type, 'int');
        assert.equal(findVar(r.outputs, 'v_var')?.type, 'int');
    });
});

describe('フェーズ5: 宣言の右側のコメント', () => {
    test('グローバル変数・内部変数・引数のコメントを取得する (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
extern int g_count;          /* 実行回数 */

int work(int ch /* チャンネル */)
{
    int local = 0;           /* 作業用 */
    g_count = local + ch;
    return g_count;
}
`, 'int work(');
        assert.equal(findVar(r.outputs, 'g_count')?.comment, '実行回数');
        assert.equal(findVar(r.internalVariables, 'local')?.comment, '作業用');
        assert.equal(findVar(r.inputs, 'ch')?.comment, 'チャンネル');
    });

    test('行コメントもブロックコメントも取得する (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
extern int a_var;    // 行コメント
extern int b_var;    /* ブロックコメント */

void work(void) {
    a_var = 1;
    b_var = 2;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'a_var')?.comment, '行コメント');
        assert.equal(findVar(r.outputs, 'b_var')?.comment, 'ブロックコメント');
    });

    test('構造体メンバのコメントを取得する (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
struct Config {
    int mode;        /* 動作モード */
    int offset;      // 補正値
};
extern struct Config g_cfg;

void work(void) {
    g_cfg.mode = 1;
    g_cfg.offset = 2;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_cfg.mode')?.comment, '動作モード');
        assert.equal(findVar(r.outputs, 'g_cfg.offset')?.comment, '補正値');
    });

    test('マクロと enum のコメントを取得する (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
#define MAX_LIMIT 100        /* 上限値 */
enum State { ST_RUN = 1 };   /* 実行中 */

int a;

void work(void) {
    a = MAX_LIMIT + ST_RUN;
}
`, 'void work(');
        assert.equal(r.macroVariables?.find(v => v.name === 'MAX_LIMIT')?.comment, '上限値');
        assert.equal(r.macroVariables?.find(v => v.name === 'ST_RUN')?.comment, '実行中');
    });

    test('関数宣言のコメントを取得する (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
int calc(int x);     /* 計算する */

void work(void) {
    calc(1);
}
`, 'void work(');
        assert.equal(r.calledFunctions.find(f => f.name === 'calc')?.comment, '計算する');
    });

    test('次の行のコメントは取得しない (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
extern int g_count;
/* これは g_count の説明ではない */

void work(void) {
    g_count = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_count')?.comment, undefined);
    });

    test('コメントがない宣言では未設定にする (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
extern int g_count;

void work(void) {
    g_count = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_count')?.comment, undefined);
    });

    test('コメント内の余分な空白を詰める (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
extern int g_count;    /*    実行   回数    */

void work(void) {
    g_count = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_count')?.comment, '実行 回数');
    });

    test('インクルード先のコメントも取得する (v2.21.0)', async () => {
        // ヘッダ側の宣言に付いたコメントが表示されること（実ファイルは使わない）
        const r = await analyzeOrThrow(`
struct Config {
    int mode;    /* ヘッダ相当の説明 */
};
extern struct Config g_cfg;

void work(void) {
    g_cfg.mode = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_cfg.mode')?.comment, 'ヘッダ相当の説明');
    });
});

describe('フェーズ5: コメント記号の除去', () => {
    /** コメントの書き方と、取り出されるべき本文 */
    const FORMS: { label: string; comment: string }[] = [
        { label: '行コメント', comment: '// 説明' },
        { label: 'Doxygen 行（!）', comment: '//! 説明' },
        { label: 'Doxygen 行（!<）', comment: '//!< 説明' },
        { label: 'Doxygen 行（///）', comment: '/// 説明' },
        { label: 'Doxygen 行（///<）', comment: '///< 説明' },
        { label: 'Doxygen 行（//<）', comment: '//< 説明' },
        { label: 'ブロックコメント', comment: '/* 説明 */' },
        { label: 'Doxygen ブロック（**）', comment: '/** 説明 */' },
        { label: 'Doxygen ブロック（**<）', comment: '/**< 説明 */' },
        { label: 'Doxygen ブロック（!）', comment: '/*! 説明 */' },
        { label: 'Doxygen ブロック（!<）', comment: '/*!< 説明 */' },
        { label: '空白なし（ブロック）', comment: '/*!<説明*/' },
        { label: '空白なし（行）', comment: '//!<説明' }
    ];

    for (const form of FORMS) {
        test(`${form.label}: ${form.comment} から記号を除く (v2.21.0)`, async () => {
            const r = await analyzeOrThrow(`
extern int g_value;    ${form.comment}

void work(void) {
    g_value = 1;
}
`, 'void work(');
            assert.equal(findVar(r.outputs, 'g_value')?.comment, '説明');
        });
    }

    test('本文中のアスタリスクは残す (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
extern int g_value;    /*!< a * b の結果 */

void work(void) {
    g_value = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_value')?.comment, 'a * b の結果');
    });

    test('本文が空のコメントは空文字列にする (v2.21.0)', async () => {
        const r = await analyzeOrThrow(`
extern int g_value;    /**/

void work(void) {
    g_value = 1;
}
`, 'void work(');
        assert.equal(findVar(r.outputs, 'g_value')?.comment, '');
    });
});

describe('フェーズ5: マクロ定義のコメント', () => {
    /** マクロの書き方と、期待する定義値・コメント */
    const CASES: { label: string; def: string; name: string; use: string; value: string; comment: string }[] = [
        { label: 'ブロックコメント', def: '#define LIMIT 100    /* 上限値 */', name: 'LIMIT', use: 'a = LIMIT;', value: '100', comment: '上限値' },
        { label: '行コメント', def: '#define LIMIT 100    // 上限値', name: 'LIMIT', use: 'a = LIMIT;', value: '100', comment: '上限値' },
        { label: 'Doxygen 行', def: '#define LIMIT 100    //!< 上限値', name: 'LIMIT', use: 'a = LIMIT;', value: '100', comment: '上限値' },
        { label: 'Doxygen ブロック', def: '#define LIMIT 100    /**< 上限値 */', name: 'LIMIT', use: 'a = LIMIT;', value: '100', comment: '上限値' },
        { label: '式の値＋行コメント', def: '#define LIMIT (BASE + 1)    // 上限値', name: 'LIMIT', use: 'a = LIMIT;', value: '(BASE + 1)', comment: '上限値' },
        { label: '関数形式＋行コメント', def: '#define SQ(x) ((x)*(x))    // 二乗', name: 'SQ', use: 'a = SQ(2);', value: '((x)*(x))', comment: '二乗' }
    ];

    for (const c of CASES) {
        test(`${c.label}: 定義値とコメントを分けて取得する (v2.23.2)`, async () => {
            const r = await analyzeOrThrow(`
${c.def}
int a;

void work(void) {
    ${c.use}
}
`, 'void work(');
            // マクロ変数とマクロ関数は別のリストのため、両方から探す
            const item: { value?: string; comment?: string } | undefined =
                (r.macroVariables || []).find(v => v.name === c.name)
                || (r.macroFunctions || []).find(v => v.name === c.name);
            assert.ok(item, `${c.name} が含まれること`);
            assert.equal(item.value, c.value, '定義値にコメントが混ざらないこと');
            assert.equal(item.comment, c.comment);
        });
    }

    test('値を持たないマクロの行コメントも取得する (v2.23.2)', async () => {
        const r = await analyzeOrThrow(`
#define ENABLED    // 有効化フラグ
int a;

void work(void) {
    a = ENABLED;
}
`, 'void work(');
        const item = (r.macroVariables || []).find(v => v.name === 'ENABLED');
        assert.equal(item?.comment, '有効化フラグ');
    });

    test('文字列リテラル内の // はコメントとして扱わない (v2.23.2)', async () => {
        const r = await analyzeOrThrow(`
#define URL "http://example.com"    // 接続先
int a;

void work(void) {
    a = (int)URL;
}
`, 'void work(');
        const item = (r.macroVariables || []).find(v => v.name === 'URL');
        assert.equal(item?.value, '"http://example.com"', 'リテラル内の // で切れないこと');
        assert.equal(item?.comment, '接続先');
    });

    test('コメントがないマクロは従来どおり定義値のみとする (v2.23.2)', async () => {
        const r = await analyzeOrThrow(`
#define LIMIT 100
int a;

void work(void) {
    a = LIMIT;
}
`, 'void work(');
        const item = (r.macroVariables || []).find(v => v.name === 'LIMIT');
        assert.equal(item?.value, '100');
        assert.equal(item?.comment, undefined);
    });
});

describe('アクセスパスのセグメント位置', () => {
    test('多段アクセスは、各セグメントの位置を記録する (v3.0.1)', async () => {
        const r = await analyzeOrThrow(`
struct Item { int value; };
struct Item g_tbl[8];

void work(void) {
    g_tbl[0].value = 1;
}
`, 'void work(');
        const item = r.outputs.find(v => v.name === 'g_tbl[8].value');
        assert.ok(item, 'g_tbl[8].value が出力変数にあること');
        assert.equal(item?.segments?.length, 2, 'g_tbl と value の2つを記録すること');
        // 1つ目は g_tbl、2つ目は value（= 参照位置と同じ）
        assert.deepEqual(item?.segments?.[0], { line: 5, column: 4 });
        assert.deepEqual(item?.segments?.[1], item?.usage);
    });

    test('単一の変数でも、セグメント位置を記録する (v3.0.1)', async () => {
        const r = await analyzeOrThrow(`
int g_flat[16];

void work(void) {
    g_flat[3] = 4;
}
`, 'void work(');
        const item = r.outputs.find(v => v.name === 'g_flat[16]');
        assert.equal(item?.segments?.length, 1);
        assert.deepEqual(item?.segments?.[0], item?.usage);
    });

    test('読み出しでもセグメント位置を記録する (v3.0.1)', async () => {
        const r = await analyzeOrThrow(`
struct Item { int value; };
struct Item g_tbl[8];
int a;

void work(void) {
    a = g_tbl[0].value;
}
`, 'void work(');
        const item = r.inputs.find(v => v.name === 'g_tbl[8].value');
        assert.equal(item?.segments?.length, 2);
        assert.deepEqual(item?.segments?.[0], { line: 6, column: 8 });
    });
});
