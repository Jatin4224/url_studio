import { config, higgsfield } from "@higgsfield/client/v2";

export const model = "kling-video/v3.0/std/image-to-video";

/**
 * Higgsfield only ever receives a text-free capture of a card, and the clip starts and ends on that exact image
 * (first and last frame), so it meets the renderer's frames without a jump.
 */
export function dataInput(imageUrl: string) {
  return {
    image_url: imageUrl, last_image_url: imageUrl, duration: 4, sound: "off", multi_shots: false, cfg_scale: 0.5,
    prompt: `Locked-off static camera: the framing never changes. This is a product interface card with its text removed.
Animate only the charts, bars and graphic shapes: they gently grow, shrink and flow by small amounts in a smooth, slow, sequential wave, as if live data were moving through them, then settle back exactly to their original sizes and positions.
Everything else stays perfectly still: same layout, same colours, same shapes, same lighting. Do not add text, numbers, labels or new elements.`,
  };
}

/** Uploads a PNG with the tested direct CDN flow (including its required upload_headers) and returns its public URL. */
export async function upload(image: Buffer) {
  const credentials = requireCredentials();
  const response = await fetch("https://api.higgsfield.ai/files/generate-upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Key ${credentials}` },
    body: JSON.stringify({ content_type: "image/png" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Higgsfield upload URL failed: HTTP ${response.status}`);
  const link = await response.json();
  if (!link.upload_url || !link.public_url || !link.upload_headers) throw new Error("Higgsfield returned an invalid upload URL.");
  const put = await fetch(link.upload_url, { method: "PUT", headers: link.upload_headers, body: new Uint8Array(image), signal: AbortSignal.timeout(120_000) });
  if (!put.ok) throw new Error(`Image upload failed: HTTP ${put.status}`);
  return link.public_url as string;
}

/** One paid generation: submits, polls until it finishes and returns the video URL. Never retries. */
export async function generate(input: Record<string, unknown>, onSubmitted: (id: string) => void | Promise<void> = () => {}) {
  const credentials = requireCredentials();
  config({ credentials });
  const submitted = await higgsfield.subscribe(model, { input, withPolling: false });
  await onSubmitted(submitted.request_id);
  let result: { status: string; video?: { url: string }; error?: unknown } = submitted;
  const deadline = Date.now() + 20 * 60_000;
  while (["queued", "in_progress"].includes(result.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const status = await fetch(submitted.status_url, { headers: { Authorization: `Key ${credentials}` }, signal: AbortSignal.timeout(30_000) });
    if (!status.ok) throw new Error(`Higgsfield status failed: HTTP ${status.status}`);
    result = await status.json();
  }
  if (["queued", "in_progress"].includes(result.status)) throw new Error("Higgsfield generation timed out after 20 minutes.");
  if (result.status !== "completed" || !result.video?.url) {
    throw new Error(`Higgsfield generation ended with status: ${result.status}${typeof result.error === "string" ? ` — ${result.error}` : ""}`);
  }
  return { requestId: submitted.request_id, videoUrl: result.video.url };
}

function requireCredentials() {
  if (!process.env.HF_CREDENTIALS) throw new Error("HF_CREDENTIALS is missing in the worker environment.");
  return process.env.HF_CREDENTIALS;
}
