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
 * `excludePaths` の指定を、判定に使える形へ分解した結果です。
 *
 * 設定値はディレクトリ指定とフォルダ名指定の2種類を受け付けます。
 * 区切り文字（`/` `\`）を含むか絶対パスであればディレクトリ指定、
 * それ以外（`variantB` のような単独の名前）はフォルダ名指定として扱います。
 */
interface ExcludeRules {
    /** 配下すべてを除外するディレクトリの絶対パス一覧 */
    directories: string[];
    /** フォルダ名に含まれていれば除外する文字列一覧（小文字化済み） */
    folderNames: string[];
}

/**
 * 設定値がディレクトリ指定かどうかを判定します。
 *
 * @param entry 設定に指定された文字列
 * @returns パス区切りを含む、または絶対パスであれば true
 */
function isDirectorySpec(entry: string): boolean {
    return path.isAbsolute(entry) || /[\\/]/.test(entry);
}

/**
 * `excludePaths` の設定値を、ディレクトリ指定とフォルダ名指定へ分解します。
 *
 * @param configured 設定 `excludePaths` の値
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @returns 除外判定に使うルール
 */
function buildExcludeRules(configured: string[], workspaceFolders: string[]): ExcludeRules {
    const directorySpecs: string[] = [];
    const folderNames: string[] = [];

    configured.forEach(entry => {
        if (!entry) {
            return;
        }
        if (isDirectorySpec(entry)) {
            directorySpecs.push(entry);
        } else {
            folderNames.push(entry.toLowerCase());
        }
    });

    return {
        directories: resolveDirectories(directorySpecs, workspaceFolders),
        folderNames
    };
}

/**
 * 対象ファイルが、名前に指定文字列を含むフォルダの配下にあるか判定します。
 *
 * 判定対象はワークスペースフォルダからの相対部分のみです。ワークスペース外の
 * パス（`C:\Users\old_user\...` など）に巻き込まれないようにするためです。
 * また、フォルダのみを対象とするためファイル名自体は判定に含めません。
 *
 * @param target 判定対象の絶対パス（ファイルパス）
 * @param folderNames フォルダ名に含まれていれば除外する文字列一覧（小文字）
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @returns 除外対象であれば true
 */
function isUnderExcludedFolderName(
    target: string,
    folderNames: string[],
    workspaceFolders: string[]
): boolean {
    if (folderNames.length === 0) {
        return false;
    }

    const directory = path.dirname(target);

    return workspaceFolders.some(folder => {
        const relative = path.relative(folder, directory);
        // '..' 始まりや絶対パスはワークスペース外を示すため対象外
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return false;
        }
        return relative
            .split(path.sep)
            .filter(segment => segment !== '')
            .some(segment => {
                const lower = segment.toLowerCase();
                return folderNames.some(name => lower.includes(name));
            });
    });
}

/**
 * 対象ファイルが除外対象かを判定します。
 *
 * @param target 判定対象の絶対パス（ファイルパス）
 * @param rules 除外ルール
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @returns 除外対象であれば true
 */
function isExcluded(target: string, rules: ExcludeRules, workspaceFolders: string[]): boolean {
    return (
        isUnderAny(target, rules.directories) ||
        isUnderExcludedFolderName(target, rules.folderNames, workspaceFolders)
    );
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
 * インクルードパスの探索候補を、優先順に組み立てます。
 *
 * 探索順は次の通りです。
 *   1. インクルード元ファイルのディレクトリ
 *   2. 各ワークスペースフォルダの直下
 *
 * ここで見つからない場合は、呼び出し側でファイル名検索
 * （`buildFileNameSearchCandidates`）へフォールバックします。
 *
 * @param includePath `#include "..."` に記述されたパス（例: `config.h`、`sub/types.h`）
 * @param fromFsPath インクルード元ファイルの絶対パス。不明な場合は null
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @param excludedPaths 設定 `excludePaths` の値。ディレクトリ配下、および名前に
 *                      指定文字列を含むフォルダの配下は候補から除外します
 * @returns 重複を除いた候補パスの配列（優先順）
 */
export function buildIncludeCandidates(
    includePath: string,
    fromFsPath: string | null,
    workspaceFolders: string[],
    excludedPaths: string[] = []
): string[] {
    const candidates: string[] = [];
    const excludeRules = buildExcludeRules(excludedPaths, workspaceFolders);

    /**
     * 候補を追加します（同一パスの重複は無視します）。
     *
     * @param candidate 追加する候補パス
     */
    const add = (candidate: string) => {
        const normalized = path.normalize(candidate);
        if (isExcluded(normalized, excludeRules, workspaceFolders)) {
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

    // 2. 各ワークスペースフォルダの直下
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

    const excludeRules = buildExcludeRules(excludedPaths, workspaceFolders);
    // 記述されたパスを、末尾一致の判定に使える形へ正規化する
    const normalizedInclude = path.normalize(includePath);
    const suffix = path.isAbsolute(normalizedInclude)
        ? normalizedInclude
        : path.sep + normalizedInclude;

    return found
        .map(filePath => path.normalize(filePath))
        .filter(filePath => !isExcluded(filePath, excludeRules, workspaceFolders))
        // "sub/types.h" のような記述では、そのディレクトリ構成を満たすものだけを採用する
        .filter(filePath => filePath.endsWith(suffix) || filePath === normalizedInclude)
        .sort((a, b) => {
            const depthA = a.split(path.sep).length;
            const depthB = b.split(path.sep).length;
            return depthA !== depthB ? depthA - depthB : a.localeCompare(b);
        });
}
