/**
 * インクルードファイルの探索候補パスを組み立てる処理です。
 *
 * ファイルシステムや VS Code API には触れないパス文字列の操作のみで構成しており、
 * ヘッドレス環境（Node 単体）でテスト可能な状態を保っています。
 */
import * as path from 'path';

/**
 * ファイル名（basename）から、そのファイルの絶対パス一覧を引くための索引です。
 * ワークスペース内のファイル名検索で使用します。
 */
export type FileNameIndex = Map<string, string[]>;

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
 * 設定値のディレクトリ指定を絶対パスへ解決します。
 *
 * 相対パスは各ワークスペースフォルダからの相対として解決し、絶対パスはそのまま使用します。
 *
 * @param configured 設定に指定されたディレクトリ
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @returns 解決後の絶対パス一覧（設定の記述順）
 */
function resolveDirectories(configured: string[], workspaceFolders: string[]): string[] {
    const resolved: string[] = [];

    configured.forEach(entry => {
        if (!entry) {
            return;
        }
        // 旧版の再帰指定（"hed/**"）が残っていても基準ディレクトリとして扱えるようにする。
        // "**" 単独の場合は基準が空になるため、下の判定で読み飛ばされる。
        const base = entry.replace(/(?:^|[\\/]+)\*\*[\\/]*$/, '');
        if (!base) {
            return;
        }

        if (path.isAbsolute(base)) {
            resolved.push(path.normalize(base));
            return;
        }
        workspaceFolders.forEach(folder => {
            resolved.push(path.resolve(folder, base));
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
 * 絶対パスの場合はそのまま使用します。いずれも指定されたディレクトリの直下のみを探します。
 *
 * @param includePath `#include "..."` に記述されたパス（例: `config.h`、`sub/types.h`）
 * @param fromFsPath インクルード元ファイルの絶対パス。不明な場合は null
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @param configuredPaths 設定 `includePaths` の値
 * @param excludedPaths 設定 `excludePaths` の値。このディレクトリ配下は候補から除外します
 * @returns 重複を除いた候補パスの配列（優先順）
 */
export function buildIncludeCandidates(
    includePath: string,
    fromFsPath: string | null,
    workspaceFolders: string[],
    configuredPaths: string[] = [],
    excludedPaths: string[] = []
): string[] {
    const candidates: string[] = [];
    const excludedDirs = resolveDirectories(excludedPaths, workspaceFolders);
    const searchDirs = resolveDirectories(configuredPaths, workspaceFolders);

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

    // 2. 設定で指定された探索パス
    searchDirs.forEach(dir => {
        add(path.join(dir, includePath));
    });

    // 3. 各ワークスペースフォルダの直下
    workspaceFolders.forEach(folder => {
        add(path.join(folder, includePath));
    });

    return candidates;
}

/**
 * ファイル名索引から、インクルードパスに一致するファイルを探します。
 *
 * 通常の探索（`buildIncludeCandidates`）で見つからなかった場合のフォールバックです。
 * `#include "sub/types.h"` のようにディレクトリを含む記述の場合は、
 * **パスの末尾がその記述と一致する**ファイルのみを対象とします。
 *
 * 複数一致した場合は、ディレクトリ階層が浅いものを優先し、同じ深さではパス順に並べます。
 * 同名ファイルが複数ある場合に、より上位のファイルが選ばれるようにするためです。
 *
 * @param includePath `#include "..."` に記述されたパス
 * @param fileNameIndex ファイル名 → 絶対パス一覧 の索引
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @param excludedPaths 設定 `excludePaths` の値
 * @returns 一致したファイルの絶対パス一覧（優先順）
 */
export function buildFileNameSearchCandidates(
    includePath: string,
    fileNameIndex: FileNameIndex,
    workspaceFolders: string[] = [],
    excludedPaths: string[] = []
): string[] {
    const fileName = path.basename(includePath);
    const found = fileNameIndex.get(fileName);
    if (!found || found.length === 0) {
        return [];
    }

    const excludedDirs = resolveDirectories(excludedPaths, workspaceFolders);
    // 記述されたパスを、末尾一致の判定に使える形へ正規化する
    const normalizedInclude = path.normalize(includePath);
    const suffix = path.isAbsolute(normalizedInclude)
        ? normalizedInclude
        : path.sep + normalizedInclude;

    return found
        .map(filePath => path.normalize(filePath))
        .filter(filePath => !isUnderAny(filePath, excludedDirs))
        // "sub/types.h" のような記述では、そのディレクトリ構成を満たすものだけを採用する
        .filter(filePath => filePath.endsWith(suffix) || filePath === normalizedInclude)
        .sort((a, b) => {
            const depthA = a.split(path.sep).length;
            const depthB = b.split(path.sep).length;
            return depthA !== depthB ? depthA - depthB : a.localeCompare(b);
        });
}
