import { Link } from "react-router";
import { DEMO_PAUSED_TITLE } from "@/web/lib/demo";

/** R71 (MB-262): shown where the demo button is once the server says the demo is resting, with the way to start for real. */
export function DemoPausedNote({ className = "" }: { className?: string }) {
  return (
    <div role="status" data-testid="demo-paused" className={`mx-auto mt-3 max-w-md rounded-xl border border-line bg-surface px-4 py-3 text-left text-[13px] leading-relaxed text-muted ${className}`}>
      <p className="font-medium text-fg">{DEMO_PAUSED_TITLE}.</p>
      <p className="mt-0.5">Create a free account instead: no card, and you can use a free test address, so no client mailbox is needed. Or try the demo again tomorrow.</p>
      <Link to="/signup" className="mt-2 inline-flex min-h-11 items-center font-medium text-brand-hover hover:underline" data-testid="demo-paused-signup">Create a free account</Link>
    </div>
  );
}
