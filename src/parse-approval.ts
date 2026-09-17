import { createHash } from "node:crypto";
import type { Approval } from "./index-page.js";
import { stripGarbledScripts } from "./mojibake.js";
import type { Cell, Page } from "./pdf-text.js";
import {
  normalizeSpace,
  parseCompactWarekiDate,
  parseJapaneseDate,
  parseNumber,
  toFullWidthKana,
  toHalfWidth,
  toWareki,
} from "./wareki.js";

export type PriceRecord = {
  id: string;
  認可年月日: string;
  認可年月日_和暦: string;
  区分: string;
  種別: string;
  銘柄: string;
  銘柄_正規化: string;
  製品の区分: string;
  内容量: number | null;
  単位: string;
  原産国: string;
  小売定価_円: number | null;
  改定前定価_円: number | null;
  実施日: string;
  出典PDF: string;
  出典ページ: number;
  抽出精度: "高" | "中";
  原文: string;
};

export type ParseResult = {
  records: PriceRecord[];
  unparsed: { pdfUrl: string; page: number; text: string }[];
  needsOcr: boolean;
};

/** 位置つきのテキスト片。行にまとめる前の状態で扱う。 */
type Placed = Cell & { y: number; page: number };

/**
 * 価格セル。「1,900円」または文字化けで単位が壊れた「1,900෇」を許す。
 * 「F45 20ｽﾃｨｯｸ」「5.4g」を価格と取り違えないよう、数字とカンマ以外の
 * 前置と小数点を認めない。
 */
const PRICE_CELL = /^([\d,]+)\s*[^\d\s.,]?$/;

/** 製品の区分に出る値。「F45 20ｽﾃｨｯｸ」「90mm 1本」「80.0g瓶」など。 */
const SPEC_CELL = /\d\s*(mm|g|ｇ|本|ｽﾃｨｯｸ|箱|瓶|袋|個|ﾊﾟｯｸ)/i;

/** 表中の実施日「8.10.1」。 */
const COMPACT_DATE = /^\d{1,2}\.\d{1,2}\.\d{1,2}$/;

/** ヘッダのラベル。行としても、1文字ずつバラけた断片としても除く。 */
const HEADER_LABEL =
  /(製造たばこの|製品の区分|製造国|小売定価|変更実施|年\s*月\s*日|名\s*称|品\s*目|現\s*行|変\s*更|（地）|区\s*分)/;
const HEADER_FRAGMENT = /^[名称現行変更区分品目地年月日（）\s]{1,3}$/;

/** 「加熱式たばこ」「葉巻たばこ」など、銘柄ではなく製造たばこの区分。 */
const CATEGORY_CELL = /たばこ$/;

/**
 * たばこ事業法で定められた製造たばこの区分。
 * 文字化けPDFでは区分が復元できず化けた文字が残るので、
 * この一覧に一致したものだけを採用し、それ以外は空にする。
 */
const KNOWN_CATEGORIES = [
  "紙巻たばこ",
  "葉巻たばこ",
  "パイプたばこ",
  "刻みたばこ",
  "かみたばこ",
  "かぎたばこ",
  "加熱式たばこ",
];

/** たばこの小売定価としてありえる範囲か（列取り違えの検出用）。 */
function plausiblePrice(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  // 製造たばこの最安でも数百円。2桁の値は列の取り違えとみなして捨てる。
  if (value < 100 || value > 5_000_000) return null;
  return value;
}

function isPriceCell(text: string): boolean {
  const m = text.trim().match(PRICE_CELL);
  return m !== null && m[1].replace(/\D/g, "").length >= 2;
}

function priceOf(text: string): number | null {
  return plausiblePrice(Number(text.trim().replace(/[^\d]/g, "")) || null);
}

/** 1次元の値を、閾値より大きい隙間で切って群の中心を返す。 */
function clusterCenters(values: number[], gap: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const centers: number[] = [];
  let group: number[] = [];
  for (const v of sorted) {
    if (group.length > 0 && v - group[group.length - 1] > gap) {
      centers.push(group.reduce((a, b) => a + b, 0) / group.length);
      group = [];
    }
    group.push(v);
  }
  if (group.length > 0) centers.push(group.reduce((a, b) => a + b, 0) / group.length);
  return centers;
}

function nearestIndex(centers: number[], value: number): number {
  return centers.reduce((best, c, i) => (Math.abs(c - value) < Math.abs(centers[best] - value) ? i : best), 0);
}

/**
 * 認可PDF 1件を解析して定価レコードにする。
 *
 * 表の構造（実PDF 273件から確認）:
 *   製造たばこの区分 | 名称（ファミリー名＋派生名） | 製品の区分 | 製造国（地）
 *   | 現行小売定価 | 変更後小売定価 | 変更実施年月日
 *
 * 面倒なのは **縦方向に結合されたセル** で、1つの価格・製造国・製品の区分が
 * 複数の銘柄にかかり、その範囲の中央に1回だけ描画される。行の区切りは
 * 銘柄（派生名）の列が決めるので、その列をアンカーにして、他の列は
 * 「同じ行にあればそれ、無ければy座標が最も近い値」で埋める。
 */
export function parseApprovalPdf(approval: Approval, pages: Page[]): ParseResult {
  const unparsed: ParseResult["unparsed"] = [];
  const placed: Placed[] = [];

  for (const page of pages) {
    for (const line of page.lines) {
      for (const cell of line.cells) {
        const text = cell.text.trim();
        if (!text) continue;
        placed.push({ ...cell, text, y: line.y, page: page.pageNumber });
      }
    }
  }

  const body = placed.filter((c) => !HEADER_LABEL.test(c.text) && !HEADER_FRAGMENT.test(c.text));
  const approvalDate = approval.approvalDate ?? findDocumentApprovalDate(pages) ?? "";
  const documentEffectiveDate = findDocumentEffectiveDate(pages);

  const priceCells = body.filter((c) => isPriceCell(c.text) && priceOf(c.text) !== null);
  if (priceCells.length === 0) {
    return { records: [], unparsed, needsOcr: placed.length === 0 };
  }

  // 価格は右寄せなので右端でまとめる。認可は1列、変更認可は現行/変更後の2列。
  const priceColumns = clusterCenters(priceCells.map((c) => c.x + c.width), 12);
  const priceLeft = Math.min(...priceCells.map((c) => c.x));

  const dateCells = body.filter((c) => COMPACT_DATE.test(c.text));

  // 製品の区分と製造国は隣り合っている。x でまとまりに分け、
  // いちばん右のまとまりを製造国、それより左を製品の区分とみなす。
  // ただし右端も数量表記ばかりなら、製造国の列は無いものとして扱う。
  const middleCells = body.filter((c) => !isPriceCell(c.text) && !COMPACT_DATE.test(c.text));
  const specAnchors = middleCells.filter((c) => SPEC_CELL.test(c.text));
  const specLeft = specAnchors.length > 0 ? Math.min(...specAnchors.map((c) => c.x)) : priceLeft;

  const rightOfName = middleCells.filter((c) => c.x >= specLeft - 1 && c.x < priceLeft);
  const middleColumns = clusterCenters(rightOfName.map((c) => c.x), 10);
  const lastColumn = middleColumns.length - 1;
  const lastColumnCells = rightOfName.filter((c) => nearestIndex(middleColumns, c.x) === lastColumn);
  const hasCountryColumn =
    middleColumns.length >= 2 && lastColumnCells.filter((c) => SPEC_CELL.test(c.text)).length <= lastColumnCells.length / 2;

  const specCells = rightOfName.filter(
    (c) => !hasCountryColumn || nearestIndex(middleColumns, c.x) !== lastColumn,
  );
  const countryCells = hasCountryColumn ? lastColumnCells : [];

  // 製品の区分より左のテキストが、区分と銘柄
  const nameCells = body.filter(
    (c) => c.x < specLeft - 1 && !isPriceCell(c.text) && !COMPACT_DATE.test(c.text),
  );
  if (nameCells.length === 0) {
    return { records: [], unparsed, needsOcr: false };
  }

  const nameColumns = clusterCenters(nameCells.map((c) => c.x), 10);
  const countPerColumn = nameColumns.map(
    (_, i) => nameCells.filter((c) => nearestIndex(nameColumns, c.x) === i).length,
  );

  // 値がすべて「…たばこ」の列は製造たばこの区分。銘柄には混ぜない。
  const categoryIndex = nameColumns.findIndex((_, i) => {
    const values = nameCells.filter((c) => nearestIndex(nameColumns, c.x) === i);
    return values.length > 0 && values.every((c) => CATEGORY_CELL.test(c.text));
  });

  // 行の区切りを決めるのは、最もセル数が多い銘柄列
  const brandCounts = countPerColumn.map((n, i) => (i === categoryIndex ? -1 : n));
  const anchorIndex = brandCounts.indexOf(Math.max(...brandCounts));
  const anchors = nameCells.filter((c) => nearestIndex(nameColumns, c.x) === anchorIndex);

  const records: PriceRecord[] = [];

  for (const anchor of anchors) {
    const onSameLine = (c: Placed) => c.page === anchor.page && Math.abs(c.y - anchor.y) < 3;
    const nearestOnPage = (pool: Placed[]) => {
      const samePage = pool.filter((c) => c.page === anchor.page);
      if (samePage.length === 0) return null;
      return samePage.reduce((best, c) => (Math.abs(c.y - anchor.y) < Math.abs(best.y - anchor.y) ? c : best));
    };

    // 銘柄: 同じ行にある銘柄セル ＋ 左側（ファミリー名）の結合セル。
    // 右側の派生名（･ﾚｷﾞｭﾗｰ 等）は行ごとの値なので、同じ行にあるときだけ使う。
    const parts = nameCells
      .filter((c) => onSameLine(c) && nearestIndex(nameColumns, c.x) !== categoryIndex)
      .map((c) => ({ x: c.x, text: c.text }));

    nameColumns.forEach((_, i) => {
      if (i === anchorIndex || i === categoryIndex || i > anchorIndex) return;
      if (parts.some((p) => nearestIndex(nameColumns, p.x) === i)) return;
      const near = nearestOnPage(nameCells.filter((c) => nearestIndex(nameColumns, c.x) === i));
      if (near) parts.push({ x: near.x, text: near.text });
    });

    const brand = stripGarbledScripts(
      normalizeSpace(
        parts
          .sort((a, b) => a.x - b.x)
          .map((p) => p.text)
          .join(" "),
      ),
    );
    // 列に分かれていないPDFでは行全体が1セルになり、銘柄に価格や別の列が丸ごと
    // 入ってしまう。そういう行はレコードにせず、未解釈として残す。
    const looksLikeWholeRow = brand.length > 60 || /[\d],[\d]{3}|円/.test(brand);
    if (!brand || looksLikeWholeRow) {
      if (brand) unparsed.push({ pdfUrl: approval.pdfUrl, page: anchor.page, text: brand });
      continue;
    }

    const byPriceColumn = priceColumns.map((_, i) => {
      const pool = priceCells.filter((c) => nearestIndex(priceColumns, c.x + c.width) === i);
      const exact = pool.find(onSameLine);
      const cell = exact ?? nearestOnPage(pool);
      return { value: cell ? priceOf(cell.text) : null, exact: Boolean(exact) };
    });

    const last = byPriceColumn[byPriceColumn.length - 1];
    const price = last?.value ?? null;
    if (price === null) continue;
    // 変更認可は「現行 → 変更後」の順。認可されたのは後者なので最後の列を採る。
    const priceBefore = byPriceColumn.length >= 2 ? byPriceColumn[byPriceColumn.length - 2].value : null;

    const specCell = specCells.find(onSameLine) ?? nearestOnPage(specCells);
    const spec = stripGarbledScripts(specCell?.text ?? "");
    const quantity = extractQuantity(spec || brand);

    const countryCell = countryCells.find(onSameLine) ?? nearestOnPage(countryCells);
    const categoryCell =
      categoryIndex >= 0
        ? nearestOnPage(nameCells.filter((c) => nearestIndex(nameColumns, c.x) === categoryIndex))
        : null;

    const dateCell = dateCells.find(onSameLine) ?? nearestOnPage(dateCells);
    const effectiveDate =
      (dateCell && approvalDate ? parseCompactWarekiDate(dateCell.text, approvalDate) : null) ??
      documentEffectiveDate ??
      "";

    records.push({
      id: recordId(approval.pdfUrl, anchor.page, brand, price, quantity.value),
      認可年月日: approvalDate,
      認可年月日_和暦: approvalDate ? toWareki(approvalDate) : "",
      区分: approval.approvalType,
      種別: knownCategory(categoryCell?.text ?? ""),
      銘柄: brand,
      銘柄_正規化: normalizeBrand(brand),
      製品の区分: spec,
      内容量: quantity.value,
      単位: quantity.unit,
      原産国: stripGarbledScripts(countryCell?.text ?? ""),
      小売定価_円: price,
      改定前定価_円: priceBefore,
      実施日: effectiveDate,
      出典PDF: approval.pdfUrl,
      出典ページ: anchor.page,
      // 価格が同じ行にあれば確実。結合セルから引き継いだ場合は推定。
      抽出精度: last.exact ? "高" : "中",
      原文: normalizeSpace([brand, spec, countryCell?.text ?? "", String(price)].filter(Boolean).join(" ")),
    });
  }

  // 銘柄列に値があるのにレコードにならなかった行は、パーサ改善のために残す
  const used = new Set(records.map((r) => r.銘柄));
  for (const anchor of anchors) {
    if (!used.has(normalizeSpace(anchor.text))) {
      unparsed.push({ pdfUrl: approval.pdfUrl, page: anchor.page, text: anchor.text });
    }
  }

  return { records, unparsed, needsOcr: false };
}

/** 既知の製造たばこの区分に一致すればそれを返し、しなければ空にする。 */
function knownCategory(text: string): string {
  const cleaned = stripGarbledScripts(text);
  return KNOWN_CATEGORIES.find((c) => cleaned.includes(c)) ?? "";
}

/** 「20本」「50g」「1個」から数量と単位を取り出す。 */
export function extractQuantity(text: string): { value: number | null; unit: string } {
  const s = toHalfWidth(text);
  const m = s.match(/([\d,]+(?:\.\d+)?)\s*(本|個|g|グラム|ｇ|ml|包|袋|枚|ｽﾃｨｯｸ|スティック)/i);
  if (!m) return { value: null, unit: "" };
  const raw = m[2];
  const unit = /g|グラム|ｇ/i.test(raw) ? "g" : raw === "ｽﾃｨｯｸ" ? "スティック" : raw;
  return { value: parseNumber(m[1]), unit };
}

/** 表記ゆれを吸収した突き合わせ用キー。全角半角・空白・中黒を潰す。 */
export function normalizeBrand(brand: string): string {
  // 認可PDFの銘柄はほぼ全て半角カナ。全角に寄せないと「ﾃﾘｱ」と「テリア」が別物になる。
  return toFullWidthKana(toHalfWidth(brand))
    .replace(/[・･]/g, "")
    .replace(/\s+/g, "")
    .replace(/[「」『』]/g, "")
    .toUpperCase();
}

/** 文書全体に効く「実施日」を拾う。 */
function findDocumentEffectiveDate(pages: Page[]): string | null {
  for (const page of pages) {
    for (const line of page.lines) {
      const text = normalizeSpace(line.text);
      if (!/(実施|適用|発売)(日|年月日|開始)/.test(text)) continue;
      const date = parseJapaneseDate(text);
      if (date) return date;
    }
  }
  return null;
}

function findDocumentApprovalDate(pages: Page[]): string | null {
  for (const page of pages) {
    for (const line of page.lines.slice(0, 15)) {
      const text = normalizeSpace(line.text);
      if (!/認可/.test(text)) continue;
      const date = parseJapaneseDate(text);
      if (date) return date;
    }
  }
  return null;
}

function recordId(
  pdfUrl: string,
  page: number,
  brand: string,
  price: number | null,
  quantity: number | null,
): string {
  return createHash("sha1")
    .update([pdfUrl, page, normalizeBrand(brand), price ?? "", quantity ?? ""].join("|"))
    .digest("hex")
    .slice(0, 16);
}
