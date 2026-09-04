import { CRAWL } from "./config.js";

export type FetchMeta = {
  etag?: string;
  lastModified?: string;
};

export type FetchResult = {
  /** 304 Not Modified のとき true（body は空） */
  notModified: boolean;
  status: number;
  body: Buffer;
  contentType: string;
  meta: FetchMeta;
};

let lastRequestAt = 0;

/** 前回リクエストから CRAWL.delayMs 経つまで待つ。 */
async function polite(): Promise<void> {
  const wait = lastRequestAt + CRAWL.delayMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 条件付きGET付きの取得。
 * 5xx とネットワークエラーのみ指数バックオフで再試行する（4xx は再試行しない）。
 */
export async function fetchUrl(url: string, prev?: FetchMeta): Promise<FetchResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= CRAWL.retries; attempt++) {
    if (attempt > 0) await sleep(2000 * 2 ** (attempt - 1));
    await polite();

    const headers: Record<string, string> = {
      "user-agent": CRAWL.userAgent,
      accept: "text/html,application/xhtml+xml,application/pdf,*/*",
      "accept-language": "ja,en;q=0.8",
    };
    if (prev?.etag) headers["if-none-match"] = prev.etag;
    if (prev?.lastModified) headers["if-modified-since"] = prev.lastModified;

    try {
      const res = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(CRAWL.timeoutMs),
      });

      if (res.status === 304) {
        return {
          notModified: true,
          status: 304,
          body: Buffer.alloc(0),
          contentType: res.headers.get("content-type") ?? "",
          meta: prev ?? {},
        };
      }

      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
      }

      return {
        notModified: false,
        status: res.status,
        body: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get("content-type") ?? "",
        meta: {
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
        },
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`取得に失敗しました: ${url} (${String(lastError)})`);
}

/**
 * HTML を文字コードを見て文字列化する。
 * 財務省のページは UTF-8 と Shift_JIS が混在しうるので meta / Content-Type から判定する。
 */
export function decodeHtml(body: Buffer, contentType: string): string {
  const fromHeader = contentType.match(/charset=([\w-]+)/i)?.[1];
  const head = body.subarray(0, 4096).toString("latin1");
  const fromMeta =
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ??
    head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i)?.[1];

  const candidates = [fromHeader, fromMeta, "utf-8"].filter(Boolean) as string[];
  for (const label of candidates) {
    try {
      const decoded = new TextDecoder(normalizeCharset(label), { fatal: false }).decode(body);
      // 文字化けの雑な検出: 置換文字が多すぎるなら次の候補へ
      const replacements = (decoded.match(/�/g) ?? []).length;
      if (replacements < decoded.length / 200) return decoded;
    } catch {
      // 未知のエンコーディング名は無視して次へ
    }
  }
  return body.toString("utf8");
}

function normalizeCharset(label: string): string {
  const l = label.toLowerCase();
  if (l === "x-sjis" || l === "sjis" || l === "ms_kanji") return "shift_jis";
  return l;
}
