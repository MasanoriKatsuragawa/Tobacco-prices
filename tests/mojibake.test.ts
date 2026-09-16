import { describe, expect, it } from "vitest";
import { decodeIfMojibake, decodeMojibake, looksMojibake } from "../src/mojibake.js";

/**
 * 実際の認可PDF（20260626_kouriteikahenkou.pdf など）から取り出した生の文字列。
 * pdfjs が ToUnicode を持たないサブセットフォントのグリフ番号をそのまま返した状態。
 */
const REAL_GARBLED = {
  price1900: "෇",
  price2500: "෇",
  size90mm: "PPᮏ",
  brandMediaCorona: "㺰㺡㺼㺆㺏㺃㺘㺹㺣",
};

describe("looksMojibake", () => {
  it("グリフ番号がそのまま出ている文書を検出する", () => {
    expect(looksMojibake(Object.values(REAL_GARBLED))).toBe(true);
  });

  it("正常に読めている文書は検出しない", () => {
    expect(looksMojibake(["ﾃﾘｱ ･ﾊﾟｰﾌﾟﾙ ｲﾀﾘｱ", "620円", "640円", "製造たばこの区分"])).toBe(false);
  });

  it("空入力では false", () => {
    expect(looksMojibake([])).toBe(false);
  });
});

describe("decodeMojibake", () => {
  it("価格を復元する（ASCIIは +0x1D）", () => {
    expect(decodeMojibake(REAL_GARBLED.price1900).trim()).toBe("1,900෇");
    expect(decodeMojibake(REAL_GARBLED.price2500).trim()).toBe("2,500෇");
  });

  it("内容量を復元する", () => {
    // 「90mm 1本」。漢字の「本」はフォント依存なので戻らず残る。
    expect(decodeMojibake(REAL_GARBLED.size90mm)).toBe("90mm 1ᮏ");
  });

  it("半角カナの銘柄を復元する（+0xC0E2）", () => {
    expect(decodeMojibake(REAL_GARBLED.brandMediaCorona).trim()).toBe("ﾒﾃﾞｨｱ･ｺﾛﾅ");
  });

  it("化けていない文書に使うと壊す（だから文書単位で判定する）", () => {
    // 半角スペース(0x20)はグリフ番号としても妥当な値なので '=' に化ける。
    // decodeMojibake を直接呼ばず decodeIfMojibake を使うべき理由。
    expect(decodeMojibake("ﾃﾘｱ ･ﾊﾟｰﾌﾟﾙ")).not.toBe("ﾃﾘｱ ･ﾊﾟｰﾌﾟﾙ");
  });

  it("復元できない漢字はそのまま残す（勝手に捨てない）", () => {
    const decoded = decodeMojibake("෇");
    expect(decoded).toBe("෇");
  });
});

describe("decodeIfMojibake", () => {
  it("化けた文書だけを復号する", () => {
    const result = decodeIfMojibake(Object.values(REAL_GARBLED));
    expect(result.mojibake).toBe(true);
    expect(result.texts[0].trim()).toBe("1,900\u0dc7");
    expect(result.texts[3].trim()).toBe("ﾒﾃﾞｨｱ･ｺﾛﾅ");
  });

  it("正常な文書には手を触れない", () => {
    const clean = ["ﾃﾘｱ ･ﾊﾟｰﾌﾟﾙ ｲﾀﾘｱ", "620円", "640円", "製造たばこの区分"];
    const result = decodeIfMojibake(clean);
    expect(result.mojibake).toBe(false);
    expect(result.texts).toEqual(clean);
  });
});
