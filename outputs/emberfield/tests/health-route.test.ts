import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {
    FIRMS_MAP_KEY: "worker-only-firms-key",
    AIRNOW_API_KEY: "worker-only-airnow-key",
    OLLAMA_BASE_URL: "http://worker.example",
  },
}));

import { GET } from "../app/api/health/route";

describe("GET /api/health", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ models: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports integrations configured through Worker bindings", async () => {
    const response = await GET();
    const health = await response.json();

    expect(health.integrations.firms).toMatchObject({
      configured: true,
      status: "ready",
    });
    expect(health.integrations.airnow).toMatchObject({
      configured: true,
      status: "ready",
    });
  });
});
