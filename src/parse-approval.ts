import { createHash } from "node:crypto";
import type { Approval } from "./index-page.js";
import type { Line, Page } from "./pdf-text.js";
import { normalizeSpace, parseJapaneseDate, parseNumber, toHalfWidth, toWareki } from "./wareki.js";

export type PriceRecord = {
  id: string;
  認可年月日: string;
  認可年月日_和暦: string;
  区分: string;
  銘柄: string;
  銘柄_正規化: string;
  内容量: number | null;
  単位: string;
  小売定価_円: number | null;
  改定前定価_円: number | null;
  実施日: string;
  製造者_輸入者: string;
  備考: string;
  出典PDF: string;
  出典ページ: number;
  抽出精度: "高" | "中";
  原文: string;
};

export type ParseResult = {
  records: PriceRecord[];
  /** 表の行に見えたのに解釈できなかった行（パーサ改善のために残す） */
  unparsed: { pdfUrl: string; page: number; text: string }[];
  /** テキストが取れないPDF（スキャン画像など） */
  needsOcr: boolean;
};

type Field = "brand" | "quantity" | "price" | "priceBefore" | "effectiveDate" | "maker" | "note";

type Column = { field: Field; center: number; label: string };

const HEADER_PATTERNS: { field: Field; re: RegExp }[] = [
  { field: "priceBefore", re: /(現行|改定前|変更前)/ },
  { field: "price", re: /(小売\s*定価|定\s*価|価\s*格)/ },
  { field: "quantity", re: /(内容量|本\s*数|入\s*数|数\s*量|規\s*格|容\s*量)/ },
  { field: "brand", re: /(銘\s*柄|品\s*名|商品名)/ },
  { field: "effectiveDate", re: /(実\s*施|適\s*用|発\s*売)/ },
  { field: "maker", re: /(製造者|輸入者|会社名|製造たばこ)/ },
  { field: "note", re: /(備\s*考|摘\s*要)/ },
];

/** 表の行ではない、見出し・注記・ページ番号などを弾く。 */
const NOISE = /^(?:-?\s*\d+\s*-?|注\d*[).：:]|※|以\s*上|（?注）?)$/;

/** PDF 1件を解析して定価レコードにする。 */
export function parseApprovalPdf(approval: Approval, pages: Page[]): ParseResult {
  const records: PriceRecord[] = [];
  const unparsed: ParseResult["unparsed"] = [];

  const documentEffectiveDate = findDocumentEffectiveDate(pages);
  const approvalDate = approval.approvalDate ?? findDocumentApprovalDate(pages) ?? "";

  for (const page of pages) {
    const columns = findColumns(page.lines);
    let currentMaker = "";

    for (const line of page.lines) {
      const text = normalizeSpace(line.text);
      if (!text || NOISE.test(text)) continue;
      if (isHeaderLine(line)) continue;
      if (isDocumentChrome(text)) continue;

      // 会社名だけの行は、以降の行の製造者・輸入者として引き継ぐ
      const maker = detectMakerHeading(text);
      if (maker) {
        currentMaker = maker;
        continue;
      }

      const parsed = columns
        ? parseByColumns(line, columns)
        : parseHeuristically(text);

      if (!parsed || parsed.price === null || !parsed.brand) {
        // 銘柄列が埋まっているのに定価を読めなかった行は、表の行なのに落としている疑いが濃い。
        // 数字らしきものを含む行も含め、パーサ改善のために記録しておく。
        if ((parsed && parsed.brand) || looksLikeDataRow(text)) {
          unparsed.push({ pdfUrl: approval.pdfUrl, page: page.pageNumber, text });
        }
        continue;
      }

      const brand = cleanBrand(parsed.brand);
      if (!brand) {
        unparsed.push({ pdfUrl: approval.pdfUrl, page: page.pageNumber, text });
        continue;
      }

      const quantity = parsed.quantity ?? extractQuantity(parsed.brand);
      const effectiveDate =
        parsed.effectiveDate ?? documentEffectiveDate ?? "";

      records.push({
        id: recordId(approval.pdfUrl, page.pageNumber, brand, parsed.price, quantity.value),
        認可年月日: approvalDate,
        認可年月日_和暦: approvalDate ? toWareki(approvalDate) : "",
        区分: approval.approvalType,
        銘柄: brand,
        銘柄_正規化: normalizeBrand(brand),
        内容量: quantity.value,
        単位: quantity.unit,
        小売定価_円: parsed.price,
        改定前定価_円: parsed.priceBefore ?? null,
        実施日: effectiveDate,
        製造者_輸入者: parsed.maker || currentMaker,
        備考: parsed.note ?? "",
        出典PDF: approval.pdfUrl,
        出典ページ: page.pageNumber,
        抽出精度: columns ? "高" : "中",
        原文: text,
      });
    }
  }

  return {
    records,
    unparsed,
    needsOcr: records.length === 0 && unparsed.length === 0,
  };
}

/** ヘッダ行を探して列の中心座標を決める。見つからなければ null。 */
export function findColumns(lines: Line[]): Column[] | null {
  for (const line of lines) {
    if (!isHeaderLine(line)) continue;

    const columns: Column[] = [];
    for (const cell of line.cells) {
      const label = normalizeSpace(cell.text);
      const field = HEADER_PATTERNS.find((p) => p.re.test(label))?.field;
      if (!field) continue;
      columns.push({ field, center: cell.x + cell.width / 2, label });
    }

    const fields = new Set(columns.map((c) => c.field));
    if (fields.has("brand") && (fields.has("price") || fields.has("priceBefore"))) {
      return columns.sort((a, b) => a.center - b.center);
    }
  }
  return null;
}

function isHeaderLine(line: Line): boolean {
  const text = normalizeSpace(line.text);
  const hasBrand = /(銘\s*柄|品\s*名)/.test(text);
  const hasPrice = /(定\s*価|価\s*格)/.test(text);
  // 数字が並ぶ行はデータ行なのでヘッダとはみなさない
  const digits = (toHalfWidth(text).match(/\d/g) ?? []).length;
  return hasBrand && hasPrice && digits <= 4;
}

/** 認可書の本文（宛名・日付・鑑文）を表データと取り違えないようにする。 */
function isDocumentChrome(text: string): boolean {
  return (
    /^(製造たばこ|下記のとおり|記$|上記のとおり|財務大臣|財務省|認可申請|申請者)/.test(text) ||
    /(認可\s*年?月?日?|申請年月日)\s*[:：]/.test(text)
  );
}

function parseByColumns(
  line: Line,
  columns: Column[],
): {
  brand: string;
  quantity: { value: number | null; unit: string } | null;
  price: number | null;
  priceBefore: number | null;
  effectiveDate: string | null;
  maker: string;
  note: string;
} | null {
  const buckets = new Map<Field, string[]>();

  for (const cell of line.cells) {
    const center = cell.x + cell.width / 2;
    const column = nearestColumn(columns, center);
    if (!column) continue;
    const list = buckets.get(column.field) ?? [];
    list.push(cell.text);
    buckets.set(column.field, list);
  }

  const get = (field: Field) => normalizeSpace((buckets.get(field) ?? []).join(" "));

  const brand = get("brand");
  const priceText = get("price");
  const priceBeforeText = get("priceBefore");
  if (!brand && !priceText) return null;

  const quantityText = get("quantity");
  const effectiveText = get("effectiveDate");

  return {
    brand,
    quantity: quantityText ? extractQuantity(quantityText) : null,
    price: plausiblePrice(parseNumber(priceText)),
    priceBefore: plausiblePrice(parseNumber(priceBeforeText)),
    effectiveDate: effectiveText ? parseJapaneseDate(effectiveText) : null,
    maker: get("maker"),
    note: get("note"),
  };
}

function nearestColumn(columns: Column[], center: number): Column | null {
  let best: Column | null = null;
  let bestDistance = Infinity;
  for (const column of columns) {
    const distance = Math.abs(column.center - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = column;
    }
  }
  return best;
}

/**
 * ヘッダが取れなかったPDF向けのフォールバック。
 * 「銘柄名 … 20本 … 600円 … 令和8年8月1日」のような1行から拾う。
 */
export function parseHeuristically(text: string): ReturnType<typeof parseByColumns> {
  const flat = toHalfWidth(text);
  const price = plausiblePrice(
    parseNumber(flat.match(/([\d,]+)\s*円/)?.[1] ?? "") ??
      parseNumber(flat.match(/([\d,]{2,7})\s*$/)?.[1] ?? ""),
  );
  if (price === null) return null;

  const effectiveDate = parseJapaneseDate(flat);
  const quantity = extractQuantity(flat);

  // 価格・数量・日付を取り除いた残りを銘柄とみなす
  const brand = normalizeSpace(
    flat
      .replace(/(令和|平成|昭和)\s*(元|\d{1,2})\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/g, " ")
      .replace(/[\d,]+\s*円/g, " ")
      .replace(/\d+\s*(本|個|g|グラム|ml)/gi, " ")
      .replace(/[\d,]{2,7}\s*$/, " "),
  );

  if (!brand) return null;

  return {
    brand,
    quantity,
    price,
    priceBefore: null,
    effectiveDate,
    maker: "",
    note: "",
  };
}

/** 「20本」「50g」「1個」から数量と単位を取り出す。 */
export function extractQuantity(text: string): { value: number | null; unit: string } {
  const s = toHalfWidth(text);
  const m = s.match(/([\d,]+(?:\.\d+)?)\s*(本|個|g|グラム|ｇ|ml|包|袋|枚)/i);
  if (!m) return { value: null, unit: "" };
  const unit = m[2].replace("グラム", "g").replace("ｇ", "g").toLowerCase();
  return { value: parseNumber(m[1]), unit: unit === "g" ? "g" : m[2] };
}

/** たばこの小売定価としてありえる範囲か（列取り違えの検出用）。 */
function plausiblePrice(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isFinite(value)) return null;
  if (value < 10 || value > 1_000_000) return null;
  return value;
}

function looksLikeDataRow(text: string): boolean {
  const flat = toHalfWidth(text);
  return /[\d,]{2,}/.test(flat) && flat.replace(/[\d,\s円]/g, "").length >= 2;
}

/** 「日本たばこ産業株式会社」のような、会社名だけの行を検出する。 */
function detectMakerHeading(text: string): string | null {
  if (!/(株式会社|合同会社|有限会社|Inc\.|Ltd\.|K\.K\.)/i.test(text)) return null;
  if (/[\d,]{2,}\s*円/.test(toHalfWidth(text))) return null;
  if (text.length > 40) return null;
  return text.replace(/^[（(]|[）)]$/g, "").trim();
}

function cleanBrand(raw: string): string {
  return normalizeSpace(raw)
    .replace(/^[0-9]+[.．)）]\s*/, "")
    .replace(/^[・･]\s*/, "")
    .trim();
}

/** 表記ゆれを吸収した突き合わせ用キー。全角半角・空白・中黒を潰す。 */
export function normalizeBrand(brand: string): string {
  return toHalfWidth(brand)
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
