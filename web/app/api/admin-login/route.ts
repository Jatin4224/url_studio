import { cookies } from "next/headers";
import { ADMIN_COOKIE, SESSION_SECONDS, createSession, passwordMatches } from "@/lib/admin-session";

// Small per-process backoff; no external store required.
let failures = 0;
let resetAt = 0;

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Invalid origin." }, { status: 403 });
  }
  if (!process.env.ADMIN_PASSWORD) {
    return Response.json({ error: "Set ADMIN_PASSWORD on the server first." }, { status: 503 });
  }
  if (Date.now() > resetAt) { failures = 0; resetAt = Date.now() + 60_000; }
  if (failures >= 10) {
    return Response.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });
  }
  const body = await request.json().catch(() => null);
  if (typeof body?.password !== "string" || body.password.length > 1024 || !passwordMatches(body.password)) {
    failures++;
    return Response.json({ error: "Incorrect password." }, { status: 401 });
  }
  failures = 0;
  (await cookies()).set(ADMIN_COOKIE, createSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
