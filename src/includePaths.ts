/**
 * インクルードファイルの探索候補パスを組み立てる処理です。
 *
 * ファイルシステムや VS Code API には触れないパス文字列の操作のみで構成しており、
 * ヘッドレス環境（Node 単体）でテスト可能な状態を保っています。
 */
import * as path from 'path';

/** 再帰探索を表す設定値の接尾辞（例: `hed/**`） */
const RECURSIVE_SUFFIX = '**';

/** 再帰展開で辿るディレクトリの深さの上限 */
const MAX_RECURSIVE_DEPTH = 16;

/** 再帰展開で収集するディレクトリ数の上限（巨大なツリーでの過剰な走査を防ぐ） */
const MAX_RECURSIVE_DIRS = 2000;

/** ディレクトリの直下にあるサブディレクトリを列挙する関数 */
export type SubdirectoryLister = (directory: string) => string[];

/**
 * 設定値を、基準ディレクトリと再帰指定の有無に分解します。
 *
 * 末尾が `**` の場合は再帰指定として扱います（`hed/**`、`hed\**` のどちらの表記にも対応）。
 *
 * @param entry 設定に指定された1件の値
 * @returns 基準ディレクトリと再帰指定の有無
 */
export function parseSearchPathEntry(entry: string): { base: string; recursive: boolean } {
    // 末尾の区切り文字を取り除いてから判定する
    const trimmed = entry.replace(/[\\/]+$/, '');
    const segments = trimmed.split(/[\\/]/);

    if (segments.length > 0 && segments[segments.length - 1] === RECURSIVE_SUFFIX) {
        return { base: segments.slice(0, -1).join(path.sep), recursive: true };
    }
    return { base: trimmed, recursive: false };
}

/**
 * 対象パスが、指定したディレクトリのいずれかの配下にあるか判定します。
 *
 * @param target 判定対象の絶対パス
 * @param directories ディレクトリの絶対パス一覧
 * @returns いずれかの配下にある場合は true
 */
function isUnderAny(target: string, directories: string[]): boolean {
    return directories.some(dir => {
        const relative = path.relative(dir, target);
        // 空文字はディレクトリ自身、'..' 始まりや絶対パスは配下でないことを示す
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
}

/**
 * 対象ディレクトリが、除外対象そのものか、その配下にあるか判定します。
 *
 * @param target 判定対象の絶対パス
 * @param directories 除外ディレクトリの絶対パス一覧
 * @returns 除外対象の場合は true
 */
function isAtOrUnderAny(target: string, directories: string[]): boolean {
    return directories.some(dir => path.relative(dir, target) === '') || isUnderAny(target, directories);
}

/**
 * 起点ディレクトリから配下のディレクトリを、浅い順に収集します。
 *
 * 浅いディレクトリを先に返すことで、同名ファイルがある場合に
 * より上位のディレクトリのものが優先されます。
 *
 * @param root 起点ディレクトリ（絶対パス）
 * @param excludedDirs 除外ディレクトリ（配下ごと辿りません）
 * @param listSubdirectories サブディレクトリを列挙する関数
 * @returns 起点を含むディレクトリの絶対パス一覧（浅い順）
 */
function expandRecursively(
    root: string,
    excludedDirs: string[],
    listSubdirectories: SubdirectoryLister
): string[] {
    const collected: string[] = [];
    const visited = new Set<string>();
    let queue: string[] = [root];
    let depth = 0;

    while (queue.length > 0 && depth < MAX_RECURSIVE_DEPTH && collected.length < MAX_RECURSIVE_DIRS) {
        const next: string[] = [];
        for (const dir of queue) {
            const normalized = path.normalize(dir);
            // シンボリックリンクなどで同じ場所を辿り直さないようにする
            if (visited.has(normalized) || isAtOrUnderAny(normalized, excludedDirs)) {
                continue;
            }
            visited.add(normalized);
            collected.push(normalized);
            if (collected.length >= MAX_RECURSIVE_DIRS) {
                break;
            }
            next.push(...listSubdirectories(normalized));
        }
        queue = next;
        depth++;
    }

    return collected;
}

/**
 * 設定値のディレクトリ指定を絶対パスへ解決します。
 *
 * 相対パスは各ワークスペースフォルダからの相対として解決し、絶対パスはそのまま使用します。
 * 末尾が `**` の指定は、`listSubdirectories` が与えられている場合に配下へ再帰展開します。
 *
 * @param configured 設定に指定されたディレクトリ
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @param excludedDirs 除外ディレクトリの絶対パス一覧
 * @param listSubdirectories サブディレクトリを列挙する関数（省略時は再帰展開を行いません）
 * @returns 解決後の絶対パス一覧（設定の記述順、再帰指定内は浅い順）
 */
function resolveDirectories(
    configured: string[],
    workspaceFolders: string[],
    excludedDirs: string[] = [],
    listSubdirectories?: SubdirectoryLister
): string[] {
    const resolved: string[] = [];

    configured.forEach(entry => {
        if (!entry) {
            return;
        }
        const { base, recursive } = parseSearchPathEntry(entry);

        // 基準ディレクトリを絶対パスへ解決する（相対指定は各ワークスペースフォルダに展開）
        const bases = path.isAbsolute(base)
            ? [path.normalize(base)]
            : workspaceFolders.map(folder => path.resolve(folder, base));

        bases.forEach(dir => {
            if (recursive && listSubdirectories) {
                resolved.push(...expandRecursively(dir, excludedDirs, listSubdirectories));
            } else {
                resolved.push(dir);
            }
        });
    });

    return resolved;
}

/**
 * インクルードパスの探索候補を、優先順に組み立てます。
 *
 * 探索順は次の通りです。
 *   1. インクルード元ファイルのディレクトリ
 *   2. 設定 `includePaths` に指定されたディレクトリ
 *   3. 各ワークスペースフォルダの直下
 *
 * 設定値が相対パスの場合は各ワークスペースフォルダからの相対として解決し、
 * 絶対パスの場合はそのまま使用します。
 *
 * @param includePath `#include "..."` に記述されたパス（例: `config.h`、`sub/types.h`）
 * @param fromFsPath インクルード元ファイルの絶対パス。不明な場合は null
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @param configuredPaths 設定 `includePaths` の値。末尾が `**` の指定は配下へ再帰展開します
 * @param excludedPaths 設定 `excludePaths` の値。このディレクトリ配下は候補から除外します
 * @param listSubdirectories サブディレクトリを列挙する関数（省略時は再帰展開を行いません）
 * @returns 重複を除いた候補パスの配列（優先順）
 */
export function buildIncludeCandidates(
    includePath: string,
    fromFsPath: string | null,
    workspaceFolders: string[],
    configuredPaths: string[] = [],
    excludedPaths: string[] = [],
    listSubdirectories?: SubdirectoryLister
): string[] {
    const candidates: string[] = [];
    // 除外指定自体は再帰展開しない（配下すべてが対象のため展開不要）
    const excludedDirs = resolveDirectories(excludedPaths, workspaceFolders);
    const searchDirs = resolveDirectories(configuredPaths, workspaceFolders, excludedDirs, listSubdirectories);

    /**
     * 候補を追加します（同一パスの重複は無視します）。
     *
     * @param candidate 追加する候補パス
     */
    const add = (candidate: string) => {
        const normalized = path.normalize(candidate);
        if (isUnderAny(normalized, excludedDirs)) {
            return;
        }
        if (!candidates.includes(normalized)) {
            candidates.push(normalized);
        }
    };

    // 1. インクルード元ファイルからの相対パス
    if (fromFsPath) {
        add(path.resolve(path.dirname(fromFsPath), includePath));
    }

    // 2. 設定で指定された探索パス（再帰指定は展開済み）
    searchDirs.forEach(dir => {
        add(path.join(dir, includePath));
    });

    // 3. 各ワークスペースフォルダの直下
    workspaceFolders.forEach(folder => {
        add(path.join(folder, includePath));
    });

    return candidates;
}
