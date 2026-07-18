import { describe, expect, it } from "vitest";
import { shellQuote, truncateTail } from "../shared/util";

describe("shellQuote", () => {
  it("通常の文字列を単一クォートで包む", () => {
    expect(shellQuote("op steve")).toBe("'op steve'");
  });

  it.each([
    ["'; rm -rf / #", `''\\''; rm -rf / #'`],
    ["$(reboot)", "'$(reboot)'"],
    ["`reboot`", "'`reboot`'"],
    ["a && b | c > d", "'a && b | c > d'"],
  ])("シェルメタ文字を無害化する: %s", (input, expected) => {
    expect(shellQuote(input)).toBe(expected);
  });

  it("単一クォートを '\\'' でエスケープする", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("truncateTail", () => {
  it("上限以内はそのまま返す", () => {
    expect(truncateTail("abc", 10)).toBe("abc");
  });

  it("上限超過は末尾（最新側）を残して切り詰める", () => {
    const text = "old-old-old\nnew-new-new";
    const result = truncateTail(text, 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain("切り詰め");
    expect(result.endsWith("new-new-new")).toBe(true);
  });
});
