/**
 * テスト用のパーサー初期化・解析ヘルパーです。
 *
 * analyzer.ts は VS Code API に依存しないため、WASM パーサーを Node 上で
 * 直接初期化することでヘッドレス（VS Code なし）でのテストが可能です。
 */
import * as path from 'path';
import Parser = require('web-tree-sitter');
import { analyzeCFunction, AnalysisResult, VariableInfo } from '../../src/analyzer';
import { parseWithModifierMacroRepair } from '../../src/macroRepair';

/** 初期化済みパーサーのキャッシュ（初期化コストが高いため再利用する） */
let cachedParser: Parser | null = null;

/**
 * web-tree-sitter を初期化し、C言語パーサーを取得します。
 * 2回目以降の呼び出しではキャッシュ済みのインスタンスを返します。
 *
 * @returns C言語が設定済みの Parser インスタンス
 * @throws WASM ファイルが見つからない場合、または初期化に失敗した場合
 */
export async function getParser(): Promise<Parser> {
    if (cachedParser) {
        return cachedParser;
    }

    // node_modules 内の WASM を require.resolve 経由で解決する（dist/ のビルド結果に依存しない）
    const treeSitterDir = path.dirname(require.resolve('web-tree-sitter'));
    const wasmsDir = path.dirname(require.resolve('tree-sitter-wasms/package.json'));

    try {
        await Parser.init({
            locateFile: (scriptName: string) => path.join(treeSitterDir, scriptName)
        });
    } catch (err) {
        throw new Error(`web-tree-sitter の初期化に失敗しました: ${err}`);
    }

    const parser = new Parser();
    try {
        const cWasmPath = path.join(wasmsDir, 'out', 'tree-sitter-c.wasm');
        const cLang = await Parser.Language.load(cWasmPath);
        parser.setLanguage(cLang);
    } catch (err) {
        throw new Error(`C言語パーサー (WASM) のロードに失敗しました: ${err}`);
    }

    cachedParser = parser;
    return parser;
}

/**
 * Cソースコードを解析し、指定シグネチャの関数の解析結果を返します。
 *
 * @param source 解析対象のCソースコード
 * @param signatureHint 解析対象関数のシグネチャ行を特定するための部分文字列（例: `int process(`）
 * @param classifyAllUppercaseAsMacros 大文字識別子をマクロとして分類するか
 * @returns 解析結果、またはカーソル位置が関数シグネチャ行でない場合は null
 * @throws signatureHint に一致する行が存在しない場合
 */
export async function analyze(
    source: string,
    signatureHint: string,
    classifyAllUppercaseAsMacros: boolean = true
): Promise<AnalysisResult | null> {
    const parser = await getParser();

    const cursorLine = source.split('\n').findIndex(line => line.includes(signatureHint));
    if (cursorLine < 0) {
        throw new Error(`シグネチャ "${signatureHint}" を含む行がソース内に見つかりません。`);
    }

    // 本番（extension.ts）と同じ経路にするため、修飾子マクロの修復を通す
    const tree = parseWithModifierMacroRepair(parser, source);
    return analyzeCFunction(tree, cursorLine, classifyAllUppercaseAsMacros);
}

/**
 * 解析結果を取得します。null の場合はテストを失敗させるため例外を投げます。
 *
 * @param source 解析対象のCソースコード
 * @param signatureHint 解析対象関数のシグネチャ行を特定するための部分文字列
 * @param classifyAllUppercaseAsMacros 大文字識別子をマクロとして分類するか
 * @returns 解析結果（null 以外であることが保証される）
 * @throws 解析結果が null だった場合
 */
export async function analyzeOrThrow(
    source: string,
    signatureHint: string,
    classifyAllUppercaseAsMacros: boolean = true
): Promise<AnalysisResult> {
    const result = await analyze(source, signatureHint, classifyAllUppercaseAsMacros);
    if (!result) {
        throw new Error(`解析結果が null でした（シグネチャ: "${signatureHint}"）。`);
    }
    return result;
}

/**
 * 変数情報・関数情報リストから名前のみを配列として取り出します。
 *
 * @param items 名前を持つ要素のリスト（VariableInfo / FunctionInfo）
 * @returns 名前の配列
 */
export function names(items: { name: string }[]): string[] {
    return items.map(v => v.name);
}

/**
 * 変数情報リストから指定名の要素を検索します。
 *
 * @param vars 変数情報リスト
 * @param name 検索する変数名（アクセスパス）
 * @returns 一致した変数情報、見つからない場合は undefined
 */
export function findVar(vars: VariableInfo[], name: string): VariableInfo | undefined {
    return vars.find(v => v.name === name);
}
