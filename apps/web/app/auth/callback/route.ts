import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return NextResponse.redirect(new URL("/auth/login", req.url));

  const session = await getSession();
  if (!session.oidc_state || session.oidc_state !== state) {
    return new NextResponse("Invalid state", { status: 400 });
  }
  const verifier = session.pkce_verifier;
  if (!verifier) return new NextResponse("Missing PKCE verifier", { status: 400 });

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.KEYCLOAK_CLIENT_ID ?? "revamp-web",
    code,
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/auth/callback`,
    code_verifier: verifier,
  });

  const tokenRes = await fetch(
    `${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    },
  );
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    return new NextResponse(`Token exchange failed: ${text}`, { status: 500 });
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    id_token: string;
    expires_in: number;
  };

  const [, payloadB64] = tokens.id_token.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as {
    sub: string;
    email: string;
    name?: string;
    realm_access?: { roles?: string[] };
  };

  const priority = ["admin", "architect", "developer", "sme"] as const;
  const roles = payload.realm_access?.roles ?? [];
  const role = priority.find((r) => roles.includes(r)) ?? "developer";

  // NOTE: do not persist id_token — combined with access+refresh it blows the 4KB
  // cookie limit (Keycloak RS256 tokens are bulky). We decoded the claims we need
  // (sub/email/name/role) above; the id_token body itself is not needed after this
  // request. Logout falls back to post_logout_redirect_uri without id_token_hint.
  session.access_token = tokens.access_token;
  session.refresh_token = tokens.refresh_token;
  session.expires_at = Date.now() + tokens.expires_in * 1000;
  session.keycloak_sub = payload.sub;
  session.email = payload.email;
  session.name = payload.name;
  session.role = role;
  session.pkce_verifier = undefined;
  session.oidc_state = undefined;
  await session.save();

  return NextResponse.redirect(new URL("/dashboard", req.url));
}
