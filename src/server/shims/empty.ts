/**
 * Stands in for @react-email/code-block in the Worker build. The real package loads Prism with every
 * language at startup (about 200 ms of CPU), which pushes the Worker past Cloudflare's startup limit.
 * Multies' emails have no code blocks; the tailwind helper only checks for the component by identity.
 */
export function CodeBlock(): null { return null; }
export const dracula = {};
