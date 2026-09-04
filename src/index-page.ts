import { createHash } from "node:crypto";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { normalizeSpace, parseJapaneseDate, toWareki } from "./wareki.js";

export type Approval = {
  /** 認可の安定ID（PDFのURLから導出） */
  id: string;
  /** PDFの絶対URL */
  pdfUrl: string;
  /** リンク文言（例: 令和8年7月30日認可） */
  title: string;
  /** 認可年月日（ISO）。判定できなければ null */
  approvalDate: string | null;
  approvalDateWareki: string;
  /** 認可 / 変更認可 / 不明 */
  approvalType: string;
  /** インデックス上の並び順（0が先頭＝通常は最新） */
  order: number;
};

/**
 * インデックスHTMLから認可PDFの一覧を抽出する。
 *
 * ページの組み方（table / ul / p）に依存しないよう、PDFへの <a> を全部拾い、
 * リンク文言と最も近いブロック要素のテキストから日付と区分を読み取る。
 */
export function extractApprovals(html: string, baseUrl: string): Approval[] {
  const root = parseHtml(html);
  const seen = new Set<string>();
  const approvals: Approval[] = [];

  for (const anchor of root.querySelectorAll("a[href]")) {
    const href = anchor.getAttribute("href");
    if (!href) continue;

    let absolute: string;
    try {
      absolute = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    if (!/\.pdf(?:$|[?#])/i.test(absolute)) continue;
    // 財務省ドメイン外のPDFは対象外（外部リンク混在への保険）
    if (!/^https:\/\/[^/]*mof\.go\.jp\//i.test(absolute)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    const linkText = normalizeSpace(anchor.textContent ?? "");
    const contextText = normalizeSpace(nearestBlockText(anchor));
    // リンク文言に日付が無い組み方（日付セル＋「PDF」リンク）にも対応させる
    const haystack = linkText.includes("年") ? `${linkText} ${contextText}` : `${contextText} ${linkText}`;

    const approvalDate = parseJapaneseDate(haystack);
    const title = linkText || contextText || absolute.split("/").pop() || absolute;

    approvals.push({
      id: approvalId(absolute),
      pdfUrl: absolute,
      title: stripFileSize(title),
      approvalDate,
      approvalDateWareki: approvalDate ? toWareki(approvalDate) : "",
      approvalType: detectApprovalType(haystack),
      order: approvals.length,
    });
  }

  return approvals;
}

/** 「変更認可」を「認可」より先に判定する。 */
export function detectApprovalType(text: string): string {
  if (/変更\s*認可/.test(text)) return "変更認可";
  if (/取消/.test(text)) return "取消";
  if (/認可/.test(text)) return "認可";
  return "不明";
}

/** 「（PDF:123KB）」のようなファイルサイズ表記を落とす。 */
export function stripFileSize(text: string): string {
  return normalizeSpace(
    text
      .replace(/[（(]\s*PDF\s*[:：]?[^）)]*[）)]/gi, "")
      .replace(/[（(]\s*[\d.,]+\s*[KMG]?B\s*[）)]/gi, ""),
  );
}

function approvalId(pdfUrl: string): string {
  return createHash("sha1").update(pdfUrl).digest("hex").slice(0, 12);
}

/** <a> から見て最も近い行・項目レベルのブロック要素のテキストを返す。 */
function nearestBlockText(anchor: HTMLElement): string {
  const blocks = new Set(["TR", "LI", "P", "DD", "DT", "TD", "DIV"]);
  let node: HTMLElement | null = anchor.parentNode as HTMLElement | null;
  let best = "";
  let hops = 0;

  while (node && hops < 6) {
    if (blocks.has(node.tagName ?? "")) {
      best = node.textContent ?? "";
      // tr / li まで上がれば十分。td だけだと日付セルを取り逃すので一段上も見る。
      if (node.tagName === "TR" || node.tagName === "LI") break;
    }
    node = node.parentNode as HTMLElement | null;
    hops++;
  }

  return best;
}
