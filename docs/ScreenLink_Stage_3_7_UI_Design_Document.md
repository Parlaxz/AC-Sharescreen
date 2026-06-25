# ScreenLink Stage 3.7 UI Design Document

**Status:** Proposed design baseline for discussion before implementation  
**Target:** Windows 10/11 Electron desktop application  
**Primary layout reference:** Discord desktop information architecture  
**Secondary visual reference:** VS Code restraint, density, and panel discipline  
**UI source:** Watermelon UI individual components and animated primitives  
**Typography recommendation:** Instrument Sans with Geist Mono for technical values

---

## 1. Non-negotiable implementation rules

These rules override every other recommendation in this document.

### 1.1 Never use Watermelon dashboard blocks

ScreenLink must **not** install, copy, adapt, or start from any complete Watermelon dashboard, page block, admin template, analytics layout, or assembled dashboard example.

Dashboard blocks are reference material only. They must never become implementation dependencies or starting templates.

The ScreenLink shell must be assembled deliberately from **individual Watermelon components** so the product keeps its own information architecture and does not inherit irrelevant dashboard assumptions.

### 1.2 Every visible UI piece must come from Watermelon

All interactive and presentational UI must be built from Watermelon components or by composing Watermelon components together.

This includes:

- buttons
- icon buttons
- tooltips
- menus
- context menus
- dropdowns
- comboboxes
- tabs
- segmented controls
- cards
- list rows
- badges
- avatars
- status indicators
- dialogs
- drawers
- sheets
- popovers
- sliders
- switches
- checkboxes
- radios
- text fields
- search fields
- separators
- scroll areas
- skeletons
- progress indicators
- toasts
- command palettes
- disclosures
- resizable panels
- empty states
- overlays
- video control surfaces
- navigation items
- group icons
- source-selection tiles
- preset tiles
- stream cards
- user dock controls
- title-bar controls

Do not hand-build substitutes when Watermelon already provides a suitable primitive or animated component.

When ScreenLink requires a product-specific element that Watermelon does not provide as a named component, it must be created by **composing existing Watermelon primitives**, not by inventing a separate custom design system component.

Example:

- A ScreenLink active-share card is a composition of Watermelon card, avatar, badge, tooltip, icon button, menu, and animated layout primitives.
- A source picker is a composition of Watermelon tabs, cards, radio-group behavior, scroll area, skeleton, tooltip, and animated selection indicators.
- A video control bar is a composition of Watermelon buttons, sliders, popovers, tooltips, badges, and animated presence primitives.

ScreenLink may add application logic, data bindings, accessibility labels, and product-specific content. It should not add a parallel library of handcrafted visual primitives.

### 1.3 Prefer animated Watermelon variants

When Watermelon offers both a static and animated version of a component, use the animated version unless motion would harm clarity, performance, or accessibility.

Watermelon motion should be used throughout the interface for:

- navigation selection
- group switching
- panel appearance and removal
- dialog and sheet transitions
- list insertion and removal
- active-share appearance
- stream-state changes
- status badges
- tab indicators
- segmented-control indicators
- dropdowns and popovers
- tooltip appearance
- collapsible sections
- notifications
- progress and loading states
- source selection
- preset selection
- viewer controls
- hover and press feedback
- connection-state transitions
- remote quality request feedback
- context-panel transitions
- fullscreen chrome

The goal is not random movement. The goal is to use Watermelon’s animation library as the interface’s primary interaction language.

### 1.4 No second component system

Do not mix Watermelon with another component library for convenience. In particular, do not introduce a separate dashboard kit, design system, animation kit, or collection of bespoke primitives.

Underlying dependencies already required by Watermelon are acceptable. The public ScreenLink UI layer should remain Watermelon-first and visually coherent.

### 1.5 ScreenLink owns composition, not primitive design

The product may define:

- page composition
- panel dimensions
- data flow
- state machines
- semantic color tokens
- typography tokens
- content hierarchy
- responsive behavior
- accessibility requirements
- which Watermelon variants are used

The product should not independently redesign the internal behavior of buttons, menus, dialogs, sliders, tooltips, focus rings, or animation mechanics unless required to fix accessibility or Electron-specific behavior.

---

## 2. Product and visual intent

ScreenLink should look structurally familiar to users of Discord while remaining calmer, more focused, and more neutral.

The application is not a chat client. The Discord influence applies to the **rough shell shape and hierarchy**, not to Discord’s exact fonts, spacing, colors, social features, or detailed styling.

The intended balance is:

- Discord-like left-side application structure
- VS Code-like restraint and density
- dark neutral surfaces
- restrained blue interaction accents
- highly cohesive typography
- animation-driven transitions using Watermelon
- video-first presentation during viewing

### 2.1 Familiar, not derivative

Use Discord’s broad structural model:

1. group rail
2. selected-group navigation/dashboard column
3. primary workspace
4. optional right-side context panel
5. bottom-left user/status dock

Do not copy:

- Discord’s exact spacing
- Discord’s typography
- Discord’s iconography
- Discord’s channel model
- Discord’s friends or direct-message model
- Nitro/shop/quest surfaces
- voice-chat controls that ScreenLink does not need
- decorative server-folder behavior unless later required

### 2.2 Dark neutrals with blue accents

The app should use layered neutral greys rather than pure black everywhere.

Blue is reserved for:

- selected navigation
- primary actions
- live stream identity
- focus indication
- active controls
- successful remote-control application
- progress and connection activity

Amber indicates degradation or recovery. Red indicates destructive actions or unrecoverable errors. Green should be used sparingly for healthy/connected confirmation, not as a competing primary accent.

### 2.3 Cohesion is more important than novelty

The interface should use:

- one primary type family
- one mono type family
- one icon family exposed through Watermelon components
- one radius system
- one border system
- one focus-ring system
- one motion vocabulary
- one semantic status vocabulary

A component should not look like it came from a different product merely because it was copied from another Watermelon example. All selected Watermelon components must be normalized to ScreenLink tokens.

---

## 3. Typography

Typography is a primary visual feature, not a finishing detail.

## 3.1 Recommended font pairing

### Primary UI font: Instrument Sans

Instrument Sans is the recommended first choice because it is close enough to Inter to remain highly readable, but has more personality and a less generic product feel.

Use it for:

- navigation
- headings
- buttons
- labels
- menus
- dialogs
- cards
- status text
- empty states
- settings

### Technical font: Geist Mono

Use Geist Mono only for values that benefit from stable character widths or a technical distinction:

- bitrate
- resolution
- frame rate
- codec
- connection IDs
- timestamps in diagnostics
- helper versions
- advanced statistics

Do not use mono text for ordinary navigation or body copy.

## 3.2 Typography rules

- Use sentence case throughout.
- Use medium weight for navigation and controls.
- Use semibold only for major page titles and strong state labels.
- Avoid bold body copy.
- Keep line heights compact but never cramped.
- Use tabular numerals for rapidly changing stream statistics.
- Avoid excessive uppercase text.
- Do not use tiny all-caps section labels as a default dashboard convention.
- Keep status copy direct: `Live`, `Reconnecting`, `Audio unavailable`, `Relay connection`.

## 3.3 Initial type scale

| Role | Size | Weight | Notes |
|---|---:|---:|---|
| Workspace title | 20 px | 600 | One per primary workspace |
| Panel title | 15 px | 600 | Group name, context title |
| Navigation item | 14 px | 500 | High legibility at desktop density |
| Body | 14 px | 400 | Default UI copy |
| Control label | 13 px | 500 | Inputs, menus, compact buttons |
| Supporting text | 12 px | 400 | Secondary state and metadata |
| Technical value | 12–13 px | 500 mono | Use tabular figures |

These values are a starting system, not permission to reproduce Discord’s spacing or density exactly.

---

## 4. Desktop shell

The default shell uses four visual regions and one bottom-left floating dock.

```text
┌──────┬────────────────────┬──────────────────────────────────────┬─────────────────┐
│      │                    │                                      │                 │
│GROUP │ SELECTED GROUP     │ PRIMARY WORKSPACE                    │ CONTEXT PANEL   │
│RAIL  │ DASHBOARD          │                                      │ optional        │
│      │                    │                                      │                 │
│      │                    │                                      │                 │
│      │                    │                                      │                 │
│      │                    │                                      │                 │
│      ├────────────────────┤                                      │                 │
│      │ USER / STATUS DOCK │                                      │                 │
└──────┴────────────────────┴──────────────────────────────────────┴─────────────────┘
```

This diagram defines rough shape only. It does not prescribe Discord’s spacing, visual styling, or exact proportions.

## 4.1 Region dimensions

| Region | Initial width | Behavior |
|---|---:|---|
| Group rail | 64 px | Fixed at normal desktop widths |
| Group dashboard | 224–248 px | Resizable only if testing proves value |
| Primary workspace | Fluid, minimum 560 px | Receives remaining width |
| Context panel | 280–320 px | Optional and collapsible |
| User dock | Bottom of group dashboard | Persistent except focused fullscreen viewer |

Use Watermelon resizable-panel primitives if resizing is supported. Do not hand-build split-pane drag behavior.

## 4.2 Window chrome

Use a compact custom Electron title bar composed entirely from Watermelon buttons, tooltips, menu primitives, and animated hover/press states.

The title bar should contain only:

- current workspace or group name when useful
- drag region
- update/status indicator when necessary
- minimize
- maximize/restore
- close

The title bar must visually belong to the shell rather than appear as a separate web toolbar.

---

## 5. Group rail

The group rail replaces Discord’s server rail conceptually.

## 5.1 Contents

From top to bottom:

1. ScreenLink home/product button
2. joined groups
3. create or join group action
4. optional separator for archived or special groups only if that feature exists

Do not place the user dock in the group rail. It belongs at the bottom of the selected-group dashboard column.

## 5.2 Watermelon composition

Each group item must be composed from Watermelon:

- animated tooltip
- icon button or button primitive
- avatar primitive
- badge primitive
- animated active indicator
- animated hover/press state
- context-menu primitive where needed

Use Watermelon layout animation when groups are added, removed, reordered, or change live-state badges.

## 5.3 Interaction states

Each group has:

- default
- hover
- keyboard focus
- selected
- one or more active shares
- degraded connection
- notification activity
- context menu open

The selected state should use a blue side marker and a slightly raised neutral surface. A live share may use a subtle blue ring or animated badge, but should not continuously pulse at full intensity.

## 5.4 Motion

Use Watermelon animation for:

- active marker movement between groups
- badge count changes
- tooltip entrance and exit
- hover and press feedback
- group insertion/removal
- context menu entrance
- live-state ring transition

The active indicator should move between items rather than abruptly disappear and reappear where the chosen Watermelon primitive supports shared layout animation.

---

## 6. Selected-group dashboard column

This column replaces Discord’s direct-message or channel list.

It is a compact task dashboard for the selected group.

## 6.1 Header

The header contains:

- group avatar
- group name
- compact member count
- animated dropdown or menu trigger

The menu contains Watermelon menu items for:

- invite members
- copy invite link
- group settings
- notification settings
- leave group

## 6.2 Navigation

Recommended navigation:

- Overview
- Active shares
- Members
- Presets
- Group settings

`Active shares` may remain visible at all times or appear with stronger emphasis when streams are active. It should not behave like a chat channel.

Every navigation item must use a Watermelon navigation/list/button primitive with:

- animated selection indicator
- icon
- label
- optional count or status badge
- tooltip in collapsed mode
- keyboard focus state

## 6.3 Contextual sections

Below primary navigation, the column may show a compact active-share section. Each row includes:

- avatar
- sharer name
- source label
- live badge
- viewer count where useful

Rows are built from Watermelon list, avatar, badge, tooltip, and animated-presence primitives.

Do not build a custom virtualized list unless Watermelon provides the required list or scroll-area foundation. First keep the group scale within normal UI limits and use Watermelon scroll areas.

---

## 7. Bottom-left user and status dock

The user dock is visually anchored at the bottom-left of the selected-group dashboard, similar in rough location to Discord’s user controls.

It should feel like a floating control surface without using glassmorphism.

## 7.1 Contents

- avatar or initials
- display name
- current ScreenLink state
- compact status indicator
- settings button
- overflow/status menu

Possible states:

- Ready
- Sharing
- Watching
- Connecting
- Reconnecting
- Offline
- Update available

Do not include permanent microphone or deafen controls unless ScreenLink later introduces features that make them meaningful.

## 7.2 Watermelon composition

Use only Watermelon:

- card or surface container
- avatar
- badge/status indicator
- icon buttons
- tooltip
- dropdown/context menu
- animated status transition
- notification indicator

When the status text changes, use Watermelon animated text/presence behavior rather than replacing text with an abrupt layout jump.

## 7.3 Dock behavior

- Persistent in normal group and host views.
- Reduced to a minimal overlay or hidden in fullscreen viewer mode.
- Settings opens a Watermelon animated sheet or dialog.
- Update state opens a Watermelon popover or menu.
- Quit/tray actions remain behind a clear overflow control.

---

## 8. Primary workspace layouts

## 8.1 Group overview: no active shares

The workspace header includes:

- group title
- member count
- invite action
- overflow menu

The main surface includes:

- concise empty state
- `Start sharing` primary action
- optional compact guidance

Do not center a tiny card in a huge empty dashboard. Keep the content aligned to a consistent workspace grid.

Watermelon components:

- animated page/header entrance
- button
- empty-state composition
- card/surface
- tooltip
- dialog or sheet for invite
- animated menu

## 8.2 Group overview: active shares

Display active shares first.

Each active-share card shows:

- sharer avatar and name
- source name
- live duration
- resolution, frame rate, and bitrate summary
- audio mode
- viewer count
- `Watch` action
- overflow menu

Every card must be composed from Watermelon card, avatar, badge, button, tooltip, menu, and animated layout primitives.

Use animated list insertion when a share begins and animated removal when it ends. When the number of cards changes, use layout animation so cards reposition smoothly.

## 8.3 Start-sharing flow

Use a Watermelon animated dialog, sheet, or full-workspace transition based on available width.

The flow contains:

1. source category
2. source selection
3. audio mode
4. quality preset
5. confirmation

The flow may be a single surface with progressive disclosure rather than a rigid wizard.

### Source category

Use a Watermelon animated tabs or segmented-control component for:

- Screen
- Window
- Application

### Source selection

Source items are composed from:

- Watermelon card
- Watermelon radio/selectable-group primitive
- Watermelon image/aspect-ratio primitive where available
- Watermelon skeleton while thumbnails load
- Watermelon tooltip for truncated titles
- Watermelon animated selection border/indicator
- Watermelon scroll area

No separate custom `SourceTile` visual primitive should be invented. A product-level composition may be named for code organization, but its visual building blocks must remain Watermelon components.

### Audio mode

Use Watermelon radio cards, tabs, or selectable cards for:

- No audio
- Application audio
- Filtered monitor audio
- System audio

Unsupported or degraded modes use Watermelon tooltip, alert, badge, and disclosure components.

### Quality preset

Use Watermelon selectable cards or segmented controls for:

- Data saver
- Balanced
- Clear
- Custom

Custom settings reveal animated Watermelon sliders, selects, switches, and disclosures.

### Confirmation

The final action area uses Watermelon buttons and animated validation feedback. `Start sharing` remains disabled until source validation passes.

## 8.4 Host dashboard

The host dashboard contains:

- live state header
- always-visible `Stop sharing` destructive action
- local preview
- current stream statistics
- viewer count
- source control
- audio control
- quality control
- remote quality request state
- connection status

Use Watermelon components for all controls and surfaces.

### Preview area

The media element itself is native browser/Electron content, but every surrounding control, overlay, loading state, badge, menu, and transition must use Watermelon components.

### Stream statistics

Use Watermelon cards, badges, tooltips, disclosures, and animated-number/text primitives. Advanced statistics remain behind a disclosure or context panel.

### Change controls

- Change source opens a Watermelon sheet/dialog.
- Change audio opens a Watermelon popover or sheet.
- Quality opens a Watermelon popover or sheet with animated sliders.
- Incoming remote requests appear through Watermelon toast plus an inline animated status row.

## 8.5 Viewer

The viewer is video-first.

At normal size, the group rail may remain visible while the group dashboard collapses. In focused mode, both left columns may collapse. In fullscreen, all application chrome disappears except transient video controls.

The video controls must be composed from Watermelon:

- animated button/icon-button components
- tooltip components
- slider components
- popover components
- menu components
- badge components
- animated presence for auto-hide
- animated sheet for detailed quality settings

Controls include:

- play/pause only if technically meaningful for live playback
- volume
- mute
- quality
- stream switcher when multiple shares are live
- connection state
- fullscreen
- exit viewer

Do not copy a generic media-player skin. Compose the controls from Watermelon primitives with ScreenLink tokens.

---

## 9. Optional right-side context panel

The right panel is visible only when it provides useful context.

Possible modes:

- active viewers
- group members
- stream details
- connection statistics
- recent stream events
- remote quality activity

The panel uses Watermelon resizable-panel, scroll-area, tabs, list, disclosure, badge, tooltip, and animated-presence components.

The panel should animate in and out using Watermelon motion. The primary workspace should resize smoothly rather than jump.

At narrower widths, the context panel becomes a Watermelon sheet rather than forcing the main workspace below its usable minimum.

---

## 10. Visual system

## 10.1 Color tokens

| Token | Initial value | Use |
|---|---|---|
| `canvas` | `#101216` | Main application background |
| `rail` | `#0C0E12` | Group rail and darkest chrome |
| `surface-1` | `#16191F` | Group dashboard and major panels |
| `surface-2` | `#1B1F27` | Cards and interactive surfaces |
| `surface-3` | `#222833` | Raised/selected surfaces |
| `surface-hover` | `#272E3A` | Hovered neutral controls |
| `border-subtle` | `#292F39` | Structural borders |
| `border-strong` | `#364050` | Focused or emphasized boundaries |
| `text-primary` | `#F1F4F8` | Main text |
| `text-secondary` | `#AAB2C0` | Supporting text |
| `text-muted` | `#727D8E` | Low-priority metadata |
| `accent` | `#4C8DFF` | Primary blue |
| `accent-hover` | `#6AA1FF` | Hovered blue |
| `accent-muted` | `#1D3154` | Selected blue-neutral surface |
| `success` | `#45B987` | Healthy confirmation only |
| `warning` | `#E1A84A` | Degraded/recovering state |
| `danger` | `#E15B64` | Stop, remove, fatal error |

These values are a starting point. The final palette must be applied through shared tokens so every Watermelon component is normalized consistently.

## 10.2 Surface rules

- Use flat layered neutrals.
- Prefer 1 px borders over strong shadows.
- Use shadows only for floating menus, dialogs, popovers, and the user dock.
- No gradients in the primary shell.
- No glassmorphism outside a restrained media-overlay treatment.
- No glow effects.
- Avoid excessive card nesting.

## 10.3 Radius system

| Role | Radius |
|---|---:|
| Compact controls | 6 px |
| Standard controls/cards | 8 px |
| Dialogs/sheets | 10–12 px |
| Avatars/group icons | Determined by chosen Watermelon avatar variant |

Use the selected Watermelon component geometry consistently. Do not mix unrelated radius families from different examples.

## 10.4 Spacing system

Use a 4 px base grid with common steps:

- 4
- 8
- 12
- 16
- 20
- 24
- 32

The layout may be Discord-like in shape but must not copy Discord’s exact spacing. ScreenLink should be slightly calmer and more deliberate.

---

## 11. Motion system

Watermelon’s animation library is a primary design dependency for Stage 3.7.

## 11.1 Motion principles

Motion must communicate:

- origin
- destination
- hierarchy
- selection
- state change
- insertion/removal
- success/failure
- continuity during layout changes

Avoid motion that exists only as decoration.

## 11.2 Motion coverage requirement

Every implementation task must explicitly evaluate whether a Watermelon animated component or transition applies.

A feature is not visually complete until the following have been considered:

- entrance
- exit
- hover
- press
- focus
- selection
- loading
- success
- error
- disabled
- layout change
- reduced-motion behavior

## 11.3 Required animated interactions

| Interaction | Required behavior |
|---|---|
| Group selection | Shared or sliding active indicator |
| Group added/removed | Animated list insertion/removal |
| Share starts/ends | Animated presence plus layout reflow |
| Navigation change | Animated selection and restrained content transition |
| Dialog/sheet | Watermelon enter/exit transition |
| Popover/menu | Origin-aware scale/fade transition |
| Tooltip | Short delayed fade/translate |
| Source selection | Animated border/check/selection marker |
| Tab change | Sliding indicator and content transition |
| Disclosure | Animated height and opacity |
| Toast | Watermelon/Sonner animated stack behavior |
| Viewer controls | Animated presence with auto-hide |
| Context panel | Animated width/position transition |
| Status change | Animated badge/text transition |
| Remote quality request | Toast plus inline state transition |
| Reconnection | Animated progress without disruptive pulsing |
| Skeleton to content | Crossfade/layout continuity |
| Fullscreen transition | Chrome presence transition |

## 11.4 Timing guidance

| Motion type | Duration target |
|---|---:|
| Hover/press | 90–140 ms |
| Tooltip/menu/popover | 120–180 ms |
| Selection indicator | 160–220 ms |
| Dialog/sheet | 180–260 ms |
| Panel layout change | 220–320 ms |
| Toast/status transition | Use Watermelon defaults unless testing shows a problem |

Prefer Watermelon’s established spring/easing behavior. Do not create a second collection of custom easing curves unless a specific interaction requires it.

## 11.5 Reduced motion

Respect `prefers-reduced-motion` and the operating system setting.

Reduced motion should:

- remove large translations
- remove spring overshoot
- preserve short opacity transitions where acceptable
- keep state changes clear
- never remove important status feedback

Use Watermelon’s reduced-motion support or Motion integration rather than maintaining separate handwritten animation logic.

---

## 12. Watermelon component adoption matrix

Before implementation, create and maintain a registry matrix with the exact Watermelon component chosen for every UI role.

| ScreenLink role | Watermelon component category | Notes |
|---|---|---|
| Group rail item | Animated icon button + avatar + tooltip + badge | Compose, do not custom draw |
| Group navigation row | Animated list/button/navigation item | Shared selection indicator preferred |
| User dock | Card/surface + avatar + badge + icon buttons + menu | All children Watermelon |
| Active-share card | Card + avatar + badge + button + menu + layout animation | No custom card primitive |
| Source category | Animated tabs or segmented control | Watermelon indicator |
| Source choice | Card + radio/selectable primitive + skeleton + tooltip | Product composition only |
| Audio choice | Radio cards or selectable cards | Animated selected state |
| Preset choice | Selectable cards/segmented control | Animated selected state |
| Quality control | Slider + select + switch + disclosure | Animated variants preferred |
| Invite flow | Dialog/sheet + input + button + toast | No custom modal |
| Settings | Tabs/navigation + forms + disclosures + sheets | Watermelon primitives only |
| Context panel | Resizable panel + tabs + scroll area + animated presence | No handwritten pane system |
| Viewer controls | Icon buttons + slider + popover + tooltip + animated presence | Native video element only exception |
| Notifications | Watermelon Sonner/toast component | Shared status language |
| Loading | Skeleton/progress/spinner | Choose by expected wait length |
| Command palette | Watermelon command component | Optional but recommended |
| Menus | Dropdown/context menu | Never custom-position menus |

No implementation should begin until the matrix identifies the intended Watermelon source for that surface.

---

## 13. Responsive and compact-window behavior

ScreenLink is a desktop app but still requires deliberate resizing behavior.

## 13.1 Wide layout

- group rail visible
- group dashboard visible
- primary workspace fluid
- context panel available

## 13.2 Medium layout

- group rail visible
- group dashboard visible or collapsible
- context panel replaced by Watermelon sheet

## 13.3 Compact layout

- group rail visible
- group dashboard collapses
- selected-group navigation opens in Watermelon sheet/popover
- workspace remains primary

## 13.4 Viewer focus mode

- group dashboard hidden
- group rail may remain as a narrow affordance
- viewer controls auto-hide using Watermelon animated presence

## 13.5 Fullscreen

- all shell chrome hidden
- only transient Watermelon-composed video controls remain
- exit affordance appears on pointer movement or keyboard action

Use Watermelon resizable/collapsible/sheet primitives for responsive changes. Do not create a separate custom responsive component system.

---

## 14. Accessibility and keyboard behavior

Watermelon components must be selected and configured for complete keyboard and screen-reader support.

Required behavior:

- visible focus rings using the blue accent
- logical tab order
- arrow-key navigation in rails, menus, tabs, and radio groups
- Escape closes the topmost overlay
- Enter/Space activates focused controls
- tooltips do not contain essential information unavailable elsewhere
- icon-only buttons have accessible labels
- status is conveyed through text and semantics, not color alone
- dialogs trap focus correctly
- focus returns to the trigger when an overlay closes
- active share and connection changes use appropriate live-region behavior without becoming noisy
- reduced-motion preferences are respected

Recommended shortcuts:

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Open Watermelon command palette |
| `Ctrl+,` | Open settings |
| `Ctrl+Shift+S` | Start or stop sharing, with confirmation when stopping |
| `Ctrl+Shift+F` | Toggle viewer fullscreen |
| `Alt+1…9` | Select group by position when practical |
| `Esc` | Close overlay or exit focused viewer chrome |

Shortcuts must be discoverable through Watermelon tooltips, menu hints, or command-palette entries.

---

## 15. Required state coverage

Every major ScreenLink surface must support these states with Watermelon components and transitions.

| State | Requirement |
|---|---|
| Loading | Skeleton, spinner, or progress based on expected duration |
| Empty | Clear explanation and one primary action |
| Connecting | Target identity, progress, and cancel where possible |
| Reconnecting | Preserve layout, use inline animated status, avoid flashing |
| Degraded | Amber badge/alert with concrete cause |
| Permission blocked | Clear recovery instruction and action |
| Stream ended | Animated exit, retained identity, return path |
| Fatal error | Retry, copy diagnostics, and safe fallback |
| Disabled | Explanation through tooltip or supporting text |
| Pending remote request | Toast plus inline pending state |
| Applied remote request | Animated success feedback |
| Rejected/failed request | Clear reason and retry path |

Do not hand-build status banners or notification stacks. Use Watermelon alert, toast, badge, progress, and animated-presence components.

---

## 16. Stage 3.7 implementation sequence

## 16.1 Stage 3.7A — Watermelon foundation

- audit current React, Tailwind, alias, and Motion setup
- inventory Watermelon components needed by ScreenLink
- create the Watermelon adoption matrix
- install individual components only
- explicitly prohibit dashboard blocks in implementation notes and review checklist
- establish ScreenLink tokens applied to all Watermelon components
- establish Instrument Sans and Geist Mono
- establish icon policy
- establish reduced-motion behavior
- build a component gallery using only chosen Watermelon pieces

## 16.2 Stage 3.7B — Application shell

- Electron title bar from Watermelon controls
- group rail from Watermelon primitives
- selected-group dashboard column from Watermelon primitives
- user/status dock from Watermelon primitives
- context panel from Watermelon panel primitives
- responsive collapse behavior using Watermelon sheets/panels
- shared animated indicators and panel transitions

## 16.3 Stage 3.7C — Group overview

- empty overview
- active-share overview
- animated card insertion/removal
- invite dialog/sheet
- members surface
- group menu
- notification behavior

## 16.4 Stage 3.7D — Share setup

- animated source-category control
- source-selection composition
- thumbnail loading skeletons
- audio-mode selection
- preset selection
- custom quality disclosure
- validation and error states
- animated dialog/sheet transitions

## 16.5 Stage 3.7E — Host experience

- live header
- local preview shell
- stream statistics
- viewer state
- source/audio/quality overlays
- remote request toasts and inline state
- stop-sharing confirmation

## 16.6 Stage 3.7F — Viewer experience

- video-first layout
- animated auto-hide controls
- volume and quality controls
- stream switcher
- reconnect/degraded/ended states
- focus mode
- fullscreen mode

## 16.7 Stage 3.7G — Settings, diagnostics, and polish

- application settings
- startup and tray settings
- update state
- codec/default quality settings
- diagnostics disclosure
- copy diagnostics toast
- keyboard pass
- accessibility pass
- reduced-motion pass
- high-DPI and Windows scaling pass
- visual regression coverage

---

## 17. Implementation guardrails

The following are automatic review failures:

- importing a full Watermelon dashboard block
- copying a Watermelon dashboard page and deleting unwanted parts
- introducing a second UI component library
- hand-building a button, menu, tooltip, dialog, slider, tabs, popover, toast, or disclosure that Watermelon provides
- hand-building animation that duplicates a suitable Watermelon animated variant
- creating a custom ScreenLink design primitive instead of composing Watermelon components
- allowing copied Watermelon components to retain inconsistent local colors, radii, or typography
- using static variants where an appropriate animated Watermelon variant exists without documenting the reason
- skipping reduced-motion support
- using motion only on a few showcase surfaces while leaving the majority of state changes abrupt
- making the shell resemble an admin analytics dashboard

## 17.1 Allowed custom code

Custom code is allowed for:

- ScreenLink state and business logic
- Electron window integration
- media rendering and native video/audio elements
- WebRTC status binding
- layout composition
- responsive orchestration
- data formatting
- accessibility labels
- tests
- adapters required to connect application state to Watermelon components

Custom code is not permission to invent replacement UI primitives.

---

## 18. Testing and acceptance criteria

Stage 3.7 is visually complete only when all of the following are true.

### Component-source acceptance

- Every visible component is traceable to a Watermelon component or a composition of Watermelon components.
- No dashboard block is present in source history for the implementation branch.
- No second component library is present.
- The component adoption matrix is complete.

### Motion acceptance

- Every major interaction has reviewed entrance, exit, selection, loading, success, failure, and reduced-motion behavior.
- Animated Watermelon variants are used wherever suitable.
- Group changes, active shares, dialogs, sheets, popovers, navigation, status, and viewer controls animate coherently.
- Motion remains smooth under expected Electron load and does not interfere with video playback.

### Visual acceptance

- The shell clearly reads as group rail → group dashboard → workspace → optional context.
- The app uses dark neutrals and restrained blue accents.
- Typography is cohesive and legible at 100%, 125%, 150%, and 200% Windows scaling.
- No screen resembles a generic analytics dashboard.
- No Watermelon component looks visually unnormalized or imported from a different theme.

### Functional acceptance

- All states in Section 15 are represented.
- Full keyboard navigation works.
- Dialog and sheet focus behavior is correct.
- Compact widths remain usable.
- Viewer mode remains video-first.
- Fullscreen controls are accessible and auto-hide correctly.
- Screen reader labels and live state announcements are appropriate.

---

## 19. Final design position

ScreenLink Stage 3.7 should adopt Discord’s broad desktop shell shape without copying Discord’s detailed design. It should use VS Code-like restraint, dark neutral surfaces, a single blue accent, and typography strong enough to give the application its own identity.

The implementation must be **Watermelon-first at every level**:

- no full dashboard blocks
- no custom substitute primitives
- no second UI library
- individual Watermelon components only
- product-specific surfaces created by composing Watermelon components
- animated Watermelon variants preferred throughout
- Watermelon motion used as the primary interaction language

The result should feel cohesive because every bit and piece comes from the same component and animation ecosystem, while the overall composition remains unmistakably ScreenLink.
