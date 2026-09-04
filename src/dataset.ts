import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, PATHS } from "./config.js";
import type { Approval } from "./index-page.js";
import type { PriceRecord } from "./parse-approval.js";

export type State = {
  /** インデックスページの条件付きGET用メタ */
  index?: { etag?: string; lastModified?: string };
  /** PDFごとの取得状態。キーは Approval.id */
  pdfs: Record<
    string,
    {
      url: string;
      etag?: string;
      lastModified?: string;
      /** 本文のSHA-256。差し替えを検知する */
      sha256: string;
      /** 抽出できたレコード数 */
      recordCount: number;
      needsOcr?: boolean;
      fetchedAt: string;
      parsedAt: string;
    }
  >;
  lastRunAt?: string;
  /** 最後にスプレッドシートへ書いたデータのハッシュ */
  lastSyncedHash?: string;
};

export const CSV_COLUMNS: (keyof PriceRecord)[] = [
  "id",
  "認可年月日",
  "認可年月日_和暦",
  "区分",
  "銘柄",
  "銘柄_正規化",
  "内容量",
  "単位",
  "小売定価_円",
  "改定前定価_円",
  "実施日",
  "製造者_輸入者",
  "備考",
  "出典PDF",
  "出典ページ",
  "抽出精度",
];

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function loadState(): Promise<State> {
  return readJson<State>(PATHS.state, { pdfs: {} });
}

export async function saveState(state: State): Promise<void> {
  await writeJson(PATHS.state, state);
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 既存レコードと新規レコードを id でマージする。
 * 同じ id は新しい方で置き換える（パーサ改善時に再解析結果を反映できるように）。
 */
export function mergeRecords(existing: PriceRecord[], incoming: PriceRecord[]): PriceRecord[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const record of incoming) byId.set(record.id, record);
  return sortRecords([...byId.values()]);
}

/** 認可年月日の新しい順、次に銘柄。並びを固定して差分を読みやすくする。 */
export function sortRecords(records: PriceRecord[]): PriceRecord[] {
  return [...records].sort(
    (a, b) =>
      b.認可年月日.localeCompare(a.認可年月日) ||
      a.出典PDF.localeCompare(b.出典PDF) ||
      a.出典ページ - b.出典ページ ||
      a.銘柄.localeCompare(b.銘柄, "ja") ||
      (a.小売定価_円 ?? 0) - (b.小売定価_円 ?? 0),
  );
}

export function recordsToRows(records: PriceRecord[]): (string | number)[][] {
  return records.map((record) =>
    CSV_COLUMNS.map((column) => {
      const value = record[column];
      return value === null || value === undefined ? "" : (value as string | number);
    }),
  );
}

export function toCsv(records: PriceRecord[]): string {
  const escape = (value: string | number) => {
    const s = String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of recordsToRows(records)) lines.push(row.map(escape).join(","));
  // Excel が UTF-8 と判定できるよう BOM を付ける
  return `﻿${lines.join("\n")}\n`;
}

export async function writeDataset(
  approvals: Approval[],
  records: PriceRecord[],
  unparsed: unknown[],
): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await writeJson(PATHS.approvals, approvals);
  await writeJson(PATHS.records, records);
  await writeJson(PATHS.unparsed, unparsed);
  await fs.writeFile(PATHS.csv, toCsv(records), "utf8");
}

/** データ内容のハッシュ。変化が無いときにスプレッドシート書き込みを省くのに使う。 */
export function datasetHash(records: PriceRecord[]): string {
  return createHash("sha256")
    .update(JSON.stringify(recordsToRows(records)))
    .digest("hex");
}
