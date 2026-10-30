/** Tools UX: a tool's icon on its section colour (the Tools list, the side rail, batch runs). */
import type { ComponentType } from "react";
import { SECTION_TINT, type Section } from "./tool-directory";

export function ToolIcon({ e, size = "md" }: { e: { icon: ComponentType<{ className?: string }>; section: Section }; size?: "sm" | "md" | "lg" }) {
  const I = e.icon;
  const box = size === "lg" ? "h-11 w-11 rounded-xl [&_svg]:h-[22px] [&_svg]:w-[22px]" : size === "sm" ? "h-7 w-7 rounded-lg [&_svg]:h-[15px] [&_svg]:w-[15px]" : "h-9 w-9 rounded-[10px] [&_svg]:h-[18px] [&_svg]:w-[18px]";
  return <span className={`grid shrink-0 place-items-center text-white ${SECTION_TINT[e.section]} ${box}`} aria-hidden><I /></span>;
}
