import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Approval } from "../src/index-page.js";
import { parseApprovalPdf } from "../src/parse-approval.js";
import { extractPages, looksLikeScannedPdf } from "../src/pdf-text.js";
import { toCsv } from "../src/dataset.js";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sample-approval.pdf",
);

const approval: Approval = {
  id: "fixture",
  pdfUrl: "https://www.mof.go.jp/policy/tab_salt/topics/sample.pdf",
  title: "令和8年7月30日認可",
  approvalDate: "2026-07-30",
  approvalDateWareki: "令和8年7月30日",
  approvalType: "認可",
  order: 0,
};

/**
 * 実PDF（日本語CIDフォント）を読み込む通しテスト。
 * CMap の設定が壊れると日本語が1文字も取れなくなるので、ここで検知する。
 */
describe("PDF一件の通し処理", () => {
  it("日本語の表組みPDFから定価レコードを取り出す", async () => {
    const pages = await extractPages(await fs.readFile(fixture));

    expect(pages).toHaveLength(1);
    expect(looksLikeScannedPdf(pages)).toBe(false);
    expect(pages[0].lines.map((l) => l.text)).toContain("銘柄 内容量 小売定価 実施日");

    const result = parseApprovalPdf(approval, pages);

    expect(result.needsOcr).toBe(false);
    // PDF上の並び順のまま返る（並べ替えは dataset.sortRecords の担当）
    expect(result.records.map((r) => r.銘柄)).toEqual([
      "メビウス",
      "メビウス・ワン",
      "セブンスター",
      "わかば",
    ]);

    const mevius = result.records.find((r) => r.銘柄 === "メビウス");
    expect(mevius).toMatchObject({
      認可年月日: "2026-07-30",
      区分: "認可",
      内容量: 20,
      単位: "本",
      小売定価_円: 600,
      実施日: "2026-08-01",
      製造者_輸入者: "日本たばこ産業株式会社",
      出典ページ: 1,
      抽出精度: "高",
    });

    // 注記や見出しを定価レコードとして拾っていないこと
    expect(result.records.map((r) => r.銘柄)).not.toContain("（注）上記は認可された小売定価である。");
  });

  it("CSVに出力できる", async () => {
    const pages = await extractPages(await fs.readFile(fixture));
    const { records } = parseApprovalPdf(approval, pages);
    const csv = toCsv(records);

    expect(csv.split("\n")).toHaveLength(records.length + 2); // ヘッダ + 末尾改行
    expect(csv).toContain("メビウス・ワン");
    expect(csv).toContain("https://www.mof.go.jp/policy/tab_salt/topics/sample.pdf");
  });
});
