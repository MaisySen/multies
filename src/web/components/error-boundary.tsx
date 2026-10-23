import { Component, type ReactNode } from "react";
import { captureError } from "@/web/lib/sentry";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { captureError(error); }
  render() {
    if (this.state.failed) return <div role="alert" style={{ padding: 32 }}>Something broke on this page. Reload to try again.</div>;
    return this.props.children;
  }
}
