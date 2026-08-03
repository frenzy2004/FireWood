import { env } from "cloudflare:workers";

import { buildHealth } from "@/lib/server/config";
import { rejectUnsafeLocalRequest } from "@/lib/server/local-request";

export async function GET(
  request = new Request("http://localhost/api/health"),
): Promise<Response> {
  const rejected = rejectUnsafeLocalRequest(request);
  if (rejected) return rejected;
  const health = await buildHealth(env);

  return Response.json(health, {
    headers: { "Cache-Control": "no-store" },
  });
}
