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

/** 半角カナ → 全角カナの対応表。 */
const HANKAKU_KANA: Record<string, string> = {
  "｡": "。", "｢": "「", "｣": "」", "､": "、", "･": "・", "ｰ": "ー",
  "ｱ": "ア", "ｲ": "イ", "ｳ": "ウ", "ｴ": "エ", "ｵ": "オ",
  "ｶ": "カ", "ｷ": "キ", "ｸ": "ク", "ｹ": "ケ", "ｺ": "コ",
  "ｻ": "サ", "ｼ": "シ", "ｽ": "ス", "ｾ": "セ", "ｿ": "ソ",
  "ﾀ": "タ", "ﾁ": "チ", "ﾂ": "ツ", "ﾃ": "テ", "ﾄ": "ト",
  "ﾅ": "ナ", "ﾆ": "ニ", "ﾇ": "ヌ", "ﾈ": "ネ", "ﾉ": "ノ",
  "ﾊ": "ハ", "ﾋ": "ヒ", "ﾌ": "フ", "ﾍ": "ヘ", "ﾎ": "ホ",
  "ﾏ": "マ", "ﾐ": "ミ", "ﾑ": "ム", "ﾒ": "メ", "ﾓ": "モ",
  "ﾔ": "ヤ", "ﾕ": "ユ", "ﾖ": "ヨ",
  "ﾗ": "ラ", "ﾘ": "リ", "ﾙ": "ル", "ﾚ": "レ", "ﾛ": "ロ",
  "ﾜ": "ワ", "ｦ": "ヲ", "ﾝ": "ン",
  "ｧ": "ァ", "ｨ": "ィ", "ｩ": "ゥ", "ｪ": "ェ", "ｫ": "ォ",
  "ｬ": "ャ", "ｭ": "ュ", "ｮ": "ョ", "ｯ": "ッ",
};

const DAKUTEN: Record<string, string> = {
  カ: "ガ", キ: "ギ", ク: "グ", ケ: "ゲ", コ: "ゴ",
  サ: "ザ", シ: "ジ", ス: "ズ", セ: "ゼ", ソ: "ゾ",
  タ: "ダ", チ: "ヂ", ツ: "ヅ", テ: "デ", ト: "ド",
  ハ: "バ", ヒ: "ビ", フ: "ブ", ヘ: "ベ", ホ: "ボ",
  ウ: "ヴ",
};
const HANDAKUTEN: Record<string, string> = { ハ: "パ", ヒ: "ピ", フ: "プ", ヘ: "ペ", ホ: "ポ" };

/**
 * 半角カナを全角カナに直す。濁点・半濁点は前の文字に合成する。
 *
 * 財務省の認可PDFは銘柄名がほぼ全て半角カナ（例: ﾃﾘｱ ･ﾊﾟｰﾌﾟﾙ）なので、
 * これを通さないと「ﾃﾘｱ」と「テリア」が別物として扱われてしまう。
 */
export function toFullWidthKana(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    const base = HANKAKU_KANA[input[i]] ?? input[i];
    const next = input[i + 1];
    if (next === "ﾞ" && DAKUTEN[base]) {
      out += DAKUTEN[base];
      i++;
    } else if (next === "ﾟ" && HANDAKUTEN[base]) {
      out += HANDAKUTEN[base];
      i++;
    } else {
      out += base;
    }
  }
  return out;
}

/**
 * 認可PDFの表で使われる和暦の省略形「8.9.19」を ISO 日付にする。
 *
 * 元号が省略されているので、同じ文書の認可年月日から元号を引き継ぐ。
 * 「40.0g」のような内容量と取り違えないよう、3つ組であることを必須にする。
 */
export function parseCompactWarekiDate(input: string, eraBaseIso: string): string | null {
  const s = toHalfWidth(input);
  const m = s.match(/(?:^|[\s(（])(\d{1,2})\.(\d{1,2})\.(\d{1,2})(?=[\s)）]|$)/);
  if (!m) return null;

  const era = ERAS.find((e) => {
    const iso = eraBaseIso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!iso) return false;
    const value = Number(iso[1]) * 10000 + Number(iso[2]) * 100 + Number(iso[3]);
    return value >= e.startYear * 10000 + e.startMonth * 100 + e.startDay;
  });
  if (!era) return null;

  return isoDate(era.startYear + Number(m[1]) - 1, Number(m[2]), Number(m[3]));
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
