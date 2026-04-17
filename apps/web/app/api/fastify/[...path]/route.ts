/**
 * Catch-all proxy: /api/fastify/<path> → FASTIFY_INTERNAL_URL/<path>.
 *
 * Reads the iron-session cookie, attaches the Keycloak access token as a
 * Bearer header, forwards the request, streams the response back. Works for
 * every HTTP method. The access token never crosses the wire to the browser.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

const FASTIFY_URL =
  process.env.FASTIFY_INTERNAL_URL ?? "http://localhost:8787";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const session = await getSession();
  if (!session.access_token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { path } = await ctx.params;
  const suffix = path.join("/");
  const search = req.nextUrl.search;
  const targetUrl = `${FASTIFY_URL}/${suffix}${search}`;

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("Authorization", `Bearer ${session.access_token}`);

  const body = ["GET", "HEAD"].includes(req.method)
    ? undefined
    : await req.arrayBuffer();

  const upstream = await fetch(targetUrl, {
    method: req.method,
    headers,
    body,
    redirect: "manual",
  });

  // Copy response headers (minus hop-by-hop)
  const respHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) respHeaders.set(key, value);
  });

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
