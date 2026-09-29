import { cookies } from "next/headers";
import { ADMIN_COOKIE, sessionExpiry } from "@/lib/admin-session";
import LogsClient from "./logs-client";
import PasswordGate from "./password-gate";

export default async function LogsPage() {
  const expires = sessionExpiry((await cookies()).get(ADMIN_COOKIE)?.value);
  return expires ? <LogsClient expires={expires} /> : <PasswordGate />;
}
