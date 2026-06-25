import { useEffect } from "react";
import { useStore } from "../stores/main-store.js";
import { ShareSetup } from "../components/workspace/ShareSetup.js";

/**
 * SourcePicker — Backward-compatible route adapter.
 *
 * This legacy route now renders the new ShareSetup dialog (Stage 3.7D)
 * and auto-opens it on mount. The existing `navigate("source-picker")`
 * calls in GroupOverview still work through this adapter.
 *
 * When the dialog closes, navigates back to the dashboard.
 */
export function SourcePicker() {
  const setOpenShareSetup = useStore((s) => s.setOpenShareSetup);
  const navigate = useStore((s) => s.navigate);

  // Auto-open the share setup dialog on mount
  useEffect(() => {
    setOpenShareSetup(true);
  }, [setOpenShareSetup]);

  // When the dialog closes (openShareSetup becomes false), go back to dashboard
  const openShareSetup = useStore((s) => s.openShareSetup);
  useEffect(() => {
    if (!openShareSetup) {
      navigate("dashboard");
    }
  }, [openShareSetup, navigate]);

  return <ShareSetup />;
}
