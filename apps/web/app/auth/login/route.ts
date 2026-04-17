import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import crypto from "crypto";

function base64url(buf: Buffer) {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function GET(_req: Request) {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(16));

  const session = await getSession();
  session.pkce_verifier = verifier;
  session.oidc_state = state;
  await session.save();

  const url = new URL(`${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/auth`);
  url.searchParams.set("client_id", process.env.KEYCLOAK_CLIENT_ID ?? "revamp-web");
  url.searchParams.set("redirect_uri", `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);

  return NextResponse.redirect(url.toString());
}
