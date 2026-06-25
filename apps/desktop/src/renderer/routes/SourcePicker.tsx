import React, { useEffect, useState, useCallback, useRef } from "react";
import { useStore, type Page } from "../stores/main-store.js";
import type { CaptureSourceDTO } from "../../preload/api-types.js";

export function SourcePicker() {
  const { sourceId: currentSourceId, setSource, navigate } = useStore();
  const [sources, setSources] = useState<CaptureSourceDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(currentSourceId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSources = useCallback(async () => {
    try {
      const api = getApi();
      if (!api) return;
      const list = await api.getSources();
      setSources(list);
      setError(null);

      // Restore previous selection via fingerprint matching
      if (list.length > 0) {
        try {
          const settings = await api.getSettings() as Record<string, unknown>;
          const lastSourceId = settings.lastSourceId as string | undefined;
          const rawFingerprint = settings.lastSourceFingerprint as string | undefined;

          if (lastSourceId) {
            // Exact ID match first
            const exact = list.find((s) => s.id === lastSourceId);
            if (exact) {
              setSelectedId(exact.id);
            } else if (rawFingerprint) {
              // Fallback to fingerprint-based matching
              const fp = JSON.parse(rawFingerprint) as { kind?: string; name?: string; displayId?: string };
              const fallback = fp.kind === "screen"
                ? (() => {
                    const matches = list.filter((s) => s.displayId === fp.displayId && s.kind === "screen");
                    return matches.length === 1 ? matches[0] : undefined;
                  })()
                : undefined;
              if (fallback) setSelectedId(fallback.id);
            }
          }
        } catch {
          // Fingerprint restore is best-effort
        }
      }
    } catch (err) {
      console.error("Failed to fetch sources:", err);
      setError("Could not retrieve sources. Make sure screen recording is permitted.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount and refresh every 5 seconds
  useEffect(() => {
    fetchSources();
    intervalRef.current = setInterval(fetchSources, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSources]);

const getApi = () =>
  (window as unknown as { screenlink?: import("../../preload/api-types.js").ScreenLinkAPI }).screenlink;

  const handleSelect = useCallback(
    async (id: string, name: string) => {
      try {
        const api = getApi();
        await api?.setSource(id);
        setSelectedId(id);

        // Find the full source metadata to persist kind, displayId, fingerprint
        const source = sources.find((s) => s.id === id);
        const kind = source?.kind ?? "screen";
        const displayId = source?.displayId ?? null;

        // Persist full source metadata to store (kind, displayId, fingerprint)
        const fingerprint = await api?.getSourceFingerprint(id);
        setSource({
          id,
          name,
          kind,
          displayId,
          fingerprint: fingerprint ?? null,
        });

        // Persist fingerprint for auto-resume
        const updates: Record<string, unknown> = { lastSourceId: id, lastSourceName: name };
        if (fingerprint) {
          updates.lastSourceFingerprint = JSON.stringify(fingerprint);
        }
        await api?.updateSettings(updates);
        navigate("dashboard" as Page);
      } catch (err) {
        console.error("Failed to set source:", err);
        setError("Failed to select source. Try again.");
      }
    },
    [setSource, navigate, sources],
  );

  return (
    <div className="source-picker">
      <div className="page-header">
        <h1>Select Source</h1>
        <button className="ghost" onClick={() => navigate("dashboard" as Page)}>
          &larr; Back
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading && sources.length === 0 ? (
        <div className="loading">
          <p>Scanning available sources...</p>
        </div>
      ) : sources.length === 0 ? (
        <div className="empty-state card">
          <p>No screens or windows detected.</p>
          <p className="dim">Make sure screen recording permissions are granted.</p>
        </div>
      ) : (
        <>
          {/* Screens section */}
          {sources.filter((s) => s.kind === "screen").length > 0 && (
            <section>
              <h2 className="section-title">Screens</h2>
              <div className="source-grid">
                {sources
                  .filter((s) => s.kind === "screen")
                  .map((src) => (
                    <div
                      key={src.id}
                      className={`source-card ${
                        selectedId === src.id ? "selected" : ""
                      }`}
                      onClick={() => handleSelect(src.id, src.name)}
                    >
                      <img
                        src={src.thumbnailDataUrl}
                        alt={src.name}
                        loading="lazy"
                      />
                      <p className="source-name">{src.name}</p>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* Windows section */}
          {sources.filter((s) => s.kind === "window").length > 0 && (
            <section>
              <h2 className="section-title">Windows</h2>
              <div className="source-grid">
                {sources
                  .filter((s) => s.kind === "window")
                  .map((src) => (
                    <div
                      key={src.id}
                      className={`source-card ${
                        selectedId === src.id ? "selected" : ""
                      }`}
                      onClick={() => handleSelect(src.id, src.name)}
                    >
                      <img
                        src={src.thumbnailDataUrl}
                        alt={src.name}
                        loading="lazy"
                      />
                      <p className="source-name">{src.name}</p>
                      {src.appIconDataUrl && (
                        <img
                          className="app-icon"
                          src={src.appIconDataUrl}
                          alt=""
                        />
                      )}
                    </div>
                  ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
