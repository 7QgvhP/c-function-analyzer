/**
 * Webview 解析結果画面のスタイル定義です。
 *
 * VS Code のテーマ変数（--vscode-*）を参照し、ライト/ダークいずれのテーマにも追従します。
 * 拡張機能は単一ファイルにバンドルされるため、外部 CSS ファイルではなく定数として保持します。
 */
export const WEBVIEW_STYLES = `
        :root {
            --border-color: var(--vscode-panel-border, rgba(255, 255, 255, 0.08));
            --text-muted: var(--vscode-descriptionForeground, #858585);
            --bg-hover: var(--vscode-list-hoverBackground, rgba(255, 255, 255, 0.04));
            --card-bg: var(--vscode-editor-background, #1e1e1e);
            --font-mono: var(--vscode-editor-font-family, Consolas, Monaco, monospace);
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: var(--vscode-editor-foreground, #cccccc);
            background-color: var(--vscode-editor-background, #1e1e1e);
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
            line-height: 1.6;
            min-width: 280px;
        }

        /* ヘッダーセクション */
        .header {
            margin-bottom: 24px;
            padding: 16px 20px;
            background: rgba(255, 255, 255, 0.01);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            overflow: hidden;
        }

        .header-meta {
            font-size: 0.75rem;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 2px;
            color: var(--vscode-textLink-foreground, #3794ff);
            margin-bottom: 6px;
        }

        .header-title {
            font-size: 1.5rem;
            font-weight: 600;
            margin: 0;
            display: flex;
            align-items: center;
            gap: 12px;
            word-break: break-all;
            color: var(--vscode-editor-foreground, #ffffff);
            flex-wrap: wrap;
        }

        .header-return-type {
            font-size: 0.95rem;
            font-weight: 500;
            color: var(--text-muted);
            font-family: var(--font-mono);
            background: rgba(255, 255, 255, 0.04);
            padding: 2px 8px;
            border-radius: 4px;
            border: 1px solid rgba(255, 255, 255, 0.05);
        }

        /* グリッドレイアウト */
        .layout-grid {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        /* セクション（カード） */
        .section-container {
            background-color: rgba(255, 255, 255, 0.01);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 18px 20px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
            overflow: hidden;
        }
        .section-container:hover {
            border-color: rgba(255, 255, 255, 0.15);
            box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
        }

        /* アクセント色定義 */
        .section-container.input { --accent-color: #3794ff; }
        .section-container.output { --accent-color: #2ecc71; }
        .section-container.internal { --accent-color: #9b59b6; }
        .section-container.macro-var { --accent-color: #e67e22; }
        .section-container.called-fn { --accent-color: #1abc9c; }
        .section-container.macro-fn { --accent-color: #f1c40f; }

        .section-title {
            font-size: 0.95rem;
            font-weight: 600;
            margin-top: 0;
            margin-bottom: 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            color: var(--vscode-editor-foreground, #ffffff);
            padding-bottom: 10px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            position: relative;
        }
        .section-title::after {
            content: '';
            position: absolute;
            bottom: -1px;
            left: 0;
            width: 100%;
            height: 2px;
            background-color: var(--accent-color);
            border-radius: 1px;
        }

        .section-count {
            font-size: 0.75rem;
            font-weight: 600;
            background: rgba(255, 255, 255, 0.06);
            color: var(--accent-color);
            padding: 2px 8px;
            border-radius: 10px;
            border: 1px solid rgba(255, 255, 255, 0.04);
            font-family: var(--font-mono);
            flex-shrink: 0;
        }

        /* 見出し右側の操作領域（件数バッジと一括コピーボタン） */
        .section-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }

        /* 分類ごとの一括コピーボタン（件数バッジの右に常時表示） */
        .section-copy-button {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.05);
            color: var(--text-muted);
            padding: 2px 8px;
            font-size: 0.7rem;
            font-weight: 400;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s ease;
            flex-shrink: 0;
            white-space: nowrap;
        }

        .section-copy-button:hover {
            background: rgba(255, 255, 255, 0.08);
            color: var(--vscode-editor-foreground, #ffffff);
            border-color: rgba(255, 255, 255, 0.15);
        }

        .section-copy-button.copied {
            background: var(--vscode-button-background, #007acc);
            color: var(--vscode-button-foreground, #ffffff);
            border-color: transparent;
        }

        /* 変数行リスト */
        .variable-list {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .variable-item {
            padding: 8px 12px;
            border-radius: 6px;
            display: flex;
            flex-direction: column;
            transition: background-color 0.2s ease, transform 0.2s cubic-bezier(0.25, 0.8, 0.25, 1);
            cursor: pointer;
            background-color: rgba(255, 255, 255, 0.005);
            border: 1px solid transparent;
        }

        .variable-item:hover {
            background-color: var(--bg-hover);
            border-color: rgba(255, 255, 255, 0.02);
            transform: translateX(4px);
        }

        .variable-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }

        .variable-info {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            flex: 1;
        }

        .variable-name {
            font-weight: 600;
            font-family: var(--font-mono);
            font-size: 0.9rem;
            color: var(--vscode-editor-foreground, #ffffff);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
        }

        .variable-type {
            font-family: var(--font-mono);
            color: var(--accent-color);
            font-size: 0.75rem;
            background: rgba(255, 255, 255, 0.03);
            padding: 2px 6px;
            border-radius: 4px;
            border: 1px solid rgba(255, 255, 255, 0.04);
            transition: background 0.2s ease;
            /* 型名によらず幅を固定し、変数名の左端が縦に揃うようにする
               （伸縮させないため flex-grow: 0 / flex-shrink: 0 / flex-basis: 140px） */
            flex: 0 0 140px;
            box-sizing: border-box;
            text-align: center;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .variable-item:hover .variable-type {
            background: rgba(255, 255, 255, 0.06);
        }

        /* 行内の操作ボタン群（「定義へ」「コピー」） */
        .variable-actions {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-shrink: 0;
        }

        .var-copy-button,
        .var-def-button {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.05);
            color: var(--text-muted);
            padding: 2px 8px;
            font-size: 0.7rem;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s ease;
            opacity: 0;
            flex-shrink: 0;
            white-space: nowrap;
        }

        .variable-item:hover .var-copy-button,
        .variable-item:hover .var-def-button {
            opacity: 1;
        }

        .var-copy-button:hover,
        .var-def-button:hover {
            background: rgba(255, 255, 255, 0.08);
            color: var(--vscode-editor-foreground, #ffffff);
            border-color: rgba(255, 255, 255, 0.15);
        }

        /* 「定義へ」ボタンはアクセント色で区別する */
        .var-def-button {
            color: var(--accent-color);
        }
        .var-def-button:hover {
            border-color: var(--accent-color);
        }

        .var-copy-button.copied {
            background: var(--vscode-button-background, #007acc);
            color: var(--vscode-button-foreground, #ffffff);
            border-color: transparent;
            opacity: 1 !important;
        }

        .no-data {
            color: var(--text-muted);
            font-size: 0.8rem;
            padding: 16px;
            text-align: center;
            background: rgba(255, 255, 255, 0.005);
            border: 1px dashed var(--border-color);
            border-radius: 6px;
        }

        /* レスポンシブ対応: 狭い幅でのレイアウト調整 */
        @media (max-width: 400px) {
            body {
                padding: 12px;
            }
            .header {
                padding: 12px 14px;
            }
            .header-title {
                font-size: 1.15rem;
                gap: 8px;
            }
            .section-container {
                padding: 14px 14px;
            }
            .variable-info {
                flex-direction: column;
                align-items: flex-start;
                gap: 4px;
            }
            .variable-type {
                /* 狭い幅では型名を変数名の上に折り返して表示するため、固定幅を解除する */
                flex: 0 1 auto;
                max-width: 100%;
            }
            .variable-item {
                padding: 8px 8px;
            }
        }
`;
