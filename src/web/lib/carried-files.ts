/**
 * Files handed from one Tools screen to the next (a dropped file, or a result to run another tool on). Memory only:
 * nothing is stored, and a refresh drops them. R66: the editors and Share read them too, so a file dropped on the
 * Tools list opens straight in Edit pages, Fill a form, Compare or Share.
 */
let carried: File[] = [];
export const carryFiles = (files: File[]) => { carried = files; };
export const takeCarried = (): File[] => { const f = carried; carried = []; return f; };
export const peekCarried = (): File[] => carried;
