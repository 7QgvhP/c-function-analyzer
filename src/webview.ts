import * as vscode from 'vscode';
import { AnalysisResult } from './analyzer';
import { buildHighlightRegex } from './highlight';
import { createNonce, renderAnalysisHtml } from './webviewHtml';

export class FunctionAnalyzerWebview {
    public static currentPanel: FunctionAnalyzerWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _highlightDecorationType: vscode.TextEditorDecorationType | undefined;
    private _result: AnalysisResult;

    /**
     * Webview を表示するか、既存のパネルを更新します。
     */
    public static show(result: AnalysisResult) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // すでにパネルが存在する場合は、そのパネルを再利用し、表示を更新します
        if (FunctionAnalyzerWebview.currentPanel) {
            FunctionAnalyzerWebview.currentPanel.update(result);
            return;
        }

        // 新しいWebviewパネルを作成します（エディタを分割して横に表示）
        const targetColumn = column ? (column === vscode.ViewColumn.One ? vscode.ViewColumn.Two : column) : vscode.ViewColumn.One;
        const panel = vscode.window.createWebviewPanel(
            'functionAnalyzer',
            `Analysis: ${result.functionName}`,
            targetColumn,
            {
                enableScripts: true,
                retainContextWhenHidden: true // タブ切り替え時も表示状態を保持
            }
        );

        FunctionAnalyzerWebview.currentPanel = new FunctionAnalyzerWebview(panel, result);
    }

    private constructor(panel: vscode.WebviewPanel, result: AnalysisResult) {
        this._panel = panel;
        this._result = result;

        // パネルが破棄された時のクリーンアップ処理
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // メッセージ受信時の処理
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'highlightVariable':
                        this._highlightVariableInEditor(message.name, this._result.startLine, this._result.endLine, this._result.filePath);
                        break;
                    case 'copyText':
                        vscode.env.clipboard.writeText(message.text);
                        break;
                }
            },
            undefined,
            this._disposables
        );

        // カーソル移動や選択変更があった場合にデコレーションをクリア
        vscode.window.onDidChangeTextEditorSelection(e => {
            // キーボードやマウス操作による明示的な変更の場合のみハイライトを解除
            if (e.kind === vscode.TextEditorSelectionChangeKind.Keyboard ||
                e.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
                if (this._highlightDecorationType) {
                    this._highlightDecorationType.dispose();
                    this._highlightDecorationType = undefined;
                }
            }
        }, null, this._disposables);

        // 初回表示
        this.update(result);
    }

    /**
     * 解析結果で Webview の中身を更新します。
     */
    public update(result: AnalysisResult) {
        this._result = result;
        this._panel.title = `Analysis: ${result.functionName}`;
        // Content-Security-Policy 用の nonce は描画のたびに新しく生成する
        this._panel.webview.html = renderAnalysisHtml(result, createNonce());
    }

    /**
     * リソースのクリーンアップを行います。
     */
    public dispose() {
        FunctionAnalyzerWebview.currentPanel = undefined;
        if (this._highlightDecorationType) {
            this._highlightDecorationType.dispose();
        }
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    /**
     * エディタ上の対象関数内にある該当変数を強調表示します。
     */
    private _highlightVariableInEditor(name: string, startLine: number, endLine: number, filePath?: string) {
        // エディタ上に実体のない項目（戻り値など）は Webview 側で送信を抑止している

        let editor = vscode.window.activeTextEditor;
        if (filePath) {
            const found = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === filePath);
            if (found) {
                editor = found;
            }
        }

        if (!editor) {
            return;
        }

        // 古いデコレーションがあれば破棄
        if (this._highlightDecorationType) {
            this._highlightDecorationType.dispose();
        }

        // テーマに合わせたハイライト色を使用
        this._highlightDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: new vscode.ThemeColor('editor.symbolHighlightBackground'),
            border: '1px solid ' + new vscode.ThemeColor('editor.symbolHighlightBorder'),
            borderRadius: '3px'
        });

        const doc = editor.document;
        const ranges: vscode.Range[] = [];

        // C言語の識別子・アクセスパスとして一致するもののみを検索する正規表現を生成
        const regex = buildHighlightRegex(name);

        for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
            if (lineNum >= doc.lineCount) {
                break;
            }
            const lineText = doc.lineAt(lineNum).text;
            regex.lastIndex = 0;
            let match;
            while ((match = regex.exec(lineText)) !== null) {
                const startPos = new vscode.Position(lineNum, match.index);
                const endPos = new vscode.Position(lineNum, match.index + match[0].length);
                ranges.push(new vscode.Range(startPos, endPos));
            }
        }

        editor.setDecorations(this._highlightDecorationType, ranges);

        // 強調表示された最初の位置までスクロールする
        if (ranges.length > 0) {
            editor.revealRange(ranges[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    }
}
