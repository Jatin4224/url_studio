import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadWebsite } from "./load-website.js";
import { checkVideoTools, composeVideo } from "./compose-video.js";
import {
  liveInput,
  renderPresentation,
  shotSeconds,
  type Live,
} from "./render-scene.js";
import { dataInput, generate, model, upload } from "./higgsfield.js";
import { r2Configured, saveJob, uploadVideo } from "./r2.js";
import { log } from "./logs.js";

const maxSeconds = 50;

export const outputRoot = fileURLToPath(new URL("../output/", import.meta.url));
export const steps = [
  "Understanding website",
  "Planning presentation",
  "Capturing product scenes",
  "Creating cinematic scenes",
  "Composing presentation",
  "Complete",
];
export interface PresentationJob {
  id: string;
  url: string;
  status: "running" | "completed" | "failed";
  step: number;
  progress: number;
  scenesCompleted: number;
  totalScenes: number;
  error?: string;
  finalVideoUrl?: string;
  higgsfieldRequestId?: string;
  durationMs?: number;
}

export async function generatePresentation(
  job: PresentationJob,
  notify: () => void = () => {},
) {
  const dir = `${outputRoot}${job.id}`;
  const startedAt = Date.now();
  const traceId = job.id.replaceAll("-", "");
  const hostname = URL.canParse(job.url)
    ? new URL(job.url).hostname
    : "invalid";
  const report = (
    eventName: string,
    message: string,
    attributes: Record<string, string | number | boolean | null> = {},
    level: "debug" | "info" | "warn" | "error" = "info",
  ) =>
    log.send({
      level,
      message,
      eventName,
      traceId,
      attributes: { "job.id": job.id, "website.host": hostname, ...attributes },
    });
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  let stage = "understand";
  let stageStartedAt = startedAt;
  const begin = (name: string) => {
    stage = name;
    stageStartedAt = Date.now();
  };
  const done = (
    eventName: string,
    message: string,
    attributes: Record<string, string | number | boolean | null> = {},
  ) => {
    const duration = Date.now() - stageStartedAt;
    report(eventName, `${message} in ${seconds(duration)}`, {
      step: stage,
      duration_ms: duration,
      status: "success",
      ...attributes,
    });
  };
  const update = (step: number, progress: number) => {
    if (step === 1 && job.step === 0) {
      done("website.understood", "Website understood");
      begin("plan");
    }
    if (step === 2 && job.step === 1) {
      done("presentation.planned", "Presentation planned");
      begin("capture");
    }
    Object.assign(job, { step, progress, durationMs: Date.now() - startedAt });
    notify();
  };
  report("presentation.started", `Presentation started for ${hostname}`);
  try {
    await checkVideoTools();
    await mkdir(dir, { recursive: true });
    const { presentationPlan: plan, sceneReferences } = await loadWebsite(
      job.url,
      dir,
      (step) => update(step, [0, 15, 25][step]),
    );
    const shotOf = (scene: (typeof plan.scenes)[number]) => {
      const reference = sceneReferences.find(
        (capture) => capture.sceneId === scene.id,
      );
      if (!reference)
        throw new Error(`No reference image was captured for ${scene.id}.`);
      return { reference: reference.path, seconds: scene.duration ?? 5 };
    };
    // Choose before duration trimming so a chart scene cannot silently disappear.
    const chartInputs = new Map<string, Awaited<ReturnType<typeof liveInput>>>();
    let chartScene: string | undefined;
    let bestShapes = -1;
    for (const scene of plan.scenes) {
      const input = await liveInput(shotOf(scene).reference);
      chartInputs.set(scene.id, input);
      if (input && input.shapes > bestShapes) { bestShapes = input.shapes; chartScene = scene.id; }
    }
    const planned = plan.scenes.length;
    let length = await shotSeconds(plan.scenes.map(shotOf));
    while (length > maxSeconds) {
      const drop = plan.scenes
        .filter((scene) => scene.id !== chartScene && !["hero", "closing"].includes(scene.type ?? ""))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
      if (!drop) break;
      plan.scenes = plan.scenes.filter((scene) => scene !== drop);
      length = await shotSeconds(plan.scenes.map(shotOf));
    }
    done("scenes.captured", "Product scenes captured", {
      "scene.count": plan.scenes.length,
      "scene.dropped": planned - plan.scenes.length,
    });
    if (length > maxSeconds)
      report(
        "presentation.over_limit",
        `Film is ${seconds(length * 1000)} even with only the hero and closing`,
        { "film.seconds": Math.round(length * 10) / 10 },
        "warn",
      );
    const shots = plan.scenes.map(shotOf);

    let live: (Live & { image: Buffer }) | undefined;
    let shapes = 0;
    for (const [scene] of shots.entries()) {
      const prepared = chartInputs.get(plan.scenes[scene].id);
      if (!prepared || prepared.shapes <= shapes) continue;
      shapes = prepared.shapes;
      live = {
        scene,
        clip: `${dir}/live.mp4`,
        frame: prepared.frame,
        image: prepared.image,
      };
    }
    if (live) report("higgsfield.chart_selected", "Chart selected for animation", {
      "scene.index": live.scene,
      "chart.width": Math.round(live.frame.region.width),
      "chart.height": Math.round(live.frame.region.height),
      "image.width": live.frame.size[0],
      "image.height": live.frame.size[1],
    });
    const useHiggsfield = !!live && !!process.env.HF_CREDENTIALS;
    if (!live)
      report(
        "higgsfield.skipped",
        "Higgsfield skipped: no chart-like visual",
        { reason: "no_visual" },
        "debug",
      );
    else if (!useHiggsfield)
      report(
        "higgsfield.skipped",
        "Higgsfield skipped: credentials missing",
        { reason: "no_credentials" },
        process.env.NODE_ENV === "production" ? "warn" : "debug",
      );
    job.scenesCompleted = 0;
    job.totalScenes = plan.scenes.length + (useHiggsfield ? 1 : 0);
    const sceneDone = () => {
      job.scenesCompleted++;
      update(3, 35 + Math.round((55 * job.scenesCompleted) / job.totalScenes));
    };
    update(3, 35);
    if (useHiggsfield && live) {
      begin("higgsfield");
      const generated = await generate(
        dataInput(await upload(live.image)),
        (requestId) => {
          job.higgsfieldRequestId = requestId;
          report(
            "higgsfield.submitted",
            "Higgsfield generation submitted",
            {
              provider: "higgsfield",
              model,
              "higgsfield.request_id": requestId,
            },
            "debug",
          );
        },
      );
      const response = await fetch(generated.videoUrl, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok)
        throw new Error(`Live card download failed: HTTP ${response.status}`);
      await writeFile(live.clip, Buffer.from(await response.arrayBuffer()));
      sceneDone();
      done("higgsfield.enhanced", "Live card animated by Higgsfield", {
        provider: "higgsfield",
        model,
        "higgsfield.request_id": generated.requestId,
      });
    }

    begin("render");
    await renderPresentation(
      shots,
      `${dir}/shot.mp4`,
      sceneDone,
      useHiggsfield && live ? [live] : [],
    );
    done("scenes.rendered", "Cinematic scenes rendered", {
      "scene.count": shots.length,
      live_card: useHiggsfield,
    });
    update(4, 92);
    begin("compose");
    const filmSeconds = await composeVideo(
      `${dir}/shot.mp4`,
      `${dir}/presentation.mp4`,
    );
    done("presentation.composed", "Presentation composed", {
      "film.seconds": filmSeconds,
    });
    if (r2Configured()) {
      begin("upload");
      const { size } = await stat(`${dir}/presentation.mp4`);
      await uploadVideo(job.id, `${dir}/presentation.mp4`);
      done("presentation.uploaded", "Presentation uploaded", {
        "file.bytes": size,
      });
    }
    job.status = "completed";
    job.finalVideoUrl = `/api/presentations/${job.id}/video`;
    stage = "cleanup";
    if (r2Configured()) await finish(job, dir);
    else await writeFile(`${dir}/job.json`, JSON.stringify(job, null, 2));
    report(
      "presentation.completed",
      `Presentation completed in ${seconds(Date.now() - startedAt)}`,
      {
        duration_ms: Date.now() - startedAt,
        status: "success",
        "scene.count": plan.scenes.length,
        "film.seconds": filmSeconds,
        higgsfield: useHiggsfield,
      },
    );
    update(5, 100);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : "Unknown error")
      .replaceAll(
        process.env.HF_CREDENTIALS ?? "__NO_CREDENTIALS__",
        "[redacted]",
      )
      .replace(/https?:\/\/\S+/g, "[url]")
      .slice(0, 2000);
    job.status = "failed";
    job.durationMs = Date.now() - startedAt;
    const messages = [
      "We couldn't read this website. Check that it is public and accessible, then try again.",
      "We couldn't find enough useful content to plan a presentation. Try a product landing page.",
      "We couldn't capture the product scenes. Please try the website again.",
      "We couldn't render the cinematic scenes. Please try again.",
      "We couldn't assemble or save the video. Please try again.",
      "We couldn't save the final presentation. Please try again later.",
    ];
    job.error = messages[job.step];
    notify();
    report(
      "presentation.failed",
      `Presentation failed at ${stage}: ${detail.slice(0, 200)}`,
      {
        step: stage,
        status: "failed",
        duration_ms: job.durationMs ?? null,
        "error.type": error instanceof Error ? error.name : "Error",
        "error.message": detail,
        ...(stage === "higgsfield"
          ? {
              provider: "higgsfield",
              model,
              "higgsfield.request_id": job.higgsfieldRequestId ?? null,
            }
          : {}),
      },
      "error",
    );
    if (r2Configured()) await finish(job, dir);
    else
      await mkdir(dir, { recursive: true }).then(() =>
        writeFile(`${dir}/job.json`, JSON.stringify(job, null, 2)),
      );
  }
  return job;
}

async function finish(job: PresentationJob, dir: string) {
  try {
    await saveJob(job);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const job: PresentationJob = {
    id: randomUUID(),
    url: process.argv[2] ?? "",
    status: "running",
    step: 0,
    progress: 0,
    scenesCompleted: 0,
    totalScenes: 0,
  };
  await generatePresentation(job);
  console.log(JSON.stringify(job, null, 2));
  if (job.status === "failed") process.exitCode = 1;
}
