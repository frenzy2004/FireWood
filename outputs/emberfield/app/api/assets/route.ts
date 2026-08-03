import { ZodError } from "zod";

import { getD1Database } from "@/db";
import {
  AssetRepository,
  assetCreateSchema,
  type D1DatabaseLike,
} from "@/lib/server/repository";

const repository = () =>
  new AssetRepository(getD1Database() as unknown as D1DatabaseLike);

export async function GET(): Promise<Response> {
  try {
    return Response.json(
      { assets: await repository().listAssets() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Saved assets are unavailable" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const payload: unknown = await request.json();
    const parsed = assetCreateSchema.safeParse(payload);
    if (!parsed.success) {
      return Response.json({ error: "Invalid asset payload" }, { status: 400 });
    }
    const asset = await repository().createAsset(parsed.data);
    return Response.json({ asset }, { status: 201 });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return Response.json({ error: "Invalid asset payload" }, { status: 400 });
    }
    return Response.json({ error: "Asset could not be saved" }, { status: 500 });
  }
}
