import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

export async function GET(_req: Request) {
  const session = await getSession();
  const idToken = session.id_token;
  session.destroy();

  const endSession = new URL(`${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/logout`);
  if (idToken) endSession.searchParams.set("id_token_hint", idToken);
  endSession.searchParams.set(
    "post_logout_redirect_uri",
    `${process.env.NEXT_PUBLIC_APP_URL}/`,
  );

  return NextResponse.redirect(endSession.toString());
}
