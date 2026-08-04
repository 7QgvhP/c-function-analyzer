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
 * 同名ファイルが複数見つかった場合の注意マークを生成します。
 *
 * @param definition 定義位置（未特定の場合はマークを出力しません）
 * @returns 生成したHTML
 */
function renderAmbiguousMark(definition?: DefinitionLocation): string {
    if (!definition || !definition.ambiguous) {
        return '';
    }
    return '<span class="ambiguous-mark" title="同名のファイルが複数見つかりました。意図と異なる定義を参照している可能性があります。「定義へ」で実際に参照しているファイルを確認できます。">!</span>';
}

/**
 * 解析結果に、同名ファイルが複数あった定義が含まれるか判定します。
 *
 * @param result 解析結果
 * @returns 1件でも該当があれば true
 */
function hasAmbiguousDefinition(result: AnalysisResult): boolean {
    const groups: { definition?: DefinitionLocation }[][] = [
        result.inputs,
        result.outputs,
        result.internalVariables,
        result.macroVariables ?? [],
        result.calledFunctions,
        result.macroFunctions ?? []
    ];
    return groups.some(items => items.some(item => item.definition && item.definition.ambiguous));
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
        const type = escapeHtml(v.type);
        // 定義値（マクロの #define 値）は型名とは別の欄に表示する。
        // 長い値は省略表示になるため、全文は title で参照できるようにする。
        const value = v.value ? escapeHtml(v.value) : '';
        const valueColumn = value
            ? `<span class="variable-value" title="${value}">${value}</span>`
            : '';
        // 宣言の右側に書かれた説明コメント
        const comment = v.comment ? escapeHtml(v.comment) : '';
        const commentColumn = comment
            ? `<span class="variable-comment" title="${comment}">${comment}</span>`
            : '';
        return `
                <div class="variable-item" data-name="${name}" data-type="${type}" data-value="${value}" data-comment="${comment}" data-highlightable="${highlightable}"${renderDefinitionAttrs(v.definition)}>
                    <div class="variable-row">
                        <div class="variable-info">
                            <span class="variable-type">${type}</span>
                            <span class="variable-name">${name}</span>${renderAmbiguousMark(v.definition)}
                            ${valueColumn}
                            ${commentColumn}
                        </div>
                        <div class="variable-actions">
                            ${renderDefinitionButton(v.definition)}
                            <button class="var-copy-button">コピー</button>
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
        // 呼び出し関数は戻り値の型、マクロ関数は macro を型名欄に表示する
        const type = f.type ? escapeHtml(f.type) : '';
        const value = f.value ? escapeHtml(f.value) : '';
        const valueColumn = value
            ? `<span class="variable-value" title="${value}">${value}</span>`
            : '';
        // 宣言の右側に書かれた説明コメント
        const comment = f.comment ? escapeHtml(f.comment) : '';
        const commentColumn = comment
            ? `<span class="variable-comment" title="${comment}">${comment}</span>`
            : '';
        return `
                <div class="variable-item" data-name="${cleanName}" data-type="${type}" data-value="${value}" data-comment="${comment}" data-highlightable="true"${renderDefinitionAttrs(f.definition)}>
                    <div class="variable-row">
                        <div class="variable-info">
                            <span class="variable-type">${type}</span>
                            <span class="variable-name">${escapeHtml(f.name)}</span>${renderAmbiguousMark(f.definition)}
                            ${valueColumn}
                            ${commentColumn}
                        </div>
                        <div class="variable-actions">
                            ${renderDefinitionButton(f.definition)}
                            <button class="var-copy-button">コピー</button>
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
 * コピー時の出力形式です。
 *
 * - `name`: 変数名のみ（1行1件）
 * - `typeAndName`: 型名とタブ区切りで変数名（表計算ソフトで2列になる）
 */
export type CopyFormat = 'name' | 'typeAndName';

/**
 * コピー形式の切り替えUIを生成します。
 *
 * @param copyFormat 現在選択されている形式
 * @returns 生成したHTML
 */
function renderCopyFormatSelector(copyFormat: CopyFormat): string {
    /**
     * 選択肢1つ分のボタンを生成します。
     *
     * @param format 対応する形式
     * @param label 表示ラベル
     * @returns 生成したHTML
     */
    const option = (format: CopyFormat, label: string) =>
        `<button class="copy-format-option${copyFormat === format ? ' is-active' : ''}" data-format="${format}">${label}</button>`;

    return `
        <div class="copy-format" role="group" aria-label="コピー形式">
            <span class="copy-format-label">コピー形式</span>
            ${option('name', '変数名')}
            ${option('typeAndName', '型名 + 変数名')}
        </div>`;
}

/** コメント欄の既定の幅（px） */
export const DEFAULT_COMMENT_WIDTH = 260;

/** コメント欄の最小の幅（px）。狭すぎて読めなくならないようにする */
export const MIN_COMMENT_WIDTH = 80;

/** コメント欄の最大の幅（px）。型名・名前が潰れないようにする */
export const MAX_COMMENT_WIDTH = 800;

/**
 * コメント欄の幅を許容範囲へ収めます。
 *
 * @param width 指定された幅
 * @returns 範囲内に収めた幅（数値として扱えない場合は既定値）
 */
export function clampCommentWidth(width: number): number {
    if (!Number.isFinite(width)) {
        return DEFAULT_COMMENT_WIDTH;
    }
    return Math.min(MAX_COMMENT_WIDTH, Math.max(MIN_COMMENT_WIDTH, Math.round(width)));
}

/**
 * 解析結果から Webview 全体のHTMLを生成します。
 *
 * @param result 解析結果
 * @param nonce Content-Security-Policy で使用する nonce 値
 * @param copyFormat コピー時の出力形式（省略時は変数名のみ）
 * @param commentWidth コメント欄の幅（px。省略時は既定値）
 * @returns 生成したHTML
 */
export function renderAnalysisHtml(
    result: AnalysisResult,
    nonce: string,
    copyFormat: CopyFormat = 'name',
    commentWidth: number = DEFAULT_COMMENT_WIDTH
): string {
    const width = clampCommentWidth(commentWidth);
    const macroVariables = result.macroVariables ?? [];
    const macroFunctions = result.macroFunctions ?? [];

    // 同名ファイルが複数あった場合は、見落とさないようヘッダにも注意を出す
    const ambiguousNotice = hasAmbiguousDefinition(result)
        ? `
        <div class="ambiguous-notice">
            <span class="ambiguous-mark">!</span>
            同名のファイルが複数見つかった定義があります。意図と異なるファイルを参照している可能性があります。
            「定義へ」で参照先を確認するか、設定 <code>excludePaths</code> で使用しないディレクトリを除外してください。
        </div>`
        : '';

    return `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Function Analysis: ${escapeHtml(result.functionName)}</title>
    <style nonce="${nonce}">
${WEBVIEW_STYLES}
        /* コメント欄の幅（区切り線のドラッグで変更され、拡張機能側に保持される） */
        :root { --comment-width: ${width}px; }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-meta">C Function Analysis</div>
        <h1 class="header-title">
            <span>${escapeHtml(result.functionName)}</span>
        </h1>
${renderCopyFormatSelector(copyFormat)}
    </div>
${ambiguousNotice}

    <div class="layout-area">
    <div class="comment-resizer" title="ドラッグしてコメント欄の幅を変更（すべての分類に反映されます）"></div>
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
    </div>
    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        // 現在選択されているコピー形式（切り替えボタンで変更される）
        let copyFormat = "${copyFormat}";

        /**
         * 対象の項目からコピー用の文字列を組み立てます。
         * 変数と変数は改行で区切り、型名を含める場合はタブで区切ります
         * （表計算ソフトへ貼り付けると1行1件・複数列になります）。
         * 定義値を持つ項目（マクロ）は、3列目に定義値を出します。
         */
        function buildCopyText(items) {
            return items.map(item => {
                const name = item.getAttribute('data-name') || '';
                if (copyFormat !== 'typeAndName') {
                    return name;
                }
                const type = item.getAttribute('data-type') || '';
                const value = item.getAttribute('data-value') || '';
                const comment = item.getAttribute('data-comment') || '';
                // 定義値を持つ項目は 4 列、それ以外は 3 列になる
                const columns = value ? [type, name, value] : [type, name];
                if (comment) {
                    columns.push(comment);
                }
                return columns.join('\\t');
            }).join('\\n');
        }

        // コメント欄の幅の調整（区切り線のドラッグ）。
        // 幅は :root の CSS 変数1つで管理しているため、すべての分類へまとめて反映される。
        const resizer = document.querySelector('.comment-resizer');
        const layoutArea = document.querySelector('.layout-area');

        /** 型名と名前のために必ず残す幅（px） */
        const RESERVED_WIDTH = 200;

        /** 現在のコメント欄の幅（px）を取得します */
        function currentCommentWidth() {
            const raw = getComputedStyle(document.documentElement).getPropertyValue('--comment-width');
            const parsed = parseInt(raw, 10);
            return isNaN(parsed) ? ${DEFAULT_COMMENT_WIDTH} : parsed;
        }

        /**
         * 今の表示幅で許されるコメント欄の最大幅を求めます。
         *
         * 行の内容が収まらなくなると、名前や定義値が縮んだ結果コメント欄の左端が
         * 行ごとにずれてしまうため、必ず余白が残る範囲に制限します。
         */
        function maxCommentWidth() {
            const info = document.querySelector('.variable-info');
            if (!info) {
                return ${MAX_COMMENT_WIDTH};
            }
            const available = Math.round(info.getBoundingClientRect().width) - RESERVED_WIDTH;
            return Math.max(${MIN_COMMENT_WIDTH}, Math.min(${MAX_COMMENT_WIDTH}, available));
        }

        /** コメント欄の幅を範囲内に収めて反映し、区切り線を合わせて配置します */
        function applyCommentWidth(width) {
            const clamped = Math.min(maxCommentWidth(), Math.max(${MIN_COMMENT_WIDTH}, Math.round(width)));
            document.documentElement.style.setProperty('--comment-width', clamped + 'px');

            const sample = document.querySelector('.variable-comment');
            if (!resizer || !layoutArea || !sample) {
                if (resizer) { resizer.style.display = 'none'; }
                return;
            }
            const areaRect = layoutArea.getBoundingClientRect();
            const commentRect = sample.getBoundingClientRect();
            resizer.style.display = 'block';
            resizer.style.left = (commentRect.left - areaRect.left - 5) + 'px';
        }

        if (resizer) {
            resizer.addEventListener('mousedown', event => {
                event.preventDefault();
                const startX = event.clientX;
                const startWidth = currentCommentWidth();
                document.body.classList.add('is-resizing');

                // 左へドラッグするほどコメント欄を広げる
                const onMove = moveEvent => applyCommentWidth(startWidth - (moveEvent.clientX - startX));

                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    document.body.classList.remove('is-resizing');
                    // 再描画されても幅を保つため、拡張機能側にも伝える
                    vscode.postMessage({ command: 'setCommentWidth', width: currentCommentWidth() });
                };

                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            });
        }

        // 表示幅が変わると許容できる最大幅も変わるため、その都度収め直す
        applyCommentWidth(currentCommentWidth());
        window.addEventListener('resize', () => applyCommentWidth(currentCommentWidth()));

        // コピー形式の切り替え
        document.querySelectorAll('.copy-format-option').forEach(button => {
            button.addEventListener('click', () => {
                const format = button.getAttribute('data-format');
                if (!format || format === copyFormat) {
                    return;
                }
                copyFormat = format;
                document.querySelectorAll('.copy-format-option').forEach(other => {
                    other.classList.toggle('is-active', other.getAttribute('data-format') === format);
                });
                // 別の関数を解析して再描画された際も選択を保つため、拡張機能側にも伝える
                vscode.postMessage({ command: 'setCopyFormat', format: format });
            });
        });

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
                const items = Array.from(container.querySelectorAll('.variable-item'));
                if (items.length === 0) {
                    return;
                }

                vscode.postMessage({ command: 'copyText', text: buildCopyText(items) });

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
                const item = button.closest('.variable-item');
                if (item) {
                    vscode.postMessage({ command: 'copyText', text: buildCopyText([item]) });

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
