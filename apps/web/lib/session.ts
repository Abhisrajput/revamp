import { cookies } from "next/headers";
import { getIronSession, type SessionOptions } from "iron-session";

export interface RevampSession {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: number; // epoch ms
  keycloak_sub?: string;
  email?: string;
  name?: string;
  role?: "admin" | "architect" | "developer" | "sme";
  pkce_verifier?: string;
  oidc_state?: string;
}

const options: SessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: "revamp_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    httpOnly: true,
    path: "/",
  },
  ttl: 60 * 60 * 12,
};

export async function getSession() {
  return getIronSession<RevampSession>(await cookies(), options);
}
