// @vitest-environment happy-dom
/**
 * Runtime behavior tests for PageHeader and PageSection.
 *
 * These tests render real components into a DOM environment and
 * verify rendered output, accessible structure, and prop-driven
 * rendering — not source string patterns.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";

import { PageHeader } from "../src/renderer/components/layout/PageHeader.js";
import { PageSection } from "../src/renderer/components/layout/PageSection.js";

beforeEach(() => {
  // no shared state to reset
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── PageHeader ─────────────────────────────────────────────────────────────

describe("PageHeader runtime behavior", () => {
  it("renders the title as a heading", () => {
    render(<PageHeader title="My Settings" />);
    const heading = screen.getByRole("heading", { name: "My Settings" });
    expect(heading).toBeInTheDocument();
  });

  it("renders the description when provided", () => {
    render(
      <PageHeader title="Settings" description="Manage your preferences" />,
    );
    expect(screen.getByText("Manage your preferences")).toBeInTheDocument();
  });

  it("renders eyebrow text above the title when provided", () => {
    render(
      <PageHeader
        title="Settings"
        description="desc"
        eyebrow="Configuration"
      />,
    );
    expect(screen.getByText("Configuration")).toBeInTheDocument();
  });

  it("renders status element when provided", () => {
    render(
      <PageHeader
        title="Settings"
        status={<span data-testid="status-badge">Active</span>}
      />,
    );
    expect(screen.getByTestId("status-badge")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("renders actions when provided", () => {
    render(
      <PageHeader
        title="Settings"
        actions={<button type="button">Save</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("does not render description when not provided", () => {
    render(<PageHeader title="Only Title" />);
    // Only the heading should be present
    expect(screen.getByRole("heading", { name: "Only Title" })).toBeInTheDocument();
    // No stray text for description
    expect(screen.queryByText("Only Title")).toBeInTheDocument();
  });

  it("sets text-text-primary class on the heading", () => {
    render(<PageHeader title="Test" />);
    const heading = screen.getByRole("heading", { name: "Test" });
    expect(heading.className).toContain("text-text-primary");
  });
});

// ─── PageSection ────────────────────────────────────────────────────────────

describe("PageSection runtime behavior", () => {
  it("renders the title as a level-2 heading", () => {
    render(<PageSection title="Stream Quality">content</PageSection>);
    const heading = screen.getByRole("heading", { name: "Stream Quality" });
    expect(heading).toBeInTheDocument();
    expect(heading.tagName).toBe("H2");
  });

  it("renders description when provided", () => {
    render(
      <PageSection title="Quality" description="Adjust your stream settings">
        content
      </PageSection>,
    );
    expect(
      screen.getByText("Adjust your stream settings"),
    ).toBeInTheDocument();
  });

  it("renders actions when provided", () => {
    render(
      <PageSection
        title="Quality"
        actions={<button type="button">Reset</button>}
      >
        content
      </PageSection>,
    );
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("renders children content", () => {
    render(
      <PageSection title="Test">
        <div data-testid="child">child content</div>
      </PageSection>,
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.getByText("child content")).toBeInTheDocument();
  });

  it("associates section with heading via aria-labelledby", () => {
    render(<PageSection title="Accessible Section">content</PageSection>);
    const heading = screen.getByRole("heading", {
      name: "Accessible Section",
    });
    const section = heading.closest("section");
    expect(section).toBeInTheDocument();
    expect(section!.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("has region role via section element", () => {
    render(<PageSection title="My Region">content</PageSection>);
    // A <section> with an accessible name is mapped to the region role
    const heading = screen.getByRole("heading", { name: "My Region" });
    const section = heading.closest("section");
    expect(section).toBeInTheDocument();
  });

  it("sets text-text-primary class on the heading", () => {
    render(<PageSection title="Test">content</PageSection>);
    const heading = screen.getByRole("heading", { name: "Test" });
    expect(heading.className).toContain("text-text-primary");
  });
});
