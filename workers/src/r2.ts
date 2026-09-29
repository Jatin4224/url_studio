import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Finished presentations live in a private Cloudflare R2 bucket: the video and a small job record per job.
 * Viewers get short-lived signed links, created fresh on every request, so the bucket is never public.
 * Without the R2 settings (local development) the worker keeps files on disk instead.
 */
const settings = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const;
export const r2Configured = () => settings.every((name) => process.env[name]);

let client: S3Client | undefined;
function r2() {
  if (!r2Configured()) throw new Error(`R2 is not configured: set ${settings.join(", ")}.`);
  client ??= new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
  });
  return client;
}

const videoKey = (id: string) => `presentations/${id}.mp4`;
const jobKey = (id: string) => `presentations/${id}.json`;

export async function uploadVideo(id: string, file: string) {
  const { size } = await stat(file);
  await r2().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET, Key: videoKey(id), Body: createReadStream(file), ContentLength: size, ContentType: "video/mp4",
  }));
}

export async function saveJob(job: { id: string }) {
  await r2().send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET, Key: jobKey(job.id), Body: JSON.stringify(job, null, 2), ContentType: "application/json",
  }));
}

export async function loadJob<T>(id: string): Promise<T | undefined> {
  try {
    const object = await r2().send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: jobKey(id) }));
    return JSON.parse(await object.Body!.transformToString()) as T;
  } catch (error) {
    if (error instanceof NoSuchKey) return undefined;
    throw error;
  }
}

/** A one-hour signed link to the video; `download` makes browsers save it as a file instead of playing it. */
export function videoUrl(id: string, download: boolean) {
  return getSignedUrl(r2(), new GetObjectCommand({
    Bucket: process.env.R2_BUCKET, Key: videoKey(id), ResponseContentType: "video/mp4",
    ResponseContentDisposition: download ? 'attachment; filename="oneminute-presentation.mp4"' : undefined,
  }), { expiresIn: 3600 });
}
