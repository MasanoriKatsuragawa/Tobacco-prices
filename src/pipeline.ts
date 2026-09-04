import fs from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, CRAWL, INDEX_URL, PATHS } from "./config.js";
import {
  datasetHash,
  loadState,
  mergeRecords,
  readJson,
  saveState,
  sha256,
  sortRecords,
  writeDataset,
  type State,
} from "./dataset.js";
import { decodeHtml, fetchUrl } from "./http.js";
import { extractApprovals, type Approval } from "./index-page.js";
import { parseApprovalPdf, type PriceRecord } from "./parse-approval.js";
import { extractPages, looksLikeScannedPdf } from "./pdf-text.js";
import { nowJst } from "./wareki.js";

export type UpdateOptions = {
  /** 既知のPDFも含めて全件を取り直して再解析する */
  full?: boolean;
  /** 1回の実行で新規に取得するPDFの上限 */
  limit?: number;
};

export type UpdateSummary = {
  approvals: number;
  newPdfs: number;
  parsedPdfs: number;
  needsOcr: string[];
  failed: { url: string; error: string }[];
  totalRecords: number;
  newRecords: number;
  unparsedLines: number;
  datasetHash: string;
  changed: boolean;
};

/** インデックスページを取得して認可PDFの一覧を返す。 */
export async function crawlIndex(state: State): Promise<{ approvals: Approval[]; state: State }> {
  const result = await fetchUrl(INDEX_URL, state.index);

  if (result.notModified) {
    const cached = await readJson<Approval[]>(PATHS.approvals, []);
    if (cached.length > 0) {
      console.log("インデックス: 更新なし（304）");
      return { approvals: cached, state };
    }
  }

  const html = decodeHtml(result.body, result.contentType);
  const approvals = extractApprovals(html, INDEX_URL);
  console.log(`インデックス: ${approvals.length} 件の認可PDFを検出`);

  if (approvals.length === 0) {
    throw new Error(
      "インデックスページからPDFリンクを1件も抽出できませんでした。ページ構造が変わった可能性があります。",
    );
  }

  return { approvals, state: { ...state, index: result.meta } };
}

/** 未取得・更新されたPDFだけをダウンロードしてキャッシュに置く。 */
async function fetchPdf(
  approval: Approval,
  state: State,
  force: boolean,
): Promise<{ file: string; changed: boolean; sha: string; meta: { etag?: string; lastModified?: string } } | null> {
  const known = state.pdfs[approval.id];
  const file = path.join(CACHE_DIR, `${approval.id}.pdf`);
  const cached = await exists(file);

  if (!force && known && cached) {
    return { file, changed: false, sha: known.sha256, meta: { etag: known.etag, lastModified: known.lastModified } };
  }

  const result = await fetchUrl(approval.pdfUrl, force ? undefined : known);
  if (result.notModified && cached) {
    return { file, changed: false, sha: known!.sha256, meta: result.meta };
  }

  if (result.body.length === 0) return null;
  if (!result.body.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    throw new Error(`PDFではない応答が返りました: ${approval.pdfUrl}`);
  }

  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(file, result.body);
  const sha = sha256(result.body);
  return { file, changed: known?.sha256 !== sha, sha, meta: result.meta };
}

/** クロール → 差分取得 → 解析 → データセット出力までを実行する。 */
export async function runUpdate(options: UpdateOptions = {}): Promise<UpdateSummary> {
  const initialState = await loadState();
  const { approvals, state } = await crawlIndex(initialState);

  const existingRecords = options.full ? [] : await readJson<PriceRecord[]>(PATHS.records, []);
  const previousHash = datasetHash(sortRecords(existingRecords));

  const limit = options.limit ?? CRAWL.maxNewPdfsPerRun;
  const summary: UpdateSummary = {
    approvals: approvals.length,
    newPdfs: 0,
    parsedPdfs: 0,
    needsOcr: [],
    failed: [],
    totalRecords: 0,
    newRecords: 0,
    unparsedLines: 0,
    datasetHash: "",
    changed: false,
  };

  const freshRecords: PriceRecord[] = [];
  const unparsed: unknown[] = await readJson<unknown[]>(PATHS.unparsed, []);
  const unparsedByPdf = new Map<string, unknown[]>();
  for (const item of unparsed) {
    const url = (item as { pdfUrl?: string }).pdfUrl;
    if (!url) continue;
    unparsedByPdf.set(url, [...(unparsedByPdf.get(url) ?? []), item]);
  }

  // インデックス上で新しいものから処理する（打ち切られても最新分は入る）
  for (const approval of approvals) {
    if (summary.newPdfs >= limit) {
      console.log(`上限 ${limit} 件に達したため、残りは次回に回します。`);
      break;
    }

    const known = state.pdfs[approval.id];
    const alreadyParsed = !options.full && known && !known.needsOcr;
    if (alreadyParsed && (await exists(path.join(CACHE_DIR, `${approval.id}.pdf`)))) {
      continue;
    }
    if (alreadyParsed && existingRecords.some((r) => r.出典PDF === approval.pdfUrl)) {
      // キャッシュは消えているが解析結果は手元にある。取り直さない。
      continue;
    }

    try {
      const fetched = await fetchPdf(approval, state, Boolean(options.full));
      if (!fetched) continue;
      summary.newPdfs++;

      const bytes = await fs.readFile(fetched.file);
      const pages = await extractPages(bytes);

      if (looksLikeScannedPdf(pages)) {
        summary.needsOcr.push(approval.pdfUrl);
        state.pdfs[approval.id] = {
          url: approval.pdfUrl,
          ...fetched.meta,
          sha256: fetched.sha,
          recordCount: 0,
          needsOcr: true,
          fetchedAt: nowJst(),
          parsedAt: nowJst(),
        };
        console.warn(`テキストを抽出できません（画像PDFの可能性）: ${approval.pdfUrl}`);
        continue;
      }

      const parsed = parseApprovalPdf(approval, pages);
      freshRecords.push(...parsed.records);
      unparsedByPdf.set(approval.pdfUrl, parsed.unparsed);
      summary.parsedPdfs++;

      state.pdfs[approval.id] = {
        url: approval.pdfUrl,
        ...fetched.meta,
        sha256: fetched.sha,
        recordCount: parsed.records.length,
        fetchedAt: nowJst(),
        parsedAt: nowJst(),
      };

      console.log(
        `解析: ${approval.approvalDate ?? "日付不明"} ${approval.title} → ${parsed.records.length} 件` +
          (parsed.unparsed.length > 0 ? `（未解釈 ${parsed.unparsed.length} 行）` : ""),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      summary.failed.push({ url: approval.pdfUrl, error: message });
      console.error(`失敗: ${approval.pdfUrl} — ${message}`);
    }
  }

  const merged = mergeRecords(existingRecords, freshRecords);
  const allUnparsed = [...unparsedByPdf.values()].flat();

  summary.totalRecords = merged.length;
  summary.newRecords = merged.length - existingRecords.length;
  summary.unparsedLines = allUnparsed.length;
  summary.datasetHash = datasetHash(merged);
  summary.changed = summary.datasetHash !== previousHash;

  state.lastRunAt = nowJst();
  await writeDataset(approvals, merged, allUnparsed);
  await saveState(state);

  return summary;
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
