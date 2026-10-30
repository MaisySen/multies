/**
 * C1: which adapter serves a channel, and the channel's decrypted credentials (server side only).
 */
import type { Deps } from "../../context";
import type { msgChannels } from "../../db/schema";
import { decryptSecret } from "../../lib/crypto";
import { HttpError } from "../../lib/errors";
import { MetaCloudAdapter } from "./meta";
import { mockAdapter } from "./mock";
import type { ChannelCredentials, ProviderAdapter } from "./provider";

export type ChannelRow = typeof msgChannels.$inferSelect;

export function adapterFor(deps: Deps, provider: ChannelRow["provider"]): ProviderAdapter {
  if (provider === "mock") {
    if (!deps.config.channels.mock) throw new HttpError(409, "channel_unavailable", "The test channel is switched off on this server.");
    return mockAdapter();
  }
  const meta = deps.config.channels.meta;
  if (!meta) throw new HttpError(409, "channel_unavailable", "Messaging channels are not set up on this server yet.");
  if (provider !== "whatsapp") throw new HttpError(409, "channel_unavailable", "Sending on this channel is coming soon.");
  return new MetaCloudAdapter(meta, deps.fetch);
}

/** The stored secret is JSON { token, pin? } encrypted with the app secret. */
export async function credentialsOf(deps: Deps, ch: ChannelRow): Promise<ChannelCredentials> {
  if (!ch.tokenEnc) throw new HttpError(409, "channel_disconnected", "This channel is disconnected. An admin can reconnect it in Settings.");
  const raw = JSON.parse(await decryptSecret(deps.config.appSecret, ch.tokenEnc)) as { token: string };
  return { token: raw.token, externalId: ch.externalId, accountId: ch.externalAccountId };
}
