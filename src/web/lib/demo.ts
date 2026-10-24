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
      await api.post("/account/demo");
      qc.clear();
      navigate("/app");
      // Sample tasks, docs and deals are seeded in later requests while the dashboard loads,
      // a part per request. A request cut short is simply asked again.
      void (async () => {
        for (let i = 0, idle = 0; i < 10 && idle < 2; i++) {
          const r = await api.post<{ ran: number }>("/account/demo/seed").catch(() => null);
          if (r?.ran) { idle = 0; void qc.invalidateQueries(); } else if (r) idle++;
          await new Promise((res) => setTimeout(res, r ? 600 : 4000));
        }
      })();
    } catch (err) {
      toast.error(err instanceof ApiError && err.status === 404 ? "The live demo isn't enabled on this server." : err instanceof Error ? err.message : "Couldn't open the demo.");
    } finally {
      setLoading(false);
    }
  };
  return { start, loading };
}
