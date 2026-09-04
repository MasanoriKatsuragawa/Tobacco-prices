import { describe, expect, it } from "vitest";
import { groupIntoLines, looksLikeScannedPdf } from "../src/pdf-text.js";

const cell = (x: number, y: number, width: number, text: string) => ({
  x,
  y,
  width,
  height: 10,
  text,
});

describe("groupIntoLines", () => {
  it("y座標が近い断片を1行にまとめ、x順に並べる", () => {
    const lines = groupIntoLines([
      cell(300, 680, 25, "600"),
      cell(50, 680.5, 60, "メビウス"),
      cell(50, 660, 90, "セブンスター"),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0].cells.map((c) => c.text)).toEqual(["メビウス", "600"]);
    expect(lines[1].cells.map((c) => c.text)).toEqual(["セブンスター"]);
  });

  it("上の行から順に返す", () => {
    const lines = groupIntoLines([cell(50, 100, 20, "下"), cell(50, 700, 20, "上")]);
    expect(lines.map((l) => l.text)).toEqual(["上", "下"]);
  });

  it("隣接して間隔の狭い断片は1セルに結合する", () => {
    const lines = groupIntoLines([
      cell(50, 680, 10, "メ"),
      cell(60, 680, 10, "ビ"),
      cell(70, 680, 10, "ウス"),
      cell(300, 680, 25, "600"),
    ]);

    expect(lines[0].cells.map((c) => c.text)).toEqual(["メビウス", "600"]);
  });

  it("空入力を扱える", () => {
    expect(groupIntoLines([])).toEqual([]);
  });
});

describe("looksLikeScannedPdf", () => {
  it("テキストがほぼ無いページを画像PDFとみなす", () => {
    expect(looksLikeScannedPdf([{ pageNumber: 1, width: 595, height: 842, lines: [] }])).toBe(true);
  });

  it("十分なテキストがあれば false", () => {
    const lines = Array.from({ length: 10 }, (_, i) => ({
      y: 700 - i * 20,
      cells: [],
      text: "メビウス 20本 600円 令和8年8月1日",
    }));
    expect(looksLikeScannedPdf([{ pageNumber: 1, width: 595, height: 842, lines }])).toBe(false);
  });
});
