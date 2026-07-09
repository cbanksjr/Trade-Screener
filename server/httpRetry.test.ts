import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./httpRetry";

function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({}), { status, headers });
}

describe("fetchWithRetry", () => {
  it("returns immediately on a successful response without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200));

    const response = await fetchWithRetry(fetchImpl, { baseDelayMs: 1 });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and eventually succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200));

    const response = await fetchWithRetry(fetchImpl, { baseDelayMs: 1, maxRetries: 2 });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once maxRetries is exhausted and returns the last response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503));

    const response = await fetchWithRetry(fetchImpl, { baseDelayMs: 1, maxRetries: 2 });

    expect(response.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry statuses outside the retry list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404));

    const response = await fetchWithRetry(fetchImpl, { baseDelayMs: 1 });

    expect(response.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors the Retry-After header when present", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(429, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200));

    const start = Date.now();
    const response = await fetchWithRetry(fetchImpl, { baseDelayMs: 5000, maxRetries: 1 });

    expect(response.status).toBe(200);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("retries thrown transient fetch failures", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("network reset"))
      .mockResolvedValueOnce(jsonResponse(200));

    const response = await fetchWithRetry(fetchImpl, { baseDelayMs: 1, maxRetries: 1 });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts slow attempts and retries before failing", async () => {
    const fetchImpl = vi.fn((signal?: AbortSignal) => new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }));

    await expect(fetchWithRetry(fetchImpl, { timeoutMs: 1, baseDelayMs: 1, maxRetries: 1 })).rejects.toThrow("Request timed out");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
