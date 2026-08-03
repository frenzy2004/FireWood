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

interface ResponseLifecycle {
  controller: AbortController;
  timeout: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

const responseLifecycles = new WeakMap<Response, ResponseLifecycle>();

function finishResponse(response: Response, abort = false): void {
  const lifecycle = responseLifecycles.get(response);
  if (!lifecycle) return;
  clearTimeout(lifecycle.timeout);
  if (abort && !lifecycle.controller.signal.aborted) {
    lifecycle.controller.abort();
  }
  responseLifecycles.delete(response);
}

async function cancelResponse(response: Response): Promise<void> {
  const lifecycle = responseLifecycles.get(response);
  try {
    if (lifecycle?.reader) await lifecycle.reader.cancel();
    else await response.body?.cancel();
  } catch {
    // Cancellation is best effort; the normalized adapter error is returned below.
  } finally {
    finishResponse(response, true);
  }
}

export async function fetchWithTimeout(
  source: string,
  url: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const lifecycle = {
    controller,
    timedOut: false,
  } as ResponseLifecycle;
  lifecycle.timeout = setTimeout(() => {
    lifecycle.timedOut = true;
    controller.abort();
    void lifecycle.reader?.cancel().catch(() => undefined);
  }, Math.max(0, timeoutMs));

  try {
    const response = await fetchImplementation(url, {
      ...init,
      signal: controller.signal,
    });
    if (lifecycle.timedOut) {
      clearTimeout(lifecycle.timeout);
      await response.body?.cancel().catch(() => undefined);
      throw new SourceAdapterError(source, "timeout", `${source} request timed out`);
    }
    responseLifecycles.set(response, lifecycle);
    return response;
  } catch (error) {
    clearTimeout(lifecycle.timeout);
    if (error instanceof SourceAdapterError) throw error;
    const code =
      lifecycle.timedOut ||
      (error instanceof DOMException && error.name === "AbortError")
        ? "timeout"
        : "unavailable";
    throw new SourceAdapterError(source, code, `${source} request failed`);
  }
}

export async function boundedText(
  source: string,
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.ok) {
    await cancelResponse(response);
    throw new SourceAdapterError(
      source,
      "upstream-error",
      `${source} returned HTTP ${response.status}`,
    );
  }

  const declaredHeader = response.headers.get("content-length");
  const declaredLength = declaredHeader === null ? null : Number(declaredHeader);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > maximumBytes
  ) {
    await cancelResponse(response);
    throw new SourceAdapterError(
      source,
      "response-too-large",
      `${source} response exceeded the size limit`,
    );
  }

  if (response.body === null) {
    finishResponse(response);
    return "";
  }

  const reader = response.body.getReader();
  const lifecycle = responseLifecycles.get(response);
  if (lifecycle) lifecycle.reader = reader;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (lifecycle?.timedOut) {
        throw new SourceAdapterError(
          source,
          "timeout",
          `${source} request timed out`,
        );
      }
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > maximumBytes) {
        await cancelResponse(response);
        throw new SourceAdapterError(
          source,
          "response-too-large",
          `${source} response exceeded the size limit`,
        );
      }
      chunks.push(chunk.value);
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    finishResponse(response);
    return new TextDecoder().decode(bytes);
  } catch (error) {
    const timedOut =
      lifecycle?.timedOut ||
      (error instanceof DOMException && error.name === "AbortError");
    await cancelResponse(response);
    if (error instanceof SourceAdapterError) throw error;
    throw new SourceAdapterError(
      source,
      timedOut ? "timeout" : "unavailable",
      timedOut
        ? `${source} request timed out`
        : `${source} response body failed`,
    );
  } finally {
    if (lifecycle) lifecycle.reader = undefined;
    try {
      reader.releaseLock();
    } catch {
      // An errored or cancelled reader may already have released its lock.
    }
  }
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
