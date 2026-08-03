import { env } from "cloudflare:workers";

import { buildHealth } from "@/lib/server/config";

export async function GET(): Promise<Response> {
  const health = await buildHealth(env);

  return Response.json(health, {
    headers: { "Cache-Control": "no-store" },
  });
}
