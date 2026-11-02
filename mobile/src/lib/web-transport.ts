/**
 * M3 (1.10.11): the live session's transport, so plain functions (doc links, notification targets, the command sheet)
 * can open web app pages signed in. Set by the session provider; null in the sample workspace and when signed out.
 * Its own module so the session does not load the router (lib/web-open.ts does).
 */
import type { Transport } from "@/api/transport";

let current: Pick<Transport, "request"> | null = null;
export function registerWebTransport(t: Pick<Transport, "request"> | null) { current = t; }
export const webTransport = () => current;
