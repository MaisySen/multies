// Negative test facts deliberately bypass automatic invalidation. Approved status
// MUST remain intact, so only the conditional witness predicates can deny.
export const witnessCases = [
 {name:'fence-generation', before:'', mutation:'UPDATE rel_security SET generation=generation+1', predicate:' AND f.generation=a.approved_security_generation'},
 {name:'fence-disabled', before:'', mutation:'UPDATE rel_security SET disabled=1', predicate:' AND f.disabled=0'},
 {name:'session-impersonation', before:'', mutation:"DROP TRIGGER rel_session_update; UPDATE sessions SET impersonated_by='operator'", predicate:' AND s.impersonated_by IS NULL'},
 {name:'current-sso-policy', before:"UPDATE members SET role='member'", mutation:'DROP TRIGGER rel_org_update; UPDATE organizations SET require_sso=1', predicate:" AND (COALESCE(o.require_sso,0)=0 OR m.role='owner' OR a.approval_login_method IN ('auth0','google'))"},
 {name:'approval-login-not-current-session', before:"UPDATE members SET role='member'", mutation:"DROP TRIGGER rel_org_update; DROP TRIGGER rel_session_update; UPDATE organizations SET require_sso=1; UPDATE sessions SET login_method='google'", predicate:"a.approval_login_method IN ('auth0','google')"},
] as const;
