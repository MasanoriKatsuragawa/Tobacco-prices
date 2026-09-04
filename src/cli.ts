#!/usr/bin/env node
import fs from "node:fs/promises";
import { INDEX_URL, PATHS } from "./config.js";
import { datasetHash, loadState, readJson, saveState, sortRecords } from "./dataset.js";
import { fetchUrl } from "./http.js";
import type { Approval } from "./index-page.js";
import type { PriceRecord } from "./parse-approval.js";
import { extractPages } from "./pdf-text.js";
import { crawlIndex, runUpdate } from "./pipeline.js";
import { createClient, syncSpreadsheet } from "./sheets.js";

const USAGE = `
使い方: npm run <コマンド> [-- オプション]

  update            クロール → 新規PDF取得 → 解析 → data/ 出力（通常はこれ）
  sync              data/ の内容を Google スプレッドシートへ反映
  crawl             インデックスページの認可PDF一覧だけを更新
  inspect <対象>    PDFのURLまたはローカルパスを指定し、抽出されたテキスト行を表示

オプション:
  --full            既知のPDFも取り直して全件を再解析する
  --limit=N         1回の実行で新規取得するPDFの上限（既定 400）
  --force           内容に変化が無くてもスプレッドシートへ書き込む（sync）

環境変数:
  GOOGLE_SERVICE_ACCOUNT_JSON   サービスアカウント鍵JSON（生JSONまたはbase64）
  SPREADSHEET_ID                同期先スプレッドシートのID
  TOBACCO_CRAWL_DELAY_MS        巡回間隔ミリ秒（既定 1500）
`.trim();

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const limit = Number(rest.find((a) => a.startsWith("--limit="))?.split("=")[1]) || undefined;

  switch (command) {
    case "update":
      await commandUpdate({ full: flags.has("--full"), limit });
      break;
    case "sync":
      await commandSync({ force: flags.has("--force") });
      break;
    case "crawl":
      await commandCrawl();
      break;
    case "inspect":
      await commandInspect(positional[0]);
      break;
    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

async function commandUpdate(options: { full?: boolean; limit?: number }): Promise<void> {
  const summary = await runUpdate(options);

  console.log("\n--- 実行結果 ---");
  console.log(`認可PDF（インデックス上）: ${summary.approvals}`);
  console.log(`今回取得したPDF: ${summary.newPdfs}（解析成功 ${summary.parsedPdfs}）`);
  console.log(`レコード合計: ${summary.totalRecords}（増分 ${summary.newRecords}）`);
  console.log(`未解釈の行: ${summary.unparsedLines}`);
  if (summary.needsOcr.length > 0) {
    console.log(`テキスト抽出不可（要OCR）: ${summary.needsOcr.length} 件`);
    for (const url of summary.needsOcr.slice(0, 10)) console.log(`  - ${url}`);
  }
  if (summary.failed.length > 0) {
    console.log(`取得・解析に失敗: ${summary.failed.length} 件`);
    for (const f of summary.failed.slice(0, 10)) console.log(`  - ${f.url}: ${f.error}`);
  }
  console.log(`データ変化: ${summary.changed ? "あり" : "なし"}`);

  // GitHub Actions のジョブサマリと後続ステップ向けに出力
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      [
        `changed=${summary.changed}`,
        `total_records=${summary.totalRecords}`,
        `new_records=${summary.newRecords}`,
        `new_pdfs=${summary.newPdfs}`,
      ].join("\n") + "\n",
    );
  }

  // 取得できたのに1件も解析できていないのは異常。CIを失敗させて気づけるようにする。
  if (summary.parsedPdfs > 0 && summary.newRecords === 0 && !options.full) {
    console.warn("警告: PDFは解析したのに新しいレコードが増えていません。パーサの確認が必要かもしれません。");
  }
  if (summary.failed.length > 0 && summary.parsedPdfs === 0) {
    process.exitCode = 1;
  }
}

async function commandSync(options: { force?: boolean }): Promise<void> {
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!spreadsheetId) throw new Error("SPREADSHEET_ID が未設定です。");

  const records = sortRecords(await readJson<PriceRecord[]>(PATHS.records, []));
  const approvals = await readJson<Approval[]>(PATHS.approvals, []);
  if (records.length === 0) {
    throw new Error("data/records.json が空です。先に update を実行してください。");
  }

  const state = await loadState();
  const hash = datasetHash(records);
  if (!options.force && state.lastSyncedHash === hash) {
    console.log("スプレッドシートは最新です（変更なしのためスキップ）。");
    return;
  }

  const client = createClient(spreadsheetId);
  await syncSpreadsheet(client, {
    records,
    approvals,
    sourceUrl: INDEX_URL,
    datasetUrl: process.env.DATASET_REPO_URL,
  });

  state.lastSyncedHash = hash;
  await saveState(state);
  console.log(
    `スプレッドシートへ ${records.length} 行を反映しました: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  );
}

async function commandCrawl(): Promise<void> {
  const state = await loadState();
  const { approvals, state: next } = await crawlIndex(state);
  await fs.mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await fs.writeFile(PATHS.approvals, `${JSON.stringify(approvals, null, 2)}\n`, "utf8");
  await saveState(next);
  for (const approval of approvals.slice(0, 20)) {
    console.log(`${approval.approvalDate ?? "----------"} [${approval.approvalType}] ${approval.title}`);
  }
  console.log(`... 合計 ${approvals.length} 件を ${PATHS.approvals} に保存しました。`);
}

/**
 * PDFの中身がどう読めているかを目視するためのコマンド。
 * パーサが崩れたときは、まずこれで実際のレイアウトを確認する。
 */
async function commandInspect(target?: string): Promise<void> {
  if (!target) throw new Error("PDFのURLまたはファイルパスを指定してください。");

  const bytes = /^https?:\/\//.test(target)
    ? (await fetchUrl(target)).body
    : await fs.readFile(target);

  const pages = await extractPages(bytes);
  for (const page of pages) {
    console.log(`\n===== ページ ${page.pageNumber} (${Math.round(page.width)}x${Math.round(page.height)}) =====`);
    for (const line of page.lines) {
      const cells = line.cells.map((c) => `[x=${Math.round(c.x)}]${c.text}`).join(" ");
      console.log(`y=${String(Math.round(line.y)).padStart(4)} ${cells}`);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
