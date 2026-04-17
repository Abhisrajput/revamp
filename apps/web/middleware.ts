import { NextResponse, type NextRequest } from "next/server";
import { getIronSession, type SessionOptions } from "iron-session";
import type { RevampSession } from "@/lib/session";

const options: SessionOptions = {
  password: process.env.SESSION_SECRET!,
  cookieName: "revamp_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    httpOnly: true,
    path: "/",
  },
};

const PUBLIC_PATHS = [
  /^\/auth\//,
  /^\/setup/,
  /^\/_next\//,
  /^\/favicon/,
  /^\/api\/health/,
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.some((r) => r.test(pathname))) return NextResponse.next();

  const res = NextResponse.next();

  // iron-session v8 two-arg form requires a CookieStore with both get() and set().
  // In middleware: reads come from req.cookies (request), writes go to res.cookies (response).
  // We proxy the two into a single object whose set() delegates to res.cookies.set
  // (which already satisfies iron-session's overloaded CookieStore.set signature).
  const cookieStore = {
    get: (name: string) => req.cookies.get(name),
    set: res.cookies.set.bind(res.cookies) as typeof res.cookies.set,
  };

  const session = await getIronSession<RevampSession>(cookieStore, options);

  if (!session.access_token || !session.expires_at) {
    const login = new URL("/auth/login", req.url);
    login.searchParams.set("return_to", pathname);
    return NextResponse.redirect(login);
  }

  // Silent refresh if within 60s of expiry
  if (session.expires_at - Date.now() < 60_000 && session.refresh_token) {
    try {
      const form = new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.KEYCLOAK_CLIENT_ID ?? "revamp-web",
        refresh_token: session.refresh_token,
      });
      const r = await fetch(
        `${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        },
      );
      if (!r.ok) throw new Error("refresh failed");
      const t = (await r.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      session.access_token = t.access_token;
      session.refresh_token = t.refresh_token;
      session.expires_at = Date.now() + t.expires_in * 1000;
      await session.save();
    } catch {
      session.destroy();
      const login = new URL("/auth/login", req.url);
      login.searchParams.set("return_to", pathname);
      return NextResponse.redirect(login);
    }
  }

  return res;
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
