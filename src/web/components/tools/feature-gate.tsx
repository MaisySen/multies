/**
 * R66 (MB-259): a Tools page whose feature is off on this deployment is a plain "not found" page, the same one any
 * unknown address shows, with no heading, description or legal words of the feature behind it. The flags come with
 * the app config (no extra request). AI pages pass every AI feature and show when any one of them is on.
 */
import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useConfig } from "@/web/lib/queries";
import { NotFound } from "@/web/pages/not-found";
import { Skeleton } from "@/web/components/ui/misc";
import { LoadError } from "@/web/components/load-error-t1g"; // T1G (T1-8)

/** R101: `orFilesPlus` also opens the page when Files plus is on (the drive works without the attachment index). */
export function ToolFeatureGate({ features, children, orFilesPlus, offTo }: { features: readonly string[]; children: ReactNode; orFilesPlus?: boolean; /** QUAL1: where the address goes while the feature is off, instead of the not found page. */ offTo?: string }) {
  const config = useConfig();
  if (config.isLoading) return <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6" aria-busy="true"><Skeleton className="h-10 w-48" /><Skeleton className="h-40 w-full" /></div>;
  // T1G (T1-8): the flags could not be read; that is a load error, never "not found".
  if (config.isError && !config.data) return <div className="mx-auto max-w-5xl p-4 sm:p-6"><LoadError onRetry={() => config.refetch()} /></div>;
  const on = (!!config.data?.tools && features.some((f) => (config.data?.toolFeatures as readonly string[] | undefined)?.includes(f))) || (!!orFilesPlus && !!config.data?.filesPlus);
  if (!on && offTo) return <Navigate to={offTo} replace />;
  if (!on) return <div className="fixed inset-0 z-[80] overflow-y-auto bg-bg" data-testid="tool-not-found"><NotFound embedded /></div>;
  return <>{children}</>;
}
