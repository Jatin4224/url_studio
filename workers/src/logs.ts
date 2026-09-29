import { createHmac } from "node:crypto";

type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
type Event = {
  level?: Level;
  message: string;
  eventName?: string;
  traceId?: string;
  attributes?: Record<string, string | number | boolean | null>;
};

const secret = process.env.WORKER_LOG_SECRET;
const endpoint = `${process.env.WEB_URL ?? "http://localhost:3000"}/api/worker-logs`;
const environment = process.env.NODE_ENV ?? "development";
const queue: (Event & { timestamp: number })[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

async function flush() {
  timer = undefined;
  const batch = queue.splice(0, 200);
  if (!batch.length || !secret) return;
  const body = JSON.stringify({ events: batch });
  for (let attempt = 0; attempt < 2; attempt++) {
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body,
        signal: AbortSignal.timeout(10_000),
        headers: {
          "Content-Type": "application/json",
          "X-Worker-Timestamp": timestamp,
          "X-Worker-Signature": `sha256=${signature}`,
        },
      });
      if (response.ok) break;
      if (response.status < 500) {
        console.error(
          `Worker logs rejected by the web app: HTTP ${response.status}`,
        );
        break;
      }
    } catch (error) {
      if (attempt)
        console.error(
          "Worker logs could not reach the web app:",
          error instanceof Error ? error.message : error,
        );
    }
  }
  if (queue.length) timer = setTimeout(flush, 0);
}

function send(event: Event) {
  const record = {
    ...event,
    level: event.level ?? "info",
    timestamp: Date.now(),
    attributes: { environment, ...event.attributes },
  };
  console.log(
    JSON.stringify({
      log: record.eventName,
      level: record.level,
      message: record.message,
      ...record.attributes,
    }),
  );
  // Debug diagnostics stay on the console unless explicitly enabled: normal telemetry is lifecycle events only.
  if (
    !secret ||
    (record.level === "debug" && process.env.WORKER_LOG_DEBUG !== "1")
  )
    return;
  queue.push(record);
  if (queue.length > 5_000) queue.splice(0, queue.length - 5_000);
  timer ??= setTimeout(flush, 2_000);
}

export const log = {
  send,
  info: (event: Event) => send({ ...event, level: "info" }),
  warn: (event: Event) => send({ ...event, level: "warn" }),
  error: (event: Event) => send({ ...event, level: "error" }),
  fatal: (event: Event) => send({ ...event, level: "fatal" }),
  /** Delivers everything still queued, e.g. before the process exits. */
  flush: async () => {
    while (queue.length) await flush();
  },
};

if (!secret)
  console.warn(
    "WORKER_LOG_SECRET is missing; worker monitoring only goes to the console.",
  );
process.once("beforeExit", () => void log.flush());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(
    signal,
    () =>
      void log
        .flush()
        .finally(() => process.exit(signal === "SIGINT" ? 130 : 143)),
  );
}
