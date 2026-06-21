export function normalizeCodecName(mimeType: string): string {
  const map: Record<string, string> = {
    "video/H264": "h264",
    "video/VP8": "vp8",
    "video/VP9": "vp9",
    "video/AV1": "av1",
    "video/H265": "h265",
    "video/HEVC": "h265",
  };
  return map[mimeType] ?? mimeType.toLowerCase();
}

export async function getSupportedVideoCodecs(): Promise<string[]> {
  if (!navigator.mediaCapabilities?.encodingInfo) {
    return ["h264", "vp8", "vp9"]; // fallback
  }

  const configs: MediaEncodingConfiguration[] = [
    { type: "record", video: { contentType: "video/H264", width: 854, height: 480, bitrate: 650000, framerate: 15 } },
    { type: "record", video: { contentType: "video/VP8", width: 854, height: 480, bitrate: 650000, framerate: 15 } },
    { type: "record", video: { contentType: "video/VP9", width: 854, height: 480, bitrate: 650000, framerate: 15 } },
    { type: "record", video: { contentType: "video/AV1", width: 854, height: 480, bitrate: 650000, framerate: 15 } },
    { type: "record", video: { contentType: "video/H265", width: 854, height: 480, bitrate: 650000, framerate: 15 } },
  ];

  const results = await Promise.allSettled(
    configs.map(c => navigator.mediaCapabilities.encodingInfo(c)),
  );

  return configs
    .filter((_, i) => {
      const result = results[i];
      return result?.status === "fulfilled" && "value" in result && result.value.supported;
    })
    .map(c => normalizeCodecName((c.video as NonNullable<typeof c.video>).contentType));
}
