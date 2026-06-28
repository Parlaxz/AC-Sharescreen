import { app } from "electron";
import path from "node:path";

const HELPER_EXE = "screenlink-video-enhancer.exe";

/**
 * Resolve the video-enhancer helper binary path.
 * In packaged builds: {resourcesPath}/screenlink-video-enhancer.exe
 * In development: {repo-root}/native/video-enhancer/build/Release/screenlink-video-enhancer.exe
 */
export function getVideoEnhancerHelperPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, HELPER_EXE);
  }

  // Development: from dist/main/, go up to repo root, then to native build output
  return path.join(
    __dirname, "..", "..", "..", "..",
    "native", "video-enhancer", "build", "Release", HELPER_EXE,
  );
}
