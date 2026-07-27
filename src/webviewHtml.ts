/**
 * Webview に表示する解析結果画面の HTML を生成します。
 *
 * VS Code API には依存しない純粋な文字列処理のみで構成されており、
 * ヘッドレス環境（Node 単体）でテスト可能な状態を保っています。
 */
import { AnalysisResult, DefinitionLocation, FunctionInfo, VariableInfo } from './analyzer';
import { WEBVIEW_STYLES } from './webviewStyles';

/**
 * HTMLの特殊文字をエスケープしてXSSや表示崩れを防ぎます。
 *
 * @param str エスケープ対象の文字列
 * @returns エスケープ後の文字列
 */
export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Content-Security-Policy で使用する nonce 値を生成します。
 *
 * @returns 英数字32文字のランダムな文字列
 */
export function createNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

/**
 * 定義位置を表すデータ属性を生成します。
 *
 * @param definition 定義位置（未特定の場合は undefined）
 * @returns HTML属性の文字列（未特定の場合は空文字列）
 */
function renderDefinitionAttrs(definition?: DefinitionLocation): string {
    if (!definition) {
        return '';
    }
    const filePathAttr = definition.filePath
        ? ` data-def-file="${escapeHtml(definition.filePath)}"`
        : '';
    return ` data-def-line="${definition.line}" data-def-column="${definition.column}"${filePathAttr}`;
}

/**
 * 「定義へ」ボタンのHTMLを生成します。
 *
 * @param definition 定義位置（未特定の場合はボタンを出力しません）
 * @returns 生成したHTML
 */
function renderDefinitionButton(definition?: DefinitionLocation): string {
    if (!definition) {
        return '';
    }
    return '<button class="var-def-button" title="定義へ移動">定義へ</button>';
}

/**
 * 変数リストの各行のHTMLを生成します。
 *
 * @param vars 変数情報のリスト
 * @returns 生成したHTML（該当がない場合はプレースホルダ）
 */
function renderVariableList(vars: VariableInfo[]): string {
    if (vars.length === 0) {
        return '<div class="no-data">検出された変数はありません</div>';
    }
    return vars.map(v => {
        // エディタ上に実体を持たない項目（戻り値など）はハイライト対象外とする
        const highlightable = v.highlightable !== false;
        const name = escapeHtml(v.name);
        return `
                <div class="variable-item" data-name="${name}" data-highlightable="${highlightable}"${renderDefinitionAttrs(v.definition)}>
                    <div class="variable-row">
                        <div class="variable-info">
                            <span class="variable-type">${escapeHtml(v.type)}</span>
                            <span class="variable-name">${name}</span>
                        </div>
                        <div class="variable-actions">
                            ${renderDefinitionButton(v.definition)}
                            <button class="var-copy-button" data-name="${name}">コピー</button>
                        </div>
                    </div>
                </div>
            `;
    }).join('');
}

/**
 * 呼び出し関数リストの各行のHTMLを生成します。
 *
 * @param funcs 関数情報のリスト
 * @returns 生成したHTML（該当がない場合はプレースホルダ）
 */
function renderCalledFunctions(funcs: FunctionInfo[]): string {
    if (funcs.length === 0) {
        return '<div class="no-data">関数呼び出しはありません</div>';
    }
    return funcs.map(f => {
        // 表示上の末尾 "()" を取り除いた名前を、ハイライト・コピーの対象とする
        const cleanName = escapeHtml(f.name.endsWith('()') ? f.name.slice(0, -2) : f.name);
        return `
                <div class="variable-item" data-name="${cleanName}" data-highlightable="true"${renderDefinitionAttrs(f.definition)}>
                    <div class="variable-row">
                        <div class="variable-info">
                            <span class="variable-name">${escapeHtml(f.name)}</span>
                        </div>
                        <div class="variable-actions">
                            ${renderDefinitionButton(f.definition)}
                            <button class="var-copy-button" data-name="${cleanName}">コピー</button>
                        </div>
                    </div>
                </div>
                `;
    }).join('');
}

/**
 * 1つのセクション（カード）のHTMLを生成します。
 *
 * @param modifier セクション種別のCSSクラス
 * @param title セクション見出し
 * @param count 件数バッジに表示する数
 * @param body セクション本体のHTML
 * @returns 生成したHTML
 */
function renderSection(modifier: string, title: string, count: number, body: string): string {
    // 対象が1件以上ある場合のみ一括コピーボタンを表示する
    const copyButton = count > 0
        ? '<button class="section-copy-button" title="この分類の名前をまとめてコピー">コピー</button>'
        : '';

    return `
        <div class="section-container ${modifier}">
            <h2 class="section-title">
                <span class="section-title-text">${title}</span>
                <span class="section-actions">
                    <span class="section-count">${count}</span>
                    ${copyButton}
                </span>
            </h2>
            <div class="variable-list">
                ${body}
            </div>
        </div>`;
}

/**
 * 解析結果から Webview 全体のHTMLを生成します。
 *
 * @param result 解析結果
 * @param nonce Content-Security-Policy で使用する nonce 値
 * @returns 生成したHTML
 */
export function renderAnalysisHtml(result: AnalysisResult, nonce: string): string {
    const macroVariables = result.macroVariables ?? [];
    const macroFunctions = result.macroFunctions ?? [];

    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Function Analysis: ${escapeHtml(result.functionName)}</title>
    <style nonce="${nonce}">
${WEBVIEW_STYLES}
    </style>
</head>
<body>
    <div class="header">
        <div class="header-meta">C Function Analysis</div>
        <h1 class="header-title">
            <span>${escapeHtml(result.functionName)}</span>
        </h1>
    </div>

    <div class="layout-grid">
        <!-- 入力変数セクション -->
${renderSection('input', '入力変数', result.inputs.length, renderVariableList(result.inputs))}

        <!-- 出力変数セクション -->
${renderSection('output', '出力変数', result.outputs.length, renderVariableList(result.outputs))}

        <!-- 内部（ローカル）変数セクション -->
${renderSection('internal', '内部変数', result.internalVariables.length, renderVariableList(result.internalVariables))}

        <!-- マクロ変数セクション（該当がある場合のみ表示） -->
${macroVariables.length > 0 ? renderSection('macro-var', 'マクロ変数', macroVariables.length, renderVariableList(macroVariables)) : ''}

        <!-- 呼び出し関数セクション -->
${renderSection('called-fn', '呼び出し関数', result.calledFunctions.length, renderCalledFunctions(result.calledFunctions))}

        <!-- マクロ関数セクション（該当がある場合のみ表示） -->
${macroFunctions.length > 0 ? renderSection('macro-fn', 'マクロ関数', macroFunctions.length, renderCalledFunctions(macroFunctions)) : ''}
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // 変数行クリック時にエディタ上の該当箇所をハイライトする
        document.querySelectorAll('.variable-item').forEach(item => {
            item.addEventListener('click', () => {
                // エディタ上に実体のない項目（戻り値など）はハイライト要求を送らない
                if (item.getAttribute('data-highlightable') === 'false') {
                    return;
                }
                const name = item.getAttribute('data-name');
                if (name) {
                    vscode.postMessage({ command: 'highlightVariable', name: name });
                }
            });
        });

        // 分類ごとの一括コピー処理
        document.querySelectorAll('.section-copy-button').forEach(button => {
            button.addEventListener('click', () => {
                const container = button.closest('.section-container');
                if (!container) {
                    return;
                }
                const names = Array.from(container.querySelectorAll('.variable-item'))
                    .map(item => item.getAttribute('data-name'))
                    .filter(name => name);
                if (names.length === 0) {
                    return;
                }

                // 表計算ソフトへ貼り付けた際に1行1件となるよう改行で区切る
                vscode.postMessage({ command: 'copyText', text: names.join('\\n') });

                button.textContent = "完了";
                button.classList.add('copied');
                setTimeout(() => {
                    button.textContent = "コピー";
                    button.classList.remove('copied');
                }, 1000);
            });
        });

        // 「定義へ」ボタンのクリック処理
        document.querySelectorAll('.var-def-button').forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation(); // 親要素のクリックイベント（ハイライト）が走るのを防止
                const item = button.closest('.variable-item');
                if (!item) {
                    return;
                }
                const line = item.getAttribute('data-def-line');
                if (line === null) {
                    return;
                }
                vscode.postMessage({
                    command: 'revealDefinition',
                    line: Number(line),
                    column: Number(item.getAttribute('data-def-column') || 0),
                    // data-def-file が無い場合は解析対象ファイル自身を指す
                    filePath: item.getAttribute('data-def-file') || undefined
                });
            });
        });

        // 個別コピーボタンのクリック処理
        document.querySelectorAll('.var-copy-button').forEach(button => {
            button.addEventListener('click', (e) => {
                e.stopPropagation(); // 親要素（variable-item）のクリックイベント（ハイライト）が走るのを防止
                const name = button.getAttribute('data-name');
                if (name) {
                    vscode.postMessage({ command: 'copyText', text: name });

                    button.textContent = "完了";
                    button.classList.add('copied');
                    setTimeout(() => {
                        button.textContent = "コピー";
                        button.classList.remove('copied');
                    }, 1000);
                }
            });
        });
    </script>
</body>
</html>`;
}
