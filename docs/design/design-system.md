# Design system

How the Multies web app is styled, and the rules that keep it consistent. The tokens live in
`src/web/index.css`; the flag gated design pass lives in `src/web/design-des1.css`; depth, motion and icons are
described in more detail in [premium-pass-2.md](./premium-pass-2.md). This page is the contract: when a page and
this page disagree, fix the page or change this page in the same pull request.

The guards in `tests/design-tokens-uix1.test.ts` fail the build when the rules marked **(guarded)** are broken.

## Principles

1. One accent. Blue is the only brand colour. Red, amber and green mean status and nothing else.
2. Tokens, not values. A page names a token (`bg-surface`, `text-muted`); it never writes a hex colour for app chrome.
3. Light and dark are the same design. Every token has a value in both, and every pair of text and background
   meets WCAG AA (4.5:1 for text, 3:1 for large text and for the edges of controls).
4. Calm by default. Depth comes from soft layered shadows and hairlines, motion is short, and nothing moves when
   the system asks for less motion.
5. A phone is a first class screen. Every control a finger can reach is at least 44 px, fields are 16 px so the
   page does not zoom, and bars respect the safe areas.

## Colour tokens

Declared in the `@theme` block of `index.css`. Tailwind turns each `--color-<name>` into utilities
(`bg-<name>`, `text-<name>`, `border-<name>`, `ring-<name>`, with `/NN` for opacity).

### Surfaces and lines

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `bg` | `#f5f5f7` | `#0c0c0d` | The page behind everything |
| `surface` | `#ffffff` | `#161618` | Cards, lists, fields |
| `elevated` | `#ffffff` | `#1f1f22` | Dialogs, menus, popovers |
| `hover` | `#ebebef` | `#2a2a2d` | Hover on a row or a ghost button |
| `fill` | `#e8e8ed` | `#2c2c2f` | Quiet filled controls, skeletons, neutral badges |
| `line` | black 9 % | white 9 % | Dividers and card borders |
| `line-strong` | black 16 % | white 16 % | Field borders, hairlines on bars |

### Text

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `fg` | `#1d1d1f` | `#f5f5f7` | Primary text |
| `muted` | `#5a5a5f` | `#aeaeb2` | Secondary text, labels |
| `subtle` | `#606065` | `#9a9a9f` | Placeholders, hints, timestamps |

### Brand

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `brand` | `#0066cc` | `#0071e3` | Filled buttons, selected state, focus ring |
| `brand-hover` | `#0058b0` | `#5ea4ff` | Links and brand coloured text |
| `brand-press` | brand, 14 % deeper | same rule | A filled button on hover and press |
| `brand-soft` | brand at 10 % | brand at 16 % | Selected rows, soft chips |
| `brand-fg` | `#ffffff` | `#ffffff` | Text on a brand fill |
| `accent`, `accent-fg` | brand | brand | A workspace's second colour; the brand by default |

A workspace can set its own brand colour. Brand tokens are then replaced at run time, so never hard code
`#0071E3` or `#0066cc` in a page or in CSS: use `var(--color-brand)`.

### Status

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `ok`, `ok-soft` | `#17692c`, green 12 % | `#30d158`, green 14 % | Done, healthy, verified |
| `warn`, `warn-soft` | `#8a4b00`, amber 16 % | `#ffb340`, amber 14 % | Needs attention, nearly over a limit |
| `bad`, `bad-soft` | `#b00017`, red 10 % | `#ff7a72`, red 14 % | Errors, destructive actions, failed |
| `info`, `info-soft` | `#0058b0`, blue 10 % | `#5ea4ff`, blue 16 % | Neutral notices. Fixed blue: it ignores a workspace brand |

The solid colour is for text and icons on a surface; the soft colour is the tint behind them. Status is never
shown by colour alone: pair it with a word or an icon.

Second names **(guarded)**: `danger` (bad), `warning` (warn), `good` and `success` (ok), `ink` (fg) and `canvas`
(bg) exist because pages already used them. They point at the first names, so they follow light, dark and brand
themes. Write the first names in new code. A semantic colour word with no token makes no CSS at all, which is
why the guard exists.

### Dark mode

One rule **(guarded)**: an explicit choice (`data-theme="light"` or `"dark"` on `<html>`) wins; with no choice the
system setting decides. The tokens follow it, and so does Tailwind's `dark:` variant (a `@custom-variant` at the
top of `index.css`). Prefer tokens over `dark:`; reach for `dark:` only for a colour that has no token, such as a
third party brand colour. The explicit dark block and the system dark block must hold the same declarations.

Surfaces that stand for paper stay white in both themes on purpose: QR codes, signature pads, PDF pages and
previews of an email or a published page.

## Typography

System font first (`--font-sans`), Inter Variable as the fallback; `--font-mono` for code, keys and record
references. Numbers that change or line up (counts, prices, dates, durations, percentages) use `tabular-nums`.

| Size | Line | Use |
| --- | --- | --- |
| 11 px | 16 | Badges, key caps, count pills |
| 12 px | 16 | Captions, table meta, hints |
| 12.5 px | 18 | Secondary line in a row |
| 13 px | 18 | The default for dense app UI: rows, menus, toolbars |
| 14 px (`text-sm`) | 20 | Body text, form fields on desktop, buttons |
| 15 px | 22 | Emphasised body, empty state titles, large buttons |
| 17 px | 24 | Dialog titles, reading text on phones |
| 20 px (`text-xl`) | 28 | Page title on desktop (`.large-title`) |
| 28 px | 34 | Page title on phones (`.large-title`) |
| `text-3xl` to `text-6xl` | tight | Public pages only: hero and section headings |

Rules: weights are 400, 500, 600 and (titles only) 700. Headings carry a slightly negative tracking
(`tracking-tight`). Headings balance their lines and paragraphs avoid a lone last word where the browser supports
it. Do not add a size between the ones above. On phones every text field is 16 px.

## Spacing and layout

- The base unit is 4 px (Tailwind's spacing scale). Use 4, 8, 12, 16, 20, 24, 32, 40, 48 and 64; avoid arbitrary
  pixel paddings.
- Inside a control: 12 to 16 px sideways. Between related controls: 8 px. Between groups: 16 to 24 px. Between
  page sections: 24 px in the app, 80 px and up on public pages.
- Page gutters: 16 px on phones, 24 px from 640 px. Public pages sit in a `max-w-6xl` column with 20 px gutters.
- Density is a per person choice (`html[data-density]`), which scales the base unit. Sizes written with the
  spacing scale follow it; arbitrary pixel values do not.
- Any flex or grid child that holds text which may be long takes `min-w-0`, and the text takes `truncate` or
  wraps. The page itself never scrolls sideways (`body` clips the x axis **(guarded)**); wide content such as a
  table scrolls inside its own box.

### Breakpoints

| Name | From | What changes |
| --- | --- | --- |
| phone | under 640 px (`max-sm:`) | Bottom sheets instead of dialogs, 44 px controls, large titles |
| `sm` | 640 px | Desktop control sizes, side by side form rows |
| `md` | 768 px | The phone tab bar gives way to the rail and sidebar |
| `lg` | 1024 px | Split panes (list and reader), multi column settings |
| `xl` | 1280 px | Wider reading columns and dashboards |

Check every change at 390, 768 and 1440 px, in light and dark.

## Radius

| Token | Value | Use |
| --- | --- | --- |
| `rounded-md` | 8 px | Small controls, menu rows, chips in toolbars |
| `rounded-lg`, `--radius-r10` | 10 px | Buttons, fields, tiles |
| `rounded-xl`, `--radius-r14` | 14 px | Cards |
| `rounded-2xl` | 16 px | Large panels on public pages |
| `--radius-r20` | 20 px | Dialogs and sheets |
| `rounded-full` | pill | Badges, avatars, switches, round icon buttons |

A nested corner is smaller than its parent's by the padding between them.

## Elevation

| Token | Use |
| --- | --- |
| `--shadow-e0` (`.elev-0`) | Flat, inside a grouped list |
| `--shadow-e1` (`.elev-1`), `shadow-card` | Resting cards, tiles, the active segment of a segmented control |
| `--shadow-e2` (`.elev-2`), `shadow-pop` | Hover on a card, menus and popovers |
| `--shadow-e3` (`.elev-3`) | Dialogs, sheets, the phone drawer |

Dark mode swaps the dark ring for a faint white one, because shadows vanish on dark surfaces. Translucent bars
use `.glass` and `.glass-sidebar`, which fall back to an opaque surface where blur is missing. Hairlines are
`.hairline-b`, `.hairline-t` and `.hairline-r`.

### Layers

| Value | Token | Use |
| --- | --- | --- |
| 10 | `--z-raised` | Sticky table heads, raised parts inside a page |
| 20 | `--z-sticky` | The top bar, sticky toolbars |
| 30 | `--z-popover` | Menus, popovers, the phone tab bar |
| 40 | `--z-chrome` | Floating bars and banners above the page |
| 50 | `--z-overlay` | Dialog like overlays, the phone drawer, the public site header |
| 60 and up | `--z-top` | Full screen modes (present, tours, the command palette). Rare; say why in a comment |

Native `<dialog>` and popover elements sit in the browser's top layer and need no z-index.

## Motion

- Durations: 150 ms for a state change, 200 ms for something that enters, 260 ms for something that settles
  (`--duration-fast`, `--duration-base`, `--duration-slow`).
- Curves: `--ease-out` for state, `--ease-spring` for things that arrive.
- Animate transform and opacity only. Named animations come from the theme **(guarded)**: `animate-fade-in`,
  `animate-pop-in` (menus), `animate-sheet-up`, `animate-drawer-in`, `animate-route-in`, `animate-shimmer`.
- `prefers-reduced-motion: reduce` cuts every animation and transition to 1 ms **(guarded)**. Never put meaning
  in motion alone.
- Press feedback: buttons scale to 0.97; `.pressable` rows scale to 0.98 on touch screens only.

## Icons

One module, `src/web/components/ui/icon.tsx` (Phosphor, regular weight; fill weight for the active or selected
state). Lint blocks importing an icon package anywhere else. Sizes: 16 px beside text, 20 px in rows and buttons,
24 px in bars. Colour is always `currentColor`. An icon is decorative unless it is the only label, in which case
it carries `aria-label`. See [premium-pass-2.md](./premium-pass-2.md) for the full name list.

## Accessibility

- Focus: every focusable element shows a 2 px brand ring on keyboard focus (`--ring-width`, `--ring-offset`,
  `--ring-color`) **(guarded)**. If a component removes the outline it must draw its own ring
  (`focus-visible:ring-2 focus-visible:ring-brand/50`, or `focus-within:` on the wrapper of a bare field).
- Pointer: anything pressable shows the hand; anything disabled shows that it is **(guarded)**.
- Targets: 44 by 44 px on phones. A small glyph keeps its size and grows its hit area with padding and a
  matching negative margin, or with an `after:` box.
- Contrast: AA in both themes. `prefers-contrast: more` strengthens lines, secondary text and the focus ring.
  Windows high contrast (`forced-colors`) gets real outlines for focus, selection and switches.
- Names: an icon only button has `aria-label`; a field has a label; a dialog has a title; status messages use
  `role="status"` or `role="alert"`.
- Fields filled by the browser keep the field's own surface and text colour.
- `e2e/a11y.spec.ts` runs axe on the main pages at desktop and phone sizes; moderate findings fail.

## Components

Use the primitives in `src/web/components/ui/` before writing a new one.

| Primitive | Standard |
| --- | --- |
| `Button`, `ButtonLink` | Variants primary, secondary, outline, ghost, danger. Heights 32 (`sm`), 36 (`md`), 44 (`lg`); 44 on phones. One primary action per view. `loading` shows a spinner and disables the button |
| `Input`, `Textarea`, `Select`, `DateInput`, `TimeInput` | 40 px high, 44 on phones, 10 px radius, brand border and soft ring on focus, red border when `aria-invalid`. Wrap in `Field` for the label, hint and error |
| `Card` | `surface`, 14 px radius, hairline border, `shadow-card`. Padding 16 or 20 px |
| `Badge` | Tones neutral, ok, warn, bad, brand. A pill with an optional dot; one or two words |
| `Dialog`, `Confirm` | Native `<dialog>`: centred card on desktop, bottom sheet on phones. Title, optional description, actions on the right with the primary last. Focus returns to the opener |
| `Menu`, `Popover` | `elevated`, `shadow-pop`, `animate-pop-in`; a bottom sheet on phones. Compact 13 px rows on desktop, 44 px rows on phones |
| `Switch` | For a setting that applies at once. Always has `label` |
| `Skeleton`, `SkeletonRows` | Same size as what will load, so nothing jumps. A flat block under reduced motion |
| `EmptyState` | An illustration or icon, one title, one sentence, at most one action |
| `PageHeader` | `h1.large-title`, optional description, actions on the right; actions wrap on phones |
| `StatTile` | A label, one large tabular figure, an optional hint. Tone colours the icon chip only |
| Segmented control | `bg-fill` track with 2 px padding; the selected segment is `bg-surface` with `shadow-card`; segments are 44 px high on phones |
| Tables | Hairline rows, a quiet header, `tabular-nums` in number columns, the table scrolls inside its own box |

States every interactive component has: rest, hover, pressed, keyboard focus, disabled, and (where it loads)
busy. A hover style must never be the only way to find an action: on touch screens hover revealed actions are
always visible.

## Copy in the interface

`npm run lint:copy` applies to every file: no long dashes (use a period, comma or colon) and no stock marketing
phrases. Sentence case for titles and buttons. Say what happens, not how it feels.

## Checklist for a pull request that touches the interface

1. Tokens only: no new hex colours for chrome, no palette colours where a status token fits.
2. Looks right at 390, 768 and 1440 px, in light and dark, with an explicit theme that differs from the system.
3. Keyboard: every control reachable, focus visible, Esc closes what opened.
4. Phone: 44 px targets, nothing cut off, nothing behind the tab bar or the home indicator.
5. Reduced motion: nothing essential lost.
6. `npm run typecheck`, `npm run lint`, `npm run lint:copy` and `npm test` pass.
