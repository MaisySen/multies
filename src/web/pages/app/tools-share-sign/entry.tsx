/**
 * Tools P2: the ways into share links and e-sign from the Tools page and a finished Tools result.
 * Each piece hides unless GET /api/tools lists its feature.
 */
import { Link } from "react-router";
import { useToolFeatureList } from "@/web/components/tools/use-tools-info";
import { IconLink, IconPenLine } from "@/web/components/ui/icon";
import type { ToolJob } from "@/shared/tools";

/** The one shared GET /api/tools features list (cached in use-tools-info). */
export function useToolFeatures(): string[] {
  return useToolFeatureList();
}

/** Two cards above the tool grid. */
export function ShareSignCards() {
  const f = useToolFeatures();
  const share = f.includes("share"), sign = f.includes("esign"), links = f.includes("links");
  if (!share && !sign && !links) return null;
  const card = "flex items-center gap-3 rounded-xl border border-line bg-elevated px-4 py-3 text-sm hover:border-line-strong hover:bg-hover/40";
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid="share-sign-cards">
      {share && <Link to="/app/tools/share" className={card}><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#0071E3] text-white"><IconLink className="h-4 w-4" /></span><span><span className="block font-medium">Share links</span><span className="text-muted">Send a big file as a link with expiry and password</span></span></Link>}
      {links && <Link to="/app/tools/links" className={card} data-testid="links-card"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#FF9500] text-white"><IconLink className="h-4 w-4" /></span><span><span className="block font-medium">Links</span><span className="text-muted">Short links with QR codes, click stats and a bio page</span></span></Link>}
      {sign && <Link to="/app/tools/sign" className={card}><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#AF52DE] text-white"><IconPenLine className="h-4 w-4" /></span><span><span className="block font-medium">E-sign</span><span className="text-muted">Sign a PDF or ask others to sign it</span></span></Link>}
    </div>
  );
}

/** Beside a finished result's Download: share it as a link, or sign it when it is a PDF. */
export function ShareResultLinks({ job }: { job: ToolJob }) {
  const f = useToolFeatures();
  const token = job.downloadUrl?.match(/\/api\/tools\/jobs\/([^/]+)\/download$/)?.[1];
  if (!token) return null;
  const q = `result=${encodeURIComponent(token)}&name=${encodeURIComponent(job.name)}`;
  // Tools UX: the same size as the other result actions.
  const btn = "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium hover:bg-hover disabled:opacity-40 max-sm:h-11 max-sm:text-[15px]";
  return (
    <>
      {f.includes("share") && <Link to={`/app/tools/share?${q}`} className={btn} data-testid="tools-share-result"><IconLink className="h-4 w-4" />Share as a link</Link>}
      {f.includes("esign") && /\.pdf$/i.test(job.name) && <Link to={`/app/tools/sign?${q}`} className={btn}><IconPenLine className="h-4 w-4" />Sign</Link>}
    </>
  );
}
