/**
 * Webview 上の項目クリック時に、エディタ上の該当箇所を検索するための処理群です。
 *
 * VS Code API に依存しない純粋な文字列処理のみを配置しており、
 * ヘッドレス環境（Node 単体）でテスト可能な状態を保っています。
 */

/**
 * 解析結果のうち、エディタ上に実体を持たないダミー項目の表示名です。
 * （analyzer.ts 側でも同一の文字列を生成しているため、将来的に定数を共有化する余地があります）
 */
export const RETURN_VALUE_LABEL = '戻り値 (return)';

/**
 * 指定された項目名がエディタ上でハイライト検索の対象になるか判定します。
 *
 * @param name Webview 上に表示されている項目名
 * @returns ハイライト検索を行う場合は true
 */
export function isHighlightableName(name: string): boolean {
    // 「戻り値 (return)」はエディタ上に対応する識別子が存在しないため対象外とする
    if (name === RETURN_VALUE_LABEL) {
        return false;
    }
    // 「(推定)」を含む項目も対象外とする
    // 注: 「推定」は型名（global (推定) 等）側に付与される文字列であり、
    //     項目名には現れないため、この条件は現状では成立しない（要改善）
    if (name.includes('推定')) {
        return false;
    }
    return true;
}

/**
 * 項目名から、エディタ上の該当箇所を検索する正規表現を生成します。
 *
 * アクセスパス中の `[]`（添字を正規化した表記）は、コード上の実際の添字
 * （`[0]`、`[i]`、`[idx + 1]` など）にマッチするパターンへ変換します。
 *
 * @param name 項目名（例: `hoge`、`hoge[]`、`hogestruct[].a`、`ptr->member`）
 * @returns グローバルフラグ付きの検索用正規表現
 */
export function buildHighlightRegex(name: string): RegExp {
    // 正規表現のメタ文字をエスケープし、識別子として厳密に一致させる
    let pattern = name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    // '[]' の箇所はコード上の実際の添字 '[0]' や '[i]' などにマッチするパターンに変換
    pattern = pattern.replace(/\\\[\\\]/g, '\\[[^\\]]+\\]');

    // 末尾が添字の閉じ括弧 ']' の場合、直後に続くのは空白や ';', '=' などの非単語文字であることが多く、
    // \b（単語境界）は非単語文字同士の間では成立しないため末尾の \b を付けない（']' 自体が区切りとして機能する）
    const endsWithSubscript = pattern.endsWith('\\]');

    return new RegExp(`\\b${pattern}${endsWithSubscript ? '' : '\\b'}`, 'g');
}
