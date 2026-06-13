import * as vscode from 'vscode';
import { AnalysisResult } from './analyzer';

export class FunctionAnalyzerWebview {
    public static currentPanel: FunctionAnalyzerWebview | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

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

        // パネルが破棄された時のクリーンアップ処理
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // 初回表示
        this.update(result);
    }

    /**
     * 解析結果で Webview の中身を更新します。
     */
    public update(result: AnalysisResult) {
        this._panel.title = `Analysis: ${result.functionName}`;
        this._panel.webview.html = this._getHtmlForWebview(result);
    }

    /**
     * リソースのクリーンアップを行います。
     */
    public dispose() {
        FunctionAnalyzerWebview.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    /**
     * Webview に表示する HTML/CSS を動的に生成します。
     */
    private _getHtmlForWebview(result: AnalysisResult): string {
        // シンプルなリスト行のHTMLを生成するヘルパー
        const renderVariableList = (vars: typeof result.inputs) => {
            if (vars.length === 0) {
                return '<div class="no-data">検出された変数はありません</div>';
            }
            return vars.map(v => `
                <div class="variable-item">
                    <div class="variable-row">
                        <span class="variable-name">${v.name}</span>
                        <span class="variable-type">${v.type}</span>
                    </div>
                    ${v.details ? `<div class="variable-details">${v.details}</div>` : ''}
                </div>
            `).join('');
        };

        // 呼び出し関数の箇条書きHTMLを生成するヘルパー
        const renderCalledFunctions = (funcs: string[]) => {
            if (funcs.length === 0) {
                return '<div class="no-data">関数呼び出しはありません</div>';
            }
            return funcs.map(f => `
                <div class="variable-item">
                    <div class="variable-row">
                        <span class="variable-name">${f}()</span>
                    </div>
                </div>
            `).join('');
        };

        return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Function Analysis: ${result.functionName}</title>
    <style>
        :root {
            --border-color: var(--vscode-panel-border, rgba(255, 255, 255, 0.1));
            --accent-color: var(--vscode-textLink-foreground, #3794ff);
            --text-muted: var(--vscode-descriptionForeground, #858585);
            --bg-hover: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.05));
        }

        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            color: var(--vscode-editor-foreground, #cccccc);
            background-color: var(--vscode-editor-background, #1e1e1e);
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
            line-height: 1.5;
        }

        /* ヘッダーセクション */
        .header {
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 14px;
            margin-bottom: 24px;
        }

        .header-meta {
            font-size: 0.8rem;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            color: var(--text-muted);
            margin-bottom: 4px;
        }

        .header-title {
            font-size: 1.6rem;
            font-weight: 600;
            margin: 0;
            display: flex;
            align-items: baseline;
            gap: 12px;
            word-break: break-all;
            color: var(--vscode-editor-foreground, #ffffff);
        }

        .header-return-type {
            font-size: 1rem;
            font-weight: normal;
            color: var(--text-muted);
            font-family: var(--vscode-editor-font-family, monospace);
        }

        /* グリッドレイアウト */
        .layout-grid {
            display: flex;
            flex-direction: column;
            gap: 24px;
        }

        /* セクション */
        .section-container {
            margin-bottom: 12px;
        }

        .section-title {
            font-size: 1rem;
            font-weight: 600;
            margin-top: 0;
            margin-bottom: 14px;
            color: var(--vscode-editor-foreground, #ffffff);
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 6px;
        }

        /* 変数行リスト */
        .variable-item {
            padding: 8px 6px;
            border-bottom: 1px dashed var(--border-color);
            display: flex;
            flex-direction: column;
            transition: background-color 0.15s ease;
        }

        .variable-item:hover {
            background-color: var(--bg-hover);
        }

        .variable-row {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
        }

        .variable-name {
            font-weight: 600;
            font-family: var(--vscode-editor-font-family, monospace);
            font-size: 0.95rem;
        }

        .variable-type {
            font-family: var(--vscode-editor-font-family, monospace);
            color: var(--accent-color);
            font-size: 0.85rem;
        }

        .variable-details {
            font-size: 0.8rem;
            color: var(--text-muted);
            margin-top: 2px;
        }



        .no-data {
            color: var(--text-muted);
            font-style: italic;
            font-size: 0.85rem;
            padding: 8px 6px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-meta">C Function Analysis</div>
        <h1 class="header-title">
            <span>${result.functionName}</span>
            <span class="header-return-type">${result.returnType}</span>
        </h1>
    </div>

    <div class="layout-grid">
        <!-- 入力変数セクション -->
        <div class="section-container">
            <h2 class="section-title">入力変数</h2>
            <div class="variable-list">
                ${renderVariableList(result.inputs)}
            </div>
        </div>

        <!-- 出力変数セクション -->
        <div class="section-container">
            <h2 class="section-title">出力変数</h2>
            <div class="variable-list">
                ${renderVariableList(result.outputs)}
            </div>
        </div>

        <!-- 内部（ローカル）変数セクション -->
        <div class="section-container">
            <h2 class="section-title">内部変数</h2>
            <div class="variable-list">
                ${renderVariableList(result.internalVariables)}
            </div>
        </div>

        <!-- マクロ変数セクション（該当がある場合のみ表示） -->
        ${result.macroVariables && result.macroVariables.length > 0 ? `
        <div class="section-container">
            <h2 class="section-title">マクロ変数</h2>
            <div class="variable-list">
                ${renderVariableList(result.macroVariables)}
            </div>
        </div>
        ` : ''}

        <!-- 呼び出し関数セクション -->
        <div class="section-container">
            <h2 class="section-title">呼び出し関数</h2>
            <div class="variable-list">
                ${renderCalledFunctions(result.calledFunctions)}
            </div>
        </div>

        <!-- マクロ関数セクション（該当がある場合のみ表示） -->
        ${result.macroFunctions && result.macroFunctions.length > 0 ? `
        <div class="section-container">
            <h2 class="section-title">マクロ関数</h2>
            <div class="variable-list">
                ${renderCalledFunctions(result.macroFunctions)}
            </div>
        </div>
        ` : ''}
    </div>
</body>
</html>`;
    }
}
