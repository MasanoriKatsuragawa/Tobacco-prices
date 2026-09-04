import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** リポジトリのルート */
export const ROOT = path.resolve(here, "..");

/** 生成物の置き場。CSV/JSON はリポジトリにコミットして公開データとしても使う。 */
export const DATA_DIR = path.join(ROOT, "data");

/** ダウンロードしたPDFのキャッシュ（.gitignore 済み。CIではキャッシュ復元される） */
export const CACHE_DIR = path.join(ROOT, ".cache", "pdf");

export const PATHS = {
  /** 認可PDFの一覧（クローラの出力） */
  approvals: path.join(DATA_DIR, "approvals.json"),
  /** 正規化済みの定価レコード（パーサの出力・マスタ） */
  records: path.join(DATA_DIR, "records.json"),
  /** 公開用CSV（スプレッドシートと同じ内容） */
  csv: path.join(DATA_DIR, "tobacco-retail-prices.csv"),
  /** 取得状態（ETag / Last-Modified / ハッシュ）。再実行時の差分検知に使う。 */
  state: path.join(DATA_DIR, "state.json"),
  /** 解析できなかった行のレポート（パーサ改善用） */
  unparsed: path.join(DATA_DIR, "unparsed.json"),
};

/** 財務省「製造たばこの小売定価の認可」インデックスページ */
export const INDEX_URL =
  "https://www.mof.go.jp/policy/tab_salt/topics/kouriteika.html";

/**
 * 相手先は官公庁サイトなので礼儀正しく巡回する。
 * - 逐次アクセス（並列にしない）
 * - リクエスト間に待機
 * - 連絡先を含む User-Agent
 * - 既知のPDFは条件付きGETで再取得しない
 */
export const CRAWL = {
  delayMs: Number(process.env.TOBACCO_CRAWL_DELAY_MS ?? 1500),
  maxNewPdfsPerRun: Number(process.env.TOBACCO_MAX_NEW_PDFS ?? 400),
  timeoutMs: 60_000,
  retries: 3,
  userAgent:
    process.env.TOBACCO_USER_AGENT ??
    "tobacco-prices-bot/1.0 (+https://github.com/MasanoriKatsuragawa/Tobacco-prices; open data mirror of MOF tobacco retail prices)",
};

/** スプレッドシートのタブ名 */
export const SHEET_TABS = {
  prices: "定価一覧",
  approvals: "認可一覧",
  readme: "このシートについて",
};
