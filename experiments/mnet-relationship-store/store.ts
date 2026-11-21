// Experiments only. No live importer. SQL statements operate only in disposable DBs.
// Caller must resolve the real authenticated session first; SQL rechecks that exact
// session. A caller-controlled session ID is NOT authentication. Never expose this API.
export const DB_NOW_MS = "(CAST(strftime('%s','now') AS INTEGER)*1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
export const initializeSql = `INSERT OR IGNORE INTO rel_security(user_id)
 SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.id=? AND s.impersonated_by IS NULL AND s.expires_at>${DB_NOW_MS}`;
const current = `u.email_verified=1 AND COALESCE(u.banned,0)=0
 AND m.kind='human' AND m.disabled_at IS NULL AND COALESCE(o.is_demo,0)=0 AND o.suspended_at IS NULL`;
export const approveSql = `INSERT INTO rel_approvals
 (id,user_id,workspace_id,member_id,device_key_digest,approving_session_id,approval_login_method,approved_security_generation,status)
 SELECT ?,u.id,o.id,m.id,?,s.id,COALESCE(s.login_method,'email'),f.generation,'approved'
 FROM sessions s JOIN users u ON u.id=s.user_id JOIN members m ON m.user_id=u.id
 JOIN organizations o ON o.id=m.organization_id JOIN rel_security f ON f.user_id=u.id
 WHERE s.id=? AND o.id=? AND ?=1 AND s.impersonated_by IS NULL AND s.expires_at>${DB_NOW_MS}
 AND f.disabled=0 AND ${current}
 AND (COALESCE(o.require_sso,0)=0 OR m.role='owner' OR s.login_method IN ('auth0','google'))`;
export const witnessSql = `INSERT INTO rel_witness(id,approval_id)
 SELECT ?,a.id FROM rel_approvals a JOIN rel_security f ON f.user_id=a.user_id
 JOIN users u ON u.id=a.user_id JOIN members m ON m.id=a.member_id AND m.user_id=u.id AND m.organization_id=a.workspace_id
 JOIN organizations o ON o.id=a.workspace_id
 JOIN sessions s ON s.id=a.approving_session_id AND s.user_id=a.user_id
 WHERE a.id=? AND a.status='approved' AND f.disabled=0 AND f.generation=a.approved_security_generation
 AND ${current} AND s.impersonated_by IS NULL AND s.expires_at>${DB_NOW_MS}
 AND (COALESCE(o.require_sso,0)=0 OR m.role='owner' OR a.approval_login_method IN ('auth0','google'))`;
export const ownRevokeSql = `UPDATE rel_approvals SET status='revoked' WHERE id=? AND status='approved'
 AND user_id=(SELECT user_id FROM sessions WHERE id=? AND impersonated_by IS NULL AND expires_at>${DB_NOW_MS})`;
export interface BoundStatement { sql: string; values: (string|number)[] }
// Initialization and conditional approval MUST execute as one real transaction:
// D1.batch on D1; synchronous driver transaction on Node. No runBatch fallback.
export function approvalBatch(sessionId: string, workspaceId: string, approvalId: string, deviceDigest: string, explicit: boolean): BoundStatement[] {
 return [{sql:initializeSql,values:[sessionId]},{sql:approveSql,values:[approvalId,deviceDigest,sessionId,workspaceId,explicit?1:0]}];
}
