/**
 * `#include "..."` を実ファイルから解決する IncludeResolver の実装です。
 *
 * ファイルシステムと VS Code のワークスペース情報に依存するため、
 * 解析ロジック（analyzer.ts）からは分離してこちらに配置しています。
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import Parser = require('web-tree-sitter');
import { IncludeResolver, ResolvedInclude } from './analyzer';
import { buildIncludeCandidates } from './includePaths';

/** パース結果のキャッシュエントリ */
interface CacheEntry {
    /** キャッシュ時点のファイル更新時刻 */
    mtimeMs: number;
    tree: Parser.Tree;
}

/** キャッシュの上限件数（超えた場合は最も古いものから破棄する） */
const MAX_CACHE_ENTRIES = 64;

export class FileIncludeResolver implements IncludeResolver {
    /** ファイルパス（fsPath）→ パース結果 のキャッシュ */
    private readonly cache = new Map<string, CacheEntry>();

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
        const resolvedFsPath = this.findFile(includePath, fromFilePath);
        if (!resolvedFsPath) {
            return null;
        }

        const tree = this.parseFile(resolvedFsPath);
        if (!tree) {
            return null;
        }

        // 定義位置のジャンプで使うため、解析結果には URI 文字列を渡す
        return { tree, filePath: vscode.Uri.file(resolvedFsPath).toString() };
    }

    /**
     * 保持しているキャッシュを破棄します（AST が確保している WASM メモリを解放します）。
     */
    public dispose(): void {
        this.cache.forEach(entry => this.deleteTree(entry.tree));
        this.cache.clear();
    }

    /**
     * インクルードパスに対応する実ファイルを探します。
     *
     * 探索順は「インクルード元ファイルのディレクトリ」→「設定 includePaths」
     * →「各ワークスペースフォルダの直下」です。
     *
     * @param includePath `#include "..."` に記述されたパス
     * @param fromFilePath インクルード元ファイルのURI文字列
     * @returns 見つかったファイルの絶対パス（fsPath）、見つからなければ null
     */
    private findFile(includePath: string, fromFilePath?: string): string | null {
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
        const configuredPaths = vscode.workspace
            .getConfiguration('c-function-analyzer')
            .get<string[]>('includePaths', []);

        const candidates = buildIncludeCandidates(
            includePath,
            fromFsPath,
            folders,
            Array.isArray(configuredPaths) ? configuredPaths : []
        );

        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return candidate;
                }
            } catch {
                // アクセス権限などで失敗した候補は読み飛ばす
            }
        }
        return null;
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
            tree = this.parser.parse(source);
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
