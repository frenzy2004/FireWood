import type { TtlCache } from "../server/cache";

export type DataMode = "live" | "fixture";
export type AdapterStatus = "ok" | "missing-key";

export interface AdapterDependencies {
  fetchImplementation?: typeof fetch;
  now?: () => Date;
  cache?: TtlCache;
}

export class SourceAdapterError extends Error {
  readonly source: string;
  readonly code: string;

  constructor(source: string, code: string, message: string) {
    super(message);
    this.name = "SourceAdapterError";
    this.source = source;
    this.code = code;
  }
}

export const utcNow = (now: (() => Date) | undefined) =>
  (now?.() ?? new Date()).toISOString();

export async function fetchWithTimeout(
  source: string,
  url: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImplementation(url, { ...init, signal: controller.signal });
  } catch (error) {
    const code =
      error instanceof DOMException && error.name === "AbortError"
        ? "timeout"
        : "unavailable";
    throw new SourceAdapterError(source, code, `${source} request failed`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function boundedText(
  source: string,
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.ok) {
    throw new SourceAdapterError(
      source,
      "upstream-error",
      `${source} returned HTTP ${response.status}`,
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new SourceAdapterError(
      source,
      "response-too-large",
      `${source} response exceeded the size limit`,
    );
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new SourceAdapterError(
      source,
      "response-too-large",
      `${source} response exceeded the size limit`,
    );
  }
  return text;
}

export async function boundedJson(
  source: string,
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const text = await boundedText(source, response, maximumBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SourceAdapterError(
      source,
      "invalid-response",
      `${source} returned invalid JSON`,
    );
  }
}

export const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

export const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};
