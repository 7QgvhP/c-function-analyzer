/**
 * Webview 解析結果画面のスタイル定義です。
 *
 * VS Code のテーマ変数（--vscode-*）を参照し、ライト/ダークいずれのテーマにも追従します。
 * 拡張機能は単一ファイルにバンドルされるため、外部 CSS ファイルではなく定数として保持します。
 *
 * 方針: 情報の構造を示す装飾（カテゴリの色分け・セクションのまとまり）は残し、
 * 見栄えのための装飾（影・大きい角丸・大文字見出し・スライドアニメーション）は持たない。
 * 配色は彩度を抑え、エディタ本体より目立たないようにする。
 */
export const WEBVIEW_STYLES = `
        /*
         * 中間案: 構造の見やすさは残しつつ、装飾を落としたスタイル
         *
         * 現在から残すもの : カテゴリごとの色分け、セクションのまとまり、型名の枠
         * 現在から落とすもの: 影、大きい角丸、大文字＋字間、横スライド、彩度の高い6色
         */
        :root {
            --border-color: var(--vscode-panel-border, #3c3c3c);
            --text-muted: var(--vscode-descriptionForeground, #9d9d9d);
            --font-mono: var(--vscode-editor-font-family, Consolas, monospace);
            --surface: rgba(127, 127, 127, 0.06);
        }

        body {
            font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
            font-size: 13px;
            color: var(--vscode-foreground, #cccccc);
            background-color: var(--vscode-editor-background, #1e1e1e);
            margin: 0;
            padding: 12px;
            box-sizing: border-box;
            line-height: 1.45;
            /* 型名・名前・定義値・コメントの4欄が1行に収まる最小幅 */
            min-width: 560px;
        }

        /* ヘッダ */
        .header {
            padding: 0 2px 10px;
            margin-bottom: 12px;
            border-bottom: 1px solid var(--border-color);
        }

        .header-meta {
            font-size: 11px;
            color: var(--text-muted);
            margin-bottom: 3px;
        }

        .header-title {
            font-size: 16px;
            font-weight: 600;
            margin: 0;
            font-family: var(--font-mono);
            word-break: break-all;
            color: var(--vscode-foreground, #cccccc);
        }

        /* コピー形式 */
        .copy-format {
            display: flex;
            align-items: center;
            gap: 5px;
            margin-top: 10px;
        }

        .copy-format-label {
            font-size: 11px;
            color: var(--text-muted);
            margin-right: 3px;
        }

        .copy-format-option {
            background: var(--surface);
            border: 1px solid var(--border-color);
            color: var(--text-muted);
            padding: 2px 9px;
            font-family: inherit;
            font-size: 11px;
            border-radius: 3px;
            cursor: pointer;
            transition: background 0.12s ease, color 0.12s ease;
        }

        .copy-format-option:hover {
            color: var(--vscode-foreground, #cccccc);
        }

        .copy-format-option.is-active {
            background: var(--vscode-button-background, #0e639c);
            color: var(--vscode-button-foreground, #ffffff);
            border-color: var(--vscode-button-background, #0e639c);
        }

        /* 注意表示 */
        .ambiguous-notice {
            display: flex;
            align-items: baseline;
            gap: 6px;
            flex-wrap: wrap;
            margin-bottom: 12px;
            padding: 8px 12px;
            font-size: 12px;
            border-radius: 3px;
            color: var(--vscode-foreground, #cccccc);
            background: var(--vscode-inputValidation-warningBackground, #352a05);
            border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
        }

        .ambiguous-notice code {
            font-family: var(--font-mono);
            font-size: 11px;
        }

        .ambiguous-mark {
            color: var(--vscode-editorWarning-foreground, #cca700);
            font-weight: 700;
            margin-left: 6px;
            cursor: help;
            flex-shrink: 0;
        }

        /* セクション: 影と大きい角丸をやめ、左に細いアクセント線 */
        .layout-grid {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .section-container {
            background: var(--surface);
            border: 1px solid var(--border-color);
            border-left: 3px solid var(--accent-color);
            border-radius: 3px;
            overflow: hidden;
        }

        /* 彩度を落としたカテゴリ色（テーマに馴染む範囲） */
        .section-container.input     { --accent-color: #5a9fd4; }
        .section-container.output    { --accent-color: #7fa96b; }
        .section-container.internal  { --accent-color: #9b8bc4; }
        .section-container.macro-var { --accent-color: #c49a6c; }
        .section-container.called-fn { --accent-color: #5fa8a3; }
        .section-container.macro-fn  { --accent-color: #bfa85c; }

        .section-title {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            margin: 0;
            padding: 6px 10px;
            font-size: 12px;
            font-weight: 600;
            color: var(--vscode-foreground, #cccccc);
            border-bottom: 1px solid var(--border-color);
        }

        .section-actions {
            display: flex;
            align-items: center;
            gap: 8px;
            flex-shrink: 0;
        }

        /* 件数はピルではなく、控えめな角丸 */
        .section-count {
            font-family: var(--font-mono);
            font-size: 11px;
            color: var(--text-muted);
            padding: 0 5px;
            border-radius: 3px;
            background: rgba(127, 127, 127, 0.12);
        }

        .section-copy-button {
            background: transparent;
            border: none;
            color: var(--text-muted);
            padding: 1px 5px;
            font-family: inherit;
            font-size: 11px;
            border-radius: 3px;
            cursor: pointer;
        }

        .section-copy-button:hover {
            color: var(--vscode-foreground, #cccccc);
            background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
        }

        .section-copy-button.copied {
            color: var(--vscode-foreground, #cccccc);
            background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
        }

        /* 変数行 */
        .variable-list {
            padding: 3px 0;
        }

        .variable-item {
            padding: 0 10px;
            cursor: pointer;
        }

        .variable-item:hover {
            background-color: var(--vscode-list-hoverBackground, #2a2d2e);
        }

        .variable-row {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            height: 26px;
        }

        .variable-info {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            flex: 1;
        }

        /* 型名は枠を残しつつ、色はアクセントに寄せて控えめに */
        .variable-type {
            flex: 0 0 94px;
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--accent-color);
            background: rgba(127, 127, 127, 0.1);
            padding: 1px 6px;
            border-radius: 3px;
            box-sizing: border-box;
            text-align: center;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* 定義値（マクロの #define 値）。名前の右に置き、残り幅をすべて使う。
           別の変数名が書かれていることがあるため、幅を優先的に確保する。 */
        .variable-value {
            flex: 1 1 0;
            min-width: 0;
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--text-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* 宣言の右側に書かれた説明コメント。行の右端に置き、残り幅を使う。
           コードではなく説明文のため、等幅ではなく通常のフォントで表示する。 */
        .variable-comment {
            flex: 1 1 0;
            min-width: 0;
            font-size: 12px;
            color: var(--text-muted);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        /* 名前は固定幅とし、右に続く定義値・コメントの左端が行ごとに揃うようにする。
           収まらない名前は末尾を省略し、全文はホバーで参照できる。 */
        .variable-name {
            flex: 0 0 180px;
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--vscode-foreground, #cccccc);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            min-width: 0;
        }

        .variable-actions {
            display: flex;
            align-items: center;
            gap: 2px;
            flex-shrink: 0;
            opacity: 0;
        }

        .variable-item:hover .variable-actions {
            opacity: 1;
        }

        .var-def-button,
        .var-copy-button {
            background: transparent;
            border: none;
            color: var(--text-muted);
            padding: 1px 6px;
            font-family: inherit;
            font-size: 11px;
            border-radius: 3px;
            cursor: pointer;
            white-space: nowrap;
        }

        .var-def-button:hover,
        .var-copy-button:hover {
            color: var(--vscode-foreground, #cccccc);
            background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
        }

        .var-copy-button.copied {
            opacity: 1;
            color: var(--vscode-foreground, #cccccc);
            background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
        }

        .no-data {
            padding: 0 10px;
            height: 26px;
            line-height: 26px;
            font-size: 12px;
            color: var(--text-muted);
        }
`;
