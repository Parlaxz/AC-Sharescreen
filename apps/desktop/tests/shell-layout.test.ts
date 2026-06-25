// @vitest-environment node
import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const shellPath = path.resolve(
  __dirname,
  "../src/renderer/components/layout/AppShell.tsx",
);
const groupRailPath = path.resolve(
  __dirname,
  "../src/renderer/components/layout/GroupRail.tsx",
);
const groupDashboardPath = path.resolve(
  __dirname,
  "../src/renderer/components/layout/GroupDashboard.tsx",
);

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

describe("AppShell layout", () => {
  const shellSrc = readFileSafe(shellPath);
  const groupRailSrc = readFileSafe(groupRailPath);
  const groupDashboardSrc = readFileSafe(groupDashboardPath);

  it("uses h-screen on root and overflow-hidden", () => {
    expect(shellSrc).toContain("h-screen");
    expect(shellSrc).toContain("overflow-hidden");
  });

  it("content row uses flex-1 min-h-0", () => {
    expect(shellSrc).toContain("flex flex-1 min-h-0 overflow-hidden");
  });

  it("workspace uses min-w-0 (not min-w-[560px])", () => {
    expect(shellSrc).toContain("min-w-0");
    // Ensure no leftover hardcoded minimum width on the workspace.
    const resizableMatch = shellSrc.match(
      /<ResizablePanel[^>]*className="([^"]+)"/,
    );
    expect(resizableMatch).not.toBeNull();
    const className = resizableMatch![1]!;
    expect(className).toContain("min-w-0");
    expect(className).not.toMatch(/min-w-\[\d/);
  });

  it("group rail wrapper and rail root use h-full min-h-0", () => {
    expect(shellSrc).toMatch(/flex-shrink-0 overflow-hidden"[\s\S]{0,200}h-full min-h-0/);
    expect(groupRailSrc).toContain("h-full min-h-0");
  });

  it("group dashboard wrapper and root use h-full min-h-0", () => {
    expect(shellSrc).toMatch(/flex-shrink-0 overflow-hidden"[\s\S]{0,200}h-full min-h-0/);
    expect(groupDashboardSrc).toContain("h-full min-h-0");
  });

  it("no nested competing scroll owners in the workspace chain", () => {
    // Workspace renders one scrolling element; the inner <main>
    // already has overflow-auto so the ResizablePanel should not
    // also be a scroll owner.
    expect(shellSrc).toMatch(/<ResizablePanel[\s\S]{0,200}className="flex-1 min-w-0 min-h-0 bg-canvas overflow-hidden"/);
  });
});
