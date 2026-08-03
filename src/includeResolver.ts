/**
 * `#include "..."` を実ファイルから解決する IncludeResolver の実装です。
 *
 * ファイルシステムと VS Code のワークスペース情報に依存するため、
 * 解析ロジック（analyzer.ts）からは分離してこちらに配置しています。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import Parser = require('web-tree-sitter');
import { IncludeResolver, ResolvedInclude } from './analyzer';
import { buildFileNameSearchCandidates, buildIncludeCandidates, FileNameIndex } from './includePaths';
import { parseWithModifierMacroRepair } from './macroRepair';

/** パース結果のキャッシュエントリ */
interface CacheEntry {
    /** キャッシュ時点のファイル更新時刻 */
    mtimeMs: number;
    tree: Parser.Tree;
}

/** キャッシュの上限件数（超えた場合は最も古いものから破棄する） */
const MAX_CACHE_ENTRIES = 64;

/** ファイル名検索の索引に登録する拡張子（インクルードされ得るファイル） */
const INDEXED_EXTENSIONS = new Set(['.h', '.hpp', '.hh', '.hxx', '.inc', '.c', '.cpp', '.cc', '.cxx']);

/** 索引を作る際に辿らないディレクトリ名（プロジェクトのソースではない領域） */
const INDEX_SKIP_DIRECTORIES = new Set(['node_modules', 'out']);

/** 索引に登録するファイル数の上限（巨大なワークスペースでの過剰な走査を防ぐ） */
const MAX_INDEXED_FILES = 50000;

export class FileIncludeResolver implements IncludeResolver {
    /** ファイルパス（fsPath）→ パース結果 のキャッシュ */
    private readonly cache = new Map<string, CacheEntry>();

    /** ファイル名 → 絶対パス一覧 の索引（初回利用時に構築し、ファイル増減で破棄する） */
    private fileNameIndex: FileNameIndex | null = null;

    /** ファイルの作成・削除を監視して索引を無効化するウォッチャ */
    private watcher: vscode.FileSystemWatcher | undefined;

    /**
     * @param parser C言語が設定済みの Parser インスタンス
     */
    constructor(private readonly parser: Parser) {}

    /**
     * インクルードパスを解決し、パース済みのASTを返します。
     *
     * @param includePath `#include "..."` に記述されたパス
     * @param fromFilePath そのインクルードが記述されているファイルのURI文字列
     * @returns 解決できた場合はASTとURI文字列、できなければ null
     */
    public resolve(includePath: string, fromFilePath?: string): ResolvedInclude | null {
        const found = this.findFile(includePath, fromFilePath);
        if (!found) {
            return null;
        }

        const tree = this.parseFile(found.fsPath);
        if (!tree) {
            return null;
        }

        // 定義位置のジャンプで使うため、解析結果には URI 文字列を渡す
        return {
            tree,
            filePath: vscode.Uri.file(found.fsPath).toString(),
            ambiguous: found.ambiguous
        };
    }

    /**
     * 保持しているキャッシュを破棄します（AST が確保している WASM メモリを解放します）。
     */
    public dispose(): void {
        this.cache.forEach(entry => this.deleteTree(entry.tree));
        this.cache.clear();
        this.fileNameIndex = null;
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = undefined;
        }
    }

    /**
     * ファイル名検索用の索引を取得します。
     *
     * 初回利用時にワークスペースを走査して構築し、以降は再利用します。
     * ファイルの作成・削除・リネームを監視しており、変化があれば破棄して作り直します。
     *
     * @returns ファイル名 → 絶対パス一覧 の索引
     */
    private getFileNameIndex(): FileNameIndex {
        if (this.fileNameIndex) {
            return this.fileNameIndex;
        }

        const index: FileNameIndex = new Map();
        let indexedCount = 0;

        /**
         * ディレクトリを再帰的に走査して索引へ登録します。
         *
         * @param directory 走査対象のディレクトリ
         */
        const walk = (directory: string): void => {
            if (indexedCount >= MAX_INDEXED_FILES) {
                return;
            }
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                // アクセスできないディレクトリは読み飛ばす
                return;
            }

            for (const entry of entries) {
                if (indexedCount >= MAX_INDEXED_FILES) {
                    return;
                }
                if (entry.isDirectory()) {
                    // ドットで始まるディレクトリ（.git など）とビルド関連は対象外
                    if (entry.name.startsWith('.') || INDEX_SKIP_DIRECTORIES.has(entry.name)) {
                        continue;
                    }
                    walk(path.join(directory, entry.name));
                    continue;
                }
                if (!entry.isFile() || !INDEXED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                    continue;
                }
                const filePath = path.join(directory, entry.name);
                const existing = index.get(entry.name);
                if (existing) {
                    existing.push(filePath);
                } else {
                    index.set(entry.name, [filePath]);
                }
                indexedCount++;
            }
        };

        (vscode.workspace.workspaceFolders || []).forEach(folder => walk(folder.uri.fsPath));

        this.ensureWatcher();
        this.fileNameIndex = index;
        return index;
    }

    /**
     * ファイルの増減で索引を破棄するウォッチャを用意します（未作成の場合のみ）。
     */
    private ensureWatcher(): void {
        if (this.watcher) {
            return;
        }
        try {
            // 索引の対象はファイルの有無のみのため、内容変更（onDidChange）は監視しない
            this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
            const invalidate = () => { this.fileNameIndex = null; };
            this.watcher.onDidCreate(invalidate);
            this.watcher.onDidDelete(invalidate);
        } catch {
            // ウォッチャを作れない環境では索引をそのまま使い続ける
            this.watcher = undefined;
        }
    }

    /**
     * インクルードパスに対応する実ファイルを探します。
     *
     * 探索順は「インクルード元ファイルのディレクトリ」→「各ワークスペースフォルダの直下」です。
     * ここで見つからなかった場合、設定 `searchWorkspaceByFileName` が有効なら
     * ワークスペース内をファイル名で検索します。
     *
     * 最初に見つかったものを採用しますが、同名のファイルが他にも存在する場合は
     * ambiguous として報告します。
     *
     * @param includePath `#include "..."` に記述されたパス
     * @param fromFilePath インクルード元ファイルのURI文字列
     * @returns 見つかったファイルの絶対パスと曖昧さ、見つからなければ null
     */
    /**
     * インクルードパスの解決結果を、実在した候補も含めて返します（診断用）。
     *
     * @param includePath `#include "..."` に記述されたパス
     * @param fromFilePath インクルード元ファイルのURI文字列
     * @returns 採用されたファイルの絶対パスと、実在した候補すべて
     */
    public inspect(
        includePath: string,
        fromFilePath?: string
    ): { resolved: string | null; candidates: string[] } {
        const found = this.findFile(includePath, fromFilePath);
        return found
            ? { resolved: found.fsPath, candidates: found.candidates }
            : { resolved: null, candidates: [] };
    }

    /**
     * ファイル名検索の索引に登録されているファイル数を返します（診断用）。
     *
     * @returns 索引に登録されているファイル数
     */
    public countIndexedFiles(): number {
        let count = 0;
        this.getFileNameIndex().forEach(list => { count += list.length; });
        return count;
    }

    /**
     * 指定ファイルのASTを取得します（診断用。パースできない場合は null）。
     *
     * @param fsPath 対象ファイルの絶対パス
     * @returns パース結果のAST
     */
    public getTree(fsPath: string): Parser.Tree | null {
        return this.parseFile(fsPath);
    }

    private findFile(
        includePath: string,
        fromFilePath?: string
    ): { fsPath: string; ambiguous: boolean; candidates: string[] } | null {
        let fromFsPath: string | null = null;
        if (fromFilePath) {
            try {
                fromFsPath = vscode.Uri.parse(fromFilePath).fsPath;
            } catch {
                // URI として解釈できない場合は起点なしとして扱う
            }
        }

        const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);

        // 設定は変更が即座に反映されるよう、解決のたびに読み取る
        const config = vscode.workspace.getConfiguration('c-function-analyzer');
        const excludedPaths = config.get<string[]>('excludePaths', []);
        const searchByFileName = config.get<boolean>('searchWorkspaceByFileName', true);
        const excluded = Array.isArray(excludedPaths) ? excludedPaths : [];

        const candidates = buildIncludeCandidates(includePath, fromFsPath, folders, excluded);

        const existing = this.filterExistingFiles(candidates);

        // 通常の探索で見つからない場合のみ、ワークスペース内をファイル名で検索する
        if (existing.length === 0 && searchByFileName) {
            const searched = buildFileNameSearchCandidates(
                includePath,
                this.getFileNameIndex(),
                folders,
                excluded
            );
            const foundByName = this.filterExistingFiles(searched);
            if (foundByName.length === 0) {
                return null;
            }
            return {
                fsPath: foundByName[0],
                ambiguous: foundByName.length > 1,
                candidates: foundByName
            };
        }

        if (existing.length === 0) {
            return null;
        }
        return { fsPath: existing[0], ambiguous: existing.length > 1, candidates: existing };
    }

    /**
     * 候補パスのうち、実在するファイルだけを順序を保って返します。
     *
     * 意図しないファイルを参照していないか利用者が気づけるよう、
     * 最初の1件で打ち切らずすべて数えます。
     *
     * @param candidates 候補パスの一覧
     * @returns 実在するファイルの一覧
     */
    private filterExistingFiles(candidates: string[]): string[] {
        const existing: string[] = [];
        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    existing.push(candidate);
                }
            } catch {
                // アクセス権限などで失敗した候補は読み飛ばす
            }
        }
        return existing;
    }

    /**
     * ファイルを読み込んでパースします。更新時刻が一致する場合はキャッシュを再利用します。
     *
     * @param fsPath 対象ファイルの絶対パス
     * @returns パース結果のAST、失敗した場合は null
     */
    private parseFile(fsPath: string): Parser.Tree | null {
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(fsPath).mtimeMs;
        } catch {
            return null;
        }

        const cached = this.cache.get(fsPath);
        if (cached && cached.mtimeMs === mtimeMs) {
            return cached.tree;
        }

        let tree: Parser.Tree;
        try {
            const source = fs.readFileSync(fsPath, 'utf8');
            // ヘッダ側の GLOBAL BYTE hoge; のような修飾子マクロ付き宣言も修復する
            tree = parseWithModifierMacroRepair(this.parser, source);
        } catch {
            return null;
        }

        // 更新により無効になった古いASTは破棄する
        if (cached) {
            this.deleteTree(cached.tree);
            this.cache.delete(fsPath);
        }

        // 上限を超える場合は最も古いエントリを破棄する
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) {
                const oldest = this.cache.get(oldestKey);
                if (oldest) {
                    this.deleteTree(oldest.tree);
                }
                this.cache.delete(oldestKey);
            }
        }

        this.cache.set(fsPath, { mtimeMs, tree });
        return tree;
    }

    /**
     * AST が確保しているメモリを解放します。
     *
     * @param tree 破棄対象のAST
     */
    private deleteTree(tree: Parser.Tree): void {
        try {
            tree.delete();
        } catch {
            // 解放に失敗しても解析処理は継続する
        }
    }
}
