# Multies brand

Everything here is built from hand-written SVG by `node brand/build.mjs` (run from the app root). Edit the
geometry in that script, run it, and commit the output. It also copies the web icons into `public/`.

## The mark

An M whose middle stroke is the flap of an envelope, white on a blue tile. The tile corner radius is
22.5 percent of its width, close to an iOS app icon. The wordmark is Inter SemiBold (SIL OFL 1.1),
outlined to paths, tracked slightly tight.

| File | Use |
| --- | --- |
| `logo-mark.svg` | The mark on its blue tile. Favicons, avatars, app icons. |
| `logo-light.svg` | Mark plus wordmark for light backgrounds. |
| `logo-dark.svg` | Mark plus wordmark for dark backgrounds. |
| `logo-mono.svg`, `logo-mark-mono.svg` | One colour (`currentColor`), the M knocked out. Print, stamps, single-colour UI. |
| `og-image.svg` | Source of the 1200 by 630 social card. |
| `web/` | favicon.svg, favicon.ico (16, 32, 48), favicon PNGs, apple-touch-icon (180), manifest icons 192 and 512, maskable 512, og-image.png. |
| `mobile/` | Expo sources: icon.png (1024, no transparency), adaptive-foreground, adaptive-background and adaptive-monochrome (1024, the M inside the central 66 percent), splash-icon.png (1024), notification-icon.png (96, white on transparent). |
| `tokens.json` | Colours, type, spacing, radius, shadow and motion tokens for the mobile app. |

## Clear space and size

- Keep clear space around the logo equal to half the mark's height on every side.
- Minimum size: the mark at 16 px on screen, the full lockup at 96 px wide. Below that, use the mark alone.
- Do not stretch, rotate, outline, add effects or recolour the tile, and do not set the wordmark in another font.

## Colours

| Name | Hex | Use |
| --- | --- | --- |
| Multies Blue | `#0071E3` | The tile, primary buttons in dark mode. |
| Blue (light UI) | `#0066CC` | Primary buttons and links on light backgrounds (5.6:1 with white). |
| Ink | `#1D1D1F` | Wordmark and text on light. |
| Paper | `#F5F5F7` | Wordmark and text on dark, light page background. |

Status colours (red, amber, green) are for status only, never decoration. See `tokens.json`.
