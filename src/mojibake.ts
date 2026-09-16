/**
 * 埋め込みサブセットフォントの文字化けを復号する。
 *
 * 認可PDFの約半数は ToUnicode CMap を持たないサブセットフォントで作られており、
 * pdfjs はグリフ番号をそのまま文字コードとして返してしまう。
 * 結果、「1,900円」が "෇" のようになる。
 *
 * このフォント群はグリフ番号が連続して割り当てられているため、文字種ごとに
 * 一定のオフセットで元に戻せる（273件のPDFで検証済み）。
 *
 *   ASCII    : グリフ番号 + 0x1D   （GID 3 = 半角スペース）
 *   半角カナ : グリフ番号 + 0xC0E2
 *
 * 漢字・ひらがなはフォントごとに並び順が違うため、この方法では戻せない。
 * 銘柄・内容量・価格は ASCII と半角カナで書かれているので実害は小さいが、
 * 「製造たばこの区分」「製造国」など漢字の列は復元できない。
 * 復元できなかった文字は捨てず、そのまま残して呼び出し側が判断できるようにする。
 */

/** グリフ番号がそのまま出てきたと判断する文字コードの範囲。 */
const GLYPH_ASCII_MIN = 0x01;
const GLYPH_ASCII_MAX = 0x62; // 0x62 + 0x1D = 0x7F
const GLYPH_KANA_MIN = 0x3e7f; // 0x3e7f + 0xC0E2 = 0xFF61
const GLYPH_KANA_MAX = 0x3ebd; // 0x3ebd + 0xC0E2 = 0xFF9F

const ASCII_OFFSET = 0x1d;
const KANA_OFFSET = 0xc0e2;

/** この文書がグリフ番号の生出力になっているか。 */
export function looksMojibake(texts: string[]): boolean {
  let suspicious = 0;
  let total = 0;
  for (const text of texts) {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      total++;
      // 制御文字が本文に大量に出るのは、グリフ番号がそのまま出ている証拠
      if ((cp >= 0x01 && cp <= 0x1f && ch !== "\t" && ch !== "\n") || (cp >= GLYPH_KANA_MIN && cp <= GLYPH_KANA_MAX)) {
        suspicious++;
      }
    }
  }
  return total > 0 && suspicious / total > 0.1;
}

/** グリフ番号を文字に戻す。戻せない文字はそのまま返す。
 *
 * **文書全体が化けていると判定できた場合にのみ使うこと。**
 * 正常な文書に適用すると、半角スペース(0x20)が '=' になるなど、かえって壊す。
 * 通常は decodeIfMojibake を使い、この関数を直接呼ばない。
 */
export function decodeMojibake(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;

    if (cp >= GLYPH_ASCII_MIN && cp <= GLYPH_ASCII_MAX) {
      const decoded = cp + ASCII_OFFSET;
      if (decoded >= 0x20 && decoded <= 0x7e) {
        out += String.fromCodePoint(decoded);
        continue;
      }
    }

    if (cp >= GLYPH_KANA_MIN && cp <= GLYPH_KANA_MAX) {
      const decoded = cp + KANA_OFFSET;
      if (decoded >= 0xff61 && decoded <= 0xff9f) {
        out += String.fromCodePoint(decoded);
        continue;
      }
    }

    out += ch;
  }
  return out;
}

/**
 * 文書全体を見て、化けていれば復号する。化けていなければ何もしない。
 *
 * 判定は必ず文書単位で行う。化けた文書の中の "APPLE PUNCH" のような
 * 英字だけのセルは制御文字を含まないため、セル単位では化けと判定できない。
 */
export function decodeIfMojibake(texts: string[]): { mojibake: boolean; texts: string[] } {
  if (!looksMojibake(texts)) return { mojibake: false, texts };
  return { mojibake: true, texts: texts.map(decodeMojibake) };
}

/**
 * 復号できずに残った漢字・ひらがなを取り除く。
 *
 * 化けた文書では漢字が意味のない文字として残るので、銘柄などに混ぜない。
 * ただし「1,900円」の「円」のように、数字の直後に来る1文字は単位とみなして
 * 呼び出し側が扱えるよう、除去は呼び出し側の判断に任せる。
 */
export function stripUndecodable(text: string): string {
  return text
    .replace(/[฀-໿ᬀ-᯿ -⯿　-㏿㐀-鿿豈-﫿]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
