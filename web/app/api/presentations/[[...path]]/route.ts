import { log } from "@/lib/logs";

export const runtime = "nodejs";
let workerUnavailableReported = false;

async function forward(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await context.params;
  const valid =
    path.length === 0 ||
    (path.length <= 2 &&
      /^[a-f0-9-]{36}$/.test(path[0]) &&
      (!path[1] || path[1] === "video"));
  if (
    !valid ||
    (request.method === "POST" ? path.length !== 0 : path.length === 0)
  ) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const video = path[1] === "video";
  const headers = new Headers();
  let body: string | undefined;
  if (request.method === "POST") {
    body = await request.text();
    if (body.length > 4096)
      return Response.json(
        { error: "Website URL is too long." },
        { status: 413 },
      );
    headers.set("Content-Type", "application/json");
  }
  if (request.headers.has("range"))
    headers.set("Range", request.headers.get("range")!);
  try {
    const download = video && new URL(request.url).searchParams.has("download");
    const response = await fetch(
      `${process.env.WORKER_URL}/jobs${path.length ? `/${path.join("/")}` : ""}${download ? "?download=1" : ""}`,
      {
        method: request.method,
        headers,
        body,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.any([
          request.signal,
          AbortSignal.timeout(video ? 120_000 : 15_000),
        ]),
      },
    );
    workerUnavailableReported = false;
    const location = response.headers.get("location");
    if (video && response.status === 302 && location) {
      return new Response(null, {
        status: 302,
        headers: { Location: location, "Cache-Control": "no-store" },
      });
    }
    if (!video || !response.ok) {
      return Response.json(await response.json(), {
        status: response.status,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const outgoing = new Headers({
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
    });
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      if (response.headers.has(name))
        outgoing.set(name, response.headers.get(name)!);
    }
    if (download) {
      outgoing.set(
        "Content-Disposition",
        'attachment; filename="oneminute-presentation.mp4"',
      );
    }
    return new Response(response.body, {
      status: response.status,
      headers: outgoing,
    });
  } catch {
    if (!workerUnavailableReported) {
      workerUnavailableReported = true;
      await log?.error({
        message: "Presentation worker unavailable",
        eventName: "presentation.worker.unavailable",
        attributes: { jobId: path[0] ?? null },
      });
    }
    return Response.json(
      {
        error:
          "The studio is temporarily unavailable. Please try again shortly.",
      },
      { status: 503 },
    );
  }
}

export const POST = forward;
export const GET = forward;
