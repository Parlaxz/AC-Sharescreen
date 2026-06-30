// @vitest-environment happy-dom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const {
  initializeAppRuntimeMock,
  acquirePhase3RuntimeMock,
  releasePhase3RuntimeMock,
} = vi.hoisted(() => ({
  initializeAppRuntimeMock: vi.fn().mockResolvedValue(undefined),
  acquirePhase3RuntimeMock: vi.fn(),
  releasePhase3RuntimeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/renderer/services/initialize-app-runtime.js", () => ({
  initializeAppRuntime: initializeAppRuntimeMock,
}));

vi.mock("../src/renderer/services/phase3-runtime.js", () => ({
  acquirePhase3Runtime: acquirePhase3RuntimeMock,
  releasePhase3Runtime: releasePhase3RuntimeMock,
}));

vi.mock("../src/renderer/components/layout/AppShell.js", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div data-testid="app-shell">{children}</div>,
}));

vi.mock("../src/renderer/components/workspace/GroupOverview.js", () => ({ GroupOverview: () => <div /> }));
vi.mock("../src/renderer/components/workspace/HostDashboard.js", () => ({ HostDashboard: () => <div /> }));
vi.mock("../src/renderer/components/workspace/ShareSetup.js", () => ({ ShareSetup: () => <div /> }));
vi.mock("../src/renderer/components/workspace/CreateGroupDialog.js", () => ({ CreateGroupDialog: () => <div /> }));
vi.mock("../src/renderer/components/workspace/JoinGroupDialog.js", () => ({ JoinGroupDialog: () => <div /> }));
vi.mock("../src/renderer/routes/HomePage.js", () => ({ HomePage: () => <div /> }));
vi.mock("../src/renderer/components/workspace/GroupsWorkspace.js", () => ({ GroupsWorkspace: () => <div /> }));
vi.mock("../src/renderer/components/workspace/QualityPresetsPage.js", () => ({ QualityPresetsPage: () => <div /> }));
vi.mock("../src/renderer/components/workspace/SettingsPage.js", () => ({ SettingsPage: () => <div /> }));
vi.mock("../src/renderer/components/workspace/GroupSettingsPage.js", () => ({ GroupSettingsPage: () => <div /> }));
vi.mock("../src/renderer/components/workspace/DiagnosticsPage.js", () => ({ DiagnosticsPage: () => <div /> }));
vi.mock("../src/renderer/components/workspace/QuickShareDialog.js", () => ({ QuickShareDialog: () => <div /> }));
vi.mock("../src/renderer/routes/About.js", () => ({ About: () => <div /> }));
vi.mock("../src/renderer/routes/ComponentGallery.js", () => ({ ComponentGallery: () => <div /> }));
vi.mock("../src/renderer/components/CommandPalette.js", () => ({ CommandPalette: () => <div /> }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => <div /> }));
vi.mock("@/components/ui/tooltip", () => ({ TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("../src/renderer/hooks/use-keyboard-shortcuts.js", () => ({ useKeyboardShortcuts: () => undefined }));
vi.mock("../src/renderer/hooks/use-preload-events.js", () => ({ usePreloadEvents: () => undefined }));
vi.mock("../src/renderer/services/group-shortcut-service.js", () => ({ initGroupShortcutListener: () => vi.fn() }));

import { App } from "../src/renderer/App.js";

describe("App runtime lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { screenlink?: unknown }).screenlink = {
      onQuickShareOpen: () => () => undefined,
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { screenlink?: unknown }).screenlink;
  });

  it("keeps the phase 3 runtime alive across ordinary App unmount cleanup", async () => {
    const { unmount } = render(<App />);

    expect(initializeAppRuntimeMock).toHaveBeenCalledTimes(1);

    unmount();

    expect(releasePhase3RuntimeMock).not.toHaveBeenCalled();
  });
});
