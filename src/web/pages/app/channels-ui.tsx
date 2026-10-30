/**
 * C1 (chat channels, phase 1): the small pieces the shared inbox and Settings, Channels share. The channel chip
 * (icon plus a tint per provider), the status query and the one place that knows each provider's colours.
 * Data: GET /api/channels/status (src/shared/channels.ts has the shapes).
 */
import { useQuery } from "@tanstack/react-query";
import { IconInstagram, IconMessageCircle, IconMessenger, IconWhatsapp } from "@/web/components/ui/icon";
import { api } from "@/web/lib/api";
import { cn } from "@/web/lib/cn";
import { PROVIDER_LABEL, type ChannelProvider, type ChannelsStatus } from "@/shared/channels";

export const channelsStatusKey = ["channels", "status"] as const;

/** The workspace's channel state. Quiet on failure: a server without the route just means mail only. */
export function useChannelsStatus() {
  return useQuery({ queryKey: channelsStatusKey, queryFn: () => api.get<ChannelsStatus>("/channels/status"), staleTime: 60_000, retry: false });
}

/** Provider colours: the glyph colour and a soft tint behind it. Instagram gets its gradient as a soft wash. */
export const PROVIDER_STYLE: Record<ChannelProvider, { fg: string; chip: string; tile: string }> = {
  whatsapp: { fg: "text-[#1DA851] dark:text-[#25D366]", chip: "bg-[#25D366]/12 border-[#25D366]/25", tile: "bg-[#25D366]" },
  messenger: { fg: "text-[#0A7CFF] dark:text-[#3D9BFF]", chip: "bg-[#0A7CFF]/10 border-[#0A7CFF]/25", tile: "bg-[linear-gradient(135deg,#00B2FF,#006AFF)]" },
  instagram: { fg: "text-[#D62976] dark:text-[#F0569B]", chip: "bg-[linear-gradient(135deg,rgb(254_218_117/0.22),rgb(214_41_118/0.16),rgb(79_91_213/0.16))] border-[#D62976]/25", tile: "bg-[linear-gradient(45deg,#FEDA75,#FA7E1E,#D62976,#962FBF,#4F5BD5)]" },
  mock: { fg: "text-muted", chip: "bg-fill border-line", tile: "bg-[#8E8E93]" },
};

export function ProviderIcon({ provider, className }: { provider: ChannelProvider; className?: string }) {
  const C = provider === "whatsapp" ? IconWhatsapp : provider === "messenger" ? IconMessenger : provider === "instagram" ? IconInstagram : IconMessageCircle;
  return <C className={className} aria-hidden />;
}

/** The chip on a chat row and in the chat header: the provider's glyph and, unless compact, its name. */
export function ChannelChip({ provider, compact, className }: { provider: ChannelProvider; compact?: boolean; className?: string }) {
  const s = PROVIDER_STYLE[provider];
  return (
    <span data-testid="channel-chip" data-provider={provider} title={PROVIDER_LABEL[provider]}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border text-[11.5px] font-medium leading-4", compact ? "h-5 w-5 justify-center" : "px-2 py-0.5", s.chip, className)}>
      <ProviderIcon provider={provider} className={cn("h-3 w-3", s.fg)} />
      {compact ? <span className="sr-only">{PROVIDER_LABEL[provider]}</span> : <span className="text-fg/80">{PROVIDER_LABEL[provider]}</span>}
    </span>
  );
}

/** A rounded app style tile with the provider glyph in white, for Settings, Channels. */
export function ProviderTile({ provider, size = "md" }: { provider: ChannelProvider; size?: "md" | "lg" }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center text-white shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.2),0_1px_2px_rgb(0_0_0/0.12)]", size === "lg" ? "h-11 w-11 rounded-[11px] [&_svg]:h-6 [&_svg]:w-6" : "h-9 w-9 rounded-[9px] [&_svg]:h-5 [&_svg]:w-5", PROVIDER_STYLE[provider].tile)}>
      <ProviderIcon provider={provider} />
    </span>
  );
}
