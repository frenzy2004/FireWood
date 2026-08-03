const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface LocalRequestOptions {
  requireJson?: boolean;
}

export interface LocalWorkLimiterOptions {
  maximumConcurrent: number;
  minimumIntervalMs?: number;
  clock?: () => number;
}

export class LocalWorkLimiter {
  private active = 0;
  private lastStartedAt = Number.NEGATIVE_INFINITY;
  private readonly maximumConcurrent: number;
  private readonly minimumIntervalMs: number;
  private readonly clock: () => number;

  constructor(options: LocalWorkLimiterOptions) {
    this.maximumConcurrent = Math.max(1, Math.floor(options.maximumConcurrent));
    this.minimumIntervalMs = Math.max(0, options.minimumIntervalMs ?? 0);
    this.clock = options.clock ?? Date.now;
  }

  tryAcquire(): (() => void) | null {
    const now = this.clock();
    if (
      this.active >= this.maximumConcurrent ||
      now - this.lastStartedAt < this.minimumIntervalMs
    ) {
      return null;
    }

    this.active += 1;
    this.lastStartedAt = now;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}

const rejection = (status: number, error: string) =>
  Response.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );

const parsedOrigin = (value: string | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
};

/**
 * Protects loopback-only APIs from browser-to-localhost request forgery.
 * Missing browser metadata remains allowed so local CLI clients and route tests
 * can use the API; modern cross-site browser requests carry Sec-Fetch-Site or a
 * mismatched Origin/Referer and are rejected before any expensive work begins.
 */
export function rejectUnsafeLocalRequest(
  request: Request,
  options: LocalRequestOptions = {},
): Response | null {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    return rejection(403, "Local API request rejected");
  }

  if (
    requestUrl.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(requestUrl.hostname) ||
    requestUrl.username ||
    requestUrl.password
  ) {
    return rejection(403, "Local API request rejected");
  }

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return rejection(403, "Cross-site local API request rejected");
  }

  const origin = parsedOrigin(request.headers.get("origin"));
  if (origin && origin !== requestUrl.origin) {
    return rejection(403, "Cross-site local API request rejected");
  }

  const referer = request.headers.get("referer");
  if (referer) {
    const refererOrigin = parsedOrigin(referer);
    if (refererOrigin !== requestUrl.origin) {
      return rejection(403, "Cross-site local API request rejected");
    }
  }

  if (options.requireJson) {
    const mediaType = request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      return rejection(415, "Content-Type must be application/json");
    }
  }

  return null;
}
