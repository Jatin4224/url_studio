import { createHmac, timingSafeEqual } from "node:crypto";
import { workerLog } from "@/lib/logs";

export const runtime = "nodejs";

const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
type Level = (typeof levels)[number];
type Primitive = string | number | boolean | null;

export async function POST(request: Request) {
  const secret = process.env.WORKER_LOG_SECRET;
  if (!secret)
    return Response.json(
      { error: "Worker logging is not configured." },
      { status: 503 },
    );
  const body = await request.text();
  if (body.length > 256 * 1024)
    return Response.json({ error: "Batch is too large." }, { status: 413 });
  const timestamp = request.headers.get("x-worker-timestamp") ?? "";
  const signature = request.headers.get("x-worker-signature") ?? "";
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000
  ) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }
  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex"),
  );
  const received = Buffer.from(signature.replace(/^sha256=/, ""));
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  ) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }
  let events: unknown;
  try {
    events = JSON.parse(body).events;
  } catch {
    return Response.json(
      { error: "Send a valid JSON batch." },
      { status: 400 },
    );
  }
  if (!Array.isArray(events) || events.length > 200)
    return Response.json({ error: "Send up to 200 events." }, { status: 400 });
  let accepted = 0;
  for (const event of events) {
    if (!event || typeof event.message !== "string") continue;
    const attributes: Record<string, Primitive> = {};
    for (const [key, value] of Object.entries(event.attributes ?? {})) {
      if (
        value === null ||
        ["string", "number", "boolean"].includes(typeof value)
      )
        attributes[key.slice(0, 100)] = value as Primitive;
    }
    await workerLog?.send({
      level: levels.includes(event.level) ? (event.level as Level) : "info",
      message: event.message.slice(0, 2000),
      eventName:
        typeof event.eventName === "string"
          ? event.eventName.slice(0, 100)
          : undefined,
      timestamp:
        typeof event.timestamp === "number" ? event.timestamp : undefined,
      traceId:
        typeof event.traceId === "string" &&
        /^[0-9a-f]{32}$/.test(event.traceId)
          ? event.traceId
          : undefined,
      attributes,
    });
    accepted++;
  }
  return Response.json({ accepted });
}
