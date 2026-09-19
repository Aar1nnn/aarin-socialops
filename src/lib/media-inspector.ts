import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getStorageAdapter, resolveLocalAssetPath } from "./adapters/storage";

const execFileAsync = promisify(execFile);

export type MediaInspection = {
  status: "AVAILABLE" | "UNAVAILABLE" | "FAILED";
  source: "ffprobe";
  durationSeconds?: number;
  width?: number;
  height?: number;
  fps?: number;
  videoCodec?: string;
  audioCodec?: string;
  bitrate?: number;
  container?: string;
  errorCode?: string;
};

export async function inspectVideo(storageProvider: string, storageKey: string): Promise<MediaInspection> {
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const source = storageProvider === "local"
    ? resolveLocalAssetPath(storageKey)
    : await getStorageAdapter(storageProvider).getSignedUrl(storageKey, 300);
  if (!source) return { status: "UNAVAILABLE", source: "ffprobe", errorCode: "MEDIA_SOURCE_UNAVAILABLE" };
  try {
    const { stdout } = await execFileAsync(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration,bit_rate,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,bit_rate",
      "-of", "json",
      source,
    ], { windowsHide: true, timeout: Number(process.env.FFPROBE_TIMEOUT_MS || 15_000), maxBuffer: 1024 * 1024 });
    return parseFfprobeOutput(stdout);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: "UNAVAILABLE", source: "ffprobe", errorCode: "FFPROBE_NOT_INSTALLED" };
    return { status: "FAILED", source: "ffprobe", errorCode: code || "FFPROBE_FAILED" };
  }
}

export function parseFfprobeOutput(stdout: string): MediaInspection {
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; bit_rate?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; bit_rate?: string }>;
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  return {
    status: "AVAILABLE",
    source: "ffprobe",
    durationSeconds: finiteNumber(parsed.format?.duration),
    width: video?.width,
    height: video?.height,
    fps: parseFrameRate(video?.avg_frame_rate),
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    bitrate: finiteNumber(parsed.format?.bit_rate || video?.bit_rate),
    container: parsed.format?.format_name,
  };
}

function finiteNumber(value?: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFrameRate(value?: string) {
  if (!value) return undefined;
  const [numerator, denominator = "1"] = value.split("/");
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}
