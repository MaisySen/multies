/**
 * F13b (MB-306): the New task dialog for My Work, fetched only when someone taps New task (not part of the first
 * screen, so its glyphs and the Tasks page code stay out of My Work's first load).
 */
import { lazyPage } from "@/web/components/lazy-page";

export const MyWorkNewTask = lazyPage(() => import("./my-work-new-task"), "MyWorkNewTask", { quiet: true });
