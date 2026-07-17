import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editOriginalResponse, sendFollowup } from "../shared/discord";

interface MockResponse {
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}

function response(status: number, body = "", headers: Record<string, string> = {}): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

const fetchMock = vi.fn<() => Promise<MockResponse>>();

describe("discordRequest のリトライ", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("@original 編集は 404 をバックオフ付きで再試行する（deferred ACK レース対策）", async () => {
    fetchMock
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200));

    const promise = editOriginalResponse("app", "tok", "hi");
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("followup の 404 は再試行せず即 throw する", async () => {
    fetchMock.mockResolvedValue(response(404));

    const promise = sendFollowup("app", "tok", "hi").catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Discord API");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("429 は retry_after（秒）を尊重して再試行する", async () => {
    fetchMock
      .mockResolvedValueOnce(response(429, JSON.stringify({ retry_after: 0.5 })))
      .mockResolvedValueOnce(response(200));

    const promise = sendFollowup("app", "tok", "hi");
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("5xx は再試行して回復できる", async () => {
    fetchMock
      .mockResolvedValueOnce(response(502))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200));

    const promise = sendFollowup("app", "tok", "hi");
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ネットワークエラーも再試行する", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValueOnce(response(200));

    const promise = sendFollowup("app", "tok", "hi");
    await vi.runAllTimersAsync();
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("リトライ枯渇時は throw する（握り潰さない）", async () => {
    fetchMock.mockResolvedValue(response(500));

    const promise = sendFollowup("app", "tok", "hi").catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Discord API");
    // 初回 + 5xx リトライ 2 回で打ち止め
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("400 系（429/対象 404 以外）は即 throw する", async () => {
    fetchMock.mockResolvedValue(response(400, '{"message":"bad request"}'));

    const promise = editOriginalResponse("app", "tok", "hi").catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("Discord API");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
