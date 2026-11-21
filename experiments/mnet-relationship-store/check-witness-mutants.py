"""Test-only source mutants. Restore exact store bytes even on failure."""
from pathlib import Path
import subprocess
p=Path('experiments/mnet-relationship-store/store.ts')
original=p.read_bytes()
s=original.decode()
head,tail=s.split('export const witnessSql =',1)
witness,rest=tail.split('export const ownRevokeSql =',1)
mutants=[
 ('fence-generation',' AND f.generation=a.approved_security_generation',''),
 ('fence-disabled',' AND f.disabled=0',''),
 ('session-impersonation',' AND s.impersonated_by IS NULL',''),
 ('current-sso-policy'," AND (COALESCE(o.require_sso,0)=0 OR m.role='owner' OR a.approval_login_method IN ('auth0','google'))",''),
 ('approval-login-not-current-session',"a.approval_login_method IN ('auth0','google')","s.login_method IN ('auth0','google')"),
]
try:
 for name,old,new in mutants:
  assert witness.count(old)==1,(name,'ambiguous source replacement')
  p.write_text(head+'export const witnessSql ='+witness.replace(old,new)+'export const ownRevokeSql ='+rest)
  for test in ['tests/mnet-relationship-store.test.ts','tests/mnet-relationship-store-d1.test.ts']:
   r=subprocess.run(['node','node_modules/vitest/vitest.mjs','run',test,'-t','approved-status witness'],capture_output=True,text=True)
   log=Path('/tmp/rel-witness-mutants')/(name+'-'+Path(test).stem+'.log');log.parent.mkdir(exist_ok=True);log.write_text(r.stdout+r.stderr)
   assert r.returncode!=0,(name,test,'MUTANT SURVIVED')
   assert 'AssertionError' in r.stdout+r.stderr,(name,test,'failed for unrelated reason')
   print(name,test,'killed by assertion',flush=True)
finally:
 p.write_bytes(original)
assert p.read_bytes()==original
print('All5 witness mutants killed in Node AND local D1; store restored byte-identical.')
