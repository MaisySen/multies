// Small source-table fixture, matching actual column names/units/FK cascades.
// Real app schema/auth integration is tested separately. Never a migration.
export const sourceSchema = `
PRAGMA foreign_keys=ON;
CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT,email_verified INTEGER,banned INTEGER);
CREATE TABLE organizations(id TEXT PRIMARY KEY,require_sso INTEGER,is_demo INTEGER,suspended_at INTEGER);
CREATE TABLE members(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,role TEXT,kind TEXT,disabled_at INTEGER);
CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER,impersonated_by TEXT,login_method TEXT);
CREATE TABLE accounts(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,provider_id TEXT,password TEXT);
`;
export const seedSql = `
INSERT INTO users VALUES('usr_a','a@example.test',1,0);
INSERT INTO organizations VALUES('org_a',0,0,NULL);
INSERT INTO members VALUES('mem_a','usr_a','org_a','owner','human',NULL);
INSERT INTO sessions VALUES('ses_a','usr_a',4102444800000,NULL,'email');
`;
