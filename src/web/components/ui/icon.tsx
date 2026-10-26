/**
 * The one icon component for the web app (R35 Premium pass 2). Import a glyph by its semantic name:
 *   import { IconInbox } from "@/web/components/ui/icon";   <IconInbox className="h-4 w-4" />   <IconStar filled />
 * Names match the phone app (mobile src/components/Icon.tsx). The full list with the Phosphor glyph behind each name is
 * in docs/design/premium-pass-2.md. This module is the only place allowed to touch an icon package (eslint).
 * Need a new glyph? Add it to scripts/r35-icon-map.json and regenerate (scripts/r35-gen-icons.mjs writes ui/icons/).
 */
export * from "./icon-base";
export * from "./icons";
