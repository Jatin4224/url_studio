import http from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { validateWebsiteUrl } from "./validate-url.js";
import {
  generatePresentation,
  outputRoot,
  type PresentationJob,
} from "./generate-presentation.js";
import { loadJob, r2Configured, videoUrl } from "./r2.js";
import { log } from "./logs.js";

let busy = false;
const jobs = new Map<string, PresentationJob>();
const port = Number(process.env.PORT ?? 4000);

http
  .createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const send = (status: number, body: object) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    const url = new URL(request.url ?? "/", "http://worker");
    const match = url.pathname.match(/^\/jobs\/([a-f0-9-]{36})(\/video)?$/);

    if (request.method === "GET" && match) {
      const id = match[1];
      let job = jobs.get(id);
      try {
        job ??= r2Configured()
          ? await loadJob<PresentationJob>(id)
          : await readFile(`${outputRoot}${id}/job.json`, "utf8").then(
              (text) => JSON.parse(text) as PresentationJob,
              () => undefined,
            );
      } catch (error) {
        void log.error({
          message: `Could not read the job record from R2 (${id})`,
          eventName: "worker.r2.read_failed",
          attributes: {
            "job.id": id,
            "error.message":
              error instanceof Error ? error.message : "Unknown error",
          },
        });
        return send(503, {
          error:
            "The studio is temporarily unavailable. Please try again shortly.",
        });
      }
      if (!job)
        return send(404, {
          error:
            "This job is no longer available. Please create a new presentation.",
        });
      if (!match[2]) return send(200, job);
      if (job.status !== "completed")
        return send(409, { error: "The presentation is not ready yet." });
      if (r2Configured()) {
        response.setHeader(
          "Location",
          await videoUrl(id, url.searchParams.has("download")),
        );
        return send(302, { redirect: true });
      }
      const file = `${outputRoot}${id}/presentation.mp4`;
      const size = await stat(file).then(
        (info) => info.size,
        () => undefined,
      );
      if (size === undefined)
        return send(404, { error: "The video file is no longer available." });
      const range = request.headers.range
        ? /^bytes=(\d*)-(\d*)$/.exec(request.headers.range)
        : undefined;
      let [start, end] = [0, size - 1];
      if (request.headers.range) {
        if (!range || (!range[1] && !range[2]))
          return send(416, { error: "Invalid video range." });
        start = range[1]
          ? Number(range[1])
          : Math.max(0, size - Number(range[2]));
        end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
        if (start > end || start >= size) {
          response.setHeader("Content-Range", `bytes */${size}`);
          return send(416, { error: "Invalid video range." });
        }
        response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      }
      response.setHeader("Content-Type", "video/mp4");
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Content-Length", end - start + 1);
      response.writeHead(range ? 206 : 200);
      const stream = createReadStream(file, { start, end });
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      return stream.pipe(response);
    }

    if (request.method !== "POST" || url.pathname !== "/jobs")
      return send(404, { error: "Not found." });
    if (!request.headers["content-type"]?.startsWith("application/json"))
      return send(415, { error: "Send a JSON request." });
    let body: unknown;
    try {
      let text = "";
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 4096)
          return send(413, { error: "Request is too large." });
      }
      body = JSON.parse(text);
    } catch {
      return send(400, { error: "Send a valid JSON request." });
    }
    const validated = validateWebsiteUrl(
      body && typeof body === "object" && "url" in body ? body.url : undefined,
    );
    if (!validated.url || validated.url.length > 2048)
      return send(400, {
        error: validated.error ?? "Website URL is too long.",
      });
    if (busy) {
      void log.warn({
        message: "Submission rejected: the worker is busy",
        eventName: "worker.job.rejected",
        attributes: {
          reason: "busy",
          "website.host": new URL(validated.url).hostname,
        },
      });
      return send(429, { error: "The worker is busy. Try again shortly." });
    }
    busy = true;
    const job: PresentationJob = {
      id: randomUUID(),
      url: validated.url,
      status: "running",
      step: 0,
      progress: 0,
      scenesCompleted: 0,
      totalScenes: 0,
    };
    if (jobs.size >= 50) jobs.delete(jobs.keys().next().value!);
    jobs.set(job.id, job);
    void generatePresentation(job)
      .catch((error) => {
        void log.fatal({
          message: `Presentation crashed outside the pipeline (${job.id})`,
          eventName: "presentation.crashed",
          traceId: job.id.replaceAll("-", ""),
          attributes: {
            "job.id": job.id,
            "error.type": error instanceof Error ? error.name : "Error",
            "error.message":
              error instanceof Error
                ? error.message.slice(0, 500)
                : "Unknown error",
          },
        });
        job.status = "failed";
        job.error = "Could not save the presentation. Please try again later.";
      })
      .finally(() => {
        busy = false;
      });
    send(202, job);
  })
  .listen(port, () => {
    console.log(`Worker listening at http://localhost:${port}`);
  });
