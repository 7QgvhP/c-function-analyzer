import * as vscode from 'vscode';
import * as path from 'path';
import Parser = require('web-tree-sitter');
import { analyzeCFunction } from './analyzer';
import { FileIncludeResolver } from './includeResolver';
import { FunctionAnalyzerWebview } from './webview';
import { parseWithModifierMacroRepair } from './macroRepair';
import { buildIncludeReport, formatIncludeReport } from './includeDiagnostics';
import { extractIncludePaths, listStructDefinitionNames, MAX_INCLUDE_DEPTH } from './analyzer';

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

    // インクルードファイルの解決を担うリゾルバ（パース結果をキャッシュするため使い回す）
    const includeResolver = new FileIncludeResolver(parser);
    context.subscriptions.push({ dispose: () => includeResolver.dispose() });

    // 診断結果の表示先（出力パネル）
    const diagnosticsChannel = vscode.window.createOutputChannel('C Function Analyzer');
    context.subscriptions.push(diagnosticsChannel);

    // 2. コマンド 'c-function-analyzer.analyze' の登録
    const disposable = vscode.commands.registerCommand('c-function-analyzer.analyze', () => {
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

        try {
            // ソースコード全体をパースしてASTを取得
            // （GLOBAL BYTE hoge; のような修飾子マクロ付き宣言は必要に応じて修復する）
            const sourceCode = document.getText();
            const tree = parseWithModifierMacroRepair(parser, sourceCode);

            // VS Codeの設定からマクロ分類オプションを取得
            const config = vscode.workspace.getConfiguration('c-function-analyzer');
            const classifyAllUppercaseAsMacros = config.get<boolean>('classifyAllUppercaseAsMacros', true);

            // C言語関数の簡易解析を実行（インクルードファイルも辿って型と定義位置を解決する）
            const result = analyzeCFunction(tree, cursorLine, classifyAllUppercaseAsMacros, {
                includeResolver,
                currentFilePath: document.uri.toString()
            });

            if (!result) {
                // 関数定義の関数名や引数宣言がある行以外で実行された場合はインフォメーションを表示
                vscode.window.showInformationMessage(
                    '関数が定義されている場所の「関数名がある行（宣言部）」にカーソルを置いて実行してください。'
                );
                return;
            }

            // Webview パネルを表示して解析結果を描画
            result.filePath = document.uri.toString();
            FunctionAnalyzerWebview.show(result);

        } catch (err) {
            vscode.window.showErrorMessage('関数の解析中にエラーが発生しました。');
        }
    });

    context.subscriptions.push(disposable);

    // 3. コマンド 'c-function-analyzer.diagnoseIncludes' の登録
    const diagnoseDisposable = vscode.commands.registerCommand(
        'c-function-analyzer.diagnoseIncludes',
        () => runIncludeDiagnostics(parser, includeResolver, diagnosticsChannel)
    );
    context.subscriptions.push(diagnoseDisposable);
}

/**
 * インクルード探索の到達状況を診断し、出力パネルへ表示します。
 *
 * 「特定のシンボルだけ `(推定)` になる」原因が、深さ上限による打ち切りなのか
 * ヘッダの解決失敗なのかを切り分けるために使います。
 *
 * @param parser 言語設定済みのパーサー
 * @param resolver インクルードを解決するリゾルバ
 * @param channel 結果を表示する出力チャンネル
 */
function runIncludeDiagnostics(
    parser: Parser,
    resolver: FileIncludeResolver,
    channel: vscode.OutputChannel
): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('アクティブなエディタがありません。');
        return;
    }
    if (editor.document.languageId !== 'c') {
        vscode.window.showWarningMessage('C言語のソースファイルでのみ有効です。');
        return;
    }

    const entryFsPath = editor.document.uri.fsPath;

    try {
        const report = buildIncludeReport(entryFsPath, MAX_INCLUDE_DEPTH, {
            readIncludePaths: (fsPath) => {
                // 解析対象ファイル自身は、未保存の変更も含めたエディタの内容を使う
                const tree = fsPath === entryFsPath
                    ? parseWithModifierMacroRepair(parser, editor.document.getText())
                    : resolver.getTree(fsPath);
                return tree ? extractIncludePaths(tree.rootNode) : [];
            },
            inspectInclude: (includePath, fromFsPath) =>
                resolver.inspect(includePath, vscode.Uri.file(fromFsPath).toString()),
            readStructNames: (fsPath) => {
                const tree = resolver.getTree(fsPath);
                return tree ? listStructDefinitionNames(tree.rootNode) : [];
            },
            countIndexedFiles: () => resolver.countIndexedFiles()
        });

        channel.clear();
        channel.appendLine(formatIncludeReport(report, toWorkspaceRelative));
        channel.show(true);
    } catch (err) {
        vscode.window.showErrorMessage(`インクルード探索の診断中にエラーが発生しました: ${err}`);
    }
}

/**
 * 絶対パスをワークスペースからの相対パスへ変換します（表示用）。
 *
 * ワークスペース外のパスは絶対パスのまま返します。
 *
 * @param fsPath 変換対象の絶対パス
 * @returns 表示用のパス
 */
function toWorkspaceRelative(fsPath: string): string {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    if (!folder) {
        return fsPath;
    }
    return path.relative(folder.uri.fsPath, fsPath) || path.basename(fsPath);
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
