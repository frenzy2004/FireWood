import { afterEach, describe, expect, it, vi } from "vitest";

import { buildHealth, getRuntimeConfig } from "../lib/server/config";

const okFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ models: [] }), { status: 200 });

describe("runtime configuration and source health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports required and optional integrations without exposing secrets", async () => {
    const health = await buildHealth(
      { FIRMS_MAP_KEY: "secret", AIRNOW_API_KEY: "" },
      okFetch,
    );

    expect(health.integrations.firms).toMatchObject({ configured: true });
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("uses defaults and prefers worker bindings over process environment", () => {
    const previousUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = "http://process.example";

    try {
      expect(
        getRuntimeConfig({ OLLAMA_BASE_URL: "http://worker.example" })
          .ollama.baseUrl,
      ).toBe("http://worker.example");
      expect(getRuntimeConfig({}).ollama.model).toBe("gemma4:12b");
    } finally {
      if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL;
      else process.env.OLLAMA_BASE_URL = previousUrl;
    }
  });

  it("labels a missing firms key without probing the unavailable source", async () => {
    const health = await buildHealth({ FIRMS_MAP_KEY: "" }, okFetch);

    expect(health.integrations.firms).toMatchObject({
      configured: false,
      status: "missing-key",
    });
  });

  it("labels an unavailable Ollama source as offline", async () => {
    const offlineFetch: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const health = await buildHealth({}, offlineFetch);

    expect(health.integrations.ollama).toMatchObject({ status: "offline" });
  });

  it("labels a rejected Ollama probe as an error", async () => {
    const rejectedFetch: typeof fetch = async () => new Response(null, { status: 503 });

    const health = await buildHealth({}, rejectedFetch);

    expect(health.integrations.ollama).toMatchObject({ status: "error" });
  });

  it("bounds the Ollama probe to two seconds", async () => {
    vi.useFakeTimers();
    const timeoutFetch: typeof fetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Timed out", "AbortError")),
        );
      });

    const pendingHealth = buildHealth({}, timeoutFetch);
    await vi.advanceTimersByTimeAsync(2_000);
    const health = await pendingHealth;

    expect(health.integrations.ollama).toMatchObject({ status: "offline" });
  });
});
