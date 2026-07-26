/**
 * Webview 上の項目クリック時に、エディタ上の該当箇所を検索するための処理群です。
 *
 * VS Code API に依存しない純粋な文字列処理のみを配置しており、
 * ヘッドレス環境（Node 単体）でテスト可能な状態を保っています。
 */

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
