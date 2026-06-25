# ScreenLink UI Implementation Guardrails

> Source: `docs/ScreenLink_Stage_3_7_UI_Design_Document.md` Section 17
> These are **automatic review failures**. Every implementation task must be checked against this list before completion.

## Checklist — Verify Before Any UI Change

- [ ] **No dashboard blocks** — Did I import, copy, adapt, or start from any complete Watermelon dashboard, page block, admin template, analytics layout, or assembled dashboard example? (Section 1.1, 17)
- [ ] **Every visible piece from Watermelon** — Is every interactive and presentational UI element built from a Watermelon component or a composition of Watermelon components? No hand-built substitutes? (Section 1.2)
- [ ] **No second component library** — Did I introduce a separate UI library beyond Watermelon + its Radix/Framer Motion dependencies? (Section 1.4)
- [ ] **Composition, not custom primitives** — Did I create a product-specific surface by composing Watermelon components rather than inventing a new design primitive? (Section 1.5)
- [ ] **Animated variants preferred** — Did I use the animated Watermelon variant where available? If I used a static variant, did I document the reason? (Section 1.3, 17)
- [ ] **Colors use ScreenLink tokens** — Are all colors using the `--color-*` tokens from `app.css` (Section 10.1), not hardcoded hex values?
- [ ] **Radii use ScreenLink tokens** — Are border radii using `rounded-compact` (6px), `rounded-standard` (8px), or `rounded-dialog` (12px)?
- [ ] **Typography uses ScreenLink tokens** — Is Instrument Sans used for UI? Is Geist Mono used only for technical values? (Section 3.1)
- [ ] **Spacing uses 4px grid** — Are spacing values on the 4px base grid (4, 8, 12, 16, 20, 24, 32)? (Section 10.4)
- [ ] **Reduced motion respected** — Does the implementation include `prefers-reduced-motion: reduce` behavior? (Section 11.5)
- [ ] **Motion coverage considered** — Have entrance, exit, hover, press, focus, selection, loading, success, error, disabled, layout-change, and reduced-motion been considered? (Section 11.2)
- [ ] **Design token normalization** — Do all copied Watermelon components use ScreenLink tokens rather than their original example colors/radii? (Section 17)
- [ ] **No custom animation system** — Did I hand-build animation that duplicates a suitable Watermelon animated variant? (Section 17)
- [ ] **Adoption matrix consulted** — Did I check `docs/watermelon-adoption-matrix.md` for the correct Watermelon component for this UI role?
- [ ] **Not a dashboard look** — Does the shell resemble an admin analytics dashboard? It should not. (Section 17)

## Allowed Custom Code (Section 17.1)

Custom code is allowed for:
- ScreenLink state and business logic
- Electron window integration
- Media rendering and native video/audio elements
- WebRTC status binding
- Layout composition
- Responsive orchestration
- Data formatting
- Accessibility labels
- Tests
- Adapters connecting app state to Watermelon components

Custom code is **not** permission to invent replacement UI primitives.

## Watermelon Dependency Chain

| Layer | Technology |
|---|---|
| Core framework | React 19 + TypeScript |
| CSS | Tailwind v4 (via `@import "tailwindcss"`) |
| Design tokens | `app.css` `@theme` block |
| Animation | Framer Motion (`motion` package) |
| UI primitives | Watermelon components (Radix-based) |
| Icons | `lucide-react` |
| Class utilities | `clsx` + `tailwind-merge` via `cn()` |
| Variant API | `class-variance-authority` (CVA) |

Never add a separate animation library, icon set, or CSS framework.
