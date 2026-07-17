import { describe, expect, it } from "vitest";
import {
  pickGithubAsset,
  pickMinecraftVersion,
  pickModrinthFile,
  pickModrinthVersion,
  type ModrinthVersion,
} from "../selection.js";

describe("pickMinecraftVersion (PaperMC Fill v3)", () => {
  const versions = {
    "26.1": ["26.1.2", "26.1.1", "26.1"],
    "26.2": ["26.2.0-rc1", "26.2.0-pre2"],
  };

  it("具体バージョンの指定はそのまま返す", () => {
    expect(pickMinecraftVersion("26.1.1", versions)).toBe("26.1.1");
  });

  it("ファミリー指定は最新の安定版に解決する", () => {
    expect(pickMinecraftVersion("26.1", versions)).toBe("26.1");
    // "26.1" は具体バージョンとしても存在するためそのまま。純粋なファミリーの場合:
    expect(pickMinecraftVersion("26.3", { "26.3": ["26.3.1", "26.3.0"] })).toBe("26.3.1");
  });

  it("rc / pre はファミリー解決の対象にしない", () => {
    expect(() => pickMinecraftVersion("26.2", versions)).toThrow(/not found/);
  });

  it("存在しないバージョンは利用可能ファミリー一覧付きで throw する", () => {
    expect(() => pickMinecraftVersion("99.9", versions)).toThrow(/available families: 26.1, 26.2/);
  });
});

describe("pickModrinthVersion / pickModrinthFile", () => {
  const versions: ModrinthVersion[] = [
    {
      version_number: "2.0.0",
      loaders: ["paper"],
      files: [
        { url: "https://cdn/2.0.0-sources.jar", primary: false },
        { url: "https://cdn/2.0.0.jar", primary: true },
      ],
    },
    {
      version_number: "1.9.0",
      loaders: ["paper"],
      files: [{ url: "https://cdn/1.9.0.jar", primary: false }],
    },
  ];

  it("latest は先頭（最新）のバージョンを選ぶ", () => {
    expect(pickModrinthVersion(versions, "latest")?.version_number).toBe("2.0.0");
  });

  it("バージョン指定は version_number 一致で選ぶ", () => {
    expect(pickModrinthVersion(versions, "1.9.0")?.version_number).toBe("1.9.0");
    expect(pickModrinthVersion(versions, "0.0.1")).toBeUndefined();
  });

  it("primary ファイルを優先し、無ければ先頭を選ぶ", () => {
    expect(pickModrinthFile(versions[0]!)?.url).toBe("https://cdn/2.0.0.jar");
    expect(pickModrinthFile(versions[1]!)?.url).toBe("https://cdn/1.9.0.jar");
    expect(pickModrinthFile({ version_number: "x", loaders: [], files: [] })).toBeUndefined();
  });
});

describe("pickGithubAsset", () => {
  const assets = [
    { name: "Plugin-1.0-sources.jar", browser_download_url: "https://gh/sources.jar" },
    { name: "Plugin-1.0.jar", browser_download_url: "https://gh/plugin.jar" },
    { name: "Plugin-1.0.zip", browser_download_url: "https://gh/plugin.zip" },
  ];

  it("assetPattern（正規表現）に一致する最初のアセットを選ぶ", () => {
    expect(pickGithubAsset(assets, "^Plugin-.*(?<!sources)\\.jar$")?.browser_download_url).toBe(
      "https://gh/plugin.jar",
    );
  });

  it("一致しなければ undefined", () => {
    expect(pickGithubAsset(assets, "\\.tar\\.gz$")).toBeUndefined();
  });
});
