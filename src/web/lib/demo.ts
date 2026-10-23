import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "./api";

/** Opens a sandbox workspace (server must run with DEMO_MODE) and goes to the dashboard. */
export function useStartDemo() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const start = async () => {
    setLoading(true);
    try {
      await api.post("/auth/demo");
      qc.clear();
      navigate("/app");
    } catch (err) {
      toast.error(err instanceof ApiError && err.status === 404 ? "The live demo isn't enabled on this server." : err instanceof Error ? err.message : "Couldn't open the demo.");
    } finally {
      setLoading(false);
    }
  };
  return { start, loading };
}
