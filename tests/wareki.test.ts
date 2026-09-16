import { describe, expect, it } from "vitest";
import {
  parseCompactWarekiDate,
  parseJapaneseDate,
  parseNumber,
  toFullWidthKana,
  toHalfWidth,
  toWareki,
} from "../src/wareki.js";

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

describe("parseCompactWarekiDate", () => {
  it("表中の「8.9.19」を認可日の元号で解釈する", () => {
    expect(parseCompactWarekiDate("ﾃﾘｱ 620円 640円 8.9.19", "2026-08-26")).toBe("2026-09-19");
    expect(parseCompactWarekiDate("8.10.1", "2026-08-26")).toBe("2026-10-01");
  });

  it("内容量「40.0g」を日付と取り違えない", () => {
    expect(parseCompactWarekiDate("パイプたばこ NASH 40.0g箱 2,300円", "2026-08-27")).toBeNull();
    expect(parseCompactWarekiDate("152mm 1本", "2026-08-27")).toBeNull();
  });

  it("元号をまたぐと年が変わる", () => {
    // 平成31年の認可なら「31.4.30」は平成31年4月30日
    expect(parseCompactWarekiDate("31.4.30", "2019-04-01")).toBe("2019-04-30");
  });

  it("ありえない月日は null", () => {
    expect(parseCompactWarekiDate("8.13.1", "2026-08-26")).toBeNull();
  });
});

describe("toFullWidthKana", () => {
  it("半角カナを全角にする", () => {
    expect(toFullWidthKana("ﾃﾘｱ")).toBe("テリア");
    expect(toFullWidthKana("ﾒﾃﾞｨｱ･ｺﾛﾅ")).toBe("メディア・コロナ");
  });

  it("濁点・半濁点を合成する", () => {
    expect(toFullWidthKana("ﾊﾟｰﾌﾟﾙ")).toBe("パープル");
    expect(toFullWidthKana("ﾌﾞﾗｯｸ")).toBe("ブラック");
    expect(toFullWidthKana("ｷﾞﾘｼｬ")).toBe("ギリシャ");
  });

  it("カナ以外はそのまま", () => {
    expect(toFullWidthKana("APPLE PUNCH 7,700円")).toBe("APPLE PUNCH 7,700円");
  });
});
