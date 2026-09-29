import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const ADMIN_COOKIE = "studio_admin";
export const SESSION_SECONDS = 24 * 60 * 60;

export function passwordMatches(value: string) {
  const password = process.env.ADMIN_PASSWORD;
  return !!password && timingSafeEqual(
    createHash("sha256").update(value).digest(),
    createHash("sha256").update(password).digest(),
  );
}

function sign(expires: string) {
  return createHmac("sha256", process.env.ADMIN_PASSWORD!).update(`studio-admin:${expires}`).digest("hex");
}

export function createSession() {
  const expires = String(Date.now() + SESSION_SECONDS * 1000);
  return `${expires}.${sign(expires)}`;
}

export function sessionExpiry(token?: string): number {
  if (!process.env.ADMIN_PASSWORD || !token) return 0;
  const [expires, signature, extra] = token.split(".");
  if (extra || !/^\d+$/.test(expires) || !/^[a-f0-9]{64}$/.test(signature ?? "")) return 0;
  const time = Number(expires);
  if (time <= Date.now() || time > Date.now() + SESSION_SECONDS * 1000) return 0;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(sign(expires), "hex")) ? time : 0;
}
