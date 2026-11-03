/** R87: /go/name and /app/go/name. Opens what a team go link points at, or offers to make it. */
import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/web/lib/api";
import { Card, EmptyState } from "@/web/components/ui/misc";
import { Spinner } from "@/web/components/ui/spinner";
import { IconHash } from "@/web/components/ui/icon";

export function GoOpenPage() {
  const { "*": rest, name: param } = useParams();
  const name = (param ?? rest ?? "").toLowerCase();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["go-open", name], queryFn: () => api.get<{ href: string | null; suggestions: string[] }>(`/links/go/open/${encodeURIComponent(name)}`), retry: false });
  useEffect(() => {
    const href = q.data?.href;
    if (!href) return;
    if (href.startsWith("/")) navigate(href, { replace: true }); else window.location.replace(href);
  }, [q.data, navigate]);
  if (q.isLoading || q.data?.href) return <div className="grid min-h-[50vh] place-items-center" role="status" aria-live="polite"><span className="flex items-center gap-2 text-sm text-muted"><Spinner className="h-4 w-4" />Opening go/{name}</span></div>;
  return (
    <div className="mx-auto max-w-lg px-4 pt-10" data-testid="go-missing">
      <Card>
        <EmptyState icon={<IconHash />} title={`go/${name} isn't set up`} body={q.isError ? "Go links are only for people in this workspace." : "Nobody has made this go link yet."}
          action={<div className="space-y-4">
            {!!q.data?.suggestions.length && <div className="text-sm"><p className="mb-2 text-muted">Did you mean</p><ul className="flex flex-wrap justify-center gap-2">{q.data.suggestions.map((s) => <li key={s}><Link to={`/app/go/${s}`} className="inline-flex min-h-9 items-center rounded-lg bg-fill px-3 font-medium hover:bg-hover max-sm:min-h-11">go/{s}</Link></li>)}</ul></div>}
            {!q.isError && <Link to={`/app/tools/links?tab=go&new=${encodeURIComponent(name)}`} className="inline-flex h-9 items-center rounded-lg bg-brand px-4 text-sm font-medium text-brand-fg hover:bg-brand-press max-sm:min-h-11">Make go/{name}</Link>}
          </div>} />
      </Card>
    </div>
  );
}
