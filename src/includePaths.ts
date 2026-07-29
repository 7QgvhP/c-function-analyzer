/**
 * インクルードファイルの探索候補パスを組み立てる処理です。
 *
 * ファイルシステムや VS Code API には触れないパス文字列の操作のみで構成しており、
 * ヘッドレス環境（Node 単体）でテスト可能な状態を保っています。
 */
import * as path from 'path';

/**
 * 設定値のディレクトリ指定を絶対パスへ解決します。
 *
 * 相対パスは各ワークスペースフォルダからの相対として解決し、絶対パスはそのまま使用します。
 *
 * @param configured 設定に指定されたディレクトリ
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @returns 解決後の絶対パス一覧
 */
function resolveDirectories(configured: string[], workspaceFolders: string[]): string[] {
    const resolved: string[] = [];
    configured.forEach(entry => {
        if (!entry) {
            return;
        }
        if (path.isAbsolute(entry)) {
            resolved.push(path.normalize(entry));
            return;
        }
        workspaceFolders.forEach(folder => {
            resolved.push(path.resolve(folder, entry));
        });
    });
    return resolved;
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
    configuredPaths.forEach(configured => {
        if (!configured) {
            return;
        }
        if (path.isAbsolute(configured)) {
            add(path.join(configured, includePath));
            return;
        }
        // 相対指定は各ワークスペースフォルダからの相対として解決する
        workspaceFolders.forEach(folder => {
            add(path.resolve(folder, configured, includePath));
        });
    });

    // 3. 各ワークスペースフォルダの直下
    workspaceFolders.forEach(folder => {
        add(path.join(folder, includePath));
    });

    return candidates;
}
