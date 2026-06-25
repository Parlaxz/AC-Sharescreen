import { useEffect, useState } from "react";
import { Monitor, ExternalLink } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";


interface AppInfo {
  version: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion?: string;
}

/**
 * About — Application info page (Section 16.7).
 *
 * Uses Watermelon Card structure with Monitor icon as app icon placeholder.
 */
export function About() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const api = (
          window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }
        ).screenlink;
        const info = await api?.getAppInfo();
        if (info) setAppInfo(info);
      } catch {
        // Silently fail
      }
    })();
  }, []);

  const InfoRow = ({ label, value }: { label: string; value: string }) => (
    <div className="flex items-center justify-between py-1 border-b border-border-subtle last:border-b-0">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="font-mono text-xs text-text-primary">{value}</span>
    </div>
  );

  return (
    <div className="h-full overflow-auto p-6 space-y-6">
      {/* ─── Page header ─────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">About ScreenLink</h1>
      </div>

      {/* ─── App hero card ───────────────────────────────────── */}
      <Card>
        <CardContent className="flex flex-col items-center py-8 space-y-3">
          <div className="flex items-center justify-center h-16 w-16 rounded-dialog bg-accent-muted">
            <Monitor className="h-8 w-8 text-accent" />
          </div>
          <h2 className="text-lg font-semibold text-text-primary">ScreenLink</h2>
          <p className="font-mono text-sm text-text-secondary">
            v{appInfo?.version ?? "?"}
          </p>
          <p className="text-xs text-text-muted">
            Private screen sharing with permanent links
          </p>
        </CardContent>
      </Card>

      {/* ─── Technology stack ────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Technology Stack</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-0">
            <InfoRow label="Application" value={appInfo?.version ?? "?"} />
            <InfoRow label="Electron" value={appInfo?.electronVersion ?? "?"} />
            <InfoRow label="Chromium" value={appInfo?.chromeVersion ?? "?"} />
            <InfoRow label="Node.js" value={appInfo?.nodeVersion ?? "?"} />
            <InfoRow label="React" value="19" />
            <InfoRow label="Zustand" value="5" />
            <InfoRow label="Zod" value="3" />
          </div>
        </CardContent>
      </Card>

      {/* ─── License ─────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>License</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-text-secondary">
            ScreenLink is provided under the terms of the ISC License.
          </p>
          <p className="text-xs text-text-muted">
            The VDO SDK component is licensed under AGPL-3.0.
            See the LICENSE file in the repository for full details.
          </p>
        </CardContent>
      </Card>

      {/* ─── Links ───────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Links</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <a
            href="#"
            className="flex items-center gap-2 text-sm text-accent hover:text-accent-hover transition-colors"
            onClick={(e) => {
              e.preventDefault();
              // In production: api.openExternal("https://github.com/...")
            }}
          >
            <ExternalLink className="h-4 w-4" />
            Source code on GitHub
          </a>
          <a
            href="#"
            className="flex items-center gap-2 text-sm text-accent hover:text-accent-hover transition-colors"
            onClick={(e) => {
              e.preventDefault();
              // In production: api.openExternal("https://screenlink.app")
            }}
          >
            <ExternalLink className="h-4 w-4" />
            ScreenLink website
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
