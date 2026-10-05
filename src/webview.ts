import * as vscode from 'vscode';
import { AnalysisResult, MacroDisplay } from './analyzer';
import { buildHighlightRegex } from './highlight';
import {
    clampCommentWidth,
    CopyFormat,
    createNonce,
    DEFAULT_COMMENT_WIDTH,
    renderAnalysisHtml
} from './webviewHtml';

export class FunctionAnalyzerWebview {
    public static currentPanel: FunctionAnalyzerWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _highlightDecorationType: vscode.TextEditorDecorationType | undefined;
    private _result: AnalysisResult;
    /** コピー時の出力形式（パネルを開いている間、別の関数を解析しても保持されます） */
    private _copyFormat: CopyFormat = 'name';

    /** コメント欄の幅（px）。区切り線のドラッグで変更される */
    private _commentWidth: number = DEFAULT_COMMENT_WIDTH;

    /**
     * マクロの表示方法。設定 `macroDisplay` の値を保持します。
     *
     * パネル上で切り替えると、ユーザー設定へ保存したうえで再描画します。
     */
    private _macroDisplay: MacroDisplay = 'separate';

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
                    case 'revealDefinition':
                        this._revealDefinition(message.line, message.column, message.filePath);
                        break;
                    case 'setCommentWidth':
                        // 再描画時にも幅を保つため、拡張機能側で保持する
                        if (typeof message.width === 'number') {
                            this._commentWidth = clampCommentWidth(message.width);
                        }
                        break;
                    case 'showDefinitionDiagnostics':
                        // 定義ジャンプの診断結果（出力パネル）を開く
                        vscode.commands.executeCommand('c-function-analyzer.showDefinitionDiagnostics');
                        break;
                    case 'setMacroDisplay':
                        // パネルでの選択をユーザー設定へ保存し、解析し直さずに描画だけ更新する
                        if (message.macroDisplay === 'separate' || message.macroDisplay === 'merged') {
                            this._setMacroDisplay(message.macroDisplay);
                        }
                        break;
                    case 'setCopyFormat':
                        // 再描画時にも選択を保つため、拡張機能側で保持する
                        if (message.format === 'name' || message.format === 'typeAndName') {
                            this._copyFormat = message.format;
                        }
                        break;
                }
            },
            undefined,
            this._disposables
        );

        // 設定画面など、パネル以外で設定が変更された場合も表示を合わせる
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration('c-function-analyzer.macroDisplay')) {
                return;
            }
            const macroDisplay = readMacroDisplay();
            if (macroDisplay !== this._macroDisplay) {
                this._macroDisplay = macroDisplay;
                this._render();
            }
        }, null, this._disposables);

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
        this._macroDisplay = readMacroDisplay();
        this._panel.title = `Analysis: ${result.functionName}`;
        // Content-Security-Policy 用の nonce は描画のたびに新しく生成する
        this._panel.webview.html = renderAnalysisHtml(
            result,
            createNonce(),
            this._copyFormat,
            this._commentWidth,
            this._macroDisplay
        );
    }

    /**
     * マクロの表示方法を切り替えて、ユーザー設定へ保存します。
     *
     * 解析結果は常にマクロを分けて保持しているため、解析をやり直さずに描画だけを
     * 更新できます。
     *
     * @param macroDisplay 新しい表示方法
     */
    private async _setMacroDisplay(macroDisplay: MacroDisplay) {
        this._macroDisplay = macroDisplay;
        this._render();
        try {
            await vscode.workspace
                .getConfiguration('c-function-analyzer')
                .update('macroDisplay', macroDisplay, vscode.ConfigurationTarget.Global);
        } catch (err) {
            vscode.window.showWarningMessage('マクロの表示方法を設定に保存できませんでした: ' + err);
        }
    }

    /**
     * 現在の状態で Webview を描き直します（解析はやり直しません）。
     */
    private _render() {
        this._panel.webview.html = renderAnalysisHtml(
            this._result,
            createNonce(),
            this._copyFormat,
            this._commentWidth,
            this._macroDisplay
        );
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
     * 変数・関数の定義位置をエディタで開いて表示します。
     *
     * @param line 定義行（0始まり）
     * @param column 定義列（0始まり）
     * @param filePath 定義があるファイル。未指定の場合は解析対象ファイル自身
     */
    private async _revealDefinition(line: number, column: number, filePath?: string) {
        // 定義先ファイルの決定（インクルードファイル内でなければ解析対象ファイル）
        const targetPath = filePath || this._result.filePath;
        if (!targetPath) {
            vscode.window.showWarningMessage('定義位置のファイルを特定できませんでした。');
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(targetPath));
            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.One,
                preserveFocus: false
            });

            const position = new vscode.Position(line, column);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenterIfOutsideViewport
            );
        } catch (err) {
            vscode.window.showErrorMessage(`定義位置を開けませんでした: ${err}`);
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

/**
 * 設定からマクロの表示方法を読み取ります。
 *
 * @returns マクロの表示方法（未設定・想定外の値の場合は `separate`）
 */
function readMacroDisplay(): MacroDisplay {
    const value = vscode.workspace
        .getConfiguration('c-function-analyzer')
        .get<string>('macroDisplay', 'separate');
    return value === 'merged' ? 'merged' : 'separate';
}
