import { describe, expect, it } from "vitest";

import {
  LocalWorkLimiter,
  rejectUnsafeLocalRequest,
} from "../lib/server/local-request";

describe("local API request boundary", () => {
  it("rejects cross-site browser requests to loopback APIs", () => {
    const rejection = rejectUnsafeLocalRequest(
      new Request("http://localhost:3010/api/snapshot?mode=live", {
        headers: {
          Origin: "https://hostile.example",
          Referer: "https://hostile.example/page",
          "Sec-Fetch-Site": "cross-site",
        },
      }),
    );

    expect(rejection?.status).toBe(403);
  });

  it("rejects browser requests whose origin does not match the local app", () => {
    const rejection = rejectUnsafeLocalRequest(
      new Request("http://127.0.0.1:3010/api/agent", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3010",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { requireJson: true },
    );

    expect(rejection?.status).toBe(403);
  });

  it("requires JSON for mutation routes", () => {
    const rejection = rejectUnsafeLocalRequest(
      new Request("http://localhost:3010/api/assets", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      }),
      { requireJson: true },
    );

    expect(rejection?.status).toBe(415);
  });

  it("allows same-origin browser requests and local non-browser clients", () => {
    const browserRequest = new Request("http://localhost:3010/api/agent", {
      method: "POST",
      headers: {
        Origin: "http://localhost:3010",
        Referer: "http://localhost:3010/",
        "Sec-Fetch-Site": "same-origin",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: "{}",
    });
    const localClientRequest = new Request("http://127.0.0.1:3010/api/health");

    expect(rejectUnsafeLocalRequest(browserRequest, { requireJson: true })).toBeNull();
    expect(rejectUnsafeLocalRequest(localClientRequest)).toBeNull();
  });

  it("rejects API requests addressed to a non-loopback host", () => {
    const rejection = rejectUnsafeLocalRequest(
      new Request("https://emberfield.example/api/health"),
    );

    expect(rejection?.status).toBe(403);
  });

  it("bounds concurrent and rapid expensive local work", () => {
    let now = 1_000;
    const limiter = new LocalWorkLimiter({
      maximumConcurrent: 1,
      minimumIntervalMs: 500,
      clock: () => now,
    });

    const release = limiter.tryAcquire();
    expect(release).toBeTypeOf("function");
    expect(limiter.tryAcquire()).toBeNull();
    release?.();
    expect(limiter.tryAcquire()).toBeNull();
    now += 500;
    const nextRelease = limiter.tryAcquire();
    expect(nextRelease).toBeTypeOf("function");
    nextRelease?.();
    nextRelease?.();
  });
});
