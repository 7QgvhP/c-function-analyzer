/**
 * Webview 上の項目クリック時に、エディタ上の該当箇所を検索するための処理群です。
 *
 * VS Code API に依存しない純粋な文字列処理のみを配置しており、
 * ヘッドレス環境（Node 単体）でテスト可能な状態を保っています。
 */

/**
 * 添字部分を一時的に置き換えるためのマーカーです。
 * Cソースコードには現れない制御文字を使用します。
 */
const SUBSCRIPT_MARKER = '\u0000';

/**
 * 項目名から、エディタ上の該当箇所を検索する正規表現を生成します。
 *
 * 項目名に含まれる添字は、中身によらず一律でコード上の実際の添字
 * （`[0]`、`[i]`、`[idx + 1]` など）にマッチするパターンへ変換します。
 * 表示上の添字は正規化された `[]` の場合と、宣言された次元（`[N]`、`[3][4]` など）を
 * 反映した場合があり、いずれも同じ検索結果になる必要があるためです。
 *
 * @param name 項目名（例: `hoge`、`hoge[]`、`hoge[N]`、`hogestruct[5].a`、`ptr->member`）
 * @returns グローバルフラグ付きの検索用正規表現
 */
export function buildHighlightRegex(name: string): RegExp {
    // 添字（角括弧とその中身）を先にマーカーへ退避する。
    // エスケープ後に置換すると、中身に含まれるメタ文字の扱いが煩雑になるため。
    const masked = name.replace(/\[[^\]]*\]/g, SUBSCRIPT_MARKER);

    // 正規表現のメタ文字をエスケープし、識別子として厳密に一致させる
    const escaped = masked.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

    // 退避した添字を「任意の添字にマッチするパターン」へ戻す
    const pattern = escaped.split(SUBSCRIPT_MARKER).join('\\[[^\\]]+\\]');

    // 末尾が添字の閉じ括弧 ']' の場合、直後に続くのは空白や ';', '=' などの非単語文字であることが多く、
    // \b（単語境界）は非単語文字同士の間では成立しないため末尾の \b を付けない（']' 自体が区切りとして機能する）
    const endsWithSubscript = pattern.endsWith('\\]');

    return new RegExp(`\\b${pattern}${endsWithSubscript ? '' : '\\b'}`, 'g');
}
