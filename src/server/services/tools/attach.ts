/**
 * Tools P2: Tools results sent as mail attachments ("Attach to a new email"). Compose sends the results'
 * download tokens with the message; here each token is checked (signature, expiry, same workspace) and the
 * file is read from the document engine, then handed to sendMessage as ordinary attachments. Nothing is
 * stored before the send; the engine deletes its copy within the hour as usual.
 */
import type { AuthContext, Deps } from "../../context";
import { HttpError } from "../../lib/errors";
import type { ParsedAttachment } from "../mail/mime";
import { readToken } from "./tokens";
import { toolJobOutput, toolsEngine } from "./run-job";
import { EXT_TYPES, type ToolExt } from "@/shared/tools";
import { COMPOSE_ATTACH_MAX_BYTES, COMPOSE_ATTACH_MAX_FILES } from "@/shared/tools-automation";

/** One limit for every attachment in one email, shared with the composer's own files. */
export const MAX_TOOL_ATTACHMENTS = COMPOSE_ATTACH_MAX_FILES;
/** All attachments in one message together (mail providers refuse much past this). */
export const MAX_TOOL_ATTACHMENT_BYTES = COMPOSE_ATTACH_MAX_BYTES;

const tooBig = () => new HttpError(400, "bad_request", "Attachments can add up to 20 MB in one email. A share link suits bigger files.");
const gone = () => new HttpError(410, "tool_file_expired", "A Tools file in this message has expired. Run the tool again, then attach it.");

/**
 * `used` is what the message already carries from the composer (files and bytes), so Tools results and
 * composer files share one limit: 10 files and 20 MB per email.
 */
export async function toolFilesAsAttachments(deps: Deps, auth: Pick<AuthContext, "orgId" | "userId">, tokens: string[], used: { files: number; bytes: number } = { files: 0, bytes: 0 }): Promise<ParsedAttachment[]> {
  if (!tokens.length) return [];
  const cfg = toolsEngine(deps);
  if (!cfg) throw new HttpError(400, "bad_request", "Tools are not available, so those files cannot be attached.");
  if (new Set(tokens).size + used.files > MAX_TOOL_ATTACHMENTS) throw new HttpError(400, "bad_request", `Attach up to ${MAX_TOOL_ATTACHMENTS} files to one email.`);
  const now = deps.now().getTime();
  const out: ParsedAttachment[] = [];
  let total = used.bytes;
  for (const tok of [...new Set(tokens)]) {
    const t = await readToken(cfg.tokenKey, tok, "d", now);
    if (!t || t.w !== auth.orgId) throw gone();
    const room = MAX_TOOL_ATTACHMENT_BYTES - total;
    if (room <= 0) throw tooBig();
    const got = await toolJobOutput(deps, auth, t.j, room).catch((err: unknown) => { throw err instanceof HttpError && err.status === 413 ? tooBig() : err; });
    if (!got) throw gone();
    total += got.bytes.byteLength;
    const ext = /\.([a-z0-9]{1,5})$/i.exec(t.n)?.[1]?.toLowerCase() as ToolExt | undefined;
    out.push({ filename: t.n, contentType: (ext && EXT_TYPES[ext]) || got.contentType || "application/octet-stream", content: got.bytes });
  }
  return out;
}
