/**
 * インクルードファイル探索（型解決・定義位置解決）のテストです。
 *
 * 実ファイルを用意する代わりに、パス→ソース文字列のマップを持つ
 * メモリ上の疑似リゾルバを注入してテストします。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Parser = require('web-tree-sitter');
import { analyzeCFunction, AnalysisResult, IncludeResolver, ResolvedInclude } from '../src/analyzer';
import { getParser, names, findVar } from './support/parse';
import { parseWithModifierMacroRepair } from '../src/macroRepair';

/**
 * メモリ上のソース群からインクルードを解決する疑似リゾルバです。
 */
class MemoryIncludeResolver implements IncludeResolver {
    /** 解決要求を受けたインクルードパスの記録（探索が発散しないことの検証に使用） */
    public readonly requested: string[] = [];

    /**
     * @param files インクルードパス → Cソース文字列 のマップ
     * @param parseFn ソース文字列をASTへ変換する関数
     */
    constructor(
        private readonly files: Record<string, string>,
        private readonly parseFn: (source: string) => Parser.Tree
    ) {}

    public resolve(includePath: string): ResolvedInclude | null {
        this.requested.push(includePath);
        const source = this.files[includePath];
        if (source === undefined) {
            return null;
        }
        return { tree: this.parseFn(source), filePath: `file:///virtual/${includePath}` };
    }
}

/**
 * 疑似リゾルバを注入して解析を実行します。
 *
 * @param mainSource 解析対象ファイルのソース
 * @param signatureHint 対象関数のシグネチャ行を特定する部分文字列
 * @param files インクルードパス → ソース文字列 のマップ
 * @returns 解析結果と使用したリゾルバ
 */
async function analyzeWithIncludes(
    mainSource: string,
    signatureHint: string,
    files: Record<string, string> = {}
): Promise<{ result: AnalysisResult; resolver: MemoryIncludeResolver }> {
    const parser = await getParser();
    const resolver = new MemoryIncludeResolver(
        files,
        (source: string) => parseWithModifierMacroRepair(parser, source)
    );
    const cursorLine = mainSource.split('\n').findIndex(line => line.includes(signatureHint));
    if (cursorLine < 0) {
        throw new Error(`シグネチャ "${signatureHint}" を含む行が見つかりません。`);
    }

    const result = analyzeCFunction(parseWithModifierMacroRepair(parser, mainSource), cursorLine, true, {
        includeResolver: resolver,
        currentFilePath: 'file:///virtual/main.c'
    });
    if (!result) {
        throw new Error('解析結果が null でした。');
    }
    return { result, resolver };
}

describe('インクルード探索: 変数の型解決', () => {
    test('ヘッダの extern 宣言からグローバル変数の型を解決する', async () => {
        const { result } = await analyzeWithIncludes(`#include "config.h"

void bump(void) {
    shared_counter = shared_counter + 1;
}
`, 'void bump(', {
            'config.h': `extern int shared_counter;\n`
        });

        const g = findVar(result.outputs, 'shared_counter');
        assert.ok(g, `出力に shared_counter が含まれること: ${names(result.outputs)}`);
        assert.equal(g.type, 'int', '(推定) ではなくヘッダの型が使われること');
    });

    test('解決した変数の定義位置にインクルードファイルのパスが設定される', async () => {
        const { result } = await analyzeWithIncludes(`#include "config.h"

void bump(void) {
    shared_counter = 1;
}
`, 'void bump(', {
            'config.h': `/* 設定 */\nextern int shared_counter;\n`
        });

        const g = findVar(result.outputs, 'shared_counter');
        assert.ok(g?.definition, '定義位置が記録されること');
        assert.equal(g.definition.filePath, 'file:///virtual/config.h');
        assert.equal(g.definition.line, 1, 'コメント行の次（0始まりで1行目）を指すこと');
    });

    test('構造体型のグローバル変数のメンバ型が解決される', async () => {
        const { result } = await analyzeWithIncludes(`#include "types.h"

void setup(void) {
    g_config.mode = 1;
}
`, 'void setup(', {
            'types.h': `struct Config { int mode; };\nextern struct Config g_config;\n`
        });

        const g = findVar(result.outputs, 'g_config.mode');
        assert.ok(g, `出力に g_config.mode が含まれること: ${names(result.outputs)}`);
        assert.equal(g.type, 'int', 'メンバ mode の型が解決されること');
    });

    test('インクルードファイル内の構造体定義からメンバ型を解決する', async () => {
        // 構造体定義はヘッダ側にあるのが一般的なため、探索結果からも引けること
        const { result } = await analyzeWithIncludes(`#include "types.h"

void setup(void) {
    g_config.ratio = 1.5;
    g_config.name[0] = 'a';
}
`, 'void setup(', {
            'types.h': `struct Config { int mode; float ratio; char name[8]; };
extern struct Config g_config;
`
        });

        assert.equal(findVar(result.outputs, 'g_config.ratio')?.type, 'float');
        assert.equal(findVar(result.outputs, 'g_config.name[8]')?.type, 'char',
            `配列メンバは名前側に次元が出ること: ${names(result.outputs)}`);
    });

    test('ヘッダ内で定義と typedef を分けて書いた構造体のメンバ型を解決する (v2.12.1)', async () => {
        // 組込みコードでよく使われる書き方。typedef の位置に中身がないため別名から実体を辿る
        const { result } = await analyzeWithIncludes(`#include "types.h"

void setup(void) {
    g_cfg.mode = 1;
}
`, 'void setup(', {
            'types.h': `#ifndef TYPES_H
#define TYPES_H
struct ConfigTag { unsigned char mode; };
typedef struct ConfigTag Config;
extern Config g_cfg;
#endif
`
        });

        const v = findVar(result.outputs, 'g_cfg.mode');
        assert.ok(v, `出力に g_cfg.mode が含まれること: ${names(result.outputs)}`);
        assert.equal(v.type, 'unsigned char', 'メンバの型に解決されること');
    });

    test('構造体定義と typedef が別のヘッダにある場合も解決する (v2.12.1)', async () => {
        const { result } = await analyzeWithIncludes(`#include "alias.h"

void setup(void) {
    g_cfg.mode = 1;
}
`, 'void setup(', {
            'alias.h': `#include "tag.h"
typedef struct ConfigTag Config;
extern Config g_cfg;
`,
            'tag.h': `struct ConfigTag { unsigned char mode; };\n`
        });

        assert.equal(
            findVar(result.outputs, 'g_cfg.mode')?.type,
            'unsigned char',
            'ファイルを跨いでも解決されること'
        );
    });

    test('解析対象ファイル自身の宣言をインクルード側より優先する', async () => {
        const { result } = await analyzeWithIncludes(`#include "config.h"

float shared_counter;

void bump(void) {
    shared_counter = 1;
}
`, 'void bump(', {
            'config.h': `extern int shared_counter;\n`
        });

        const g = findVar(result.outputs, 'shared_counter');
        assert.ok(g, '出力に shared_counter が含まれること');
        assert.equal(g.type, 'float', '自ファイルの宣言（float）が優先されること');
        assert.equal(g.definition?.filePath, undefined, '自ファイル内のため filePath は未設定');
    });
});

describe('インクルード探索: プリプロセッサ条件ブロック内の宣言', () => {
    test('インクルードガード内の extern 宣言を解決する', async () => {
        // #ifndef 〜 #endif で囲まれた宣言は preproc_ifdef の子になるため、
        // ルート直下のみを走査すると拾えない（C言語ヘッダのほぼ全てが該当する）
        const { result } = await analyzeWithIncludes(`#include "config.h"

void bump(void) {
    shared_counter = shared_counter + 1;
}
`, 'void bump(', {
            'config.h': `#ifndef CONFIG_H
#define CONFIG_H

extern int shared_counter;

#endif
`
        });

        const g = findVar(result.outputs, 'shared_counter');
        assert.ok(g, `出力に shared_counter が含まれること: ${names(result.outputs)}`);
        assert.equal(g.type, 'int', 'インクルードガード内の型が解決されること');
        assert.equal(g.definition?.line, 3);
    });

    test('インクルードガード内の関数プロトタイプ宣言を解決する', async () => {
        const { result } = await analyzeWithIncludes(`#include "log.h"

void work(void) {
    log_message("hello");
}
`, 'void work(', {
            'log.h': `#ifndef LOG_H
#define LOG_H
void log_message(const char *m);
#endif
`
        });

        const fn = result.calledFunctions.find(f => f.name === 'log_message');
        assert.ok(fn?.definition, 'log_message の定義位置が解決されること');
        assert.equal(fn.definition.line, 2);
    });

    test('#if / #elif / #else 内の宣言も解決する', async () => {
        const { result } = await analyzeWithIncludes(`#include "variant.h"

void work(void) {
    in_if = 1;
    in_elif = 2;
    in_else = 3;
}
`, 'void work(', {
            'variant.h': `#if defined(A)
extern char in_if;
#elif defined(B)
extern short in_elif;
#else
extern long in_else;
#endif
`
        });

        // 条件の真偽は評価せず、記述されている宣言をすべて収集する
        assert.equal(findVar(result.outputs, 'in_if')?.type, 'char');
        assert.equal(findVar(result.outputs, 'in_elif')?.type, 'short');
        assert.equal(findVar(result.outputs, 'in_else')?.type, 'long');
    });

    test('入れ子になったインクルードガード内の宣言も解決する', async () => {
        const { result } = await analyzeWithIncludes(`#include "outer.h"

void work(void) {
    nested_value = 1;
}
`, 'void work(', {
            'outer.h': `#ifndef OUTER_H
#define OUTER_H
#ifdef FEATURE_X
extern double nested_value;
#endif
#endif
`
        });

        assert.equal(findVar(result.outputs, 'nested_value')?.type, 'double');
    });

    test('インクルードガード内の #include も辿る', async () => {
        const { result } = await analyzeWithIncludes(`#include "a.h"

void work(void) {
    deep_value = 1;
}
`, 'void work(', {
            'a.h': `#ifndef A_H
#define A_H
#include "b.h"
#endif
`,
            'b.h': `extern unsigned int deep_value;\n`
        });

        const g = findVar(result.outputs, 'deep_value');
        assert.ok(g, '出力に deep_value が含まれること');
        assert.equal(g.type, 'unsigned int');
        assert.equal(g.definition?.filePath, 'file:///virtual/b.h');
    });
});

describe('インクルード探索: マクロの解決', () => {
    test('ヘッダの #define から定義値を表示する', async () => {
        const { result } = await analyzeWithIncludes(`#include "limits.h"

int check(int v) {
    return v > MAX_LIMIT;
}
`, 'int check(', {
            'limits.h': `#define MAX_LIMIT 10\n`
        });

        const m = findVar(result.macroVariables ?? [], 'MAX_LIMIT');
        assert.ok(m, `マクロ変数に MAX_LIMIT が含まれること: ${names(result.macroVariables ?? [])}`);
        assert.equal(m.type, 'macro');
        assert.equal(m.value, '10');
        assert.equal(m.definition?.filePath, 'file:///virtual/limits.h');
    });

    test('値を持たないマクロは macro と表示する', async () => {
        const { result } = await analyzeWithIncludes(`#include "flags.h"

int check(int v) {
    return v + ENABLE_DEBUG;
}
`, 'int check(', {
            'flags.h': `#define ENABLE_DEBUG\n`
        });

        const m = findVar(result.macroVariables ?? [], 'ENABLE_DEBUG');
        assert.ok(m, 'マクロ変数に ENABLE_DEBUG が含まれること');
        assert.equal(m.type, 'macro');
    });

    test('解析対象ファイル自身の #define も解決する', async () => {
        const { result } = await analyzeWithIncludes(`#define LOCAL_MAX 42

int check(int v) {
    return v > LOCAL_MAX;
}
`, 'int check(');

        const m = findVar(result.macroVariables ?? [], 'LOCAL_MAX');
        assert.ok(m, 'マクロ変数に LOCAL_MAX が含まれること');
        assert.equal(m.type, 'macro');
        assert.equal(m.value, '42');
        assert.equal(m.definition?.filePath, undefined, '自ファイル内のため filePath は未設定');
        assert.equal(m.definition?.line, 0);
    });

    test('解決できないマクロは (推定) のままとする', async () => {
        const { result } = await analyzeWithIncludes(`int check(int v) {
    return v > UNKNOWN_LIMIT;
}
`, 'int check(');

        const m = findVar(result.macroVariables ?? [], 'UNKNOWN_LIMIT');
        assert.ok(m, 'マクロ変数に UNKNOWN_LIMIT が含まれること');
        assert.equal(m.type, '(推定)');
        assert.equal(m.definition, undefined);
    });

    test('マクロ関数の定義位置を解決する', async () => {
        const { result } = await analyzeWithIncludes(`#include "log.h"

void work(void) {
    LOG_MSG("hello");
}
`, 'void work(', {
            'log.h': `#define LOG_MSG(m) printf(m)\n`
        });

        const fn = (result.macroFunctions ?? []).find(f => f.name === 'LOG_MSG');
        assert.ok(fn, `マクロ関数に LOG_MSG が含まれること: ${names(result.macroFunctions ?? [])}`);
        assert.equal(fn.definition?.filePath, 'file:///virtual/log.h');
    });
});

describe('インクルード探索: 関数の定義位置解決', () => {
    test('ヘッダのプロトタイプ宣言から呼び出し関数の定義位置を解決する', async () => {
        const { result } = await analyzeWithIncludes(`#include "log.h"

void work(void) {
    log_message("hello");
}
`, 'void work(', {
            'log.h': `void log_message(const char *m);\n`
        });

        const fn = result.calledFunctions.find(f => f.name === 'log_message');
        assert.ok(fn, `呼び出し関数に log_message が含まれること: ${names(result.calledFunctions)}`);
        assert.equal(fn.definition?.filePath, 'file:///virtual/log.h');
        assert.equal(fn.definition?.line, 0);
    });
});

describe('インクルード探索: 探索の制御', () => {
    test('インクルードを再帰的に辿る', async () => {
        const { result } = await analyzeWithIncludes(`#include "a.h"

void work(void) {
    deep_value = 1;
}
`, 'void work(', {
            'a.h': `#include "b.h"\n`,
            'b.h': `extern short deep_value;\n`
        });

        const g = findVar(result.outputs, 'deep_value');
        assert.ok(g, '出力に deep_value が含まれること');
        assert.equal(g.type, 'short', '2段階先のヘッダの型が解決されること');
        assert.equal(g.definition?.filePath, 'file:///virtual/b.h');
    });

    test('循環インクルードでも無限ループしない', async () => {
        const { result, resolver } = await analyzeWithIncludes(`#include "x.h"

void work(void) {
    ring_value = 1;
}
`, 'void work(', {
            'x.h': `#include "y.h"\nextern int ring_value;\n`,
            'y.h': `#include "x.h"\n`
        });

        assert.ok(findVar(result.outputs, 'ring_value'), '循環があっても解析が完了すること');
        // x.h は一度しか展開されないため、解決要求は有限回に収まる
        assert.ok(resolver.requested.length < 10, `解決要求が発散しないこと: ${resolver.requested.length}回`);
    });

    test('システムインクルード (<...>) は探索しない', async () => {
        const { resolver } = await analyzeWithIncludes(`#include <stdio.h>
#include "config.h"

void work(void) {
    shared_counter = 1;
}
`, 'void work(', {
            'config.h': `extern int shared_counter;\n`
        });

        assert.ok(!resolver.requested.includes('stdio.h'), 'stdio.h は解決要求されないこと');
        assert.ok(resolver.requested.includes('config.h'), 'config.h は解決要求されること');
    });

    test('解決できないインクルードがあっても解析を継続する', async () => {
        const { result } = await analyzeWithIncludes(`#include "missing.h"

void work(void) {
    unknown_global = 1;
}
`, 'void work(');

        const g = findVar(result.outputs, 'unknown_global');
        assert.ok(g, '解析結果が得られること');
        assert.equal(g.type, '(推定)', '解決できない変数は推定表示のままであること');
    });

    test('リゾルバが例外を投げても解析を継続する', async () => {
        const parser = await getParser();
        const throwingResolver: IncludeResolver = {
            resolve: () => {
                throw new Error('読み込み失敗');
            }
        };
        const source = `#include "broken.h"

void work(void) {
    some_global = 1;
}
`;
        const cursorLine = source.split('\n').findIndex(l => l.includes('void work('));
        const result = analyzeCFunction(parser.parse(source), cursorLine, true, {
            includeResolver: throwingResolver,
            currentFilePath: 'file:///virtual/main.c'
        });

        assert.ok(result, '例外が伝播せず解析結果が返ること');
        assert.ok(names(result.outputs).includes('some_global'));
    });

    test('#ifdef 内のインクルードも探索する', async () => {
        const { result } = await analyzeWithIncludes(`#ifdef DEBUG
#include "debug.h"
#endif

void work(void) {
    debug_level = 1;
}
`, 'void work(', {
            'debug.h': `extern char debug_level;\n`
        });

        const g = findVar(result.outputs, 'debug_level');
        assert.ok(g, '出力に debug_level が含まれること');
        assert.equal(g.type, 'char');
    });

    test('リゾルバ未指定時はインクルードを探索しない（後方互換）', async () => {
        const parser = await getParser();
        const source = `#include "config.h"

void work(void) {
    shared_counter = 1;
}
`;
        const cursorLine = source.split('\n').findIndex(l => l.includes('void work('));
        const result = analyzeCFunction(parser.parse(source), cursorLine, true);

        assert.ok(result, '解析結果が返ること');
        const g = findVar(result.outputs, 'shared_counter');
        assert.equal(g?.type, '(推定)', 'リゾルバなしでは従来通り推定表示となること');
    });
});

describe('インクルード探索: 構造体メンバの定義位置', () => {
    test('メンバの定義位置はヘッダ内のメンバ宣言行を指す (v2.17.0)', async () => {
        const { result } = await analyzeWithIncludes(`#include "types.h"

void setup(void) {
    g_config.mode = 1;
}
`, 'void setup(', {
            'types.h': `#ifndef TYPES_H
#define TYPES_H
struct Config {
    int mode;
};
extern struct Config g_config;
#endif
`
        });

        const v = findVar(result.outputs, 'g_config.mode');
        assert.ok(v?.definition, '定義位置が記録されること');
        assert.equal(v.definition.filePath, 'file:///virtual/types.h');
        assert.equal(v.definition.line, 3, 'メンバ int mode; の行を指すこと');
    });

    test('解決できないメンバは定義位置を持たない (v2.17.0)', async () => {
        const { result } = await analyzeWithIncludes(`#include "types.h"

void setup(void) {
    g_config.unknown = 1;
}
`, 'void setup(', {
            'types.h': `struct Config { int mode; };\nextern struct Config g_config;\n`
        });

        const v = findVar(result.outputs, 'g_config.unknown');
        assert.ok(v, '出力に含まれること');
        assert.equal(v.type, '(推定)');
        assert.equal(v.definition, undefined, '「定義へ」ボタンを出さないこと');
    });
});
