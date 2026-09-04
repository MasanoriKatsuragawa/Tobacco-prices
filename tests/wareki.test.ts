import { describe, expect, it } from "vitest";
import { parseJapaneseDate, parseNumber, toHalfWidth, toWareki } from "../src/wareki.js";

describe("parseJapaneseDate", () => {
  it("令和を西暦に変換する", () => {
    expect(parseJapaneseDate("令和8年7月30日認可")).toBe("2026-07-30");
  });

  it("元年を1年として扱う", () => {
    expect(parseJapaneseDate("令和元年5月1日")).toBe("2019-05-01");
    expect(parseJapaneseDate("平成元年1月8日")).toBe("1989-01-08");
  });

  it("平成・昭和も扱う", () => {
    expect(parseJapaneseDate("平成31年4月30日")).toBe("2019-04-30");
    expect(parseJapaneseDate("昭和60年4月1日")).toBe("1985-04-01");
  });

  it("全角数字を受け付ける", () => {
    expect(parseJapaneseDate("令和８年１２月１日")).toBe("2026-12-01");
  });

  it("西暦表記も受け付ける", () => {
    expect(parseJapaneseDate("2026年7月30日")).toBe("2026-07-30");
    expect(parseJapaneseDate("2026/7/30")).toBe("2026-07-30");
  });

  it("存在しない日付は null", () => {
    expect(parseJapaneseDate("令和8年2月30日")).toBeNull();
    expect(parseJapaneseDate("銘柄名だけの行")).toBeNull();
  });
});

describe("toWareki", () => {
  it("ISO日付を和暦に戻す", () => {
    expect(toWareki("2026-07-30")).toBe("令和8年7月30日");
    expect(toWareki("2019-05-01")).toBe("令和元年5月1日");
    expect(toWareki("2019-04-30")).toBe("平成31年4月30日");
  });

  it("元号の境界をまたがない", () => {
    expect(toWareki("1989-01-07")).toBe("昭和64年1月7日");
    expect(toWareki("1989-01-08")).toBe("平成元年1月8日");
  });
});

describe("parseNumber", () => {
  it("桁区切りと全角を処理する", () => {
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("６００")).toBe(600);
    expect(parseNumber("600円")).toBe(600);
  });

  it("数字が無ければ null", () => {
    expect(parseNumber("－")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });
});

describe("toHalfWidth", () => {
  it("全角英数と全角スペースを半角にする", () => {
    expect(toHalfWidth("ＡＢＣ１２３　")).toBe("ABC123 ");
  });
});
