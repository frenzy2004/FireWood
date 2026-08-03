import { afterEach, describe, expect, it, vi } from "vitest";

const workerEnvironment = vi.hoisted(() => ({
  DB: undefined as unknown,
  OLLAMA_BASE_URL: "http://127.0.0.1:11434",
  OLLAMA_MODEL: "gemma4:12b",
}));
vi.mock("cloudflare:workers", () => ({ env: workerEnvironment }));

import { POST as agentRoute } from "../app/api/agent/route";
import { DEMO_ASSET } from "../lib/fixtures/demo";

describe("agent route local boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects cross-site requests before model or database work", async () => {
    const response = await agentRoute(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "cross-site",
        },
        body: JSON.stringify({ prompt: "Brief me", assetId: "asset-1" }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it("rejects agent request bodies larger than 16 KB before parsing", async () => {
    const response = await agentRoute(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "x".repeat(17_000),
          assetId: DEMO_ASSET.id,
        }),
      }),
    );

    expect(response.status).toBe(413);
  });

  it("rejects fixture evidence for every saved non-demo asset", async () => {
    const response = await agentRoute(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Brief this saved orchard.",
          assetId: "saved-orchard",
          mode: "fixture",
        }),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Fixture mode is available only for the virtual demo asset",
    });
  });

  it("allows the explicit virtual demo to request live evidence coherently", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          model: "gemma4:12b",
          done: true,
          done_reason: "stop",
          message: { role: "assistant", content: "I need evidence before making claims." },
        }),
      ),
    );

    const response = await agentRoute(
      new Request("http://localhost/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "Brief the demo using live sources.",
          assetId: DEMO_ASSET.id,
          mode: "live",
        }),
      }),
    );

    expect(response.status).toBe(200);
  });
});
