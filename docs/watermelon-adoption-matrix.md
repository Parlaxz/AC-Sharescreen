# Watermelon Adoption Matrix

> Source: `docs/ScreenLink_Stage_3_7_UI_Design_Document.md` Section 12
> Every ScreenLink UI role maps to an individual Watermelon component or composition.

## Foundational Primitives

| ScreenLink Role | Watermelon Component(s) | Notes |
|---|---|---|
| Button (primary, secondary, ghost, destructive, outline, link) | `Button` (`@/components/ui/button`) | CVA variants for all Button types; animated hover/press via CSS transitions |
| Icon button | `Button` with `size="icon"` variant | Button supports `asChild` for Slot composition |
| Card / surface container | `Card`, `CardHeader`, `CardContent`, `CardFooter`, `CardTitle`, `CardDescription` | All from `@/components/ui/card` |
| Avatar / group icon | `Avatar`, `AvatarImage`, `AvatarFallback` | Radix-based; fallback shows initials |
| Badge / status indicator | `Badge` (`@/components/ui/badge`) | Variants: default, secondary, destructive, success, warning, outline |
| Tooltip | `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` | Radix-based; animated entrance with scale/fade |
| Dropdown menu | `DropdownMenu` family | Radix-based; includes items, labels, separators, shortcuts |
| Context menu | `ContextMenu` family | Radix-based; same pattern as dropdown |
| Dialog / modal | `Dialog` family | Radix-based; overlay + animated content |
| Sheet / drawer | `Sheet` family | Radix-based; configurable side (left/right/top/bottom) |
| Tabs / segmented control | `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Radix-based; animated indicator |
| Separator | `Separator` | Radix-based; horizontal/vertical |
| Scroll area | `ScrollArea`, `ScrollBar` | Radix-based; custom thumb styling |
| Skeleton / loading placeholder | `Skeleton` (`@/components/ui/skeleton`) | CSS pulse animation |
| Toast / notification | `Toaster` + `sonner` (`@/components/ui/sonner`) | Sonner library; dark theme styled to ScreenLink tokens |
| Popover | `Popover`, `PopoverTrigger`, `PopoverContent` | Radix-based; origin-aware scale/fade |
| Select / combobox | `Select` family | Radix-based; trigger + content with items |
| Switch / toggle | `Switch` | Radix-based; animated thumb |
| Slider | `Slider` | Radix-based; dual-thumb capable |
| Progress indicator | `Progress` | Radix-based; animated fill |
| Text input / search field | `Input` (`@/components/ui/input`) | Styled to ScreenLink tokens |
| Label | `Label` | Radix-based; peer-disabled support |
| Checkbox | `Checkbox` | Radix-based; animated check indicator |
| Radio group | `RadioGroup`, `RadioGroupItem` | Radix-based |
| Command palette | `Command`, `CommandDialog`, `CommandInput`, `CommandList`, etc. | `cmdk` library; opens in a Dialog overlay |
| Resizable panels | `ResizablePanel`, `ResizableHandle` | Custom lightweight implementation; supports handle with grip dots |
| Alert / banner | `Alert`, `AlertTitle`, `AlertDescription` | Variants: default, destructive, warning, success |
| Navigation menu | `NavigationMenu` family | Radix-based; animated viewport |

## Product-Level Compositions

| ScreenLink Surface | Watermelon Building Blocks | Notes |
|---|---|---|
| Group rail item | `Avatar` + `Tooltip` + `Badge` + animated `motion.div` | Compose from primitives; no custom `GroupRailItem` |
| Group navigation row | `NavigationMenu` or animated `Button` + `Badge` | Shared selection indicator |
| User dock | `Card` + `Avatar` + `Badge` + `Button` (icon) + `DropdownMenu` | All children from Watermelon |
| Active-share card | `Card` + `Avatar` + `Badge` + `Button` + animated layout via `motion.div` | Product composition only |
| Source category switcher | `Tabs` (animated) | Watermelon indicator |
| Source tile | `Card` + `RadioGroup`/selectable + `Skeleton` + `Tooltip` | Product composition; visual parts from Watermelon |
| Audio mode picker | `RadioGroup` with styled cards or `Tabs` | Selectable primitive |
| Quality preset picker | `RadioGroup` with styled cards or `Tabs` | Selectable primitive |
| Quality controls (custom) | `Slider` + `Select` + `Switch` + animated `Disclosure` pattern | All primitives from Watermelon |
| Invite flow | `Dialog` + `Input` + `Button` + `Toaster` | Standard dialog pattern |
| Settings pages | `Tabs` + form components (`Input`, `Switch`, `Select`, `Button`) + `Sheet` | Watermelon primitives only |
| Context panel | `ResizablePanel` + `ResizableHandle` + `Tabs` + `ScrollArea` + animated presence | No custom pane system |
| Viewer controls | `Button` (icon) + `Slider` + `Popover` + `Tooltip` + animated presence | Native video element is only non-Watermelon part |
| Notification system | `Toaster` (Sonner) | Shared status language |
| Loading states | `Skeleton` / `Progress` / `Spinner icon` | Choose by expected wait length |
| Title bar controls | `Button` (icon/groups) + `Tooltip` + `DropdownMenu` | Animated hover/press via CSS |
| Empty states | `Card` + icon + `Button` + descriptive text | Product layout; visual components from Watermelon |
| Error state | `Alert` (destructive/warning) + `Button` | Watermelon alert primitives |

## Non-Component UI Elements

| Element | Implementation Strategy |
|---|---|
| Native video / preview element | Native `<video>` — no Watermelon equivalent exists |
| WebRTC status bindings | Application logic connecting store data to Watermelon component props |
| Layout composition / responsive orchestration | Application code using Watermelon components as building blocks |
| Accessibility labels | Added to Watermelon components via standard React props |
| Animated layout transitions | `motion.div` from Framer Motion (via `motion` package) with ScreenLink timing |
| Reduced-motion behavior | CSS `@media (prefers-reduced-motion: reduce)` in app.css; Watermelon's `MotionConfig` |

## Excluded (Dashboard Block Prohibition)

The following must **never** be imported or adapted:
- Any complete Watermelon dashboard page or template
- `admin-page`, `analytics-page`, `settings-page`, `dashboard-page` blocks
- Assembled page layouts from Watermelon registry
- Any component imported as part of a dashboard bundle

## Dependency Audit

| Package | Purpose | Source |
|---|---|---|
| `@radix-ui/*` | Accessible UI primitives | Watermelon's Radix foundation |
| `motion` (Framer Motion v11) | Animation | Watermelon motion dependency |
| `clsx` | Conditional class joining | Utility |
| `tailwind-merge` | Tailwind class deduplication | Utility |
| `class-variance-authority` | Component variant API | Watermelon pattern |
| `lucide-react` | Icon library | Watermelon icon source |
| `cmdk` | Command palette primitive | Watermelon command component |
| `sonner` | Toast notification library | Watermelon toast component |
| `tailwindcss` v4 | CSS framework | Styling foundation |
| `@tailwindcss/vite` | Tailwind Vite plugin | Build integration |
| `tailwindcss-animate` | Tailwind animation utilities | Watermelon animation support |
| `tw-animate-css` | Additional animation classes | Watermelon animation support |
