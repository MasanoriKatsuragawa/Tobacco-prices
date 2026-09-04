import { describe, expect, it } from "vitest";
import { CSV_COLUMNS, datasetHash, mergeRecords, sortRecords, toCsv } from "../src/dataset.js";
import type { PriceRecord } from "../src/parse-approval.js";

function record(overrides: Partial<PriceRecord> = {}): PriceRecord {
  return {
    id: "r1",
    認可年月日: "2026-07-30",
    認可年月日_和暦: "令和8年7月30日",
    区分: "認可",
    銘柄: "メビウス",
    銘柄_正規化: "メビウス",
    内容量: 20,
    単位: "本",
    小売定価_円: 600,
    改定前定価_円: null,
    実施日: "2026-08-01",
    製造者_輸入者: "日本たばこ産業株式会社",
    備考: "",
    出典PDF: "https://www.mof.go.jp/a.pdf",
    出典ページ: 1,
    抽出精度: "高",
    原文: "メビウス 20本 600",
    ...overrides,
  };
}

describe("toCsv", () => {
  it("ヘッダとBOMを付ける", () => {
    const csv = toCsv([record()]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv.split("\n")[0]).toBe(`﻿${CSV_COLUMNS.join(",")}`);
  });

  it("null は空欄になる", () => {
    const csv = toCsv([record({ 改定前定価_円: null, 内容量: null })]);
    expect(csv).toContain(",,");
  });

  it("カンマ・引用符・改行を含む値を引用符で囲む", () => {
    const csv = toCsv([record({ 備考: 'A,B "C"\n D' })]);
    expect(csv).toContain('"A,B ""C""\n D"');
  });

  it("原文はCSVに含めない（列定義どおり）", () => {
    expect(CSV_COLUMNS).not.toContain("原文");
  });
});

describe("mergeRecords", () => {
  it("同じIDは新しい方で置き換える", () => {
    const merged = mergeRecords(
      [record({ id: "a", 小売定価_円: 500 })],
      [record({ id: "a", 小売定価_円: 600 })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].小売定価_円).toBe(600);
  });

  it("新しいIDは追加される", () => {
    const merged = mergeRecords([record({ id: "a" })], [record({ id: "b" })]);
    expect(merged.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("sortRecords", () => {
  it("認可年月日の新しい順に並ぶ", () => {
    const sorted = sortRecords([
      record({ id: "old", 認可年月日: "2025-01-01" }),
      record({ id: "new", 認可年月日: "2026-07-30" }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["new", "old"]);
  });

  it("並び順は安定していて、入力順に依存しない", () => {
    const a = record({ id: "a", 銘柄: "あ" });
    const b = record({ id: "b", 銘柄: "い" });
    expect(sortRecords([a, b]).map((r) => r.id)).toEqual(sortRecords([b, a]).map((r) => r.id));
  });
});

describe("datasetHash", () => {
  it("内容が同じならハッシュも同じ", () => {
    expect(datasetHash([record()])).toBe(datasetHash([record()]));
  });

  it("内容が変わればハッシュも変わる", () => {
    expect(datasetHash([record()])).not.toBe(datasetHash([record({ 小売定価_円: 700 })]));
  });

  it("CSVに出ない列（原文）の違いは無視される", () => {
    expect(datasetHash([record()])).toBe(datasetHash([record({ 原文: "違う原文" })]));
  });
});
