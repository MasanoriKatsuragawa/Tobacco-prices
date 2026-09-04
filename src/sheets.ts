/**
 * Google スプレッドシートへの同期。
 *
 * 前提となる公開モデル:
 *  - スプレッドシートの所有者は人間（利用者のGoogleアカウント）
 *  - 一般公開のリンク共有は「閲覧者」まで。編集権限は誰にも配らない
 *  - 書き込み権限を持つのは同期に使う1主体だけ（編集者として個別に共有）
 *  - シートには公開情報しか載せない（個人情報・鍵・内部URLを入れない）
 *
 * 認証は2通りを受け付ける。組織のポリシーでサービスアカウント鍵の作成が
 * 禁止されている場合は、鍵を持たない Workload Identity 連携を使う。
 *
 *  1. Workload Identity 連携（鍵なし・推奨）
 *     google-github-actions/auth が書き出す認証情報を ADC 経由で拾う。
 *     環境変数の設定は不要（GOOGLE_APPLICATION_CREDENTIALS が自動で入る）。
 *  2. サービスアカウント鍵JSON
 *     GOOGLE_SERVICE_ACCOUNT_JSON に鍵の中身を入れる。
 *
 * どちらも使えない場合は、Apps Script からシート側で取りに行く方式
 * （apps-script/ 配下）を使う。そちらは Google Cloud を一切使わない。
 */

import { GoogleAuth, JWT } from "google-auth-library";
import { SHEET_TABS } from "./config.js";
import type { Approval } from "./index-page.js";
import type { PriceRecord } from "./parse-approval.js";
import { CSV_COLUMNS, recordsToRows } from "./dataset.js";
import { nowJst } from "./wareki.js";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

/** 1リクエストあたりの行数。大きすぎるとAPIのペイロード上限に当たる。 */
const CHUNK_ROWS = 2000;

export type SheetsClient = {
  spreadsheetId: string;
  request: <T>(method: string, url: string, body?: unknown) => Promise<T>;
};

export function createClient(spreadsheetId: string): SheetsClient {
  const auth = createAuth();

  return {
    spreadsheetId,
    request: async <T>(method: string, url: string, body?: unknown): Promise<T> => {
      const res = await auth.request<T>({
        method: method as "GET" | "POST" | "PUT",
        url,
        data: body,
      });
      return res.data;
    },
  };
}

type Authorized = Pick<GoogleAuth, "request">;

/**
 * 鍵JSONがあればそれを使い、無ければ ADC にフォールバックする。
 *
 * ADC は Workload Identity 連携（google-github-actions/auth）や
 * `gcloud auth application-default login` が置いた認証情報を拾うので、
 * サービスアカウント鍵を1つも作らずに動かせる。
 */
function createAuth(): Authorized {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (raw) {
    const credentials = parseServiceAccountJson(raw);
    return new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: SCOPES,
    });
  }

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.CLOUDSDK_CONFIG) {
    throw new Error(
      [
        "Googleの認証情報が見つかりません。次のいずれかを用意してください。",
        "  1. Workload Identity 連携（鍵なし・推奨）",
        "     ワークフローで google-github-actions/auth を実行すると ADC が設定されます。",
        "  2. GOOGLE_SERVICE_ACCOUNT_JSON にサービスアカウント鍵JSONを設定",
        "  3. Google Cloud を使えない場合は apps-script/ の方式（README 4章）",
      ].join("\n"),
    );
  }

  return new GoogleAuth({ scopes: SCOPES });
}

function parseServiceAccountJson(raw: string): { client_email: string; private_key: string } {
  let parsed: { client_email?: string; private_key?: string };
  try {
    // GitHub Secrets 経由で改行が \n のまま渡ることがあるので両対応
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("サービスアカウントJSONに client_email / private_key がありません。");
  }
  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}

type SheetProperties = { sheetId: number; title: string; gridProperties?: { rowCount: number; columnCount: number } };

async function getSheets(client: SheetsClient): Promise<SheetProperties[]> {
  const data = await client.request<{ sheets: { properties: SheetProperties }[] }>(
    "GET",
    `${SHEETS_API}/${client.spreadsheetId}?fields=sheets.properties`,
  );
  return data.sheets.map((s) => s.properties);
}

async function batchUpdate(client: SheetsClient, requests: unknown[]): Promise<void> {
  if (requests.length === 0) return;
  await client.request("POST", `${SHEETS_API}/${client.spreadsheetId}:batchUpdate`, { requests });
}

/** タブが無ければ作る。 */
async function ensureTabs(client: SheetsClient, titles: string[]): Promise<SheetProperties[]> {
  const existing = await getSheets(client);
  const missing = titles.filter((t) => !existing.some((s) => s.title === t));
  if (missing.length > 0) {
    await batchUpdate(
      client,
      missing.map((title) => ({ addSheet: { properties: { title } } })),
    );
    return getSheets(client);
  }
  return existing;
}

/** タブを空にしてから values を書き込む。行数が多い場合は分割して送る。 */
async function replaceTab(
  client: SheetsClient,
  title: string,
  rows: (string | number)[][],
): Promise<void> {
  const quoted = `'${title.replace(/'/g, "''")}'`;
  await client.request("POST", `${SHEETS_API}/${client.spreadsheetId}/values/${encodeURIComponent(quoted)}:clear`, {});

  for (let offset = 0; offset < rows.length; offset += CHUNK_ROWS) {
    const chunk = rows.slice(offset, offset + CHUNK_ROWS);
    const range = `${quoted}!A${offset + 1}`;
    await client.request(
      "PUT",
      `${SHEETS_API}/${client.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
      { values: chunk },
    );
  }
}

/**
 * データセット全体をスプレッドシートへ反映する。
 * 追記ではなく毎回全書き換え。何度実行しても同じ結果になる（冪等）。
 */
export async function syncSpreadsheet(
  client: SheetsClient,
  input: { records: PriceRecord[]; approvals: Approval[]; sourceUrl: string; datasetUrl?: string },
): Promise<void> {
  const titles = [SHEET_TABS.prices, SHEET_TABS.approvals, SHEET_TABS.readme];
  const sheets = await ensureTabs(client, titles);

  const priceRows: (string | number)[][] = [CSV_COLUMNS as string[], ...recordsToRows(input.records)];

  const approvalHeader = ["認可年月日", "認可年月日_和暦", "区分", "件名", "抽出件数", "出典PDF"];
  const countByPdf = new Map<string, number>();
  for (const record of input.records) {
    countByPdf.set(record.出典PDF, (countByPdf.get(record.出典PDF) ?? 0) + 1);
  }
  const approvalRows: (string | number)[][] = [
    approvalHeader,
    ...input.approvals.map((a) => [
      a.approvalDate ?? "",
      a.approvalDateWareki,
      a.approvalType,
      a.title,
      countByPdf.get(a.pdfUrl) ?? 0,
      a.pdfUrl,
    ]),
  ];

  await removeEmptyDefaultTab(client, sheets);

  await replaceTab(client, SHEET_TABS.prices, priceRows);
  await replaceTab(client, SHEET_TABS.approvals, approvalRows);
  await replaceTab(
    client,
    SHEET_TABS.readme,
    readmeRows({
      recordCount: input.records.length,
      approvalCount: input.approvals.length,
      sourceUrl: input.sourceUrl,
      datasetUrl: input.datasetUrl,
    }),
  );

  await applyFormatting(client, sheets, priceRows[0].length, approvalHeader.length);
}

/**
 * 新規スプレッドシートに最初からある空タブ（「シート1」/「Sheet1」）を片付ける。
 *
 * 取り違えて人のデータを消さないよう、既定名かつ中身が空のものだけを対象にする。
 */
async function removeEmptyDefaultTab(client: SheetsClient, sheets: SheetProperties[]): Promise<void> {
  const ours = new Set(Object.values(SHEET_TABS));
  const candidates = sheets.filter((s) => !ours.has(s.title) && /^(シート1|Sheet1)$/.test(s.title));
  if (candidates.length === 0) return;
  // 全タブを消してしまわないための保険
  if (sheets.length - candidates.length < 1) return;

  const removable: number[] = [];
  for (const sheet of candidates) {
    const quoted = `'${sheet.title.replace(/'/g, "''")}'`;
    const values = await client.request<{ values?: unknown[][] }>(
      "GET",
      `${SHEETS_API}/${client.spreadsheetId}/values/${encodeURIComponent(quoted)}`,
    );
    if (!values.values || values.values.length === 0) removable.push(sheet.sheetId);
  }

  await batchUpdate(
    client,
    removable.map((sheetId) => ({ deleteSheet: { sheetId } })),
  );
}

function readmeRows(info: {
  recordCount: number;
  approvalCount: number;
  sourceUrl: string;
  datasetUrl?: string;
}): (string | number)[][] {
  return [
    ["製造たばこ小売定価（認可分）統合データ"],
    [""],
    ["最終更新（JST）", nowJst()],
    ["収録レコード数", info.recordCount],
    ["収録認可件数", info.approvalCount],
    [""],
    ["出典", "財務省「製造たばこの小売定価の認可」"],
    ["出典URL", info.sourceUrl],
    ...(info.datasetUrl ? [["生成元リポジトリ", info.datasetUrl]] : []),
    [""],
    ["このシートについて"],
    [
      "財務省が個別のPDFで公表している認可済みの製造たばこ小売定価を、機械的に読み取って1つの表にまとめたものです。",
    ],
    ["財務省が作成・公表しているものではなく、非公式の二次データです。"],
    [""],
    ["免責"],
    [
      "PDFからの自動抽出のため、誤り・取りこぼし・重複が含まれる可能性があります。正確な内容は必ず出典PDFで確認してください。",
    ],
    ["各行の「出典PDF」列から、元の認可PDFに直接あたれます。"],
    ["「抽出精度」列が「中」の行は、表の列構造を検出できずに推定で読み取った行です。"],
    [""],
    ["更新の仕組み"],
    ["1日1回、出典ページを巡回して新しい認可PDFを検出し、追加分だけを解析してこの表に反映します。"],
    ["過去分を含めて毎回全体を書き換えるため、同じ内容で何度実行しても結果は変わりません。"],
    [""],
    ["利用について"],
    [
      "出典である財務省ウェブサイトのコンテンツは政府標準利用規約に基づき利用しています。二次データである本シートも同様に自由にご利用いただけますが、出典として財務省の当該ページを併記してください。",
    ],
  ];
}

/** ヘッダ固定・フィルタ・列幅など、見た目の初期設定。毎回かけても害はない。 */
async function applyFormatting(
  client: SheetsClient,
  sheets: SheetProperties[],
  priceColumnCount: number,
  approvalColumnCount: number,
): Promise<void> {
  const find = (title: string) => sheets.find((s) => s.title === title);
  const requests: unknown[] = [];

  for (const [title, columnCount] of [
    [SHEET_TABS.prices, priceColumnCount],
    [SHEET_TABS.approvals, approvalColumnCount],
  ] as const) {
    const sheet = find(title);
    if (!sheet) continue;

    requests.push({
      updateSheetProperties: {
        properties: { sheetId: sheet.sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    });
    requests.push({
      repeatCell: {
        range: { sheetId: sheet.sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: {
          userEnteredFormat: {
            textFormat: { bold: true },
            backgroundColor: { red: 0.93, green: 0.95, blue: 0.98 },
          },
        },
        fields: "userEnteredFormat(textFormat,backgroundColor)",
      },
    });
    requests.push({
      setBasicFilter: {
        filter: {
          range: { sheetId: sheet.sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: columnCount },
        },
      },
    });
  }

  const readme = find(SHEET_TABS.readme);
  if (readme) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: readme.sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: 1 },
        properties: { pixelSize: 220 },
        fields: "pixelSize",
      },
    });
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: readme.sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 },
        properties: { pixelSize: 700 },
        fields: "pixelSize",
      },
    });
  }

  await batchUpdate(client, requests);
}
