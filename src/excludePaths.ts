/**
 * 設定 `excludePaths` による除外判定です。
 *
 * 定義位置の候補が複数返ってきた場合に、使用しない側を取り除くために使います。
 * ビルド時に切り替える同名ファイル（`variantA` / `variantB` など）がある構成で、
 * 意図した側だけを残すのが目的です。
 *
 * ファイルシステムや VS Code API には触れないパス文字列の操作のみで構成しており、
 * ヘッドレス環境（Node 単体）でテスト可能な状態を保っています。
 */
import * as path from 'path';

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
 * 設定値がディレクトリ指定かどうかを判定します。
 *
 * @param entry 設定に指定された文字列
 * @returns パス区切りを含む、または絶対パスであれば true
 */
function isDirectorySpec(entry: string): boolean {
    return path.isAbsolute(entry) || /[\\/]/.test(entry);
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
 * 除外判定を行う関数を作ります。
 *
 * @param configured 設定 `excludePaths` の値
 * @param workspaceFolders ワークスペースフォルダの絶対パス一覧
 * @returns 絶対パスを渡すと除外対象かを返す関数
 */
export function createExcludeFilter(
    configured: string[],
    workspaceFolders: string[]
): (fsPath: string) => boolean {
    const rules = buildExcludeRules(configured, workspaceFolders);

    // 除外指定がない場合は判定そのものを省く
    if (rules.directories.length === 0 && rules.folderNames.length === 0) {
        return () => false;
    }

    return (fsPath: string) => {
        const normalized = path.normalize(fsPath);
        return (
            isUnderAny(normalized, rules.directories) ||
            isUnderExcludedFolderName(normalized, rules.folderNames, workspaceFolders)
        );
    };
}
