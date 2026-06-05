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
        // 変数カードのHTMLを生成するヘルパー
        const renderVariableList = (vars: typeof result.inputs) => {
            if (vars.length === 0) {
                return '<div class="no-data">検出された変数はありません</div>';
            }
            return vars.map(v => `
                <div class="variable-card">
                    <div class="variable-header">
                        <span class="variable-name">${v.name}</span>
                        <span class="variable-type">${v.type}</span>
                    </div>
                    ${v.details ? `<div class="variable-details">${v.details}</div>` : ''}
                </div>
            `).join('');
        };

        // 呼び出し関数のバッジリストを生成するヘルパー
        const renderCalledFunctions = (funcs: string[]) => {
            if (funcs.length === 0) {
                return '<div class="no-data">関数呼び出しはありません</div>';
            }
            return funcs.map(f => `
                <div class="function-badge">
                    <span class="function-icon">ƒ</span>
                    <span class="function-name">${f}</span>
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
            --accent-gradient: linear-gradient(135deg, #6366f1 0%, #a855f7 100%);
            --accent-color: #6366f1;
            --bg-glass: rgba(255, 255, 255, 0.03);
            --border-glass: rgba(255, 255, 255, 0.08);
            --text-muted: var(--vscode-descriptionForeground, #858585);
            --card-shadow: 0 4px 20px 0 rgba(0, 0, 0, 0.15);
        }

        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
            color: var(--vscode-editor-foreground, #cccccc);
            background-color: var(--vscode-editor-background, #1e1e1e);
            margin: 0;
            padding: 24px;
            box-sizing: border-box;
            line-height: 1.6;
            animation: fadeIn 0.4s ease-out;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* ヘッダーヒーローセクション */
        .hero {
            background: var(--accent-gradient);
            border-radius: 16px;
            padding: 28px;
            margin-bottom: 28px;
            box-shadow: var(--card-shadow);
            color: #ffffff;
            position: relative;
            overflow: hidden;
        }

        .hero::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 80%);
            pointer-events: none;
        }

        .hero-meta {
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 2px;
            opacity: 0.8;
            margin-bottom: 8px;
            font-weight: 600;
        }

        .hero-title {
            font-size: 2.2rem;
            font-weight: 800;
            margin: 0;
            display: flex;
            align-items: baseline;
            gap: 12px;
            word-break: break-all;
        }

        .hero-return-type {
            font-size: 1.2rem;
            font-weight: 400;
            opacity: 0.9;
            background: rgba(255, 255, 255, 0.15);
            padding: 4px 12px;
            border-radius: 8px;
            backdrop-filter: blur(4px);
            font-family: var(--vscode-editor-font-family, monospace);
        }

        /* グリッドレイアウト */
        .layout-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
            gap: 24px;
        }

        /* セクションカード */
        .section-card {
            background: var(--bg-glass);
            border: 1px solid var(--border-glass);
            border-radius: 14px;
            padding: 20px;
            box-shadow: var(--card-shadow);
            backdrop-filter: blur(8px);
            transition: transform 0.2s ease, border-color 0.2s ease;
        }

        .section-card:hover {
            transform: translateY(-2px);
            border-color: rgba(99, 102, 241, 0.3);
        }

        .section-title {
            font-size: 1.1rem;
            font-weight: 700;
            margin-top: 0;
            margin-bottom: 18px;
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-editor-foreground, #ffffff);
            border-bottom: 2px solid var(--border-glass);
            padding-bottom: 8px;
        }

        .section-title::before {
            content: '';
            display: inline-block;
            width: 4px;
            height: 16px;
            background: var(--accent-gradient);
            border-radius: 2px;
        }

        /* 変数カードデザイン */
        .variable-card {
            background: rgba(0, 0, 0, 0.15);
            border-left: 3px solid var(--accent-color);
            border-radius: 6px;
            padding: 10px 14px;
            margin-bottom: 12px;
            transition: background-color 0.2s ease;
        }

        .variable-card:hover {
            background: rgba(0, 0, 0, 0.25);
        }

        .variable-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.95rem;
        }

        .variable-name {
            font-weight: 700;
            font-family: var(--vscode-editor-font-family, monospace);
        }

        .variable-type {
            font-family: var(--vscode-editor-font-family, monospace);
            color: var(--accent-color);
            font-size: 0.85rem;
            font-weight: 600;
        }

        .variable-details {
            font-size: 0.8rem;
            color: var(--text-muted);
            margin-top: 4px;
        }

        /* 呼び出し関数バッジ */
        .called-functions-container {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
        }

        .function-badge {
            background: rgba(99, 102, 241, 0.08);
            border: 1px solid rgba(99, 102, 241, 0.2);
            color: var(--vscode-editor-foreground, #cccccc);
            border-radius: 8px;
            padding: 6px 12px;
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-size: 0.9rem;
            font-family: var(--vscode-editor-font-family, monospace);
            transition: all 0.2s ease;
        }

        .function-badge:hover {
            background: rgba(99, 102, 241, 0.15);
            border-color: rgba(99, 102, 241, 0.4);
            transform: scale(1.03);
        }

        .function-icon {
            color: var(--accent-color);
            font-weight: bold;
        }

        .no-data {
            color: var(--text-muted);
            font-style: italic;
            font-size: 0.9rem;
            text-align: center;
            padding: 12px;
        }
    </style>
</head>
<body>
    <div class="hero">
        <div class="hero-meta">C Function Analysis</div>
        <h1 class="hero-title">
            <span>${result.functionName}</span>
            <span class="hero-return-type">${result.returnType}</span>
        </h1>
    </div>

    <div class="layout-grid">
        <!-- 入力変数セクション -->
        <div class="section-card">
            <h2 class="section-title">入力変数 (Inputs)</h2>
            <div class="variable-list">
                ${renderVariableList(result.inputs)}
            </div>
        </div>

        <!-- 出力変数セクション -->
        <div class="section-card">
            <h2 class="section-title">出力変数 (Outputs)</h2>
            <div class="variable-list">
                ${renderVariableList(result.outputs)}
            </div>
        </div>

        <!-- 内部（ローカル）変数セクション -->
        <div class="section-card">
            <h2 class="section-title">内部変数 (Internal Variables)</h2>
            <div class="variable-list">
                ${renderVariableList(result.internalVariables)}
            </div>
        </div>

        <!-- 呼び出し関数セクション -->
        <div class="section-card">
            <h2 class="section-title">呼び出し関数 (Called Functions)</h2>
            <div class="called-functions-container">
                ${renderCalledFunctions(result.calledFunctions)}
            </div>
        </div>
    </div>
</body>
</html>`;
    }
}
