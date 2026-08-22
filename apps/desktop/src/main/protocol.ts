import { protocol, net } from "electron";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Register the screenlink:// privileged scheme.
 * Must be called before app 'ready' event.
 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "screenlink",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Register the screenlink:// protocol handler.
 * Must be called after app 'ready' event.
 */
export function registerAppProtocol(): void {
  protocol.handle("screenlink", (request) => {
    const url = new URL(request.url);
    if (url.hostname === "app") {
      return serveRenderer(url);
    }
    if (url.hostname === "group") {
      // Phase 3: deep linking for group invites. The renderer reads the
      // link from process.argv at startup; we do not log the URL.
      return new Response("ScreenLink group link received", { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  });
}

/**
 * Serve static renderer files for screenlink://app/... URLs.
 * In production, reads from dist/renderer.
 * Falls back to index.html for SPA client-side routing.
 *
 * Path containment: the pathname is percent-decoded, normalized, and resolved
 * against distPath; anything that escapes distPath (or contains null bytes)
 * is rejected with 404 so traversal sequences like "..%2F" cannot read
 * arbitrary files.
 */
async function serveRenderer(url: URL): Promise<Response> {
  const distPath = path.resolve(__dirname, "..", "renderer");

  // Reject null bytes outright — they can confuse filesystem APIs.
  if (url.pathname.includes("\0")) {
    return new Response("Not Found", { status: 404 });
  }

  let decodedPathname: string;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding
    return new Response("Not Found", { status: 404 });
  }

  const filePath = decodedPathname === "/" ? "/index.html" : decodedPathname;
  const resolved = path.resolve(distPath, path.normalize(filePath));

  // Containment check: the resolved path must stay inside distPath
  // (equal to distPath itself is also rejected — only real files serve).
  if (resolved !== distPath && !resolved.startsWith(distPath + path.sep)) {
    return new Response("Not Found", { status: 404 });
  }

  try {
    // net.fetch handles file:// URLs with proper MIME types and caching
    return await net.fetch(pathToFileURL(resolved).href);
  } catch {
    // SPA fallback: serve index.html for any unrecognized path
    try {
      return await net.fetch(pathToFileURL(path.join(distPath, "index.html")).href);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
}
