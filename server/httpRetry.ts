export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  retryStatuses?: number[];
  timeoutMs?: number;
};

const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504];
const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchWithRetry(
  fetchImpl: (signal?: AbortSignal) => Promise<Response>,
  options: RetryOptions = {}
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const retryStatuses = options.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let response: Response;
    try {
      response = await fetchWithTimeout(fetchImpl, timeoutMs);
    } catch (error) {
      if (attempt >= maxRetries) throw error;
      await delay(baseDelayMs * 2 ** attempt);
      continue;
    }

    if (!retryStatuses.includes(response.status) || attempt >= maxRetries) return response;
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    await delay(Number.isFinite(retryAfterMs) ? (retryAfterMs as number) : baseDelayMs * 2 ** attempt);
  }
  throw new Error("Request retry loop exited unexpectedly.");
}

async function fetchWithTimeout(fetchImpl: (signal?: AbortSignal) => Promise<Response>, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Request timed out after " + timeoutMs + "ms.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
