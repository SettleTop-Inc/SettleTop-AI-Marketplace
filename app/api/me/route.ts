import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth";

export async function GET() {
  const profile = await getSessionProfile();
  return NextResponse.json(profile ? { email: profile.email, role: profile.role } : null, {
    headers: { "Cache-Control": "no-store" },
  });
}
