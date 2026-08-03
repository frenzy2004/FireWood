import { ZodError } from "zod";

import { getD1Database } from "@/db";
import {
  AssetRepository,
  assetUpdateSchema,
  type D1DatabaseLike,
  RepositoryNotFoundError,
} from "@/lib/server/repository";

const repository = () =>
  new AssetRepository(getD1Database() as unknown as D1DatabaseLike);

type RouteContext = {
  params: Promise<{ id: string }> | { id: string };
};

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<Response> {
  try {
    const { id } = await context.params;
    if (!id || id.length > 128) {
      return Response.json({ error: "Invalid asset id" }, { status: 400 });
    }
    const payload: unknown = await request.json();
    const parsed = assetUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      return Response.json({ error: "Invalid asset payload" }, { status: 400 });
    }
    const asset = await repository().updateAsset(id, parsed.data);
    return Response.json({ asset });
  } catch (error) {
    if (error instanceof RepositoryNotFoundError) {
      return Response.json({ error: "Asset not found" }, { status: 404 });
    }
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return Response.json({ error: "Invalid asset payload" }, { status: 400 });
    }
    return Response.json({ error: "Asset could not be updated" }, { status: 500 });
  }
}
