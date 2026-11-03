import { Component, type ReactNode } from "react";
import { captureError } from "@/web/lib/sentry";
import { tr } from "@/web/i18n"; // R104

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { captureError(error); }
  render() {
    if (this.state.failed) return <div role="alert" style={{ padding: 32 }}>{tr("errors.something_broke_on_this_page_reload_to_try_again")}</div>;
    return this.props.children;
  }
}
