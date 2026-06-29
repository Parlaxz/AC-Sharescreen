import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

const HELPER_EXE = "screenlink-video-enhancer.exe";

function findDevelopmentHelper(): string {
  const startDirectories = [
    app.getAppPath(),
    process.cwd(),
  ];

  for (const startDirectory of startDirectories) {
    let currentDirectory = path.resolve(startDirectory);

    for (let depth = 0; depth < 8; depth += 1) {
      const candidate = path.join(
        currentDirectory,
        "native",
        "video-enhancer",
        "build",
        "Release",
        HELPER_EXE,
      );

      if (existsSync(candidate)) {
        console.log(
          `[nvidia-capability] Using video enhancer helper: ${candidate}`,
        );

        return candidate;
      }

      const parentDirectory = path.dirname(currentDirectory);

      if (parentDirectory === currentDirectory) {
        break;
      }

      currentDirectory = parentDirectory;
    }
  }

  // Deterministic fallback used for the resulting diagnostic message.
  return path.resolve(
    app.getAppPath(),
    "..",
    "..",
    "native",
    "video-enhancer",
    "build",
    "Release",
    HELPER_EXE,
  );
}

/**
 * Resolve the native video-enhancer helper.
 */
export function getVideoEnhancerHelperPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, HELPER_EXE);
  }

  return findDevelopmentHelper();
}