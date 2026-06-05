import * as vscode from 'vscode';
import * as path from 'path';
import Parser from 'web-tree-sitter';
import { analyzeCFunction } from './analyzer';
import { FunctionAnalyzerWebview } from './webview';

/**
 * 拡張機能がアクティベートされた際に実行されます。
 */
export async function activate(context: vscode.ExtensionContext) {
    console.log('Extension "function-analyzer" is now active.');

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

    // 2. コマンド 'function-analyzer.analyze' の登録
    const disposable = vscode.commands.registerCommand('function-analyzer.analyze', () => {
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
            const sourceCode = document.getText();
            const tree = parser.parse(sourceCode);

            // C言語関数の簡易解析を実行
            const result = analyzeCFunction(tree, cursorLine);

            if (!result) {
                // 関数定義の関数名や引数宣言がある行以外で実行された場合はインフォメーションを表示
                vscode.window.showInformationMessage(
                    '関数が定義されている場所の「関数名がある行（宣言部）」にカーソルを置いて実行してください。'
                );
                return;
            }

            // Webview パネルを表示して解析結果を描画
            FunctionAnalyzerWebview.show(result);

        } catch (err) {
            vscode.window.showErrorMessage('関数の解析中にエラーが発生しました: ' + err);
        }
    });

    context.subscriptions.push(disposable);
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
