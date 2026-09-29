import { rasterChart } from "./raster-chart.js";
import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium, type Browser } from "playwright";

type Box = { x: number; y: number; width: number; height: number; radius?: number; cutout?: string; shapes?: number };
type Layers = { width: number; height: number; heading?: Box; raster?: boolean; surfaces: Box[]; data?: Box[] };
type Camera = { x: number; y: number; zoom: number; tiltX: number; tiltY: number };
type Move = { from: Camera; to: Camera; style: Style; blur: [number, number] };
type Scene = { png: Buffer; layers: Layers; origin: { x: number; y: number }; subjects: Box[]; start: Camera; end: Camera };
type Segment = { index: number; seconds: number; travel?: Move };
export type Shot = { reference: string; seconds: number };
/** Where a Higgsfield clip of a text-free card plays: `region` (CSS px, section-relative) is cut from the clip. */
export type LiveFrame = { region: Box; crop: [number, number, number, number]; size: [number, number] };
export type Live = { scene: number; clip: string; frame: LiveFrame };

const width = 1920;
const height = 1080;
const fps = 24;
/**
 * Camera moves are rendered as sub-frames and averaged into real motion blur; holds stay single, exact frames.
 * At these calm speeds 4 is indistinguishable from 8 (53.8 dB PSNR over a move) and renders moves twice as fast.
 */
const subframes = 4;
/**
 * Transitions between scenes rotate through distinct camera moves so no two in a row feel the same. All of them are
 * slow and gently eased: the presentation is an unhurried film, not a montage.
 */
const styles = ["drift", "sweep", "focus"] as const;
type Style = (typeof styles)[number];
const seconds: Record<Style, number> = { drift: 3, sweep: 3.2, focus: 2.8 };
/** Fastest the page may cross the screen during a move, in pixels per second. */
const calmSpeed = 900;

/**
 * The camera keeps its distance between scenes (no zoom-out), so the film stays one continuous story. Longer
 * distances simply take longer, keeping the page's speed across the screen calm.
 */
function between(from: Camera, to: Camera, style: Style): { seconds: number; travel: Move } {
  const distance = Math.hypot(to.x - from.x, to.y - from.y) * (from.zoom + to.zoom) / 2;
  const time = style === "focus" ? seconds.focus : Math.min(5, Math.max(seconds[style], Math.PI / 2 * distance / calmSpeed));
  return { seconds: time, travel: { from, to, style, blur: [maxBlur, maxBlur] } };
}
/** Softness of the page around the focused subject (a long, fast prime lens), and how far the subject rises off it. */
const maxBlur = 2.6;
const liftDepth = 30;

/**
 * One continuous cinematic shot. The scenes sit side by side, each aligned so the camera trucks straight across to
 * the next. The camera settles on each scene (its headline, then its main surface lifts into focus), then moves on.
 * Every pixel comes from the captures; out-of-focus areas are only blurred, so letters and numbers never change.
 *
 * `live` clips (Higgsfield animations of a text-free card) play inside that card while it is in focus; only their
 * chart region is used, so every letter on the card stays the original capture.
 */
export async function renderPresentation(shots: Shot[], destination: string, onShot: (index: number) => void = () => {}, liveCards: Live[] = []) {
  const { scenes, timeline } = await prepare(shots);
  const parts = `${destination}.parts`;
  await mkdir(parts, { recursive: true });
  const live = [];
  for (const entry of liveCards) live.push({ ...entry, frames: await extractLive(entry, `${parts}/live-${entry.scene}`) });
  const browser = await chromium.launch({ timeout: 10_000 });
  try {
    const page = await stage(browser, scenes, live, parts);
    const files: string[] = [];
    for (const [n, segment] of timeline.entries()) {
      const sub = segment.travel ? subframes : 1;
      const count = Math.round(segment.seconds * fps) * sub;
      const clip = live.find((entry) => entry.scene === segment.index);
      const file = `${parts}/${n}.mp4`;
      await encode(file, sub, async (write) => {
        for (let i = 0; i < count; i++) {
          const u = i / (count - 1);
          const state = segment.travel ? travelState(segment.travel, u)
            : holdState(scenes[segment.index], u, segment.index === 0, segment.index === scenes.length - 1);
          // A live card starts moving as focus passes to it, and ends on its original frame.
          const animationStart = scenes[segment.index].subjects.length === 1 ? .16 : .5;
          const progress = Math.max(0, Math.min(1, (u - animationStart) / (.88 - animationStart)));
          const frame = clip && !segment.travel ? Math.round(progress * (clip.frames - 1)) + 1 : 0;
          await page.evaluate(`apply(${JSON.stringify({ ...state, index: segment.index, frame, backgroundMix: segment.travel ? gentle(u) : 0 })})`);
          await write(await page.screenshot({ type: "png" }));
        }
      });
      files.push(file);
      if (!segment.travel) onShot(segment.index);
    }
    // Every part shares one encoding, so they join without re-encoding.
    await writeFile(`${parts}/list.txt`, files.map((file) => `file '${file}'`).join("\n"));
    await exec("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", `${parts}/list.txt`, "-c", "copy", "-movflags", "+faststart", destination]);
  } finally {
    await browser.close();
    await rm(parts, { recursive: true, force: true });
  }
}

/**
 * A chart-like visual inside the card the camera focuses on, prepared for Higgsfield: the whole card from the
 * text-free capture, padded to 16:9 in its own corner colour, plus where the chart sits inside that image.
 */
export async function liveInput(reference: string): Promise<{ image: Buffer; frame: LiveFrame; shapes: number } | undefined> {
  const layers = await readLayers(reference);
  const chart = layers.data?.find((chart) => layers.surfaces.some((box) => box.x <= chart.x && box.y <= chart.y && box.x + box.width >= chart.x + chart.width && box.y + box.height >= chart.y + chart.height));
  const card = chart && pickSubjects(layers).find((box) => box.radius !== undefined && box.x <= chart.x && box.y <= chart.y
    && box.x + box.width >= chart.x + chart.width && box.y + box.height >= chart.y + chart.height);
  if (!layers || !chart || !card) return undefined;
  // A margin of the card around the chart, so the feathered edge falls on plain card rather than on the bars.
  const margin = 16;
  const data = { x: Math.max(card.x, chart.x - margin), y: Math.max(card.y, chart.y - margin), width: 0, height: 0 };
  data.width = Math.min(card.x + card.width, chart.x + chart.width + margin) - data.x;
  data.height = Math.min(card.y + card.height, chart.y + chart.height + margin) - data.y;
  const plate = await readFile(reference.replace(/\.png$/, "-plate.png"));
  const scale = plate.readUInt32BE(16) / layers.width;
  const [cw, ch, cx, cy] = [card.width, card.height, card.x, card.y].map((n) => Math.round(n * scale));
  // Fixed model input dimensions, independent of the source card's size.
  const W = 1280, H = 720;
  const fit = Math.min(W / cw, H / ch);
  const rw = Math.max(2, Math.min(W, Math.round(cw * fit / 2) * 2));
  const rh = Math.max(2, Math.min(H, Math.round(ch * fit / 2) * 2));
  const [ox, oy] = [(W - rw) / 2, (H - rh) / 2];
  const sx = rw / cw, sy = rh / ch;
  const corner = await ffmpeg(plate, ["-vf", `crop=1:1:${cx + 2}:${cy + 2}`, "-f", "rawvideo", "-pix_fmt", "rgb24"]);
  const image = await ffmpeg(plate, ["-vf", `crop=${cw}:${ch}:${cx}:${cy},scale=${rw}:${rh}:flags=lanczos,setsar=1,pad=${W}:${H}:${ox}:${oy}:color=0x${corner.subarray(0, 3).toString("hex")}`,
    "-frames:v", "1", "-f", "image2pipe", "-c:v", "png"]);
  const left = Math.round((data.x * scale - cx) * sx + ox);
  const top = Math.round((data.y * scale - cy) * sy + oy);
  const crop = [Math.min(W - left, Math.round(data.width * scale * sx)), Math.min(H - top, Math.round(data.height * scale * sy)), left, top];
  return { image, frame: { region: data, crop: crop as LiveFrame["crop"], size: [W, H] }, shapes: chart.shapes ?? 0 };
}

/** Product screenshots contain raster charts invisible to DOM inspection. */
async function readLayers(reference: string): Promise<Layers> {
  const layers: Layers = JSON.parse(await readFile(reference.replace(/\.png$/, ".json"), "utf8"));
  if ((layers.raster || (!layers.heading && !layers.surfaces.length)) && !layers.data?.length) {
    const png = await readFile(reference);
    const w = 640, h = Math.round(png.readUInt32BE(20) / png.readUInt32BE(16) * w);
    const rgb = await ffmpeg(png, ["-vf", `scale=${w}:${h}`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24"]);
    const chart = rasterChart(rgb, w, h);
    if (chart && chart.width * layers.width / w >= 80 && chart.height * layers.height / h >= 40) {
      const sx = layers.width / w, sy = layers.height / h;
      const region = { x: chart.x * sx, y: chart.y * sy, width: chart.width * sx, height: chart.height * sy, shapes: 50 };
      // Restrict AI to the plot, keeping baked-in titles and labels outside the animated region.
      layers.data = [region];
      layers.surfaces = [{ ...region, radius: 0 }];
    }
  }
  return layers;
}

/** How long the rendered shot will be for these scenes: every hold plus the moves between them, in seconds. */
export async function shotSeconds(shots: Shot[]) {
  const { timeline } = await prepare(shots, false);
  return timeline.reduce((sum, segment) => sum + segment.seconds, 0);
}

/** Scenes placed side by side with their cameras, and the timeline of holds and moves between them. */
async function prepare(shots: Shot[], cutouts = true) {
  let rowX = 0;
  let rowY: number | undefined;
  const scenes: Scene[] = [];
  for (const shot of shots) {
    const png = await readFile(shot.reference);
    const layers = await readLayers(shot.reference);
    const local = pickSubjects(layers);
    // Alternate the side each scene is seen from, so consecutive scenes never look like repeats.
    const { start, end } = cameras(layers, local, scenes.length % 2 ? -1 : 1);
    // The next scene's opening framing sits exactly level with where the previous one ended.
    const origin = { x: rowX, y: rowY === undefined ? 0 : rowY - start.y };
    rowX += layers.width + 240;
    rowY = origin.y + end.y;
    const shift = (camera: Camera) => ({ ...camera, x: camera.x + origin.x, y: camera.y + origin.y });
    const subjects = local.map((box) => ({ ...box, x: box.x + origin.x, y: box.y + origin.y }));
    const scene = { png, layers, origin, subjects, start: shift(start), end: shift(end) };
    if (cutouts) await cutOutHeadlines(scene);
    scenes.push(scene);
  }
  // One framing distance for the whole film (the widest scene decides), with a slow push-in that carries on
  // across every scene and move: the camera only ever creeps forward, never back.
  const baseZoom = Math.min(...scenes.map((scene) => scene.start.zoom));
  scenes.forEach((scene, i) => {
    scene.start.zoom = baseZoom * 1.04 ** i;
    scene.end.zoom = baseZoom * 1.04 ** (i + 1);
  });
  const last = scenes.length - 1;
  const timeline: Segment[] = scenes.flatMap((scene, index) => [
    // Holds are long enough for each highlight to breathe.
    { index, seconds: Math.max(4.5, shots[index].seconds) },
    ...(index < last ? [{ index, ...between(scene.end, scenes[index + 1].start, styles[index % styles.length]) }] : []),
  ] as Segment[]);
  return { scenes, timeline };
}

/** An offline page holding the whole world; live-card frames are served from disk, nothing else may load. */
async function stage(browser: Browser, scenes: Scene[], live: { scene: number; frame: LiveFrame }[], parts: string) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route("**/*", (route) => route.request().url().startsWith("http://frames.local/")
    ? route.fulfill({ path: `${parts}/${route.request().url().slice(20)}` }) : route.abort());
  await page.setContent(stageHtml(scenes, live));
  await page.evaluate(() => Promise.all(Array.from(document.images).filter((img) => img.getAttribute("src")).map((img) => img.decode())));
  // Around the page, continue the site's own background colour.
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64; canvas.height = 32;
    const context = canvas.getContext("2d")!;
    const backgrounds = Array.from(document.querySelectorAll<HTMLImageElement>("#flat > img")).map((img) => {
      context.clearRect(0, 0, 64, 32);
      context.drawImage(img, 0, 0, 64, 32);
      const pixels = context.getImageData(0, 0, 64, 32).data;
      const samples: number[][] = [];
      for (let x = 0; x < 64; x++) {
        const i = (2 * 64 + x) * 4;
        samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
      }
      // Discard bright headline pixels; retain this scene's own backdrop.
      samples.sort((a, b) => Math.max(...a) - Math.max(...b));
      const color = samples[Math.floor(samples.length * .6)];
      img.dataset.background = color.join(",");
      return color;
    });
    document.body.style.background = `rgb(${backgrounds[0].join(",")})`;
    for (const cover of document.querySelectorAll<HTMLElement>(".cover")) {
      cover.style.background = `rgb(${backgrounds[Number(cover.dataset.scene)].join(",")})`;
    }
  });
  return page;
}

/** The chart region of a live clip as 24 fps frames, scaled back to the geometry of the image Higgsfield received. */
async function extractLive(entry: Live, dir: string) {
  await mkdir(dir, { recursive: true });
  const [W, H] = entry.frame.size;
  await exec("ffmpeg", ["-y", "-v", "error", "-i", entry.clip, "-vf", `scale=${W}:${H},crop=${entry.frame.crop.join(":")},fps=${fps}`,
    "-q:v", "2", `${dir}/%05d.jpg`], { timeout: 120_000 });
  return (await readdir(dir)).length;
}

const exec = promisify(execFile);

/** Pipes screenshots to FFmpeg; with sub-frames, each output frame is the average of its group. */
async function encode(destination: string, sub: number, frames: (write: (frame: Buffer) => Promise<void>) => Promise<void>) {
  const blend = sub > 1 ? ["-vf", `tmix=frames=${sub},select='not(mod(n+1\\,${sub}))',setpts=N/(${fps}*TB)`] : [];
  const encoder = spawn("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-framerate", String(fps * sub), "-i", "-", ...blend,
    "-r", String(fps), "-c:v", "libx264", "-crf", "16", "-preset", "medium", "-pix_fmt", "yuv420p", destination]);
  let error = "";
  encoder.stderr.on("data", (chunk) => { error += chunk; });
  const done = new Promise<void>((resolve, reject) => {
    encoder.on("error", reject);
    encoder.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Presentation encoding failed: ${error.trim() || `exit ${code}`}`)));
  });
  try {
    await frames(async (frame) => {
      if (!encoder.stdin.write(frame)) await new Promise((resolve) => encoder.stdin.once("drain", resolve));
    });
    encoder.stdin.end();
  } catch (cause) {
    encoder.kill();
    throw cause;
  }
  await done;
}

/** The story of each scene: the headline first, then the section's main surface (product card, input). */
function pickSubjects(layers: Layers): Box[] {
  // Rounded surfaces (cards, panels, inputs) read as product UI; plain bordered rows come after them.
  const surfaces = [...layers.surfaces].sort((a, b) => Number(!!b.radius) - Number(!!a.radius) || b.width * b.height - a.width * a.height);
  const chart = layers.data?.find((chart) => surfaces.some((box) => box.x <= chart.x && box.y <= chart.y && box.x + box.width >= chart.x + chart.width && box.y + box.height >= chart.y + chart.height));
  const chartCard = chart && surfaces.find((box) => box.x <= chart.x && box.y <= chart.y && box.x + box.width >= chart.x + chart.width && box.y + box.height >= chart.y + chart.height);
  const picked = layers.heading ? [pad(layers.heading, 16), chartCard ?? surfaces[0]] : chartCard ? [chartCard] : surfaces.slice(0, 2);
  return picked.filter((box): box is Box => !!box);
}

const pad = (box: Box, by: number): Box => ({ x: box.x - by, y: box.y - by, width: box.width + by * 2, height: box.height + by * 2 });
const smooth = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * (3 - 2 * x); };
const ease = (x: number) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
const mix = (a: Camera, b: Camera, e: number): Camera => ({
  x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e, zoom: a.zoom + (b.zoom - a.zoom) * e,
  tiltX: a.tiltX + (b.tiltX - a.tiltX) * e, tiltY: a.tiltY + (b.tiltY - a.tiltY) * e,
});

/** Where the camera starts and ends inside a scene: from the first subject to the second, pushing in slightly. */
function cameras(layers: Layers, subjects: Box[], side: number) {
  const centers = subjects.map((s) => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 }));
  const middle = { x: layers.width / 2, y: layers.height / 2 };
  const [from, to] = centers.length > 1 ? centers
    : [centers[0] ?? middle].flatMap((c) => [{ x: c.x - 70, y: c.y }, { x: c.x + 70, y: c.y }]);
  // Keep each subject fully in frame, with room around it.
  const widest = Math.max(0, ...subjects.map((s) => s.width));
  const zoom = width / Math.min(Math.max(widest * 1.25, 950), layers.width * 1.15);
  return {
    start: { ...from, zoom, tiltX: 13, tiltY: 11 * side },
    end: { ...to, zoom: zoom * 1.06, tiltX: 9, tiltY: 5 * side },
  };
}

/** Rack focus inside a scene: the first subject lifts, then focus passes to the second, which settles before travel. */
function holdState(scene: Scene, u: number, first: boolean, last: boolean) {
  const lifts = scene.subjects.map((_, i) => {
    const focus = scene.subjects.length === 1 ? 1 : i === 0 ? 1 - smooth((u - .42) / .22) : smooth((u - .46) / .22);
    return focus * smooth(u / .16) * (last ? 1 : 1 - smooth((u - .88) / .12));
  });
  return { camera: mix(scene.start, scene.end, ease(u)), blur: (scene.subjects.length ? (scene.layers.raster || !scene.layers.heading ? .7 : maxBlur) : 0) * (first ? smooth(u / .16) : 1), lifts };
}

/**
 * Camera moves between scenes, each with its own character but all slow:
 * drift — trucks straight on to the next scene in soft focus, at the same distance;
 * sweep — the same journey on a gentle arc to one side;
 * focus — the image melts into a dreamy defocus while travelling, then resolves on the next headline.
 */
function travelState(move: Move, u: number) {
  const arc = Math.sin(Math.PI * u);
  // Focus never travels: it softens fully, repositions while nothing is sharp, and resolves on the next scene.
  const camera = move.style === "focus" ? { ...(u < .5 ? move.from : move.to) } : mix(move.from, move.to, gentle(u));
  let soften = 0;
  if (move.style === "drift") {
    camera.tiltX += 4 * arc;
    soften = .8 * arc;
  } else if (move.style === "sweep") {
    // A gentle arc to one side of the path.
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) || 1;
    camera.x -= 220 * arc * (move.to.y - move.from.y) / length;
    camera.y += 220 * arc * (move.to.x - move.from.x) / length * -1;
    soften = .6 * arc;
  } else if (move.style === "focus") {
    soften = 9 * arc;
  }
  return { camera, blur: move.blur[0] + (move.blur[1] - move.blur[0]) * gentle(u) + soften, lifts: [] };
}

/** Sine ease-in-out: no fast middle, so moves stay calm under slow music. */
const gentle = (x: number) => (1 - Math.cos(Math.PI * x)) / 2;

/**
 * Headlines sharpen in place using their exact captured pixels. A single colour key cannot
 * separate text from gradients, grids or images without damaging the original background.
 */
async function cutOutHeadlines(scene: Scene) {
  const scale = scene.png.readUInt32BE(16) / scene.layers.width;
  for (const [j, box] of scene.subjects.entries()) {
    if (box.radius !== undefined) continue;
    // Keep the crop inside the capture (the headline box is padded and may reach past its edges).
    const x = Math.max(box.x, scene.origin.x), y = Math.max(box.y, scene.origin.y);
    const right = Math.min(box.x + box.width, scene.origin.x + scene.layers.width);
    const bottom = Math.min(box.y + box.height, scene.origin.y + scene.layers.height);
    const crop = [right - x, bottom - y, x - scene.origin.x, y - scene.origin.y].map((n) => Math.round(n * scale));
    const cutout = await ffmpeg(scene.png, ["-vf", `crop=${crop.join(":")},format=rgba`, "-f", "image2pipe", "-c:v", "png"]);
    scene.subjects[j] = { ...box, x, y, width: right - x, height: bottom - y, cutout: `data:image/png;base64,${cutout.toString("base64")}` };
  }
}

/** Runs FFmpeg on an in-memory image and returns its output. */
function ffmpeg(input: Buffer, args: string[]) {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", ...args, "pipe:1"]);
    const chunks: Buffer[] = [];
    let error = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`FFmpeg failed: ${error.trim() || `exit ${code}`}`)));
    child.stdin.end(input);
  });
}

function stageHtml(scenes: Scene[], live: { scene: number; frame: LiveFrame }[]) {
  const images = scenes.map((scene) => `data:image/png;base64,${scene.png.toString("base64")}`);
  const sections = scenes.map((scene, i) => `<img src="${images[i]}" style="left:${scene.origin.x}px;top:${scene.origin.y}px;` +
    `width:${scene.layers.width}px;height:${scene.layers.height}px">`).join("");
  // Only cards lift off the page. Headlines stay on the original plane and need no background cover.
  const covers = scenes.flatMap((scene, i) => scene.subjects.map((box, j) => box.radius === undefined ? "" : `<div class="cover" data-scene="${i}" data-subject="${j}" ` +
    `style="left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;border-radius:${box.radius ?? 0}px"></div>`)).join("");
  // A live card carries its Higgsfield frames over the chart region, inside the card as it lifts.
  const liveImage = (scene: Scene, i: number, box: Box) => {
    const region = live.find((entry) => entry.scene === i)?.frame.region;
    if (!region || box.radius === undefined) return "";
    const x = scene.origin.x + region.x - box.x, y = scene.origin.y + region.y - box.y;
    if (x < 0 || y < 0 || x + region.width > box.width || y + region.height > box.height) return "";
    return `<img class="live" data-scene="${i}" src="http://frames.local/live-${i}/00001.jpg" style="left:${x}px;top:${y}px;width:${region.width}px;height:${region.height}px">`;
  };
  const lifts = scenes.flatMap((scene, i) => scene.subjects.map((box, j) => `<div class="lift${box.radius === undefined ? "" : " card"}" ` +
    `data-scene="${i}" data-subject="${j}" style="left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px;` +
    `border-radius:${box.radius ?? 0}px;` + (box.cutout ? `background-image:url('${box.cutout}');background-size:100% 100%` :
    `background-image:url('${images[i]}');background-size:${scene.layers.width}px ${scene.layers.height}px;` +
    `background-position:${scene.origin.x - box.x}px ${scene.origin.y - box.y}px`) + `">${liveImage(scene, i, box)}</div>`)).join("");
  return `<!doctype html><html><head><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  #stage { position: absolute; inset: 0; perspective: 2400px; perspective-origin: 50% 46%; }
  #world { position: absolute; left: 0; top: 0; transform-origin: 0 0; transform-style: preserve-3d; }
  #flat, #flat img { position: absolute; left: 0; top: 0; }
  .lift { position: absolute; background-repeat: no-repeat; }
  .cover { position: absolute; opacity: 0; }
  /* Feathered, so any colour difference between the clip and the capture melts into the card. */
  .live { position: absolute; -webkit-mask-image: linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent), linear-gradient(transparent, #000 22%, #000 78%, transparent);
    -webkit-mask-composite: source-in; mask-composite: intersect; }
  #vignette { position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse 75% 70% at 50% 46%, transparent 55%, rgba(0, 0, 0, .15) 100%); }
  </style></head><body>
  <div id="stage"><div id="world"><div id="flat">${sections}${covers}</div>${lifts}</div></div>
  <div id="vignette"></div>
  <script>
  const lifts = [...document.querySelectorAll(".lift")];
  const covers = [...document.querySelectorAll(".cover")];
  const live = [...document.querySelectorAll(".live")];
  window.apply = async ({ camera: c, blur, lifts: amounts, index, frame, backgroundMix = 0 }) => {
    const scenes = document.querySelectorAll("#flat > img");
    const from = scenes[index].dataset.background.split(",").map(Number);
    const to = (scenes[index + 1] || scenes[index]).dataset.background.split(",").map(Number);
    const background = from.map((channel, i) => Math.round(channel + (to[i] - channel) * backgroundMix));
    document.body.style.background = "rgb(" + background.join(",") + ")";
    for (const img of live) {
      if (!frame || Number(img.dataset.scene) !== index) continue;
      const src = "http://frames.local/live-" + index + "/" + String(frame).padStart(5, "0") + ".jpg";
      if (img.getAttribute("src") !== src) { img.src = src; await img.decode(); }
    }
    document.getElementById("world").style.transform = "translate(${width / 2}px, ${height / 2}px) rotateX(" + c.tiltX + "deg) rotateY(" +
      c.tiltY + "deg) scale3d(" + c.zoom + "," + c.zoom + "," + c.zoom + ") translate(" + -c.x + "px, " + -c.y + "px)";
    document.getElementById("flat").style.filter = "blur(" + blur + "px)";
    // The subject's original spot empties as soon as it starts to rise, so it is never seen twice.
    for (const el of covers) el.style.opacity = Math.min(1, 4 * (Number(el.dataset.scene) === index ? amounts[Number(el.dataset.subject)] ?? 0 : 0));
    for (const el of lifts) {
      const lift = Number(el.dataset.scene) === index ? amounts[Number(el.dataset.subject)] ?? 0 : 0;
      // The subject rises off the plane and turns partly toward the camera.
      el.style.transform = "translateZ(" + (el.classList.contains("card") ? ${liftDepth} * lift : 0) + "px)";
      el.style.filter = "blur(" + blur * (1 - lift) + "px)";
      if (el.classList.contains("card")) el.style.boxShadow = "0 " + 22 * lift + "px " + 50 * lift + "px rgba(0, 0, 0, " + .5 * lift + ")";
    }
  };
  </script></body></html>`;
}
