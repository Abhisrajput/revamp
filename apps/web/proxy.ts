import { NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Check for auth token — try the lightweight cookie first, fall back to Zustand cookie
  let isAuthenticated = false;
  const simpleToken = request.cookies.get('revamp-token')?.value;
  if (simpleToken) {
    isAuthenticated = true;
  } else {
    // Backwards compat: parse the legacy Zustand-serialized cookie
    const legacyCookie = request.cookies.get('auth-store')?.value;
    if (legacyCookie) {
      try {
        const decoded = decodeURIComponent(legacyCookie);
        const parsed = JSON.parse(decoded);
        isAuthenticated = !!parsed.state?.token;
      } catch {
        isAuthenticated = false;
      }
    }
  }

  // Protect dashboard routes
  // BREE Engine dashboard is public (read-only analysis tool, no user data)
  const protectedPaths = ['/projects', '/settings', '/admin', '/dashboard', '/agents'];
  const isProtected = protectedPaths.some((p) => pathname.startsWith(p));

  if (isProtected && !isAuthenticated) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // Redirect authenticated users away from login
  if (pathname === '/login' && isAuthenticated) {
    return NextResponse.redirect(new URL('/projects', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
