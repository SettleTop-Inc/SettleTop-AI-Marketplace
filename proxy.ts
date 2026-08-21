import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(list) {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    }
  );
  // Refresh the session; do not run code between createServerClient and getUser.
  await supabase.auth.getUser();
  return response;
}

// Exclude static assets, API routes (they read the session themselves), the
// auth routes, and metadata files, so the proxy's getUser round-trip runs only
// where a page render needs a fresh session cookie.
export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|auth/|favicon.ico|brand/|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|svg|ico|woff2?)$).*)",
  ],
};
