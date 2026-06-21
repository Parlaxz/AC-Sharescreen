/**
 * URL parsing and building for viewer links.
 *
 * Viewer links use the URL fragment (#) to carry parameters:
 *   https://example.com/viewer#v=1&share=abc123&token=xyz456&name=User&preset=balanced
 */

export interface ViewerLinkParams {
  version: 1;
  shareId: string;
  token: string;
  name?: string;
  preset?: string;
}

/**
 * Parse a window.location.hash fragment into ViewerLinkParams.
 * Returns null if the fragment is invalid or missing required fields.
 *
 * Expected format: #v=1&share=...&token=...&name=...&preset=...
 */
export function parseViewerUrl(hash: string): ViewerLinkParams | null {
  if (!hash.startsWith("#")) return null;

  const query = hash.slice(1); // Remove leading #
  const params = new URLSearchParams(query);

  const version = params.get("v");
  if (version !== "1") return null;

  const shareId = params.get("share");
  if (!shareId) return null;

  const token = params.get("token");
  if (!token) return null;

  const name = params.get("name") ?? undefined;
  const preset = params.get("preset") ?? undefined;

  return {
    version: 1,
    shareId,
    token,
    ...(name && { name }),
    ...(preset && { preset }),
  };
}

/**
 * Build a fragment-based viewer URL from params.
 */
export function buildViewerUrl(baseUrl: string, params: ViewerLinkParams): string {
  const searchParams = new URLSearchParams();
  searchParams.set("v", String(params.version));
  searchParams.set("share", params.shareId);
  searchParams.set("token", params.token);

  if (params.name) {
    searchParams.set("name", params.name);
  }
  if (params.preset) {
    searchParams.set("preset", params.preset);
  }

  const base = baseUrl.replace(/\/$/, "");
  return `${base}#${searchParams.toString()}`;
}

/**
 * Quick check if a hash fragment looks like a viewer URL.
 */
export function isViewerUrl(hash: string): boolean {
  return hash.startsWith("#v=1&share=");
}
