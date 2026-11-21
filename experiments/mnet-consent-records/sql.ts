import { DB_NOW_MS, initializeSql, approveSql } from '../mnet-relationship-store/store';
export { DB_NOW_MS, initializeSql };
// Small hard bounds for this disposable candidate. No tombstone deletion/reset.
export const APPROVED_CAP=4, HISTORY_CAP=8;
export const insertSql=approveSql+`
 AND (SELECT count(*) FROM rel_approvals WHERE user_id=u.id AND status='approved')<${APPROVED_CAP}
 AND (SELECT count(*) FROM rel_approvals WHERE user_id=u.id)<${HISTORY_CAP}
 ON CONFLICT(user_id,workspace_id,device_key_digest) WHERE status='approved' DO NOTHING`;
const actor=`EXISTS(SELECT 1 FROM sessions actor WHERE actor.id=? AND actor.user_id=a.user_id AND actor.impersonated_by IS NULL AND actor.expires_at>${DB_NOW_MS})`;
// Effective validity is diagnostic DATA, never a consumer or grant.
export const selectSql=`SELECT a.id,a.workspace_id workspaceId,a.device_key_digest deviceDigest,a.status recordedStatus,
 CASE WHEN a.status='revoked' THEN 'recorded-revoked'
 WHEN s.id IS NULL OR s.expires_at<=${DB_NOW_MS} OR s.impersonated_by IS NOT NULL THEN 'original-session-ended'
 WHEN f.user_id IS NULL OR f.disabled<>0 OR f.generation<>a.approved_security_generation THEN 'security-fence-changed'
 WHEN u.id IS NULL OR u.email_verified<>1 OR COALESCE(u.banned,0)<>0 OR m.id IS NULL OR m.kind<>'human' OR m.disabled_at IS NOT NULL OR o.id IS NULL OR COALESCE(o.is_demo,0)<>0 OR o.suspended_at IS NOT NULL THEN 'current-eligibility-unmet'
 WHEN COALESCE(o.require_sso,0)<>0 AND m.role<>'owner' AND a.approval_login_method NOT IN ('auth0','google') THEN 'sso-blocked'
 ELSE 'currently-valid-session-bound-data' END validity
 FROM rel_approvals a LEFT JOIN users u ON u.id=a.user_id
 LEFT JOIN members m ON m.id=a.member_id AND m.user_id=a.user_id AND m.organization_id=a.workspace_id
 LEFT JOIN organizations o ON o.id=a.workspace_id
 LEFT JOIN sessions s ON s.id=a.approving_session_id AND s.user_id=a.user_id
 LEFT JOIN rel_security f ON f.user_id=a.user_id
 WHERE ${actor}`;
export const revokeSql=`UPDATE rel_approvals SET status='revoked' WHERE id=? AND status='approved'
 AND user_id=(SELECT user_id FROM sessions WHERE id=? AND impersonated_by IS NULL AND expires_at>${DB_NOW_MS})`;
export const actorSql=`SELECT id FROM sessions WHERE id=? AND user_id=? AND impersonated_by IS NULL AND expires_at>${DB_NOW_MS}`;
