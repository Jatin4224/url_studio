# URL Studio

**Paste a website URL. Get back a short cinematic video about that product.**

URL Studio takes a public product page, reads it the way a person would, decides which
parts are worth showing, and turns them into a single continuous ~50-second 1920×1080
MP4 — a camera gliding across the real page, settling on the headline, lifting the
product card into focus, moving on. No stock footage, no templates: every pixel in the
film comes from screenshots of the actual site.

```
https://yourproduct.com  ──►  [ URL Studio ]  ──►  presentation.mp4
```

---

## What it actually does

When you submit a URL, the worker runs a five-step pipeline. The web UI shows each step
as it happens.

| # | Step | What happens |
|---|------|--------------|
| 1 | **Understanding website** | Opens the page in a headless Chromium, waits for fonts and images, scrolls to the bottom so lazy content loads, then extracts every heading, paragraph, image, button and section — with position, colour and styling — into a structured "website IR". |
| 2 | **Planning presentation** | Turns that IR into a scene list: a hero scene, a product-screenshot scene, a features scene, the richest remaining sections, and a closing scene built around the page's call-to-action. Each scene gets a duration and a priority. |
| 3 | **Capturing product scenes** | Screenshots each scene's exact region at 2× (hiding sticky and fixed chrome first). Captures a second, text-free "plate" of each, and records where the cards, surfaces and chart-like shapes sit inside it. If the plan runs longer than 50 seconds, the lowest-priority scenes are dropped — never the hero, the closing, or the chart scene. |
| 4 | **Creating cinematic scenes** | Lays the captures side by side and renders one unbroken camera move across them: slow drifts, sweeps and focus pulls, with real motion blur (rendered as averaged sub-frames) and depth of field around whatever is in focus. Optionally, the single best chart on the page is sent to **Higgsfield** for an image-to-video pass so its bars visibly animate, then composited back into the still card. |
| 5 | **Composing presentation** | ffmpeg pads to exactly 1920×1080, adds a half-second fade in and out, encodes H.264 at CRF 18 with `+faststart`, and — if R2 is configured — uploads the result. |

The finished video is streamed back to the browser and can be played or downloaded.

### Two design rules worth knowing

- **Text is never regenerated.** Out-of-focus areas are blurred, cards are lifted and
  moved, but no letter or number on screen was invented by a model — it all comes from
  the capture. That is why the Higgsfield pass is only ever handed a *text-free* plate,
  and why its clip starts and ends on that exact image.
- **The camera never cuts.** The whole film is one continuous shot. Scenes are placed so
  the camera can truck straight from one to the next, and longer distances simply take
  longer, so the page's speed across the screen stays calm.

---

## Repository layout

```
OneMinute-Studio/          the checkout folder; the product itself is URL Studio
├── web/                   Next.js 16 app — landing page, job UI, video player, admin log viewer
└── workers/               Node worker — the generation pipeline (Playwright + ffmpeg + Higgsfield)
```

Package names and environment variables still carry the earlier `oneminute` spelling
(`@oneminute/worker`, `ONE_MINUTE_LOGS_API_KEY`). Those are real identifiers in the code
and are left alone; only the product name is URL Studio.

### `web/` — the front end

- [app/page.tsx](web/app/page.tsx) — the whole product in one client component: the
  marketing landing page, the URL form, the live progress view (polls every 2 s), and the
  result player. The last job id is kept in `localStorage`, so a refresh reconnects to a
  running job instead of paying for a second generation.
- `web/app/api/presentations/[[...path]]/route.ts` — a thin, strict proxy to the worker.
  Validates the path shape, forwards `POST /jobs`, `GET /jobs/:id` and
  `GET /jobs/:id/video` (including HTTP range requests, so the player can seek), and turns
  any worker outage into a friendly 503.
- [app/api/worker-logs/route.ts](web/app/api/worker-logs/route.ts) — receives batched
  telemetry from the worker. Every batch is HMAC-signed with a shared secret and rejected
  if its timestamp is more than five minutes old.
- [app/logs/](web/app/logs/) — a password-gated live log viewer. Sign-in uses
  `ADMIN_PASSWORD` with constant-time comparison, an HMAC-signed 24-hour cookie, and a
  small per-process attempt throttle. [proxy.ts](web/proxy.ts) guards the log stream route.

### `workers/` — the generation pipeline

| File | Role |
|------|------|
| [server.ts](workers/src/server.ts) | Tiny HTTP API: `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/video`. Runs **one job at a time** — a second submission gets a 429. Keeps the last 50 jobs in memory. |
| [load-website.ts](workers/src/load-website.ts) | Drives Playwright: loads the page, scrolls it, extracts content, plans scenes, captures the reference screenshots and plates. |
| [extract-raw.ts](workers/src/extract-raw.ts) | Runs inside the page. Finishes entrance animations and cancels looping ones, then collects every meaningful element with a stable CSS selector, de-duplicating carousel clones and off-screen copies. |
| [website-ir.ts](workers/src/website-ir.ts) | Builds the structured page model and derives the scene plan (`createPresentationPlan`). Filters out logos, avatars and headshots so they are never mistaken for product screenshots. |
| [render-scene.ts](workers/src/render-scene.ts) | The camera. Composes the shot in a headless browser, frame by frame, encodes it, and splices in the Higgsfield clip. |
| [raster-chart.ts](workers/src/raster-chart.ts) | Pixel-level fallback for finding a chart inside a dashboard screenshot when the DOM does not reveal one. |
| [higgsfield.ts](workers/src/higgsfield.ts) | Uploads the plate, submits one `kling-video/v3.0` generation, polls for up to 20 minutes. Never retries — each call costs money. |
| [compose-video.ts](workers/src/compose-video.ts) | Final ffmpeg pass: letterbox, fades, H.264. |
| [r2.ts](workers/src/r2.ts) | Cloudflare R2 storage. The bucket stays private; viewers get one-hour signed URLs generated fresh per request. Without R2 settings, files stay on local disk. |
| [public-request.ts](workers/src/public-request.ts), [public-proxy.ts](workers/src/public-proxy.ts) | SSRF protection. Chromium is forced through a local proxy that resolves each hostname once, refuses any non-public IP, and connects to that exact address — so a public hostname cannot DNS-rebind to your internal network. WebSockets, service workers, downloads and non-GET methods are blocked. |
| [logs.ts](workers/src/logs.ts) | Batches structured events, signs them, ships them to the web app, and flushes on exit. |

---

## Running it locally

**Prerequisites:** Node 20+, and `ffmpeg` / `ffprobe` on your `PATH` (the pipeline checks
for both before it starts work and fails immediately if either is missing).

```sh
# 1. Worker
cd workers
npm install
npx playwright install chromium
cp .env.example .env        # fill in what you need — see the table below
npm run dev                 # http://localhost:4000

# 2. Web app, in a second terminal
cd web
npm install
cp .env.example .env.local  # set WORKER_URL=http://localhost:4000
npm run dev                 # http://localhost:3000
```

Then open <http://localhost:3000> and paste a product URL.

### Generating one video without the web app

```sh
cd workers
npm run generate -- https://yourproduct.com
```

The finished file lands in `workers/output/<job-id>/presentation.mp4`.

### Other commands

```sh
cd workers && npm test        # unit tests for the IR builder and the chart finder
cd workers && npm run typecheck
cd web && npm run build
cd web && npm run lint
```

---

## Configuration

Everything below is optional except `WORKER_URL` — the pipeline degrades gracefully when
a key is absent rather than failing.

### `web/.env.local`

| Variable | Effect if unset |
|----------|-----------------|
| `WORKER_URL` | Required. Where the worker is listening, e.g. `http://localhost:4000`. |
| `ONE_MINUTE_LOGS_API_KEY` | Monitoring is disabled; logs only reach the console. |
| `WORKER_LOG_SECRET` | The worker-log endpoint returns 503. Must match the worker's value. |
| `ADMIN_PASSWORD` | `/logs` cannot be signed into. |

### `workers/.env`

| Variable | Effect if unset |
|----------|-----------------|
| `HF_CREDENTIALS` | Higgsfield is skipped — the chart stays a still image and everything else works. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Videos and job records stay on local disk under `workers/output/`. All four are needed to switch to R2. |
| `WORKER_LOG_SECRET` | Telemetry stays on the console only. |
| `WEB_URL` | Defaults to `http://localhost:3000` when shipping logs. |
| `PORT` | Defaults to `4000`. |
| `WORKER_LOG_DEBUG` | Off by default; set to `1` to ship `debug`-level events instead of keeping them on the console. |

> Note: `R2_BUCKET`, `WEB_URL` and `PORT` are read by the code but are not listed in
> `workers/.env.example` — add them yourself if you need them.

---

## Current limitations

- **One job at a time.** The worker is single-slot by design (Chromium plus ffmpeg is
  heavy); concurrent submissions get a `429`. There is no queue yet.
- **In-memory job list.** Without R2, job state lives in the worker process and on local
  disk, so a restart loses anything not yet written. With R2 configured, job records persist.
- **~50 second ceiling.** Scenes are dropped by priority to fit. If even the hero and
  closing exceed it, the film is still produced and a warning is logged.
- **Public pages only.** Anything behind a login, on a private IP, or protected by an
  aggressive bot wall will fail at step 1.
- **Higgsfield calls cost money** and are never retried automatically.
