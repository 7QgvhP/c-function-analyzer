import * as vscode from 'vscode';
import * as path from 'path';
import Parser = require('web-tree-sitter');
import { analyzeCFunction, describeDefinitionSite, SourcePosition } from './analyzer';
import { FunctionAnalyzerWebview } from './webview';
import { parseWithModifierMacroRepair } from './macroRepair';
import { createExcludeFilter } from './excludePaths';
import { DefinitionCandidate, DefinitionLookup, resolveDefinitions } from './definitionResolver';

/**
 * 拡張機能がアクティベートされた際に実行されます。
 */
export async function activate(context: vscode.ExtensionContext) {
    console.log('Extension "c-function-analyzer" is now active.');

    // 1. web-tree-sitter の初期化
    try {
        await Parser.init({
            locateFile(scriptName: string) {
                // scripts/copy-wasm.js によって dist/ にコピーされた WASM を参照します
                return path.join(context.extensionPath, 'dist', scriptName);
            }
        });
    } catch (err) {
        vscode.window.showErrorMessage('web-tree-sitter の初期化に失敗しました: ' + err);
        return;
    }

    // C言語パーサー (WASM) のロードと Parser インスタンスへの設定
    const parser = new Parser();
    try {
        const cWasmPath = path.join(context.extensionPath, 'dist', 'tree-sitter-c.wasm');
        const cLang = await Parser.Language.load(cWasmPath);
        parser.setLanguage(cLang);
    } catch (err) {
        vscode.window.showErrorMessage('C言語パーサー (WASM) のロードに失敗しました: ' + err);
        return;
    }

    // 2. コマンド 'c-function-analyzer.analyze' の登録
    const disposable = vscode.commands.registerCommand('c-function-analyzer.analyze', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('アクティブなエディタがありません。');
            return;
        }

        // C言語ファイルのみを対象とする
        if (editor.document.languageId !== 'c') {
            vscode.window.showWarningMessage('C言語のソースファイルでのみ有効です。');
            return;
        }

        const document = editor.document;
        const cursorLine = editor.selection.active.line; // 0始まりの行番号

        await runWithProgress('関数を解析しています…', async () => {
            // ソースコード全体をパースしてASTを取得
            // （GLOBAL BYTE hoge; のような修飾子マクロ付き宣言は必要に応じて修復する）
            const tree = parseWithModifierMacroRepair(parser, document.getText());

            // VS Codeの設定からマクロ分類オプションを取得
            const config = vscode.workspace.getConfiguration('c-function-analyzer');
            const classifyAllUppercaseAsMacros = config.get<boolean>('classifyAllUppercaseAsMacros', true);

            // 現在のファイルだけで分かる範囲を解析する
            const result = analyzeCFunction(tree, cursorLine, classifyAllUppercaseAsMacros);

            if (!result) {
                // 関数定義の関数名や引数宣言がある行以外で実行された場合はインフォメーションを表示
                vscode.window.showInformationMessage(
                    '関数が定義されている場所の「関数名がある行（宣言部）」にカーソルを置いて実行してください。'
                );
                return;
            }

            // 定義位置を辿って、型名・コメント・定義値を埋める
            const lookup = createDefinitionLookup(parser, document);
            try {
                await resolveDefinitions(result, lookup);
            } finally {
                lookup.dispose();
            }

            // Webview パネルを表示して解析結果を描画
            result.filePath = document.uri.toString();
            FunctionAnalyzerWebview.show(result);
        }, '関数の解析中にエラーが発生しました。');
    });

    context.subscriptions.push(disposable);
}

/** 使い終わったASTを解放できる定義解決手段 */
interface DisposableDefinitionLookup extends DefinitionLookup {
    dispose(): void;
}

/**
 * VS Code の定義プロバイダ（F12 と同じもの）を使う定義解決手段を作ります。
 *
 * 候補が複数返る場合（ビルド時に切り替える同名ファイルなど）は、設定 `excludePaths`
 * に該当するものを取り除きます。残りが無ければ「定義なし」として扱います。
 *
 * @param parser 言語設定済みのパーサー
 * @param document 解析対象のドキュメント（参照位置の基準）
 * @returns 定義解決手段
 */
function createDefinitionLookup(
    parser: Parser,
    document: vscode.TextDocument
): DisposableDefinitionLookup {
    const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    const config = vscode.workspace.getConfiguration('c-function-analyzer');
    const excludedPaths = config.get<string[]>('excludePaths', []);
    const isExcluded = createExcludeFilter(
        Array.isArray(excludedPaths) ? excludedPaths : [],
        folders
    );

    // 同じヘッダを何度もパースしないよう、この解析中だけ結果を保持する
    const trees = new Map<string, Parser.Tree>();

    return {
        async findDefinitions(usage: SourcePosition): Promise<DefinitionCandidate[]> {
            const locations = await vscode.commands.executeCommand<
                vscode.Location[] | vscode.LocationLink[] | undefined
            >(
                'vscode.executeDefinitionProvider',
                document.uri,
                new vscode.Position(usage.line, usage.column)
            );
            return toCandidates(locations).filter(candidate => {
                try {
                    return !isExcluded(vscode.Uri.parse(candidate.filePath).fsPath);
                } catch {
                    // URI として解釈できない候補は除外対象と判断できないため残す
                    return true;
                }
            });
        },

        async describe(candidate: DefinitionCandidate) {
            const uri = vscode.Uri.parse(candidate.filePath);
            // 文字コードの判別は VS Code に任せる
            const doc = await vscode.workspace.openTextDocument(uri);
            const key = `${uri.toString()}@${doc.version}`;
            let tree = trees.get(key);
            if (!tree) {
                tree = parseWithModifierMacroRepair(parser, doc.getText());
                trees.set(key, tree);
            }
            return describeDefinitionSite(tree, candidate.line, candidate.column);
        },

        dispose() {
            trees.forEach(tree => {
                try {
                    tree.delete();
                } catch {
                    // 解放に失敗しても処理は継続する
                }
            });
            trees.clear();
        }
    };
}

/**
 * 定義プロバイダの戻り値を、扱いやすい形へ変換します。
 *
 * プロバイダは `Location[]` と `LocationLink[]` のどちらでも返しうるため、双方に対応します。
 *
 * @param locations 定義プロバイダの戻り値
 * @returns 定義位置の候補（返却順を保つ）
 */
function toCandidates(
    locations: vscode.Location[] | vscode.LocationLink[] | undefined
): DefinitionCandidate[] {
    if (!locations || locations.length === 0) {
        return [];
    }

    return locations.map(item => {
        const link = item as vscode.LocationLink;
        const uri = link.targetUri || (item as vscode.Location).uri;
        // 名前そのものの範囲（targetSelectionRange）があればそちらを使う
        const range = link.targetSelectionRange
            || link.targetRange
            || (item as vscode.Location).range;
        return {
            filePath: uri.toString(),
            line: range.start.line,
            column: range.start.character
        };
    });
}

/**
 * 処理中であることを右下の通知に表示しながら、処理を実行します。
 *
 * 解析は同期処理を含むため、そのまま実行すると通知が描画される前に処理が始まって
 * しまいます。重い処理の前に一度制御を返すことで、通知を先に表示します。
 *
 * @param title 通知に表示する文言
 * @param work 実行する処理
 * @param errorMessage 例外が発生した場合に表示する文言
 */
async function runWithProgress(
    title: string,
    work: () => Promise<void> | void,
    errorMessage: string
): Promise<void> {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        async () => {
            // 通知が描画されるよう、重い処理の前に一度制御を返す
            await new Promise(resolve => setTimeout(resolve, 0));
            try {
                await work();
            } catch (err) {
                vscode.window.showErrorMessage(errorMessage);
            }
        }
    );
}

/**
 * 拡張機能が非アクティブ化された際に実行されます。
 */
export function deactivate() {
    // 開いている Webview パネルがあれば破棄します
    if (FunctionAnalyzerWebview.currentPanel) {
        FunctionAnalyzerWebview.currentPanel.dispose();
    }
}
