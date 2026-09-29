import { NextRequest, NextResponse } from "next/server";
import { ADMIN_COOKIE, sessionExpiry } from "@/lib/admin-session";

export function proxy(request: NextRequest) {
  if (!sessionExpiry(request.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: "Admin login required." }, { status: 401 });
  }
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = { matcher: ["/api/oneminutelogs/:path*"] };
