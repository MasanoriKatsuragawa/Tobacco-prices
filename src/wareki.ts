/** 和暦・全角数字まわりのユーティリティ。 */

const ERAS: { name: string; alt: string[]; startYear: number; startMonth: number; startDay: number }[] = [
  { name: "令和", alt: ["令和", "R"], startYear: 2019, startMonth: 5, startDay: 1 },
  { name: "平成", alt: ["平成", "H"], startYear: 1989, startMonth: 1, startDay: 8 },
  { name: "昭和", alt: ["昭和", "S"], startYear: 1926, startMonth: 12, startDay: 25 },
];

/** 全角英数字・全角記号を半角に寄せる。 */
export function toHalfWidth(input: string): string {
  return input
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ")
    .replace(/[‐-―−－]/g, "-");
}

/** 表示や照合のための空白正規化。 */
export function normalizeSpace(input: string): string {
  return toHalfWidth(input).replace(/\s+/g, " ").trim();
}

/**
 * 「令和8年7月30日」「令和元年5月1日」「2026年7月30日」「2026/7/30」を ISO 日付にする。
 * 見つからなければ null。
 */
export function parseJapaneseDate(input: string): string | null {
  const s = toHalfWidth(input);

  for (const era of ERAS) {
    const re = new RegExp(`${era.name}\\s*(元|[0-9]{1,2})\\s*年\\s*([0-9]{1,2})\\s*月\\s*([0-9]{1,2})\\s*日`);
    const m = s.match(re);
    if (m) {
      const eraYear = m[1] === "元" ? 1 : Number(m[1]);
      const year = era.startYear + eraYear - 1;
      return isoDate(year, Number(m[2]), Number(m[3]));
    }
  }

  const western = s.match(/(1[89][0-9]{2}|2[0-9]{3})\s*[年/\-.]\s*([0-9]{1,2})\s*[月/\-.]\s*([0-9]{1,2})\s*日?/);
  if (western) {
    return isoDate(Number(western[1]), Number(western[2]), Number(western[3]));
  }

  return null;
}

/** ISO 日付を「令和8年7月30日」形式に戻す。範囲外なら空文字。 */
export function toWareki(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const value = y * 10000 + mo * 100 + d;

  for (const era of ERAS) {
    const start = era.startYear * 10000 + era.startMonth * 100 + era.startDay;
    if (value >= start) {
      const eraYear = y - era.startYear + 1;
      return `${era.name}${eraYear === 1 ? "元" : eraYear}年${mo}月${d}日`;
    }
  }
  return "";
}

function isoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 「1,234」「１２３４」などを数値にする。数値でなければ null。 */
export function parseNumber(input: string): number | null {
  const s = toHalfWidth(input).replace(/[,\s]/g, "");
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** JST の ISO 文字列（例: 2026-08-06T17:00:00+09:00）。 */
export function nowJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.toISOString().slice(0, 19)}+09:00`;
}
