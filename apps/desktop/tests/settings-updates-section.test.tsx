// @vitest-environment node
/**
 * settings-updates-section.test.tsx
 *
 * Proves the User Settings page renders a real Updates section that
 * consumes the `useUpdateStatus` hook. No fake strings, no fake
 * versions, no auto-install controls, no prerelease toggles.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PAGE = path.resolve(
  __dirname,
  "../src/renderer/components/workspace/SettingsPage.tsx",
);
const SECTION = path.resolve(
  __dirname,
  "../src/renderer/components/settings/UpdatesSettingsSection.tsx",
);

describe("User Settings — Updates section is real", () => {
  it("SettingsPage imports the UpdatesSettingsSection component", () => {
    const source = fs.readFileSync(SETTINGS_PAGE, "utf-8");
    expect(source).toMatch(/import\s+\{[^}]*UpdatesSettingsSection[^}]*\}\s+from\s+["']@\/components\/settings\/UpdatesSettingsSection["']/);
  });

  it("SettingsPage renders the Updates card with a heading", () => {
    const source = fs.readFileSync(SETTINGS_PAGE, "utf-8");
    expect(source).toContain("<CardTitle>Updates</CardTitle>");
    expect(source).toContain("<UpdatesSettingsSection");
  });

  it("UpdatesSettingsSection consumes the useUpdateStatus hook", () => {
    const source = fs.readFileSync(SECTION, "utf-8");
    expect(source).toMatch(/import\s+\{[^}]*useUpdateStatus[^}]*\}\s+from\s+["']@\/hooks\/use-update-status["']/);
  });

  it("UpdatesSettingsSection does NOT add forbidden UI affordances", () => {
    const source = fs.readFileSync(SECTION, "utf-8");
    // Strip comments and strings from doc-block style, then assert that
    // the source does not actually wire up any of the forbidden controls.
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const lc = codeOnly.toLowerCase();
    // The spec forbids update channels, prerelease toggles, automatic-install
    // settings, fake release notes, fake latest version.
    expect(lc).not.toMatch(/<select[^>]*>[\s\S]*?(release.?channel|update.?channel)/i);
    expect(lc).not.toMatch(/<switch[^>]*>[\s\S]*?(prerelease|beta.?channel|allow.?prerelease)/i);
    expect(lc).not.toMatch(/<switch[^>]*>[\s\S]*?(auto.?install|install.?automatically)/i);
    expect(codeOnly).not.toContain("Improved WebRTC");
    expect(codeOnly).not.toContain("1.1.0");
  });

  it("UpdatesSettingsSection does not hardcode a fake latest version", () => {
    const source = fs.readFileSync(SECTION, "utf-8");
    expect(source).not.toMatch(/["']0\.\d+\.\d+["']/);
  });

  it("UpdatesSettingsSection displays current version from status", () => {
    const source = fs.readFileSync(SECTION, "utf-8");
    expect(source).toContain("status.currentVersion");
  });

  it("renders check-download-and-install button", () => {
    const source = fs.readFileSync(SECTION, "utf-8");
    expect(source).toContain("updates-full-update-button");
    expect(source).toContain("checkDownloadAndInstall");
    expect(source).toContain("Check, download, and install");
  });
});
