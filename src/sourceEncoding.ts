/**
 * ソースファイルの文字コードを判別してデコードする処理です。
 *
 * 日本語圏の組込みプロジェクトでは、ソースが Shift-JIS で保存されていることが
 * 珍しくありません。UTF-8 固定で読むとコメントの日本語が文字化けするため、
 * 内容から判別して切り替えます。
 *
 * ファイルシステムには触れず、バイト列と文字列の変換のみを行うため
 * ヘッドレス環境でテストできます。
 */

/** UTF-8 のバイト順マーク */
const BOM_UTF8 = [0xef, 0xbb, 0xbf];

/** UTF-16 リトルエンディアンのバイト順マーク */
const BOM_UTF16LE = [0xff, 0xfe];

/** UTF-16 ビッグエンディアンのバイト順マーク */
const BOM_UTF16BE = [0xfe, 0xff];

/** 判別できなかった場合に使う既定の文字コード */
export const DEFAULT_FALLBACK_ENCODING = 'shift_jis';

/**
 * バイト列が指定のバイト順マークで始まるかを判定します。
 *
 * @param buffer 判定対象のバイト列
 * @param bom バイト順マーク
 * @returns 一致すれば true
 */
function startsWithBom(buffer: Buffer, bom: number[]): boolean {
    if (buffer.length < bom.length) {
        return false;
    }
    return bom.every((byte, index) => buffer[index] === byte);
}

/**
 * バイト列を文字コードとして妥当な UTF-8 とみなせるか判定します。
 *
 * ASCII のみのファイルは UTF-8 としても妥当なため true になります。
 * Shift-JIS の日本語を含むバイト列は UTF-8 として不正になるため false になります。
 *
 * @param buffer 判定対象のバイト列
 * @returns UTF-8 として解釈できれば true
 */
function isValidUtf8(buffer: Buffer): boolean {
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        return true;
    } catch {
        return false;
    }
}

/**
 * 指定の文字コードでデコードします。対応していない場合は UTF-8 で代用します。
 *
 * @param buffer デコード対象のバイト列
 * @param encoding 文字コード名
 * @returns デコード結果
 */
function decodeWith(buffer: Buffer, encoding: string): string {
    try {
        return new TextDecoder(encoding).decode(buffer);
    } catch {
        // 実行環境が対応していない文字コード名を指定された場合の保険
        return buffer.toString('utf8');
    }
}

/**
 * ソースファイルのバイト列を、文字コードを判別してデコードします。
 *
 * 判別の順序は次のとおりです。
 *
 * 1. バイト順マーク（UTF-8 / UTF-16）があれば、それに従う
 * 2. UTF-8 として妥当ならば UTF-8（ASCII のみのファイルもここに該当する）
 * 3. いずれでもなければ、指定された文字コードで読む（既定は Shift-JIS）
 *
 * @param buffer ファイルのバイト列
 * @param fallbackEncoding UTF-8 として読めなかった場合に使う文字コード
 * @returns デコードした文字列（バイト順マークは取り除かれます）
 */
export function decodeSource(
    buffer: Buffer,
    fallbackEncoding: string = DEFAULT_FALLBACK_ENCODING
): string {
    if (startsWithBom(buffer, BOM_UTF8)) {
        return buffer.subarray(BOM_UTF8.length).toString('utf8');
    }
    if (startsWithBom(buffer, BOM_UTF16LE)) {
        return decodeWith(buffer.subarray(BOM_UTF16LE.length), 'utf-16le');
    }
    if (startsWithBom(buffer, BOM_UTF16BE)) {
        return decodeWith(buffer.subarray(BOM_UTF16BE.length), 'utf-16be');
    }

    if (isValidUtf8(buffer)) {
        return buffer.toString('utf8');
    }

    return decodeWith(buffer, fallbackEncoding || DEFAULT_FALLBACK_ENCODING);
}
