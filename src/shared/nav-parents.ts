/**
 * MPT-10 (NAV1 slice 1): where app pages without a menu entry, Settings pane or Tools tile live.
 * tests/nav-homes-nav1.test.ts reads this file. Add a new /app page to the menu, or declare its parent here.
 */
export interface NavParent { parent: string; file: string; reason: string }
export interface NavNoHome { reason: string; slice: string }

/** Pages opened from a parent page. file is the source file that links to the page. */
export const NAV_PARENTS: Record<string, NavParent> = {};

/** Pages with no home yet. Each names the NAV1 slice that gives it one. The list is empty when NAV1 is done. */
export const NAV_NO_HOME_YET: Record<string, NavNoHome> = {};
