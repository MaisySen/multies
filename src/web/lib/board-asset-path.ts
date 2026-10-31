/**
 * R89: the whiteboard library reads window.EXCALIDRAW_ASSET_PATH when its module first runs and builds every font
 * address from it then. Its code can arrive in a shared chunk that loads with the docs editor, before the board
 * itself, so the path is set here, first thing in the app, before any chunk can run. The fonts are copied to
 * /board-assets/fonts at build time (scripts/board-fonts.ts), so boards never ask another origin for them.
 */
declare global { interface Window { EXCALIDRAW_ASSET_PATH?: string | string[] } }

export const BOARD_ASSET_PATH = "/board-assets/";

if (typeof window !== "undefined") window.EXCALIDRAW_ASSET_PATH = BOARD_ASSET_PATH;
