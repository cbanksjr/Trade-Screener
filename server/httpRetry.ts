export type RetryOptions = {
  maxRetries?: number;
  baseDelayMs?: number;
  retryStatuses?: number[];
};

const DEFAULT_RETRY_STATUSES = [429, 500, 502, 503, 504];

export async function fetchWithRetry(
  fetchImpl: () => Promise<Response>,
  options: RetryOptions = {}
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 400;
  const retryStatuses = options.retryStatuses ?? DEFAULT_RETRY_STATUSES;

  let response = await fetchImpl();
  for (let attempt = 0; attempt < maxRetries && retryStatuses.includes(response.status); attempt += 1) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
    const delayMs = Number.isFinite(retryAfterMs) ? (retryAfterMs as number) : baseDelayMs * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    response = await fetchImpl();
  }
  return response;
}
