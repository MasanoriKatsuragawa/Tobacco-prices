/**
 * キャッシュ済みPDFから、抽出された生の行データを書き出す開発用コマンド。
 *
 * 財務省サイトへ再アクセスせず（CIのPDFキャッシュを使う）、実際のレイアウトを
 * 手元に持ってくるためのもの。パーサを実データに合わせて直す際の土台になる。
 * 出力はリポジトリの debug/ に置き、公開データである data/ は汚さない。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, PATHS, ROOT } from "./config.js";
import { readJson } from "./dataset.js";
import type { Approval } from "./index-page.js";
import { extractPages } from "./pdf-text.js";

export type DumpedLine = {
  page: number;
  y: number;
  cells: { x: number; width: number; text: string }[];
};

export type DumpedPdf = {
  pdfUrl: string;
  title: string;
  approvalDate: string | null;
  approvalType: string;
  pageCount: number;
  lines: DumpedLine[];
};

export async function dumpLines(limit: number): Promise<string> {
  const approvals = await readJson<Approval[]>(PATHS.approvals, []);
  if (approvals.length === 0) {
    throw new Error("data/approvals.json が空です。先に update を実行してください。");
  }

  const dumped: DumpedPdf[] = [];
  let missing = 0;

  for (const approval of approvals.slice(0, limit)) {
    const file = path.join(CACHE_DIR, `${approval.id}.pdf`);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch {
      // キャッシュに無いものは飛ばす（ネットワークには取りに行かない）
      missing++;
      continue;
    }

    const pages = await extractPages(bytes);
    dumped.push({
      pdfUrl: approval.pdfUrl,
      title: approval.title,
      approvalDate: approval.approvalDate,
      approvalType: approval.approvalType,
      pageCount: pages.length,
      lines: pages.flatMap((page) =>
        page.lines.map((line) => ({
          page: page.pageNumber,
          y: Math.round(line.y * 10) / 10,
          cells: line.cells.map((c) => ({
            x: Math.round(c.x * 10) / 10,
            width: Math.round(c.width * 10) / 10,
            text: c.text,
          })),
        })),
      ),
    });
  }

  const out = path.join(ROOT, "debug", "lines.json");
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(dumped, null, 1)}\n`, "utf8");

  const lineCount = dumped.reduce((sum, d) => sum + d.lines.length, 0);
  console.log(`ダンプ: ${dumped.length} PDF / ${lineCount} 行 → ${out}`);
  if (missing > 0) console.log(`キャッシュに無くスキップ: ${missing} 件`);
  return out;
}
