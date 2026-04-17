import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET() {
  const s = await getSession();
  if (!s.access_token) return NextResponse.json({ user: null }, { status: 200 });
  return NextResponse.json({
    user: {
      id: s.keycloak_sub,
      email: s.email,
      name: s.name,
      role: s.role,
    },
  });
}
