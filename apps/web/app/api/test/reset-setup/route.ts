import { NextResponse } from "next/server";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Disabled in production" }, { status: 403 });
  }
  const API = process.env.FASTIFY_INTERNAL_URL ?? "http://localhost:8787";
  const r = await fetch(`${API}/internal/test/reset-setup`, { method: "POST" });
  const body = await r.json().catch(() => ({}));
  return NextResponse.json({ ok: r.ok, ...(body as object) });
}
