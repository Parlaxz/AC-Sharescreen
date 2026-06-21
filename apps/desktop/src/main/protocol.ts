import { protocol, net } from "electron";
import path from "path";
import { fileURLToPath } from "url";

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
    if (url.hostname === "pair") {
      // Deep linking for pairing — the app handles this on startup via argv
      return new Response("ScreenLink pairing link received", { status: 200 });
    }
    return new Response("Not Found", { status: 404 });
  });
}

/**
 * Serve static renderer files for screenlink://app/... URLs.
 * In production, reads from dist/renderer.
 * Falls back to index.html for SPA client-side routing.
 */
async function serveRenderer(url: URL): Promise<Response> {
  const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  const distPath = path.join(__dirname, "..", "renderer");

  try {
    // net.fetch handles file:// URLs with proper MIME types and caching
    return await net.fetch(`file://${distPath}${filePath}`);
  } catch {
    // SPA fallback: serve index.html for any unrecognized path
    try {
      return await net.fetch(`file://${distPath}/index.html`);
    } catch {
      return new Response("Not Found", { status: 404 });
    }
  }
}
