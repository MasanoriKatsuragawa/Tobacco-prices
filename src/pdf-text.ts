import { createRequire } from "node:module";
import path from "node:path";

/**
 * PDFから座標付きテキストを取り出し、行（同じ高さのまとまり）に組み直す。
 *
 * 財務省の認可PDFは表組みなので、pdfjs が返すテキスト片を y でクラスタリングして
 * 行にし、x でソートしてセル列を作る。列の切り出しは parse-approval.ts が担当する。
 */

export type Cell = {
  /** 左端のx座標（PDFユーザ空間、左下原点） */
  x: number;
  /** セル幅 */
  width: number;
  text: string;
};

export type Line = {
  /** 行のy座標（大きいほどページ上部） */
  y: number;
  cells: Cell[];
  /** セルを空白1個で連結したもの */
  text: string;
};

export type Page = {
  pageNumber: number;
  width: number;
  height: number;
  lines: Line[];
};

/**
 * pdfjs に同梱されたリソースの場所。
 *
 * 日本語PDFは CJK の CMap（UniJIS-UCS2-H など）を読めないと1文字も取り出せないので、
 * 必ず渡す。Node版の pdfjs は fs.readFile でこれを読むため、file:// URL ではなく
 * 素のファイルパスを末尾スラッシュ付きで渡すこと。
 */
function pdfjsAssetPaths(): { cMapUrl: string; standardFontDataUrl: string } {
  const pkg = createRequire(import.meta.url).resolve("pdfjs-dist/package.json");
  const root = path.dirname(pkg);
  return {
    cMapUrl: `${path.join(root, "cmaps")}${path.sep}`,
    standardFontDataUrl: `${path.join(root, "standard_fonts")}${path.sep}`,
  };
}

/** PDFバイト列 → ページごとの行データ。 */
export async function extractPages(pdf: Buffer): Promise<Page[]> {
  // pdfjs は Node 用の legacy ビルドを使う。ワーカーは使わない（CIで安定させるため）。
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = pdfjsAssetPaths();

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    cMapUrl: assets.cMapUrl,
    cMapPacked: true,
    standardFontDataUrl: assets.standardFontDataUrl,
    disableFontFace: true,
    verbosity: 0,
  }).promise;

  const pages: Page[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();

        const cells: (Cell & { y: number; height: number })[] = [];
        for (const item of content.items) {
          if (!("str" in item)) continue;
          const text = item.str;
          if (!text || !text.trim()) continue;
          cells.push({
            x: item.transform[4],
            y: item.transform[5],
            width: item.width ?? 0,
            height: item.height || Math.abs(item.transform[3]) || 10,
            text,
          });
        }

        pages.push({
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          lines: groupIntoLines(cells),
        });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await doc.destroy();
  }

  return pages;
}

/** y座標が近いテキスト片を1行にまとめる。 */
export function groupIntoLines(
  cells: (Cell & { y: number; height: number })[],
): Line[] {
  if (cells.length === 0) return [];

  const sorted = [...cells].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  let current: (Cell & { y: number; height: number })[] = [];

  const tolerance = (a: { height: number }, b: { height: number }) =>
    Math.max(2, Math.min(a.height, b.height) * 0.6);

  for (const cell of sorted) {
    if (current.length === 0) {
      current = [cell];
      continue;
    }
    const ref = current[current.length - 1];
    if (Math.abs(cell.y - ref.y) <= tolerance(cell, ref)) {
      current.push(cell);
    } else {
      lines.push(finishLine(current));
      current = [cell];
    }
  }
  if (current.length > 0) lines.push(finishLine(current));

  return lines;
}

function finishLine(cells: (Cell & { y: number })[]): Line {
  const ordered = [...cells].sort((a, b) => a.x - b.x);
  const merged: Cell[] = [];

  // 文字単位でバラバラに来るPDFがあるので、隣接して間隔が狭いものは1セルに結合する
  for (const cell of ordered) {
    const prev = merged[merged.length - 1];
    const gap = prev ? cell.x - (prev.x + prev.width) : Infinity;
    if (prev && gap < 1.5) {
      prev.text += cell.text;
      prev.width = cell.x + cell.width - prev.x;
    } else {
      merged.push({ x: cell.x, width: cell.width, text: cell.text });
    }
  }

  for (const cell of merged) cell.text = cell.text.trim();

  return {
    y: cells[0].y,
    cells: merged.filter((c) => c.text.length > 0),
    text: merged
      .map((c) => c.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  };
}

/** テキストがほぼ取れないPDF（画像スキャン）かどうか。 */
export function looksLikeScannedPdf(pages: Page[]): boolean {
  const chars = pages.reduce(
    (sum, page) => sum + page.lines.reduce((s, line) => s + line.text.length, 0),
    0,
  );
  return chars < 20 * Math.max(1, pages.length);
}
