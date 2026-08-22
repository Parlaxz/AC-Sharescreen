import { useId } from "react";
import type React from "react";
import { cn } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PageSectionProps {
  /** Section title — displayed as a secondary heading */
  title: string;
  /** Optional description displayed below the title */
  description?: string;
  /** Optional action elements (buttons, toggles) shown in the header row */
  actions?: React.ReactNode;
  /** Section content */
  children: React.ReactNode;
  /** Additional class names */
  className?: string;
}

/**
 * PageSection — a labeled content section within a page (Section 3.7G).
 *
 * Composed from ScreenLink design tokens. No hardcoded colors.
 *
 * Layout:
 *   ┌───────────────────────────────────┐
 *   │  Title               [ actions ]  │
 *   │  Description (optional)           │
 *   ├───────────────────────────────────┤
 *   │  children                         │
 *   └───────────────────────────────────┘
 *
 * @example
 *   <PageSection
 *     title="Stream quality"
 *     description="Configure your streaming settings"
 *     actions={<Button size="sm">Reset</Button>}
 *   >
 *     <SliderGroup ... />
 *   </PageSection>
 */
export function PageSection({
  title,
  description,
  actions,
  children,
  className,
}: PageSectionProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("space-y-4", className)}>
      {/* Header row — title + optional description and actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={headingId} className="text-sm font-medium text-text-primary">{title}</h2>
          {description && (
            <p className="text-xs text-text-secondary mt-0.5">{description}</p>
          )}
        </div>

        {actions && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {actions}
          </div>
        )}
      </div>

      {/* Section content */}
      {children}
    </section>
  );
}
