/**
 * 解析結果の各項目について、定義位置を解決して型名・コメント・定義値を埋める処理です。
 *
 * 定義位置は VS Code の定義プロバイダ（F12 と同じもの）から取得します。自前で
 * `#include` を辿る方式と違い、実際のビルド構成に基づいて解決されるため、
 * 同名ファイルの取り違えや探索の深さ上限といった問題が起きません。
 *
 * VS Code API には触れず、参照を解決する関数を注入する形にしているため
 * ヘッドレス環境でテストできます。
 */
import {
    AnalysisResult,
    DefinitionInfo,
    FunctionInfo,
    SourcePosition,
    VariableInfo
} from './analyzer';

/** 定義位置の候補 */
export interface DefinitionCandidate {
    /** 定義があるファイル（URI文字列） */
    filePath: string;
    /** 定義位置の行（0始まり） */
    line: number;
    /** 定義位置の列（0始まり） */
    column: number;
}

/** 定義位置を解決するための依存 */
export interface DefinitionLookup {
    /**
     * 参照位置から定義位置の候補を返します。
     * 設定 `excludePaths` による除外は、この中で適用済みであることを想定します。
     */
    findDefinitions(usage: SourcePosition): Promise<DefinitionCandidate[]>;
    /** 定義位置にある宣言の情報を読み取ります */
    describe(candidate: DefinitionCandidate): Promise<DefinitionInfo | null>;
}

/** 型名を特定できなかった項目に表示する文字列（analyzer.ts と揃える） */
const UNKNOWN_TYPE = '(推定)';

/**
 * 解析結果の各項目について、定義位置を解決して情報を埋めます。
 *
 * 参照位置を持たない項目（引数そのもの・ローカル変数・戻り値）は、現在のファイルだけで
 * 型もコメントも分かるため対象外です。
 *
 * @param result 解析結果（この関数が直接書き換えます）
 * @param lookup 定義位置の解決手段
 */
export async function resolveDefinitions(
    result: AnalysisResult,
    lookup: DefinitionLookup
): Promise<void> {
    const macroVariables = result.macroVariables ?? [];
    const macroFunctions = result.macroFunctions ?? [];

    // 型名だと判明した項目は変数・関数の一覧から取り除く
    const typeNames = new Set<string>();
    // マクロ・列挙子だと判明した項目はマクロの一覧へ移す
    const movedToMacro: VariableInfo[] = [];

    const variableLists: VariableInfo[][] = [
        result.inputs,
        result.outputs,
        result.internalVariables,
        macroVariables
    ];

    for (const list of variableLists) {
        for (const item of list) {
            await applyToVariable(item, lookup, typeNames, movedToMacro, list !== macroVariables);
        }
    }

    for (const list of [result.calledFunctions, macroFunctions]) {
        for (const item of list) {
            await applyToFunction(item, lookup, typeNames);
        }
    }

    finalize(result, typeNames, movedToMacro, macroVariables, macroFunctions);
}

/**
 * 変数の項目に、定義位置から読み取った情報を反映します。
 *
 * @param item 対象の項目
 * @param lookup 定義位置の解決手段
 * @param typeNames 型名だと判明した名前の記録先
 * @param movedToMacro マクロだと判明した項目の記録先
 * @param canBecomeMacro マクロへ移し替える対象か（マクロ変数の一覧では不要）
 */
async function applyToVariable(
    item: VariableInfo,
    lookup: DefinitionLookup,
    typeNames: Set<string>,
    movedToMacro: VariableInfo[],
    canBecomeMacro: boolean
): Promise<void> {
    const resolved = await resolve(item.usage, lookup);
    if (!resolved) {
        return;
    }
    const { candidate, info, ambiguous } = resolved;

    if (info.kind === 'type') {
        // 型名は変数ではない（キャストの誤解釈で紛れ込む）
        typeNames.add(item.name);
        return;
    }

    item.definition = {
        filePath: candidate.filePath,
        line: candidate.line,
        column: candidate.column,
        ambiguous: ambiguous || undefined
    };
    if (info.comment) {
        item.comment = info.comment;
    }

    if (info.kind === 'macro' || info.kind === 'enum') {
        item.type = info.kind === 'enum' ? 'enum' : 'macro';
        if (info.value) {
            item.value = info.value;
        }
        if (canBecomeMacro) {
            movedToMacro.push(item);
        }
        return;
    }

    applyVariableType(item, info);
    await applyArrayDimensions(item, info, lookup);
}

/**
 * アクセスパスの各セグメントに、宣言された配列の次元を反映します。
 *
 * 次元はセグメントごとに宣言が異なるため（`g_tbl[].member` の `[]` は `g_tbl` の次元）、
 * `[]` が残っているセグメントについて、そのセグメントの定義を個別に辿ります。
 *
 * @param item 対象の項目
 * @param lastInfo 最後のセグメントについて解決済みの情報（再取得を避けるために使う）
 * @param lookup 定義位置の解決手段
 */
async function applyArrayDimensions(
    item: VariableInfo,
    lastInfo: DefinitionInfo,
    lookup: DefinitionLookup
): Promise<void> {
    // 区切り文字（. と ->）を保持したまま分割する
    const parts = item.name.split(/(\.|->)/);

    // 単一セグメントであれば、参照位置がそのままそのセグメントの位置になる
    const positions = item.segments && item.segments.length > 0
        ? item.segments
        : (parts.length === 1 && item.usage ? [item.usage] : undefined);
    if (!positions) {
        return;
    }

    let segmentIndex = 0;
    let changed = false;

    for (let i = 0; i < parts.length; i += 2) {
        const segment = parts[i];
        const position = positions[segmentIndex];
        segmentIndex++;

        // 次元が未確定（`[]` のまま）のセグメントだけを対象とする
        if (!segment.endsWith('[]') || !position) {
            continue;
        }

        const isLast = i + 2 >= parts.length;
        const info = isLast ? lastInfo : await describeAt(position, lookup);
        if (!info || info.arrayDimensions.length === 0) {
            continue;
        }

        parts[i] = segment.slice(0, -2) + info.arrayDimensions.map(d => `[${d}]`).join('');
        changed = true;
    }

    if (changed) {
        item.name = parts.join('');
    }
}

/**
 * 参照位置の定義を辿り、宣言情報を返します。
 *
 * @param position 参照位置
 * @param lookup 定義位置の解決手段
 * @returns 宣言情報。解決できない場合は null
 */
async function describeAt(
    position: SourcePosition,
    lookup: DefinitionLookup
): Promise<DefinitionInfo | null> {
    const resolved = await resolve(position, lookup);
    return resolved ? resolved.info : null;
}

/**
 * 変数の型名と、配列の次元の表記を反映します。
 *
 * 次元は名前と型名のどちらか一方にのみ出します（添字でアクセスされている場合は名前側）。
 *
 * @param item 対象の項目
 * @param info 定義位置から読み取った情報
 */
function applyVariableType(item: VariableInfo, info: DefinitionInfo): void {
    if (!info.type) {
        return;
    }

    const dimensions = info.arrayDimensions;
    // 添字でアクセスされている場合、次元は名前側へ出す（反映は applyArrayDimensions が行う）
    if (dimensions.length > 0 && item.name.endsWith('[]')) {
        item.type = info.type;
        return;
    }

    // 添字なしで参照されている場合は、次元を型名側へ付ける
    item.type = dimensions.length > 0
        ? info.type + dimensions.map(d => `[${d}]`).join('')
        : info.type;
}

/**
 * 呼び出し関数の項目に、定義位置から読み取った情報を反映します。
 *
 * @param item 対象の項目
 * @param lookup 定義位置の解決手段
 * @param typeNames 型名だと判明した名前の記録先
 */
async function applyToFunction(
    item: FunctionInfo,
    lookup: DefinitionLookup,
    typeNames: Set<string>
): Promise<void> {
    const resolved = await resolve(item.usage, lookup);
    if (!resolved) {
        return;
    }
    const { candidate, info, ambiguous } = resolved;

    if (info.kind === 'type') {
        typeNames.add(item.name);
        return;
    }

    item.definition = {
        filePath: candidate.filePath,
        line: candidate.line,
        column: candidate.column,
        ambiguous: ambiguous || undefined
    };
    if (info.comment) {
        item.comment = info.comment;
    }

    if (info.kind === 'macro' || info.kind === 'enum') {
        item.type = info.kind === 'enum' ? 'enum' : 'macro';
        if (info.value) {
            item.value = info.value;
        }
        return;
    }
    if (info.type) {
        item.type = info.type;
    }
}

/**
 * 参照位置から定義位置と宣言情報を求めます。
 *
 * @param usage 参照位置（未設定の場合は解決しません）
 * @param lookup 定義位置の解決手段
 * @returns 解決結果。解決できない場合は null
 */
async function resolve(
    usage: SourcePosition | undefined,
    lookup: DefinitionLookup
): Promise<{ candidate: DefinitionCandidate; info: DefinitionInfo; ambiguous: boolean } | null> {
    if (!usage) {
        return null;
    }

    let candidates: DefinitionCandidate[];
    try {
        candidates = await lookup.findDefinitions(usage);
    } catch {
        // 定義プロバイダが応答しない場合は解決せず、推定表示のままにする
        return null;
    }
    if (candidates.length === 0) {
        return null;
    }

    let info: DefinitionInfo | null;
    try {
        info = await lookup.describe(candidates[0]);
    } catch {
        info = null;
    }
    if (!info || info.kind === 'unknown') {
        return null;
    }

    return { candidate: candidates[0], info, ambiguous: candidates.length > 1 };
}

/**
 * 型名だと判明した項目の除去と、マクロだと判明した項目の移し替えを行います。
 *
 * @param result 解析結果
 * @param typeNames 型名だと判明した名前
 * @param movedToMacro マクロだと判明した項目
 * @param macroVariables マクロ変数の一覧
 * @param macroFunctions マクロ関数の一覧
 */
function finalize(
    result: AnalysisResult,
    typeNames: Set<string>,
    movedToMacro: VariableInfo[],
    macroVariables: VariableInfo[],
    macroFunctions: FunctionInfo[]
): void {
    const moved = new Set(movedToMacro);

    const keepVariable = (item: VariableInfo) => !typeNames.has(item.name) && !moved.has(item);
    result.inputs = result.inputs.filter(keepVariable);
    result.outputs = result.outputs.filter(keepVariable);
    result.internalVariables = result.internalVariables.filter(keepVariable);

    movedToMacro.forEach(item => {
        if (!macroVariables.some(existing => existing.name === item.name)) {
            macroVariables.push(item);
        }
    });

    result.calledFunctions = result.calledFunctions.filter(item => !typeNames.has(item.name));
    result.macroVariables = macroVariables.filter(item => !typeNames.has(item.name));
    result.macroFunctions = macroFunctions.filter(item => !typeNames.has(item.name));

    // 型名を特定できなかった項目は、推定表示のままにする
    [...result.inputs, ...result.outputs, ...result.internalVariables, ...result.macroVariables]
        .forEach(item => {
            if (!item.type) {
                item.type = UNKNOWN_TYPE;
            }
        });
    [...result.calledFunctions, ...result.macroFunctions].forEach(item => {
        if (!item.type) {
            item.type = UNKNOWN_TYPE;
        }
    });
}
