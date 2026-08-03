/**
 * インクルード探索の到達状況を診断する処理です。
 *
 * 「特定のシンボルだけ `(推定)` になる」原因の切り分けに使います。原因は主に
 * 「深さ上限で探索が打ち切られている」か「ヘッダを解決できていない」の2つですが、
 * 通常の解析結果からはどちらなのか判別できません。
 *
 * ファイルシステムや VS Code API には触れず、依存を注入する形にしているため
 * ヘッドレス環境でテストできます。
 */

/** インクルードの解決結果（診断用に候補も含めたもの） */
export interface InspectedInclude {
    /** 採用されたファイルの絶対パス。解決できなかった場合は null */
    resolved: string | null;
    /** 実在した候補すべて（採用されたものが先頭） */
    candidates: string[];
}

/** 診断に必要な外部依存 */
export interface IncludeDiagnosticsDeps {
    /** 指定ファイルに書かれた `#include "..."` のパス一覧を返します */
    readIncludePaths(fsPath: string): string[];
    /** インクルードパスを解決し、候補を含めて返します */
    inspectInclude(includePath: string, fromFsPath: string): InspectedInclude;
    /** 指定ファイルで定義されている構造体・共用体の型名一覧を返します */
    readStructNames(fsPath: string): string[];
    /** ファイル名検索の索引に登録されているファイル数を返します */
    countIndexedFiles(): number;
}

/** 到達したファイルとその深さ */
export interface ReachedFile {
    fsPath: string;
    /** 解析対象ファイルからの最短の深さ（解析対象自身は 0） */
    depth: number;
}

/** 深さ上限を超えるため探索されないファイル */
export interface SkippedFile extends ReachedFile {
    /** そのファイルで定義されている構造体・共用体の型名 */
    structNames: string[];
}

/** 解決できなかったインクルード */
export interface UnresolvedInclude {
    includePath: string;
    fromFsPath: string;
}

/** 候補が複数あったインクルード */
export interface AmbiguousInclude extends UnresolvedInclude {
    /** 実在した候補すべて（採用されたものが先頭） */
    candidates: string[];
}

/** 診断結果 */
export interface IncludeReport {
    /** 解析対象ファイルの絶対パス */
    entryFsPath: string;
    /** ファイル名検索の索引に登録されているファイル数 */
    indexedFileCount: number;
    /** 到達したファイル（解析対象自身を除く） */
    reached: ReachedFile[];
    /** 到達した最大の深さ */
    maxDepth: number;
    /** 探索の深さ上限 */
    depthLimit: number;
    /** 深さ上限を超えるため探索されないファイル */
    skipped: SkippedFile[];
    /** 解決できなかったインクルード */
    unresolved: UnresolvedInclude[];
    /** 候補が複数あったインクルード */
    ambiguous: AmbiguousInclude[];
}

/** 一度の診断で辿るファイル数の上限（異常な構成で処理が膨らむのを防ぐ） */
const MAX_VISITED_FILES = 20000;

/**
 * インクルードの到達状況を調べます。
 *
 * 実際の解析と異なり**深さ上限を設けずに**全体を辿り、後から上限との関係を評価します。
 * これにより「上限に達したせいで見えていないヘッダ」を具体的に示せます。
 *
 * @param entryFsPath 解析対象ファイルの絶対パス
 * @param depthLimit 実際の解析で用いる深さ上限
 * @param deps 外部依存
 * @returns 診断結果
 */
export function buildIncludeReport(
    entryFsPath: string,
    depthLimit: number,
    deps: IncludeDiagnosticsDeps
): IncludeReport {
    /** ファイルパス → 到達した最短の深さ */
    const depthOf = new Map<string, number>([[entryFsPath, 0]]);
    const unresolved: UnresolvedInclude[] = [];
    const ambiguous: AmbiguousInclude[] = [];

    // 幅優先で辿ることで、各ファイルの「最短の深さ」を求める
    const queue: ReachedFile[] = [{ fsPath: entryFsPath, depth: 0 }];
    while (queue.length > 0 && depthOf.size < MAX_VISITED_FILES) {
        const current = queue.shift()!;

        for (const includePath of deps.readIncludePaths(current.fsPath)) {
            const inspected = deps.inspectInclude(includePath, current.fsPath);

            if (!inspected.resolved) {
                unresolved.push({ includePath, fromFsPath: current.fsPath });
                continue;
            }
            if (inspected.candidates.length > 1) {
                ambiguous.push({
                    includePath,
                    fromFsPath: current.fsPath,
                    candidates: inspected.candidates
                });
            }

            const nextDepth = current.depth + 1;
            const known = depthOf.get(inspected.resolved);
            if (known === undefined || nextDepth < known) {
                depthOf.set(inspected.resolved, nextDepth);
                queue.push({ fsPath: inspected.resolved, depth: nextDepth });
            }
        }
    }

    const reached: ReachedFile[] = [];
    depthOf.forEach((depth, fsPath) => {
        if (fsPath !== entryFsPath) {
            reached.push({ fsPath, depth });
        }
    });
    reached.sort((a, b) => (a.depth !== b.depth ? a.depth - b.depth : a.fsPath.localeCompare(b.fsPath)));

    const maxDepth = reached.reduce((max, r) => Math.max(max, r.depth), 0);
    const skipped: SkippedFile[] = reached
        .filter(r => r.depth > depthLimit)
        .map(r => ({ ...r, structNames: deps.readStructNames(r.fsPath) }));

    return {
        entryFsPath,
        indexedFileCount: deps.countIndexedFiles(),
        reached,
        maxDepth,
        depthLimit,
        skipped,
        unresolved,
        ambiguous
    };
}

/** 一覧で表示する件数の上限（出力が長くなりすぎるのを防ぐ） */
const MAX_LISTED_ITEMS = 50;

/**
 * 診断結果を人が読める文字列へ整形します。
 *
 * @param report 診断結果
 * @param toDisplayPath 絶対パスを表示用の文字列へ変換する関数（ワークスペース相対など）
 * @returns 出力パネルへ表示する文字列
 */
export function formatIncludeReport(
    report: IncludeReport,
    toDisplayPath: (fsPath: string) => string
): string {
    const lines: string[] = [];

    lines.push('===== インクルード探索の診断 =====');
    lines.push(`解析対象      : ${toDisplayPath(report.entryFsPath)}`);
    lines.push(`索引ファイル数: ${report.indexedFileCount} 件`);
    lines.push(`到達ヘッダ数  : ${report.reached.length} 件`);
    lines.push(`最大の深さ    : ${report.maxDepth} 段（上限 ${report.depthLimit} 段）`);
    lines.push('');

    lines.push('----- 深さごとのヘッダ数 -----');
    if (report.reached.length === 0) {
        lines.push('  （インクルードがありません）');
    } else {
        const countByDepth = new Map<number, number>();
        report.reached.forEach(r => countByDepth.set(r.depth, (countByDepth.get(r.depth) || 0) + 1));
        [...countByDepth.keys()].sort((a, b) => a - b).forEach(depth => {
            const mark = depth > report.depthLimit ? '  ← 上限を超えるため探索されません' : '';
            const count = String(countByDepth.get(depth)).padStart(4);
            lines.push(`  深さ ${String(depth).padStart(2)} : ${count} 件${mark}`);
        });
    }
    lines.push('');

    lines.push(`----- 深さ上限で探索されないヘッダ（${report.skipped.length} 件）-----`);
    if (report.skipped.length === 0) {
        lines.push('  なし');
    } else {
        report.skipped.slice(0, MAX_LISTED_ITEMS).forEach(s => {
            lines.push(`  深さ ${s.depth}  ${toDisplayPath(s.fsPath)}`);
            if (s.structNames.length > 0) {
                const shown = s.structNames.slice(0, 8).join(', ');
                const rest = s.structNames.length > 8 ? ` ほか${s.structNames.length - 8}件` : '';
                lines.push(`        構造体定義: ${shown}${rest}`);
            }
        });
        appendOmitted(lines, report.skipped.length);
        lines.push('');
        lines.push('  ★ ここに構造体定義がある場合、そのメンバの型・定義位置を解決できません。');
    }
    lines.push('');

    lines.push(`----- 解決できなかった #include（${report.unresolved.length} 件）-----`);
    if (report.unresolved.length === 0) {
        lines.push('  なし');
    } else {
        report.unresolved.slice(0, MAX_LISTED_ITEMS).forEach(u => {
            lines.push(`  "${u.includePath}"  (${toDisplayPath(u.fromFsPath)} から)`);
        });
        appendOmitted(lines, report.unresolved.length);
        lines.push('');
        lines.push('  ★ この先にある定義はすべて解決できません。');
    }
    lines.push('');

    lines.push(`----- 同名ファイルの候補が複数あった #include（${report.ambiguous.length} 件）-----`);
    if (report.ambiguous.length === 0) {
        lines.push('  なし');
    } else {
        report.ambiguous.slice(0, MAX_LISTED_ITEMS).forEach(a => {
            lines.push(`  "${a.includePath}"  (${toDisplayPath(a.fromFsPath)} から)`);
            a.candidates.forEach((c, i) => {
                lines.push(`      ${i === 0 ? '→ 採用 ' : '       '}${toDisplayPath(c)}`);
            });
        });
        appendOmitted(lines, report.ambiguous.length);
        lines.push('');
        lines.push('  ★ 意図と異なるファイルを採用している場合、excludePaths で除外してください。');
    }

    return lines.join('\n');
}

/**
 * 表示件数の上限で省略した分を追記します。
 *
 * @param lines 出力行の配列
 * @param total 全体の件数
 */
function appendOmitted(lines: string[], total: number): void {
    if (total > MAX_LISTED_ITEMS) {
        lines.push(`  ... ほか ${total - MAX_LISTED_ITEMS} 件`);
    }
}
