import { ApprovalsView } from "@/components/approvals-view";

/** M3 (1.10.11): Approvals as a stack screen with a title and back button, reached from Today, More, links and pushes. */
export default function Review() {
  return <ApprovalsView stacked />;
}
