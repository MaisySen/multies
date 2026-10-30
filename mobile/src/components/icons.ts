import { ICON_PATHS } from "./icon-paths";

/**
 * The icons the app uses, by name (R34: one Icon component, src/components/Icon.tsx; Phosphor on
 * iOS and web, Material Symbols Rounded on Android). Names are semantic: "inbox", "compose",
 * "snooze", "trash", "more", "back" and so on; the older line icon names still resolve.
 */
export const ICONS = ICON_PATHS;
export type IconName = keyof typeof ICON_PATHS;
