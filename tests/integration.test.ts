import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toCsv } from "../src/dataset.js";
import type { Approval } from "../src/index-page.js";
import { parseApprovalPdf } from "../src/parse-approval.js";
import { extractPages, looksLikeScannedPdf } from "../src/pdf-text.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-approval.pdf");

const approval: Approval = {
  id: "fixture",
  pdfUrl: "https://www.mof.go.jp/policy/tab_salt/topics/sample.pdf",
  title: "製造たばこ小売定価(令和8年8月26日変更認可)",
  approvalDate: "2026-08-26",
  approvalDateWareki: "令和8年8月26日",
  approvalType: "変更認可",
  order: 0,
};

/**
 * 実PDF（日本語CIDフォント）を読み込む通しテスト。
 *
 * ふたつの回帰を同時に見張っている:
 *  - CMap の設定が壊れると日本語が1文字も取れなくなる
 *  - 結合セルの割り当てが壊れると、価格や銘柄が行に行き渡らなくなる
 */
describe("PDF一件の通し処理", () => {
  it("結合セルを含む表から、全銘柄に価格を行き渡らせる", async () => {
    const pages = await extractPages(await fs.readFile(fixture));

    expect(pages).toHaveLength(1);
    expect(pages[0].mojibake).toBe(false);
    expect(looksLikeScannedPdf(pages)).toBe(false);

    const { records } = parseApprovalPdf(approval, pages);

    // 派生名は4つ。結合セルの価格が全てに行き渡る。
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.銘柄).sort()).toEqual(
      ["ﾐｯｸｽ ･ｱｲｽ", "ﾐｯｸｽ ･ｱｲｽ･ﾌﾟﾗｽ", "ﾐｯｸｽ ･ﾍﾞﾙﾍﾞｯﾄ", "ﾐｯｸｽ ･ﾐｯｸｽ"].sort(),
    );

    for (const record of records) {
      expect(record.小売定価_円).toBe(590);
      expect(record.改定前定価_円).toBe(560);
      expect(record.種別).toBe("加熱式たばこ");
      expect(record.製品の区分).toBe("F45 20ｽﾃｨｯｸ");
      expect(record.原産国).toBe("大韓民国");
      expect(record.実施日).toBe("2026-10-01");
      expect(record.内容量).toBe(20);
      expect(record.単位).toBe("スティック");
      expect(record.認可年月日).toBe("2026-08-26");
      expect(record.区分).toBe("変更認可");
    }
  });

  it("ヘッダや区分を銘柄に取り込まない", async () => {
    const pages = await extractPages(await fs.readFile(fixture));
    const { records } = parseApprovalPdf(approval, pages);
    for (const record of records) {
      expect(record.銘柄).not.toMatch(/(製造|区分|名|称|小売定価|たばこ)/);
    }
  });

  it("CSVに出力できる", async () => {
    const pages = await extractPages(await fs.readFile(fixture));
    const { records } = parseApprovalPdf(approval, pages);
    const csv = toCsv(records);

    expect(csv.split("\n")).toHaveLength(records.length + 2); // ヘッダ + 末尾改行
    expect(csv).toContain("ﾐｯｸｽ ･ｱｲｽ･ﾌﾟﾗｽ");
    expect(csv).toContain("https://www.mof.go.jp/policy/tab_salt/topics/sample.pdf");
  });
});
