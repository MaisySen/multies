/**
 * POL1: a page's main read shows "Couldn't load this" within about a second when the server fails: at most one quick
 * retry (half a second later) for a server failure, none for a refusal (4xx). The shared queryRetry decides what is
 * worth retrying at all; this caps how long the person looks at skeletons.
 */
import { queryRetry } from "./load-errors-t1g";

export const quickRetry = {
  retry: (count: number, err: unknown) => count < 1 && queryRetry(count, err),
  retryDelay: 500,
};
