import { describe, expect, it } from "vitest";
import type { Approval } from "../src/index-page.js";
import type { Line, Page } from "../src/pdf-text.js";
import { extractQuantity, normalizeBrand, parseApprovalPdf } from "../src/parse-approval.js";

const approval: Approval = {
  id: "abc123",
  pdfUrl: "https://www.mof.go.jp/policy/tab_salt/topics/20260730.pdf",
  title: "令和8年7月30日認可",
  approvalDate: "2026-07-30",
  approvalDateWareki: "令和8年7月30日",
  approvalType: "認可",
  order: 0,
};

/** [x, 幅, 文字列] の並びから1行を組み立てる。 */
function line(y: number, cells: [number, number, string][]): Line {
  const built = cells.map(([x, width, text]) => ({ x, width, text }));
  return {
    y,
    cells: built,
    text: built.map((c) => c.text).join(" "),
  };
}

function page(lines: Line[]): Page {
  return { pageNumber: 1, width: 595, height: 842, lines };
}

describe("parseApprovalPdf", () => {
  it("ヘッダから列を検出して表を読む", () => {
    const result = parseApprovalPdf(approval, [
      page([
        line(700, [[50, 40, "銘柄"], [200, 40, "内容量"], [300, 50, "小売定価"], [420, 40, "実施日"]]),
        line(680, [[50, 60, "メビウス"], [200, 30, "20本"], [300, 25, "600"], [420, 70, "令和8年8月1日"]]),
        line(660, [[50, 90, "セブンスター"], [200, 30, "20本"], [300, 25, "660"], [420, 70, "令和8年8月1日"]]),
      ]),
    ]);

    expect(result.needsOcr).toBe(false);
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      認可年月日: "2026-07-30",
      認可年月日_和暦: "令和8年7月30日",
      区分: "認可",
      銘柄: "メビウス",
      内容量: 20,
      単位: "本",
      小売定価_円: 600,
      実施日: "2026-08-01",
      出典PDF: approval.pdfUrl,
      出典ページ: 1,
      抽出精度: "高",
    });
    expect(result.records[1].小売定価_円).toBe(660);
  });

  it("現行・改定後の2列を区別する", () => {
    const result = parseApprovalPdf({ ...approval, approvalType: "変更認可" }, [
      page([
        line(700, [[50, 40, "銘柄"], [220, 60, "現行定価"], [340, 70, "改定後定価"]]),
        line(680, [[50, 60, "メビウス"], [220, 30, "580"], [340, 30, "600"]]),
      ]),
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      区分: "変更認可",
      改定前定価_円: 580,
      小売定価_円: 600,
    });
  });

  it("会社名だけの行を以降の製造者として引き継ぐ", () => {
    const result = parseApprovalPdf(approval, [
      page([
        line(700, [[50, 40, "銘柄"], [300, 50, "小売定価"]]),
        line(690, [[50, 160, "日本たばこ産業株式会社"]]),
        line(680, [[50, 60, "メビウス"], [300, 25, "600"]]),
      ]),
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.records[0].製造者_輸入者).toBe("日本たばこ産業株式会社");
  });

  it("文書全体の実施日を各行に反映する", () => {
    const result = parseApprovalPdf(approval, [
      page([
        line(720, [[50, 200, "実施日 令和8年9月1日"]]),
        line(700, [[50, 40, "銘柄"], [300, 50, "小売定価"]]),
        line(680, [[50, 60, "メビウス"], [300, 25, "600"]]),
      ]),
    ]);

    expect(result.records[0].実施日).toBe("2026-09-01");
  });

  it("ヘッダが見つからなくても1行から推定する", () => {
    const result = parseApprovalPdf(approval, [
      page([line(680, [[50, 300, "メビウス 20本 600円 令和8年8月1日"]])]),
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      銘柄: "メビウス",
      内容量: 20,
      小売定価_円: 600,
      実施日: "2026-08-01",
      抽出精度: "中",
    });
  });

  it("価格として不自然な値は採用しない", () => {
    const result = parseApprovalPdf(approval, [
      page([
        line(700, [[50, 40, "銘柄"], [300, 50, "小売定価"]]),
        line(680, [[50, 60, "メビウス"], [300, 25, "3"]]),
      ]),
    ]);

    expect(result.records).toHaveLength(0);
    expect(result.unparsed).toHaveLength(1);
  });

  it("テキストが取れないPDFは要OCRとして報告する", () => {
    const result = parseApprovalPdf(approval, [page([])]);

    expect(result.records).toHaveLength(0);
    expect(result.needsOcr).toBe(true);
  });

  it("同じ内容なら同じIDになる（再実行で重複しない）", () => {
    const pages = [
      page([
        line(700, [[50, 40, "銘柄"], [300, 50, "小売定価"]]),
        line(680, [[50, 60, "メビウス"], [300, 25, "600"]]),
      ]),
    ];
    const first = parseApprovalPdf(approval, pages);
    const second = parseApprovalPdf(approval, pages);
    expect(first.records[0].id).toBe(second.records[0].id);
  });
});

describe("extractQuantity", () => {
  it("本数・重量・個数を読む", () => {
    expect(extractQuantity("20本")).toEqual({ value: 20, unit: "本" });
    expect(extractQuantity("１０本入")).toEqual({ value: 10, unit: "本" });
    expect(extractQuantity("50g")).toEqual({ value: 50, unit: "g" });
    expect(extractQuantity("30グラム")).toEqual({ value: 30, unit: "g" });
    expect(extractQuantity("メビウス")).toEqual({ value: null, unit: "" });
  });
});

describe("normalizeBrand", () => {
  it("表記ゆれを吸収する", () => {
    expect(normalizeBrand("メビウス・ワン")).toBe("メビウスワン");
    expect(normalizeBrand("ＬＡＲＫ  ＭＩＬＤ")).toBe("LARKMILD");
  });
});
