import { NextResponse } from "next/server";
import { getPassportByAssetId } from "@/lib/registry";
import { rateLimit, globalReadTake } from "@/lib/rate-limit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  if (!UUID.test(assetId)) {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const okGlobal = await globalReadTake();
  const okIp = await rateLimit("passport", 0.5, 30);
  if (!okGlobal || !okIp) {
    return NextResponse.json(
      { error: "You are moving quickly. Sign in for higher limits, or slow down and try again in a moment." },
      { status: 429 }
    );
  }
  const r = await getPassportByAssetId(assetId);
  if (!r.ok) {
    return NextResponse.json(
      { error: "Something went wrong loading this passport. Try again." },
      { status: 500 }
    );
  }
  if (!r.data) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json(r.data);
}
