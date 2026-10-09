import * as vscode from 'vscode';
import * as path from 'path';
import Parser = require('web-tree-sitter');
import {
    AnalysisResult,
    analyzeCFunction,
    describeDefinitionSite,
    SourcePosition
} from './analyzer';
import { FunctionAnalyzerWebview } from './webview';
import { parseWithModifierMacroRepair } from './macroRepair';
import { buildFlowchart } from './flowModel';
import { toMermaid } from './flowMermaid';
import { createExcludeFilter } from './excludePaths';
import { DefinitionCandidate, DefinitionLookup, resolveDefinitions } from './definitionResolver';
import {
    DefinitionDiagnosis,
    EditorSignals,
    formatDiagnosisReport,
    ReportEntry,
    SignalDiagnostic
} from './definitionDiagnosis';

/** 定義ジャンプの診断結果を書き出す出力パネルの名前 */
const DIAGNOSIS_CHANNEL_NAME = 'C Function Analyzer: 定義の診断';

/** C/C++ 拡張（IntelliSense）の拡張機能ID */
const CPPTOOLS_EXTENSION_ID = 'ms-vscode.cpptools';

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

    // 定義ジャンプの診断結果の書き出し先（解析のたびに最新の結果へ置き換える）
    const diagnosisChannel = vscode.window.createOutputChannel(DIAGNOSIS_CHANNEL_NAME);
    context.subscriptions.push(diagnosisChannel);
    context.subscriptions.push(
        vscode.commands.registerCommand('c-function-analyzer.showDefinitionDiagnostics', () => {
            diagnosisChannel.show(true);
        })
    );

    // フローチャート（Mermaid 記法）をクリップボードへコピーするコマンド
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'c-function-analyzer.copyFlowchart',
            async (args?: { filePath?: string; line?: number }) => {
                await runWithProgress('フローチャートを作成しています…', async () => {
                    const target = await resolveFlowTarget(args);
                    if (!target) {
                        vscode.window.showWarningMessage(
                            'C言語のソースファイルで、関数の中にカーソルを置いて実行してください。'
                        );
                        return;
                    }

                    const tree = parseWithModifierMacroRepair(parser, target.document.getText());
                    const flow = buildFlowchart(tree, target.line);
                    if (!flow) {
                        vscode.window.showInformationMessage('カーソル位置に関数が見つかりません。');
                        return;
                    }

                    await vscode.env.clipboard.writeText(toMermaid(flow));
                    const notice = flow.hasParseError
                        ? '（構文エラーがあるため、一部の制御構造が図に含まれていない可能性があります）'
                        : '';
                    vscode.window.showInformationMessage(
                        `${flow.functionName} のフローチャートを Mermaid 形式でコピーしました。`
                        + `GitHub や Notion に貼り付けると図になります。${notice}`
                    );
                }, 'フローチャートの作成中にエラーが発生しました。');
            }
        )
    );

    // 2. コマンド 'c-function-analyzer.analyze' の登録
    const disposable = vscode.commands.registerCommand('c-function-analyzer.analyze', async () => {
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

        await runWithProgress('関数を解析しています…', async () => {
            // ソースコード全体をパースしてASTを取得
            // （GLOBAL BYTE hoge; のような修飾子マクロ付き宣言は必要に応じて修復する）
            const tree = parseWithModifierMacroRepair(parser, document.getText());

            // 現在のファイルだけで分かる範囲を解析する
            // （マクロをどこに表示するかは設定 macroDisplay に応じて描画時に決まる）
            const result = analyzeCFunction(tree, cursorLine);

            if (!result) {
                // 関数定義の関数名や引数宣言がある行以外で実行された場合はインフォメーションを表示
                vscode.window.showInformationMessage(
                    '関数が定義されている場所の「関数名がある行（宣言部）」にカーソルを置いて実行してください。'
                );
                return;
            }

            // 定義位置を辿って、型名・コメント・定義値を埋める。
            // あわせて、項目ごとに定義ジャンプの結果と原因を判定する
            const signals = collectEditorSignals(document);
            const lookup = createDefinitionLookup(parser, document);
            try {
                await resolveDefinitions(result, lookup, signals);
            } finally {
                lookup.dispose();
            }
            writeDiagnosisReport(diagnosisChannel, result, signals, document);

            // Webview パネルを表示して解析結果を描画
            result.filePath = document.uri.toString();
            FunctionAnalyzerWebview.show(result);
        }, '関数の解析中にエラーが発生しました。');
    });

    context.subscriptions.push(disposable);
}

/** 使い終わったASTを解放できる定義解決手段 */
interface DisposableDefinitionLookup extends DefinitionLookup {
    dispose(): void;
}

/**
 * VS Code の定義プロバイダ（F12 と同じもの）を使う定義解決手段を作ります。
 *
 * 候補が複数返る場合（ビルド時に切り替える同名ファイルなど）は、設定 `excludePaths`
 * に該当するものを取り除きます（除外そのものは definitionResolver.ts が `isExcluded` を
 * 使って行います）。残りが無ければ「定義なし」として扱います。
 *
 * @param parser 言語設定済みのパーサー
 * @param document 解析対象のドキュメント（参照位置の基準）
 * @returns 定義解決手段
 */
function createDefinitionLookup(
    parser: Parser,
    document: vscode.TextDocument
): DisposableDefinitionLookup {
    const folders = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
    const config = vscode.workspace.getConfiguration('c-function-analyzer');
    const excludedPaths = config.get<string[]>('excludePaths', []);
    const isExcluded = createExcludeFilter(
        Array.isArray(excludedPaths) ? excludedPaths : [],
        folders
    );

    // 同じヘッダを何度もパースしないよう、この解析中だけ結果を保持する
    const trees = new Map<string, Parser.Tree>();

    return {
        async findDefinitions(usage: SourcePosition): Promise<DefinitionCandidate[]> {
            const locations = await vscode.commands.executeCommand<
                vscode.Location[] | vscode.LocationLink[] | undefined
            >(
                'vscode.executeDefinitionProvider',
                document.uri,
                new vscode.Position(usage.line, usage.column)
            );
            return toCandidates(locations);
        },

        isExcluded(candidate: DefinitionCandidate): boolean {
            try {
                return isExcluded(vscode.Uri.parse(candidate.filePath).fsPath);
            } catch {
                // URI として解釈できない候補は除外対象と判断できないため残す
                return false;
            }
        },

        tokenAt(usage: SourcePosition): string | undefined {
            const range = document.getWordRangeAtPosition(
                new vscode.Position(usage.line, usage.column),
                /[A-Za-z_][A-Za-z0-9_]*/
            );
            return range ? document.getText(range) : undefined;
        },

        async describe(candidate: DefinitionCandidate) {
            const uri = vscode.Uri.parse(candidate.filePath);
            // 文字コードの判別は VS Code に任せる
            const doc = await vscode.workspace.openTextDocument(uri);
            const key = `${uri.toString()}@${doc.version}`;
            let tree = trees.get(key);
            if (!tree) {
                tree = parseWithModifierMacroRepair(parser, doc.getText());
                trees.set(key, tree);
            }
            return describeDefinitionSite(tree, candidate.line, candidate.column);
        },

        dispose() {
            trees.forEach(tree => {
                try {
                    tree.delete();
                } catch {
                    // 解放に失敗しても処理は継続する
                }
            });
            trees.clear();
        }
    };
}

/**
 * フローチャートを作る対象（ファイルとカーソル行）を決めます。
 *
 * 解析結果画面から呼ばれた場合は、その画面が対象としている関数を使います。
 * コマンドパレットから呼ばれた場合は、編集中のファイルとカーソル位置を使います。
 *
 * @param args 解析結果画面から渡された対象（省略時は編集中のファイル）
 * @returns 対象のドキュメントと行。対象が無い場合は null
 */
async function resolveFlowTarget(
    args?: { filePath?: string; line?: number }
): Promise<{ document: vscode.TextDocument; line: number } | null> {
    if (args && args.filePath) {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.filePath));
        return { document, line: args.line ?? 0 };
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'c') {
        return null;
    }
    return { document: editor.document, line: editor.selection.active.line };
}

/**
 * 原因の判定に使う手がかりを、エディタから集めます。
 *
 * C/C++ 拡張が解析対象ファイルに出しているエラー・警告と、そのエラー表示の設定を読み取ります。
 *
 * @param document 解析対象のドキュメント
 * @returns 判定に使う手がかり
 */
function collectEditorSignals(document: vscode.TextDocument): EditorSignals {
    const diagnostics = vscode.languages.getDiagnostics(document.uri).map(toSignalDiagnostic);
    const errorSquiggles = vscode.workspace
        .getConfiguration('C_Cpp', document.uri)
        .get<string>('errorSquiggles');
    const cppTools = vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID);
    return {
        diagnostics,
        errorSquiggles,
        cppToolsActive: cppTools ? cppTools.isActive : false
    };
}

/**
 * VS Code のエラー・警告を、判定に必要な情報だけの形へ変換します。
 *
 * @param diagnostic VS Code のエラー・警告
 * @returns 判定用のエラー・警告
 */
function toSignalDiagnostic(diagnostic: vscode.Diagnostic): SignalDiagnostic {
    const code = diagnostic.code;
    // code は文字列・数値のほか、リンク付きの { value, target } の形もある
    const codeText = code === undefined
        ? undefined
        : String(typeof code === 'object' ? code.value : code);
    return {
        line: diagnostic.range.start.line,
        column: diagnostic.range.start.character,
        endLine: diagnostic.range.end.line,
        endColumn: diagnostic.range.end.character,
        severity: toSeverityName(diagnostic.severity),
        source: diagnostic.source,
        code: codeText,
        message: diagnostic.message
    };
}

/**
 * エラー・警告の重大度を名前に変換します。
 *
 * @param severity VS Code の重大度
 * @returns 重大度の名前
 */
function toSeverityName(severity: vscode.DiagnosticSeverity): SignalDiagnostic['severity'] {
    switch (severity) {
        case vscode.DiagnosticSeverity.Error:
            return 'error';
        case vscode.DiagnosticSeverity.Warning:
            return 'warning';
        case vscode.DiagnosticSeverity.Information:
            return 'information';
        default:
            return 'hint';
    }
}

/**
 * 解析結果の診断を出力パネルへ書き出します（前回の内容は消します）。
 *
 * 出力パネルは自動では開きません。Webview の「定義の診断」ボタン、または
 * コマンド「定義ジャンプの診断を表示」で開きます。
 *
 * @param channel 書き出し先の出力パネル
 * @param result 定義を解決済みの解析結果
 * @param signals 判定に使った手がかり
 * @param document 解析対象のドキュメント
 */
function writeDiagnosisReport(
    channel: vscode.OutputChannel,
    result: AnalysisResult,
    signals: EditorSignals,
    document: vscode.TextDocument
): void {
    const sections: [string, { name: string; diagnosis?: DefinitionDiagnosis }[]][] = [
        ['入力変数', result.inputs],
        ['出力変数', result.outputs],
        ['内部変数', result.internalVariables],
        ['マクロ変数', result.macroVariables ?? []],
        ['呼び出し関数', result.calledFunctions],
        ['マクロ関数', result.macroFunctions ?? []]
    ];
    const entries: ReportEntry[] = [];
    sections.forEach(([section, items]) => {
        items.forEach(item => {
            if (item.diagnosis) {
                entries.push({ section, name: item.name, diagnosis: item.diagnosis });
            }
        });
    });

    const cppTools = vscode.extensions.getExtension(CPPTOOLS_EXTENSION_ID);
    const cppToolsStatus = cppTools
        ? `${CPPTOOLS_EXTENSION_ID} ${cppTools.packageJSON?.version ?? ''}（${cppTools.isActive ? '有効' : '未起動'}）`
        : `${CPPTOOLS_EXTENSION_ID} は未インストール`;

    channel.clear();
    channel.appendLine(formatDiagnosisReport(entries, signals, {
        timestamp: new Date().toLocaleString('ja-JP'),
        filePath: document.uri.fsPath,
        functionName: result.functionName,
        cppToolsStatus
    }));
}

/**
 * 定義プロバイダの戻り値を、扱いやすい形へ変換します。
 *
 * プロバイダは `Location[]` と `LocationLink[]` のどちらでも返しうるため、双方に対応します。
 *
 * @param locations 定義プロバイダの戻り値
 * @returns 定義位置の候補（返却順を保つ）
 */
function toCandidates(
    locations: vscode.Location[] | vscode.LocationLink[] | undefined
): DefinitionCandidate[] {
    if (!locations || locations.length === 0) {
        return [];
    }

    return locations.map(item => {
        const link = item as vscode.LocationLink;
        const uri = link.targetUri || (item as vscode.Location).uri;
        // 名前そのものの範囲（targetSelectionRange）があればそちらを使う
        const range = link.targetSelectionRange
            || link.targetRange
            || (item as vscode.Location).range;
        return {
            filePath: uri.toString(),
            line: range.start.line,
            column: range.start.character
        };
    });
}

/**
 * 処理中であることを右下の通知に表示しながら、処理を実行します。
 *
 * 解析は同期処理を含むため、そのまま実行すると通知が描画される前に処理が始まって
 * しまいます。重い処理の前に一度制御を返すことで、通知を先に表示します。
 *
 * @param title 通知に表示する文言
 * @param work 実行する処理
 * @param errorMessage 例外が発生した場合に表示する文言
 */
async function runWithProgress(
    title: string,
    work: () => Promise<void> | void,
    errorMessage: string
): Promise<void> {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title },
        async () => {
            // 通知が描画されるよう、重い処理の前に一度制御を返す
            await new Promise(resolve => setTimeout(resolve, 0));
            try {
                await work();
            } catch (err) {
                vscode.window.showErrorMessage(errorMessage);
            }
        }
    );
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
