import { geocodeAddress } from "@/lib/sources/census";
import { SourceAdapterError } from "@/lib/sources/shared";
import { rejectUnsafeLocalRequest } from "@/lib/server/local-request";

export async function GET(request: Request): Promise<Response> {
  const rejected = rejectUnsafeLocalRequest(request);
  if (rejected) return rejected;
  const address = new URL(request.url).searchParams.get("address") ?? "";
  try {
    const result = await geocodeAddress(address);
    return Response.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const invalid = error instanceof SourceAdapterError && error.code === "invalid-address";
    return Response.json(
      {
        status: "error",
        code: invalid ? "invalid-address" : "unavailable",
        error: invalid ? "Address must contain 1 to 100 characters" : "Geocoding is unavailable",
      },
      { status: invalid ? 400 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
