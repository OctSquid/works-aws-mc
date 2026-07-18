import { describe, expect, it } from "vitest";
import { parseInteractionOptions } from "../shared/interaction-options";

describe("parseInteractionOptions", () => {
  it("options が無ければ空の結果を返す", () => {
    expect(parseInteractionOptions(undefined)).toEqual({
      subcommandGroup: undefined,
      subcommand: undefined,
      args: {},
    });
  });

  it("トップレベルの leaf オプションは従来どおりフラット化する", () => {
    const parsed = parseInteractionOptions([
      { name: "example", value: true, type: 5 },
      { name: "count", value: 3, type: 4 },
    ]);
    expect(parsed).toEqual({
      subcommandGroup: undefined,
      subcommand: undefined,
      args: { example: true, count: 3 },
    });
  });

  it("SUB_COMMAND を 1 段降りて引数を取り出す", () => {
    const parsed = parseInteractionOptions([
      { type: 1, name: "op", options: [{ type: 3, name: "player", value: "steve" }] },
    ]);
    expect(parsed).toEqual({
      subcommandGroup: undefined,
      subcommand: "op",
      args: { player: "steve" },
    });
  });

  it("SUB_COMMAND_GROUP > SUB_COMMAND > 引数のネストを降りる", () => {
    const parsed = parseInteractionOptions([
      {
        type: 2,
        name: "whitelist",
        options: [{ type: 1, name: "add", options: [{ type: 3, name: "player", value: "alex" }] }],
      },
    ]);
    expect(parsed).toEqual({
      subcommandGroup: "whitelist",
      subcommand: "add",
      args: { player: "alex" },
    });
  });

  it("引数なしの SUB_COMMAND も扱える", () => {
    const parsed = parseInteractionOptions([{ type: 1, name: "banlist" }]);
    expect(parsed).toEqual({ subcommandGroup: undefined, subcommand: "banlist", args: {} });
  });

  it("type が欠落していてもネスト構造からコンテナを判定する", () => {
    const parsed = parseInteractionOptions([
      {
        name: "whitelist",
        options: [{ name: "add", options: [{ name: "player", value: "alex" }] }],
      },
    ]);
    expect(parsed).toEqual({
      subcommandGroup: "whitelist",
      subcommand: "add",
      args: { player: "alex" },
    });
  });

  it("type 欠落の 1 段ネストはサブコマンドとして扱う", () => {
    const parsed = parseInteractionOptions([
      { name: "op", options: [{ name: "player", value: "steve" }] },
    ]);
    expect(parsed).toEqual({
      subcommandGroup: undefined,
      subcommand: "op",
      args: { player: "steve" },
    });
  });
});
