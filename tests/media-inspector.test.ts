import { describe, expect, it } from "vitest";
import { parseFfprobeOutput } from "../src/lib/media-inspector";

describe("MediaInspector", () => {
  it("normalizes ffprobe video metadata", () => {
    const result = parseFfprobeOutput(JSON.stringify({
      format: { duration: "12.5", bit_rate: "800000", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, avg_frame_rate: "30000/1001" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    }));
    expect(result).toMatchObject({ status: "AVAILABLE", durationSeconds: 12.5, width: 1920, height: 1080, videoCodec: "h264", audioCodec: "aac", bitrate: 800000 });
    expect(result.fps).toBeCloseTo(29.97, 2);
  });
});
