import { describe, expect, it } from "vitest";
import { detectApprovalType, extractApprovals, stripFileSize } from "../src/index-page.js";
import { INDEX_URL } from "../src/config.js";

describe("extractApprovals", () => {
  it("リンク文言に日付がある構造（ul）から抽出する", () => {
    const html = `
      <html><body>
        <ul>
          <li><a href="/policy/tab_salt/topics/20260730.pdf">令和8年7月30日認可（PDF:120KB）</a></li>
          <li><a href="/policy/tab_salt/topics/20260728.pdf">令和8年7月28日変更認可（PDF:98KB）</a></li>
        </ul>
      </body></html>`;

    const approvals = extractApprovals(html, INDEX_URL);

    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatchObject({
      pdfUrl: "https://www.mof.go.jp/policy/tab_salt/topics/20260730.pdf",
      approvalDate: "2026-07-30",
      approvalDateWareki: "令和8年7月30日",
      approvalType: "認可",
      title: "令和8年7月30日認可",
      order: 0,
    });
    expect(approvals[1].approvalType).toBe("変更認可");
  });

  it("日付が別セルにあるテーブル構造からも抽出する", () => {
    const html = `
      <html><body>
        <table>
          <tr><th>認可年月日</th><th>資料</th></tr>
          <tr><td>令和8年6月25日</td><td><a href="./kouri/0625.pdf">認可分 (PDF:1,024KB)</a></td></tr>
        </table>
      </body></html>`;

    const approvals = extractApprovals(html, INDEX_URL);

    expect(approvals).toHaveLength(1);
    expect(approvals[0].approvalDate).toBe("2026-06-25");
    expect(approvals[0].pdfUrl).toBe("https://www.mof.go.jp/policy/tab_salt/topics/kouri/0625.pdf");
  });

  it("PDF以外・外部ドメイン・重複を除外する", () => {
    const html = `
      <html><body>
        <a href="/policy/index.html">たばこ事業</a>
        <a href="https://example.com/other.pdf">外部PDF</a>
        <a href="/a.pdf">令和8年5月1日認可</a>
        <a href="/a.pdf">令和8年5月1日認可（再掲）</a>
      </body></html>`;

    const approvals = extractApprovals(html, INDEX_URL);

    expect(approvals.map((a) => a.pdfUrl)).toEqual(["https://www.mof.go.jp/a.pdf"]);
  });

  it("安定IDはURLから決まる", () => {
    const html = `<a href="/x.pdf">令和8年1月1日認可</a>`;
    const first = extractApprovals(html, INDEX_URL);
    const second = extractApprovals(`${html}<a href="/y.pdf">令和8年1月2日認可</a>`, INDEX_URL);
    expect(first[0].id).toBe(second[0].id);
    expect(second[0].id).not.toBe(second[1].id);
  });
});

describe("detectApprovalType", () => {
  it("変更認可を認可より優先する", () => {
    expect(detectApprovalType("令和8年7月28日変更認可")).toBe("変更認可");
    expect(detectApprovalType("令和8年7月28日認可")).toBe("認可");
    expect(detectApprovalType("参考資料")).toBe("不明");
  });
});

describe("stripFileSize", () => {
  it("PDFサイズ表記を落とす", () => {
    expect(stripFileSize("令和8年7月30日認可（PDF:120KB）")).toBe("令和8年7月30日認可");
    expect(stripFileSize("認可分 (PDF:1,024KB)")).toBe("認可分");
  });
});
