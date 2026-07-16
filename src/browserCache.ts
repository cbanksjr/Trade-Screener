import type { LocalSessionSnapshot } from "../shared/types";

const STORAGE_KEY = "trade-screener:local-session:v1";
const CACHE_VERSION = 1;

type StoredSnapshot = {
  version: typeof CACHE_VERSION;
  snapshot: LocalSessionSnapshot;
};

export async function loadBrowserSession(storage: Storage = window.localStorage): Promise<LocalSessionSnapshot | undefined> {
  const stored = storage.getItem(STORAGE_KEY);
  if (!stored) return undefined;
  try {
    const decoded = await decode(stored);
    const parsed = JSON.parse(decoded) as Partial<StoredSnapshot>;
    if (parsed.version !== CACHE_VERSION || !isSessionSnapshot(parsed.snapshot)) return undefined;
    return {
      ...parsed.snapshot,
      scanStatus: parsed.snapshot.lastScanFinishedAt
        ? parsed.snapshot.scanStatus === "failed" ? "failed" : "complete"
        : "idle",
      isRefreshing: false
    };
  } catch {
    return undefined;
  }
}

export async function saveBrowserSession(snapshot: LocalSessionSnapshot, storage: Storage = window.localStorage): Promise<void> {
  const normalized: StoredSnapshot = {
    version: CACHE_VERSION,
    snapshot: {
      ...snapshot,
      scanStatus: snapshot.lastScanFinishedAt
        ? snapshot.scanStatus === "failed" ? "failed" : "complete"
        : "idle",
      isRefreshing: false,
      cachedAt: new Date().toISOString()
    }
  };
  storage.setItem(STORAGE_KEY, await encode(JSON.stringify(normalized)));
}

export function clearBrowserSession(storage: Storage = window.localStorage): void {
  storage.removeItem(STORAGE_KEY);
}

function isSessionSnapshot(value: unknown): value is LocalSessionSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<LocalSessionSnapshot>;
  return Array.isArray(snapshot.results)
    && Array.isArray(snapshot.watchlist)
    && Boolean(snapshot.settings && typeof snapshot.settings === "object")
    && Boolean(snapshot.runtimeCache && typeof snapshot.runtimeCache === "object");
}

async function encode(value: string): Promise<string> {
  if (typeof CompressionStream === "undefined") return "json:" + value;
  const stream = new Blob([value]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return "gzip:" + bytesToBase64(bytes);
}

async function decode(value: string): Promise<string> {
  if (value.startsWith("json:")) return value.slice(5);
  if (!value.startsWith("gzip:") || typeof DecompressionStream === "undefined") {
    throw new Error("Unsupported browser cache encoding.");
  }
  const bytes = base64ToBytes(value.slice(5));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
