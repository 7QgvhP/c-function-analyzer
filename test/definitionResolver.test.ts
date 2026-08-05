/**
 * 定義位置の解決（definitionResolver.ts）のテストです。
 *
 * VS Code の定義プロバイダを模した関数を注入し、解析結果へ型名・コメント・定義値が
 * 正しく反映されるかを検証します。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisResult, DefinitionInfo } from '../src/analyzer';
import {
    DefinitionCandidate,
    DefinitionLookup,
    resolveDefinitions
} from '../src/definitionResolver';

/**
 * テスト用の解析結果を作ります。
 *
 * @param overrides 上書きしたいフィールド
 * @returns 解析結果
 */
function makeResult(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
    return {
        functionName: 'work',
        returnType: 'void',
        inputs: [],
        outputs: [],
        internalVariables: [],
        calledFunctions: [],
        macroVariables: [],
        macroFunctions: [],
        startLine: 0,
        endLine: 10,
        ...overrides
    };
}

/** 疑似の定義プロバイダに渡す設定 */
interface LookupEntry {
    /** 定義位置から読み取れる情報 */
    info: DefinitionInfo;
    /** 返す候補の数（既定は1件） */
    candidates?: number;
}

/**
 * 参照位置の行番号ごとに決まった結果を返す、疑似の定義プロバイダを作ります。
 *
 * @param table 参照位置の行番号 → 定義情報
 * @returns 定義解決手段
 */
function makeLookup(table: Record<number, LookupEntry>): DefinitionLookup {
    return {
        async findDefinitions(usage): Promise<DefinitionCandidate[]> {
            const entry = table[usage.line];
            if (!entry) {
                return [];
            }
            const count = entry.candidates === undefined ? 1 : entry.candidates;
            // 参照位置の行番号を定義位置の列に埋め込み、describe から引けるようにする
            return Array.from({ length: count }, (unused, index) => ({
                filePath: 'file:///a.h',
                line: 10 + index,
                column: usage.line
            }));
        },
        async describe(candidate) {
            const entry = table[candidate.column];
            return entry ? entry.info : null;
        }
    };
}

/**
 * 変数の定義情報を作ります。
 *
 * @param type 型名
 * @param extra 上書きしたいフィールド
 * @returns 定義情報
 */
function variableInfo(type: string, extra: Partial<DefinitionInfo> = {}): DefinitionInfo {
    return { kind: 'variable', type, arrayDimensions: [], ...extra };
}

describe('resolveDefinitions: 変数', () => {
    test('型名とコメントと定義位置を埋める', async () => {
        const result = makeResult({
            outputs: [{ name: 'g_count', type: '(推定)', details: '', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: variableInfo('int', { comment: '実行回数' }) }
        }));

        const item = result.outputs[0];
        assert.equal(item.type, 'int');
        assert.equal(item.comment, '実行回数');
        assert.equal(item.definition?.filePath, 'file:///a.h');
        assert.equal(item.definition?.line, 10);
    });

    test('参照位置がない項目は変更しない', async () => {
        const result = makeResult({
            outputs: [{ name: 'local', type: 'int', details: '' }]
        });
        await resolveDefinitions(result, makeLookup({}));

        assert.equal(result.outputs[0].type, 'int');
        assert.equal(result.outputs[0].definition, undefined);
    });

    test('定義が見つからない項目は推定表示のままにする', async () => {
        const result = makeResult({
            outputs: [{ name: 'g_unknown', type: '(推定)', details: '', usage: { line: 5, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({}));

        assert.equal(result.outputs[0].type, '(推定)');
        assert.equal(result.outputs[0].definition, undefined);
    });

    test('候補が複数ある場合は注意の印を付ける', async () => {
        const result = makeResult({
            outputs: [{ name: 'g_count', type: '(推定)', details: '', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: variableInfo('int'), candidates: 2 }
        }));

        assert.equal(result.outputs[0].definition?.ambiguous, true);
    });
});

describe('resolveDefinitions: 配列の次元', () => {
    test('添字でアクセスされている場合は名前側へ次元を出す', async () => {
        const result = makeResult({
            outputs: [{ name: 'g_tbl[]', type: '(推定)', details: '', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: { kind: 'variable', type: 'int', arrayDimensions: ['8'] } }
        }));

        assert.equal(result.outputs[0].name, 'g_tbl[8]');
        assert.equal(result.outputs[0].type, 'int');
    });

    test('添字なしで参照されている場合は型名側へ次元を出す', async () => {
        const result = makeResult({
            inputs: [{ name: 'g_tbl', type: '(推定)', details: '', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: { kind: 'variable', type: 'int', arrayDimensions: ['8'] } }
        }));

        assert.equal(result.inputs[0].type, 'int[8]');
    });
});

describe('resolveDefinitions: マクロと列挙子', () => {
    test('マクロだと判明した変数はマクロ変数へ移す', async () => {
        const result = makeResult({
            inputs: [{ name: 'LIMIT', type: '(推定)', details: '', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: { kind: 'macro', type: '', arrayDimensions: [], value: '100', comment: '上限値' } }
        }));

        assert.deepEqual(result.inputs, [], '入力変数からは取り除かれること');
        assert.equal(result.macroVariables?.length, 1);
        assert.equal(result.macroVariables?.[0].type, 'macro');
        assert.equal(result.macroVariables?.[0].value, '100');
        assert.equal(result.macroVariables?.[0].comment, '上限値');
    });

    test('列挙子は型名欄を enum とする', async () => {
        const result = makeResult({
            inputs: [{ name: 'ST_RUN', type: '(推定)', details: '', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: { kind: 'enum', type: '', arrayDimensions: [], value: '1' } }
        }));

        assert.equal(result.macroVariables?.[0].type, 'enum');
        assert.equal(result.macroVariables?.[0].value, '1');
    });
});

describe('resolveDefinitions: 型名の除去', () => {
    test('型だと判明した項目は一覧から取り除く', async () => {
        const result = makeResult({
            inputs: [
                { name: 'BYTE', type: '(推定)', details: '', usage: { line: 1, column: 4 } },
                { name: 'g_count', type: '(推定)', details: '', usage: { line: 2, column: 4 } }
            ]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: { kind: 'type', type: 'unsigned char', arrayDimensions: [] } },
            2: { info: variableInfo('int') }
        }));

        assert.deepEqual(result.inputs.map(v => v.name), ['g_count']);
    });

    test('型だと判明した呼び出し関数も取り除く', async () => {
        const result = makeResult({
            calledFunctions: [{ name: 'BYTE', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: { kind: 'type', type: 'unsigned char', arrayDimensions: [] } }
        }));

        assert.deepEqual(result.calledFunctions, []);
    });
});

describe('resolveDefinitions: 呼び出し関数', () => {
    test('戻り値の型とコメントを埋める', async () => {
        const result = makeResult({
            calledFunctions: [{ name: 'calc', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: { kind: 'function', type: 'int', arrayDimensions: [], comment: '計算する' } }
        }));

        assert.equal(result.calledFunctions[0].type, 'int');
        assert.equal(result.calledFunctions[0].comment, '計算する');
        assert.equal(result.calledFunctions[0].definition?.line, 10);
    });

    test('マクロ関数だと判明した場合は macro と定義値を出す', async () => {
        const result = makeResult({
            macroFunctions: [{ name: 'SQ', usage: { line: 1, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({
            1: { info: { kind: 'macro', type: '', arrayDimensions: [], value: '((x)*(x))' } }
        }));

        assert.equal(result.macroFunctions?.[0].type, 'macro');
        assert.equal(result.macroFunctions?.[0].value, '((x)*(x))');
    });

    test('定義が見つからない関数は推定表示にする', async () => {
        const result = makeResult({
            calledFunctions: [{ name: 'printf', usage: { line: 9, column: 4 } }]
        });
        await resolveDefinitions(result, makeLookup({}));

        assert.equal(result.calledFunctions[0].type, '(推定)');
    });
});

describe('resolveDefinitions: 例外への耐性', () => {
    test('定義プロバイダが例外を投げても解析結果を壊さない', async () => {
        const result = makeResult({
            outputs: [{ name: 'g_count', type: '(推定)', details: '', usage: { line: 1, column: 4 } }]
        });
        const lookup: DefinitionLookup = {
            async findDefinitions() { throw new Error('provider error'); },
            async describe() { return null; }
        };

        await assert.doesNotReject(() => resolveDefinitions(result, lookup));
        assert.equal(result.outputs[0].type, '(推定)');
    });

    test('宣言を読み取れない場合は推定表示のままにする', async () => {
        const result = makeResult({
            outputs: [{ name: 'g_count', type: '(推定)', details: '', usage: { line: 1, column: 4 } }]
        });
        const lookup: DefinitionLookup = {
            async findDefinitions() { return [{ filePath: 'file:///a.h', line: 1, column: 0 }]; },
            async describe() { return { kind: 'unknown' as const, type: '', arrayDimensions: [] }; }
        };

        await resolveDefinitions(result, lookup);
        assert.equal(result.outputs[0].type, '(推定)');
        assert.equal(result.outputs[0].definition, undefined);
    });
});
