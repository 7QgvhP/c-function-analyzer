/**
 * 定義ジャンプがうまくいかなかった原因を判定する処理です。
 *
 * 定義検索の経過（候補の件数・除外・読み取りの成否）と、C/C++ 拡張が出している
 * エラー・警告を手がかりに、項目ごとに原因を分類します。
 *
 * | 分類 | 意味 |
 * |---|---|
 * | 正常 | 候補が1件で、宣言も読み取れた |
 * | 原因1（本アプリ） | 問い合わせ位置のずれ・excludePaths による除外・候補が複数・宣言の読み取り失敗 |
 * | 原因2（推測ジャンプ） | 候補はあるが、IntelliSense が宣言を把握できていない（include エラーなど） |
 * | 原因3（インクルード設定） | 候補が無く、include エラー、または識別子が未定義のエラーがある |
 * | 原因4（プロトタイプなし） | 呼び出し箇所で関数が暗黙に宣言されている |
 * | 判定できず | 候補が無く、手がかりも無い |
 *
 * VS Code API には触れないため、ヘッドレス環境でテストできます。
 */
import type { SourcePosition } from './analyzer';

/** 定義位置の候補（definitionResolver.ts の DefinitionCandidate と同じ形） */
export interface CandidateLocation {
    /** 定義があるファイル（URI文字列） */
    filePath: string;
    /** 定義位置の行（0始まり） */
    line: number;
    /** 定義位置の列（0始まり） */
    column: number;
}

/** 定義検索の結果の種類 */
export type LookupOutcome =
    /** 候補が1件で、宣言を読み取れた */
    | 'resolved'
    /** 候補が複数あり、先頭を採用した */
    | 'ambiguous'
    /** 定義プロバイダが候補を1件も返さなかった */
    | 'noCandidate'
    /** 候補はあったが、すべて excludePaths で除外された */
    | 'allExcluded'
    /** 定義プロバイダが例外を投げた */
    | 'providerError'
    /** 候補はあったが、その位置の宣言を読み取れなかった */
    | 'unreadable';

/** 定義検索の経過の記録 */
export interface LookupRecord {
    /** 結果の種類 */
    outcome: LookupOutcome;
    /** 定義プロバイダが返した候補（除外前） */
    candidates: CandidateLocation[];
    /** excludePaths で除外された候補 */
    excluded: CandidateLocation[];
    /** 採用した候補 */
    chosen?: CandidateLocation;
    /** 問い合わせた位置にある単語（取得できない場合は未設定） */
    tokenAtUsage?: string;
}

/** エディタのエラー・警告1件分（判定に必要な情報のみ） */
export interface SignalDiagnostic {
    /** 開始行（0始まり） */
    line: number;
    /** 開始列（0始まり） */
    column: number;
    /** 終了行（0始まり） */
    endLine: number;
    /** 終了列（0始まり） */
    endColumn: number;
    /** 重大度 */
    severity: 'error' | 'warning' | 'information' | 'hint';
    /** 発行元（C/C++ 拡張は `C/C++`） */
    source?: string;
    /** エラー番号（C/C++ 拡張は EDG の番号） */
    code?: string;
    /** メッセージ本文 */
    message: string;
}

/** 判定に使う、エディタ側の手がかり */
export interface EditorSignals {
    /** 解析対象ファイルに出ているエラー・警告 */
    diagnostics: SignalDiagnostic[];
    /**
     * C/C++ 拡張のエラー表示の設定（`C_Cpp.errorSquiggles`）。
     * 既定の `enabledIfIncludesResolve` では、include エラーがあると他のエラー表示が止まります。
     */
    errorSquiggles?: string;
    /** C/C++ 拡張がインストールされ有効か（不明な場合は未設定） */
    cppToolsActive?: boolean;
}

/** 判定結果の分類 */
export type DiagnosisCategory = 'ok' | 'app' | 'guess' | 'config' | 'implicit' | 'unknown';

/** 原因1（本アプリ側）の内訳 */
export type AppCause = 'position' | 'excluded' | 'multiple' | 'unreadable';

/** 項目ごとの判定結果 */
export interface DefinitionDiagnosis {
    /** 分類 */
    category: DiagnosisCategory;
    /** 原因1の内訳（category が `app` の場合のみ） */
    appCause?: AppCause;
    /** 分類の表示名（例: `原因3: インクルード設定`） */
    label: string;
    /** 1行の説明（ツールチップ・出力パネルで使う） */
    summary: string;
    /** 判定の根拠になったエラー・警告 */
    evidence: SignalDiagnostic[];
    /** 定義プロバイダが返した候補の件数（除外前） */
    candidateCount: number;
    /** 採用した候補 */
    chosen?: CandidateLocation;
}

/** C/C++ 拡張のエラー番号（EDG）。実環境で番号が違っても、メッセージの照合で補う */
const CPPTOOLS_CODES = {
    includeError: ['1696'],
    implicitDeclaration: ['223'],
    undefinedIdentifier: ['20']
};

/** メッセージの照合パターン（C/C++ 拡張の英語・日本語表示と clangd を想定） */
const MESSAGE_PATTERNS = {
    includeError: /cannot open source file|#include errors detected|file not found|開けません|#include\s*エラー/i,
    implicitDeclaration: /declared implicitly|implicit declaration of function|暗黙的に宣言|暗黙の宣言/i,
    undefinedIdentifier: /is undefined|undeclared identifier|定義されていません|宣言されていません/i
};

/** 分類ごとの表示名 */
const CATEGORY_LABELS: Record<DiagnosisCategory, string> = {
    ok: '正常',
    app: '原因1: 本アプリ',
    guess: '原因2: 推測ジャンプ',
    config: '原因3: インクルード設定',
    implicit: '原因4: プロトタイプなし',
    unknown: '判定できず'
};

/** 原因1の内訳ごとの表示名 */
const APP_CAUSE_LABELS: Record<AppCause, string> = {
    position: '原因1-①: 問い合わせ位置のずれ',
    excluded: '原因1-②: excludePaths で除外',
    multiple: '原因1-③: 候補が複数',
    unreadable: '原因1-④: 宣言を読み取れない'
};

/**
 * 項目1件について、定義ジャンプの結果と原因を判定します。
 *
 * @param itemName 項目の表示名（`g_tbl[].value` のようなアクセスパスや `func()` も可）
 * @param usage 項目の参照位置
 * @param record 定義検索の経過
 * @param signals エディタ側の手がかり
 * @returns 判定結果
 */
export function diagnoseDefinition(
    itemName: string,
    usage: SourcePosition,
    record: LookupRecord,
    signals: EditorSignals
): DefinitionDiagnosis {
    const rawCount = record.candidates.length;
    const keptCount = rawCount - record.excluded.length;
    const base = { candidateCount: rawCount, chosen: record.chosen };

    const expected = lastSegmentName(itemName);
    const includeErrors = findIncludeErrors(signals.diagnostics);
    const implicitAtUsage = findAtUsage(signals.diagnostics, usage, expected, 'implicitDeclaration');
    const undefinedAtUsage = findAtUsage(signals.diagnostics, usage, expected, 'undefinedIdentifier');

    // ① 問い合わせた位置の単語が項目名と違う場合は、本アプリの位置記録の誤り
    if (record.tokenAtUsage !== undefined && expected && record.tokenAtUsage !== expected) {
        return app('position', `参照位置の単語が「${record.tokenAtUsage}」で、項目名「${expected}」と一致しません（本アプリの不具合）`, [], base);
    }

    if (record.outcome === 'providerError') {
        return result('unknown', '定義プロバイダがエラーを返しました（C/C++ 拡張の起動中・再読み込み中の可能性があります）', [], base);
    }

    // 原因4: 宣言が見えていないため、ビルドは暗黙の宣言で通っていても IntelliSense は宣言を把握できない
    if (implicitAtUsage.length > 0) {
        const jump = keptCount > 0
            ? `候補${keptCount}件は名前だけで探した推測の可能性があります`
            : '定義は見つかりませんでした';
        return result('implicit', `呼び出し箇所で関数が暗黙に宣言されています（プロトタイプの #include が見えていません）。${jump}`, implicitAtUsage, base);
    }

    if (keptCount === 0 && rawCount > 0) {
        const files = record.excluded.map(c => fileNameOf(c.filePath)).join(', ');
        return app('excluded', `候補${rawCount}件がすべて excludePaths で除外されました（${files}）`, [], base);
    }

    if (rawCount === 0) {
        if (includeErrors.length > 0) {
            return result('config', `定義が見つかりません。${describeIncludeErrors(includeErrors)}`, includeErrors, base);
        }
        if (undefinedAtUsage.length > 0) {
            return result('config', '定義が見つかりません。参照箇所で「識別子が未定義」のエラーが出ています（マクロ定義 -D の不一致で #ifdef の分岐がずれている可能性があります）', undefinedAtUsage, base);
        }
        if (signals.errorSquiggles === 'disabled') {
            return result('unknown', '定義が見つかりません。C/C++ 拡張のエラー表示が無効（C_Cpp.errorSquiggles: disabled）のため、原因の手がかりがありません', [], base);
        }
        if (signals.cppToolsActive === false) {
            return result('unknown', '定義が見つかりません。C/C++ 拡張が有効になっていません', [], base);
        }
        return result('unknown', '定義が見つかりません。手がかりとなるエラーはありません（本当に定義が無い、#ifdef で無効な箇所にある、IntelliSense の解析が終わっていない などが考えられます）', [], base);
    }

    if (record.outcome === 'unreadable') {
        return app('unreadable', `候補${rawCount}件の先頭（${locationText(record.chosen)}）にある宣言を読み取れませんでした（本アプリの不具合の可能性）`, [], base);
    }

    // 候補はあるが IntelliSense が宣言を把握できていない場合、その候補は名前だけで探した推測の可能性が高い
    if (includeErrors.length > 0) {
        return result('guess', `候補${keptCount}件は推測の可能性があります。${describeIncludeErrors(includeErrors)}`, includeErrors, base);
    }
    if (undefinedAtUsage.length > 0) {
        return result('guess', `候補${keptCount}件は推測の可能性があります。参照箇所で「識別子が未定義」のエラーが出ています`, undefinedAtUsage, base);
    }

    if (keptCount > 1) {
        return app('multiple', `候補が${keptCount}件あり、先頭（${locationText(record.chosen)}）を採用しました（F12 では一覧から選べます）`, [], base);
    }

    return result('ok', `定義: ${locationText(record.chosen)}`, [], base);
}

/**
 * 解析対象ファイルに出ている include エラーを取り出します。
 *
 * @param diagnostics エラー・警告の一覧
 * @returns include エラーの一覧
 */
export function findIncludeErrors(diagnostics: SignalDiagnostic[]): SignalDiagnostic[] {
    return diagnostics.filter(d => matches(d, 'includeError'));
}

/**
 * include エラーを「〇〇 を開けません」の形でまとめます。
 *
 * @param includeErrors include エラーの一覧
 * @returns 説明文
 */
function describeIncludeErrors(includeErrors: SignalDiagnostic[]): string {
    const files = unique(includeErrors
        .map(d => quotedFileName(d.message))
        .filter((name): name is string => !!name));
    return files.length > 0
        ? `include エラーがあります（${files.map(f => `"${f}"`).join(', ')} を開けません）`
        : `include エラーが${includeErrors.length}件あります`;
}

/**
 * 参照位置に掛かっている、指定種別のエラー・警告を取り出します。
 *
 * 範囲が参照位置を含むもの、または同じ行でメッセージに名前を含むものを対象とします。
 *
 * @param diagnostics エラー・警告の一覧
 * @param usage 参照位置
 * @param name 項目名（アクセスパスの最後の名前）
 * @param kind 種別
 * @returns 該当するエラー・警告
 */
function findAtUsage(
    diagnostics: SignalDiagnostic[],
    usage: SourcePosition,
    name: string,
    kind: keyof typeof MESSAGE_PATTERNS
): SignalDiagnostic[] {
    return diagnostics.filter(d => {
        if (!matches(d, kind)) {
            return false;
        }
        const covers = (d.line < usage.line || (d.line === usage.line && d.column <= usage.column))
            && (d.endLine > usage.line || (d.endLine === usage.line && d.endColumn >= usage.column));
        const sameLineByName = d.line === usage.line && !!name && d.message.includes(name);
        return covers || sameLineByName;
    });
}

/**
 * エラー・警告が指定の種別に当たるかを判定します。
 *
 * エラー番号は C/C++ 拡張のものに限って照合し、メッセージはどの発行元でも照合します。
 *
 * @param diagnostic エラー・警告
 * @param kind 種別
 * @returns 当たる場合は true
 */
function matches(diagnostic: SignalDiagnostic, kind: keyof typeof MESSAGE_PATTERNS): boolean {
    const fromCppTools = !!diagnostic.source && /C\/C\+\+|cpptools/i.test(diagnostic.source);
    if (fromCppTools && diagnostic.code && CPPTOOLS_CODES[kind].includes(diagnostic.code)) {
        return true;
    }
    return MESSAGE_PATTERNS[kind].test(diagnostic.message);
}

/**
 * 項目名から、アクセスパスの最後の名前を取り出します。
 *
 * `g_tbl[N].value` は `value`、`p->next` は `next`、`func()` は `func` になります。
 *
 * @param itemName 項目の表示名
 * @returns 最後の名前
 */
export function lastSegmentName(itemName: string): string {
    const segments = itemName.split(/\.|->/);
    const last = segments[segments.length - 1] || '';
    return last.replace(/\[[^\]]*\]/g, '').replace(/\(\)$/, '').trim();
}

/** 出力パネルに書き出す項目1件分 */
export interface ReportEntry {
    /** 分類名（入力変数・呼び出し関数など） */
    section: string;
    /** 項目の表示名 */
    name: string;
    /** 判定結果 */
    diagnosis: DefinitionDiagnosis;
}

/** 出力パネルに書き出す、解析1回分の情報 */
export interface ReportContext {
    /** 解析した時刻の表示文字列 */
    timestamp: string;
    /** 解析対象ファイルのパス */
    filePath: string;
    /** 解析対象の関数名 */
    functionName: string;
    /** C/C++ 拡張の状態の表示文字列（例: `ms-vscode.cpptools 1.22.0（有効）`） */
    cppToolsStatus: string;
}

/**
 * 解析1回分の診断結果を、出力パネル向けの文字列にまとめます。
 *
 * @param entries 項目ごとの判定結果
 * @param signals エディタ側の手がかり
 * @param context 解析の情報
 * @returns 出力パネルに書き出す文字列（改行区切り）
 */
export function formatDiagnosisReport(
    entries: ReportEntry[],
    signals: EditorSignals,
    context: ReportContext
): string {
    const lines: string[] = [];
    lines.push(`===== 定義ジャンプの診断 ${context.timestamp} =====`);
    lines.push(`ファイル      : ${context.filePath}`);
    lines.push(`関数          : ${context.functionName}`);
    lines.push(`C/C++ 拡張    : ${context.cppToolsStatus}`);
    lines.push(`エラー表示設定: C_Cpp.errorSquiggles = ${signals.errorSquiggles ?? '(不明)'}`);

    const includeErrors = findIncludeErrors(signals.diagnostics);
    lines.push(`include エラー: ${includeErrors.length}件`);
    includeErrors.forEach(d => lines.push(`  - ${diagnosticText(d)}`));
    lines.push('');

    // 分類ごとの件数
    const order: DiagnosisCategory[] = ['ok', 'app', 'guess', 'config', 'implicit', 'unknown'];
    const counts = order.map(category =>
        `${CATEGORY_LABELS[category]} ${entries.filter(e => e.diagnosis.category === category).length}`);
    lines.push(`集計: ${counts.join(' / ')}`);
    lines.push('');

    // 分類（入力変数など）ごとに項目を並べる
    const nameWidth = Math.min(40, Math.max(8, ...entries.map(e => e.name.length)));
    unique(entries.map(e => e.section)).forEach(section => {
        lines.push(`[${section}]`);
        entries.filter(e => e.section === section).forEach(e => {
            lines.push(`  [${e.diagnosis.label}] ${e.name.padEnd(nameWidth)}  ${e.diagnosis.summary}`);
        });
        lines.push('');
    });

    // 判定の根拠にしたエラー・警告（番号の確認用に生の内容を出す）
    const evidence = unique(entries.flatMap(e => e.diagnosis.evidence).map(diagnosticText));
    if (evidence.length > 0) {
        lines.push('--- 判定に使ったエラー・警告 ---');
        evidence.forEach(text => lines.push(`  ${text}`));
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * エラー・警告1件を、行番号・発行元・番号付きの文字列にします。
 *
 * @param d エラー・警告
 * @returns 表示用の文字列（行・列は1始まり）
 */
function diagnosticText(d: SignalDiagnostic): string {
    const origin = d.source ? `${d.source}${d.code ? `(${d.code})` : ''}` : (d.code ?? '');
    return `${d.line + 1}行${d.column + 1}列 [${origin}] ${d.message}`;
}

/**
 * 原因1（本アプリ側）の判定結果を作ります。
 *
 * @param cause 内訳
 * @param summary 説明
 * @param evidence 根拠
 * @param base 候補の件数など
 * @returns 判定結果
 */
function app(
    cause: AppCause,
    summary: string,
    evidence: SignalDiagnostic[],
    base: { candidateCount: number; chosen?: CandidateLocation }
): DefinitionDiagnosis {
    return { category: 'app', appCause: cause, label: APP_CAUSE_LABELS[cause], summary, evidence, ...base };
}

/**
 * 原因1以外の判定結果を作ります。
 *
 * @param category 分類
 * @param summary 説明
 * @param evidence 根拠
 * @param base 候補の件数など
 * @returns 判定結果
 */
function result(
    category: Exclude<DiagnosisCategory, 'app'>,
    summary: string,
    evidence: SignalDiagnostic[],
    base: { candidateCount: number; chosen?: CandidateLocation }
): DefinitionDiagnosis {
    return { category, label: CATEGORY_LABELS[category], summary, evidence, ...base };
}

/**
 * 候補の位置を「ファイル名:行」の形にします。
 *
 * @param candidate 候補
 * @returns 表示用の文字列（行は1始まり）
 */
function locationText(candidate?: CandidateLocation): string {
    return candidate ? `${fileNameOf(candidate.filePath)}:${candidate.line + 1}` : '(不明)';
}

/**
 * URI・パスからファイル名だけを取り出します。
 *
 * @param filePath URI文字列またはパス
 * @returns ファイル名
 */
function fileNameOf(filePath: string): string {
    let decoded = filePath;
    try {
        decoded = decodeURIComponent(filePath);
    } catch {
        // デコードできない場合はそのまま使う
    }
    const parts = decoded.split(/[\\/]/);
    return parts[parts.length - 1] || decoded;
}

/**
 * メッセージの中で引用符に囲まれたファイル名を取り出します。
 *
 * @param message メッセージ本文
 * @returns ファイル名。見つからない場合は undefined
 */
function quotedFileName(message: string): string | undefined {
    const match = message.match(/["'「“]([^"'」”]+\.[A-Za-z0-9]+)["'」”]/);
    return match ? match[1] : undefined;
}

/**
 * 重複を取り除きます（最初に現れた順を保ちます）。
 *
 * @param items 対象
 * @returns 重複を除いた配列
 */
function unique<T>(items: T[]): T[] {
    return Array.from(new Set(items));
}
