import { describe, expect, it } from "vitest";
import type { Approval } from "../src/index-page.js";
import type { Line, Page } from "../src/pdf-text.js";
import { extractQuantity, normalizeBrand, parseApprovalPdf } from "../src/parse-approval.js";

const approval: Approval = {
  id: "abc123",
  pdfUrl: "https://www.mof.go.jp/policy/tab_salt/topics/20260826_kouriteikahenkou.pdf",
  title: "製造たばこ小売定価(令和8年8月26日変更認可)",
  approvalDate: "2026-08-26",
  approvalDateWareki: "令和8年8月26日",
  approvalType: "変更認可",
  order: 0,
};

/** [x, 幅, 文字列] の並びから1行を組み立てる。 */
function line(y: number, cells: [number, number, string][]): Line {
  const built = cells.map(([x, width, text]) => ({ x, width, text }));
  return { y, cells: built, text: built.map((c) => c.text).join(" ") };
}

function page(lines: Line[]): Page {
  return { pageNumber: 1, width: 595, height: 842, mojibake: false, lines };
}

/**
 * 実際の 20260826_kouriteikahenkou.pdf の座標をなぞったもの。
 * ヘッダが2行にまたがり、価格・製造国・製品の区分が縦方向に結合されている。
 */
function realisticChangePage(): Page {
  return page([
    line(763.6, [[170, 90, "製造たばこの品目"], [389, 26, "製造国"], [425, 12, "現"], [461, 12, "変"]]),
    line(754.6, [
      [55, 63, "製造たばこの区分"], [206, 12, "名"], [238, 12, "称"],
      [336, 40, "製品の区分"], [389, 26, "（地）"], [425, 32, "小売定価"], [461, 32, "小売定価"],
      [502, 32, "年 月 日"],
    ]),
    line(744.8, [[171, 24, "･ｱｲｽ"], [335, 40, "F45 20ｽﾃｨｯｸ"]]),
    line(730.3, [[171, 30, "･ﾐｯｸｽ"], [348, 14, "5.4g"]]),
    line(711.6, [
      [55, 63, "加熱式たばこ"], [138, 24, "ﾐｯｸｽ"], [171, 48, "･ｱｲｽ･ﾌﾟﾗｽ"],
      [341, 34, "ﾊｰﾄﾞﾊﾟｯｸ"], [387, 28, "大韓民国"],
      [439, 18, "560円"], [475, 18, "590円"], [502, 24, "8.10.1"],
    ]),
  ]);
}

describe("parseApprovalPdf（変更認可・結合セルあり）", () => {
  it("結合された価格を各銘柄に割り当て、変更後の価格を小売定価として採る", () => {
    const { records } = parseApprovalPdf(approval, [realisticChangePage()]);

    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record.小売定価_円).toBe(590);
      expect(record.改定前定価_円).toBe(560);
      expect(record.区分).toBe("変更認可");
      expect(record.実施日).toBe("2026-10-01");
    }
  });

  it("ファミリー名（結合セル）を各行の銘柄に引き継ぐ", () => {
    const { records } = parseApprovalPdf(approval, [realisticChangePage()]);
    expect(records.map((r) => r.銘柄).sort()).toEqual(
      ["ﾐｯｸｽ ･ｱｲｽ", "ﾐｯｸｽ ･ｱｲｽ･ﾌﾟﾗｽ", "ﾐｯｸｽ ･ﾐｯｸｽ"].sort(),
    );
  });

  it("製造たばこの区分を銘柄に混ぜず、独立した列にする", () => {
    const { records } = parseApprovalPdf(approval, [realisticChangePage()]);
    for (const record of records) {
      expect(record.種別).toBe("加熱式たばこ");
      expect(record.銘柄).not.toContain("たばこ");
    }
  });

  it("ヘッダの断片（名・称など）を銘柄に混ぜない", () => {
    const { records } = parseApprovalPdf(approval, [realisticChangePage()]);
    for (const record of records) {
      expect(record.銘柄).not.toMatch(/[名称現行変更]/);
    }
  });

  it("価格が同じ行にあれば「高」、結合セルからの引き継ぎなら「中」", () => {
    const { records } = parseApprovalPdf(approval, [realisticChangePage()]);
    expect(records.find((r) => r.銘柄 === "ﾐｯｸｽ ･ｱｲｽ･ﾌﾟﾗｽ")?.抽出精度).toBe("高");
    expect(records.find((r) => r.銘柄 === "ﾐｯｸｽ ･ｱｲｽ")?.抽出精度).toBe("中");
  });

  it("製品の区分と原産国を取る", () => {
    const { records } = parseApprovalPdf(approval, [realisticChangePage()]);
    const record = records.find((r) => r.銘柄 === "ﾐｯｸｽ ･ｱｲｽ");
    expect(record?.製品の区分).toBe("F45 20ｽﾃｨｯｸ");
    expect(record?.原産国).toBe("大韓民国");
  });

  it("同じ内容なら同じIDになる（再実行で重複しない）", () => {
    const first = parseApprovalPdf(approval, [realisticChangePage()]);
    const second = parseApprovalPdf(approval, [realisticChangePage()]);
    expect(first.records.map((r) => r.id)).toEqual(second.records.map((r) => r.id));
  });
});

describe("parseApprovalPdf（認可・価格1列）", () => {
  const newApproval: Approval = { ...approval, approvalType: "認可", pdfUrl: "https://www.mof.go.jp/a.pdf" };

  /** 実際の 20260827_kouriteika.pdf をなぞったもの。価格の列が1つしかない。 */
  const single = page([
    line(780.6, [
      [44, 63, "製造たばこの区分"], [179, 90, "製造たばこの品目名"], [266, 12, "称"],
      [377, 40, "製品の区分"], [459, 50, "製造国（地）"], [519, 32, "小売定価"],
    ]),
    line(748.3, [[206, 70, "BASHKIR HONEY"]]),
    line(698.0, [[206, 30, "PLAY"], [517, 30, "7,900円"]]),
    line(544.9, [
      [58, 50, "パイプたばこ"], [136, 40, "DOGMA"], [206, 60, "PURE DOGMA"],
      [390, 34, "80.0g瓶"], [466, 20, "ﾛｼｱ"],
    ]),
  ]);

  it("価格が1列のときは改定前定価を空にする", () => {
    const { records } = parseApprovalPdf(newApproval, [single]);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record.改定前定価_円).toBeNull();
      expect(record.小売定価_円).toBe(7900);
      expect(record.区分).toBe("認可");
    }
  });

  it("内容量を製品の区分から取り出す", () => {
    const { records } = parseApprovalPdf(newApproval, [single]);
    const dogma = records.find((r) => r.銘柄.includes("PURE DOGMA"));
    expect(dogma?.内容量).toBe(80);
    expect(dogma?.単位).toBe("g");
  });
});

describe("parseApprovalPdf（異常系）", () => {
  it("価格が1つも無ければレコードを作らない", () => {
    const result = parseApprovalPdf(approval, [page([line(700, [[50, 40, "銘柄だけの行"]])])]);
    expect(result.records).toHaveLength(0);
  });

  it("テキストが無いPDFは要OCRとして報告する", () => {
    const result = parseApprovalPdf(approval, [page([])]);
    expect(result.records).toHaveLength(0);
    expect(result.needsOcr).toBe(true);
  });
});

describe("extractQuantity", () => {
  it("本数・重量・スティック数を読む", () => {
    expect(extractQuantity("90mm 1本")).toEqual({ value: 1, unit: "本" });
    expect(extractQuantity("80.0g瓶")).toEqual({ value: 80, unit: "g" });
    expect(extractQuantity("F45 20ｽﾃｨｯｸ")).toEqual({ value: 20, unit: "スティック" });
    expect(extractQuantity("ﾊｰﾄﾞﾊﾟｯｸ")).toEqual({ value: null, unit: "" });
  });
});

describe("normalizeBrand", () => {
  it("半角カナと全角カナを同じキーにする", () => {
    expect(normalizeBrand("ﾃﾘｱ ･ﾊﾟｰﾌﾟﾙ")).toBe("テリアパープル");
    expect(normalizeBrand("テリア・パープル")).toBe("テリアパープル");
  });

  it("全角英数を半角に寄せる", () => {
    expect(normalizeBrand("ＬＡＲＫ  ＭＩＬＤ")).toBe("LARKMILD");
  });
});
