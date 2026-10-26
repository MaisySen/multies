import { Row, SectionTitle } from "@/components/ui";
import { useOta } from "@/lib/ota/provider";
import type { OtaStatus } from "@/lib/ota/controller";
/** What the Check for updates row says for each state. */
export function updateStatusLabel(status: OtaStatus): string {
  switch (status) {
    case "checking": return "Checking";
    case "downloading": return "Downloading";
    case "up_to_date": return "Up to date";
    case "ready": return "Ready";
    case "installing": return "Installing";
    case "error": return "Try again later";
    default: return "";
  }
}

/** Settings, About: Check for updates, and Restart to update once an update is downloaded. Nothing on web. */
export function UpdateRows() {
  const ota = useOta();
  if (!ota) return null;
  const { state, controller } = ota;
  const busy = state.status === "checking" || state.status === "downloading" || state.status === "installing";
  return (
    <>
      <SectionTitle>Updates</SectionTitle>
      <Row icon="refresh-cw" label="Check for updates" value={updateStatusLabel(state.status)} onPress={busy ? undefined : () => { void controller.checkNow(); }} testID="check-updates" />
      {state.status === "ready" ? (
        <Row icon="download" label="Restart to update" onPress={() => { void controller.restartNow(); }} testID="restart-to-update" />
      ) : null}
    </>
  );
}
