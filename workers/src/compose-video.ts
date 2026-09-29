import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function checkVideoTools() {
  await exec("ffmpeg", ["-version"]);
  await exec("ffprobe", ["-version"]);
}

export async function composeVideo(clip: string, destination: string) {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip]);
  const duration = Number(stdout);
  if (!duration) throw new Error("The rendered shot has no video.");
  await exec("ffmpeg", ["-y", "-v", "error", "-i", clip, "-vf",
    `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,fade=t=in:st=0:d=0.5,fade=t=out:st=${(duration - 0.5).toFixed(3)}:d=0.5,format=yuv420p`,
    "-an", "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", destination], { timeout: 300_000 });
  return Math.round(duration * 10) / 10;
}
