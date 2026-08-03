import { buildHealth } from "@/lib/server/config";

export async function GET(): Promise<Response> {
  const health = await buildHealth();

  return Response.json(health, {
    headers: { "Cache-Control": "no-store" },
  });
}
