import type React from "react";
import { cn } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PageHeaderProps {
  /** Page title — displayed as the primary heading */
  title: string;
  /** Optional subtitle or description below the title */
  description?: string;
  /** Optional rich description node rendered like `description` (takes precedence) */
  descriptionNode?: React.ReactNode;
  /** Optional eyebrow text displayed above the title */
  eyebrow?: string;
  /** Optional status element (badge, pill, indicator) shown in the header row */
  status?: React.ReactNode;
  /** Optional action elements (buttons, menus) shown in the header row */
  actions?: React.ReactNode;
  /** Additional class names */
  className?: string;
}

/**
 * PageHeader — top-of-page heading region (Section 3.7G).
 *
 * Composed from ScreenLink design tokens. No hardcoded colors.
 *
 * Layout:
 *   ┌─────────────────────────────┬──────────┐
 *   │  eyebrow (optional)         │          │
 *   │  Title                      │  status  │
 *   │  Description (optional)     │  actions │
 *   └─────────────────────────────┴──────────┘
 *
 * @example
 *   <PageHeader
 *     title="Group Settings"
 *     description="Manage your group preferences"
 *     eyebrow="Configuration"
 *     actions={<Button>Save</Button>}
 *   />
 */
export function PageHeader({
  title,
  description,
  descriptionNode,
  eyebrow,
  status,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("mb-6", className)}>
      {/* Eyebrow — subtle label above the title */}
      {eyebrow && (
        <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-1">
          {eyebrow}
        </p>
      )}

      {/* Title row with optional status and actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
          {(descriptionNode ?? description) && (
            <p className="text-sm text-text-secondary mt-1">
              {descriptionNode ?? description}
            </p>
          )}
        </div>

        {/* Status + Actions — right-aligned, shrink-protected */}
        {(status || actions) && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {status}
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
