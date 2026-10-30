/**
 * R73: every lazily loaded page and panel is made with lazyPage instead of React.lazy. It names the export it wants
 * (the build checks it exists), loads through lib/page-load.ts (one retry, a reload only when a newer release is
 * live), and holds its own small boundary: a page whose code could not load shows "Could not load this page" with
 * Retry where the page would be, inside the app frame, and tries again by itself when the connection returns.
 * Anything else a page throws goes on to the route's error screen as before.
 */
import { Component, lazy, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { Button } from "@/web/components/ui/button";
import { IconWifiOff } from "@/web/components/ui/icon";
import { isPageLoadError, loadPageModule } from "@/web/lib/page-load";
import { captureWarning } from "@/web/lib/sentry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export interface LazyPageOptions {
  /** Small helpers (the command menu, the call dock): show nothing instead of the note when their code fails. */
  quiet?: boolean;
}

/**
 * lazyPage(() => import("./pages/app/work/docs"), "DocsPage"). The module must export `name` as a component, so a
 * renamed export is a build error rather than an undefined page at run time.
 */
export function lazyPage<M extends Record<K, AnyComponent>, K extends string>(load: () => Promise<M>, name: K, options: LazyPageOptions = {}): ComponentType<ComponentProps<M[K]>> {
  const make = () => lazy(async () => ({ default: await loadPageModule<AnyComponent>(load, name) }));
  const holder = { Comp: make() };
  const Inner = (props: Record<string, unknown>) => {
    const C = holder.Comp;
    return <C {...props} />;
  };
  function LazyPage(props: ComponentProps<M[K]>) {
    return (
      <PageLoadBoundary page={name} quiet={!!options.quiet} onRetry={() => { holder.Comp = make(); }}>
        <Inner {...(props as Record<string, unknown>)} />
      </PageLoadBoundary>
    );
  }
  LazyPage.displayName = `LazyPage(${name})`;
  return LazyPage;
}

interface BoundaryProps { page: string; quiet: boolean; onRetry: () => void; children: ReactNode }
interface BoundaryState { error: unknown; retries: number }

/** Exported for tests. Catches only page load failures; everything else is thrown on to the route's boundary. */
export class PageLoadBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, retries: 0 };
  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> { return { error }; }
  componentDidCatch(error: unknown) {
    if (isPageLoadError(error)) captureWarning(error, { page_load: error.reason, page: this.props.page });
  }
  componentDidUpdate(_: BoundaryProps, prev: BoundaryState) {
    if (!!prev.error !== !!this.state.error) this.listen(!!this.state.error && isPageLoadError(this.state.error));
  }
  componentWillUnmount() { this.listen(false); }
  private onOnline = () => this.retry(true);
  private listen(on: boolean) {
    if (typeof window === "undefined") return;
    window.removeEventListener("online", this.onOnline);
    if (on) window.addEventListener("online", this.onOnline);
  }
  retry = (auto = false) => {
    // A browser that keeps a failed page file in memory (older Safari) cannot load it again in place: after two
    // taps that did not help, Retry reloads the page instead (only while online, and only on a tap).
    if (!auto && this.state.retries >= 2 && typeof navigator !== "undefined" && navigator.onLine) { window.location.reload(); return; }
    this.props.onRetry();
    this.setState((s) => ({ error: null, retries: s.retries + 1 }));
  };
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (!isPageLoadError(error)) throw error;
    if (this.props.quiet) return null;
    const offline = error.reason === "offline" || (typeof navigator !== "undefined" && navigator.onLine === false);
    return <PageLoadFailed offline={offline} onRetry={() => this.retry(false)} />;
  }
}

/** The note shown where a page could not load. */
export function PageLoadFailed({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <div role="alert" data-testid="page-load-failed" className="flex min-h-[50dvh] flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-fill text-muted [&_svg]:h-5 [&_svg]:w-5" aria-hidden><IconWifiOff /></div>
      <h2 className="text-[15px] font-semibold">Could not load this page</h2>
      <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
        {offline ? "You are offline. Check your connection. This page opens by itself when you are back online." : "Check your connection."}
      </p>
      <div className="mt-5"><Button variant="secondary" onClick={onRetry} data-testid="page-load-retry">Retry</Button></div>
    </div>
  );
}
