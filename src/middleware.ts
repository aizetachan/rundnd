import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Routes under the (app) route group require auth. Everything else — landing
// page, sign-in/sign-up, health/ready, auth API endpoints — is public.
const PROTECTED_PREFIXES = ["/campaigns", "/settings", "/admin", "/account"] as const;

function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Edge middleware — runs on every request matching the matcher below.
 *
 * Crucially, this middleware does NOT verify the session cookie
 * cryptographically. Firebase Admin SDK requires Node.js APIs (crypto, fs)
 * that are not available in the Edge runtime where Next middleware runs.
 * Instead, the middleware does a CHEAP presence check: does `__session`
 * exist? If yes, let the request through; the route handler / Server
 * Component will then call `getCurrentUser()` which does the real
 * verification in the Node runtime and 401s if invalid.
 *
 * This is defense-in-depth, not a security relaxation. The presence check
 * redirects unauthenticated users to /sign-in early so we don't render a
 * protected page only to redirect inside it. Real authorization always
 * lives in the route handler.
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (!isProtected(pathname)) {
    return NextResponse.next();
  }

  const hasSession = req.cookies.has("__session");
  if (!hasSession) {
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    url.searchParams.set("redirect", pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Skip Next internals and all static assets.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes so auth context is populated.
    "/(api|trpc)(.*)",
  ],
};
