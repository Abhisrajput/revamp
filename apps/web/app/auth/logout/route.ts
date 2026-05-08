import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET(_req: Request) {
  const session = await getSession();
  const idToken = session.id_token;
  session.destroy();

  const endSession = new URL(`${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/logout`);
  // Keycloak 18+ requires either id_token_hint OR client_id alongside post_logout_redirect_uri.
  // We no longer persist the id_token (cookie-size limit), so always pass client_id.
  if (idToken) endSession.searchParams.set("id_token_hint", idToken);
  endSession.searchParams.set(
    "client_id",
    process.env.KEYCLOAK_CLIENT_ID ?? "revamp-web",
  );
  endSession.searchParams.set(
    "post_logout_redirect_uri",
    `${process.env.NEXT_PUBLIC_APP_URL}/`,
  );

  return NextResponse.redirect(endSession.toString());
}
