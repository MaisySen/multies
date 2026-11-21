#!/usr/bin/env python3
"""Isolated X11 default-decline driver. Never clicks Allow or uses a physical DISPLAY."""
import os,pathlib,subprocess,time,tempfile,json,sys
root=pathlib.Path(__file__).resolve().parent.parent
out=pathlib.Path(tempfile.mkdtemp(prefix='attended-real-dialog-',dir='/downloads'))
for exe in ['Xvfb','xdotool','import','node']:
 import shutil
 if not shutil.which(exe):raise RuntimeError('required isolated negative-test dependency unavailable: '+exe)
proc=None
with (out/'display').open('w')as fd,(out/'xvfb.log').open('w')as log:
 x=subprocess.Popen(['Xvfb','-noreset','-displayfd',str(fd.fileno()),'-screen','0','1024x768x24'],stdout=log,stderr=log,pass_fds=(fd.fileno(),))
try:
 until=time.monotonic()+5
 while not (out/'display').read_text().strip():
  if time.monotonic()>until or x.poll()is not None:raise RuntimeError('isolated display failed')
  time.sleep(.02)
 display=':'+(out/'display').read_text().strip()
 env=dict(os.environ,DISPLAY=display,MNET_ISOLATED_X11_DISPLAY=display,MNET_ATTENDED_REAL_DIALOG='1',NO_AT_BRIDGE='1')
 env.pop('WAYLAND_DISPLAY',None)
 clicked=False
 with (out/'test.log').open('w')as log:
  proc=subprocess.Popen(['node','node_modules/vitest/vitest.mjs','run','tests/mnet-attended-network-cross-app.test.ts','-t','deny-real-dialog'],cwd=root,env=env,stdout=log,stderr=log)
  until=time.monotonic()+95
  while proc.poll()is None:
   if time.monotonic()>until:raise RuntimeError('bounded negative run timed out')
   if not clicked:
    query=subprocess.run(['xdotool','search','--onlyvisible','--name','^Mnet: allow viewing\\?$'],env=env,text=True,capture_output=True)
    ids=query.stdout.strip().splitlines()if query.returncode==0 else []
    if len(ids)>1:raise RuntimeError('ambiguous local view dialog')
    if ids:
     wid=ids[0]
     subprocess.run(['xdotool','windowfocus',wid],env=env,check=True)
     # Capture actual pixels before any answer. Return preserves the real default-cancel selection.
     time.sleep(.06)
     subprocess.run(['import','-window',wid,str(out/'default-decline-before-return.png')],env=env,check=True)
     subprocess.run(['xdotool','windowfocus',wid,'key','Return'],env=env,check=True)
     clicked=True
   time.sleep(.01)
  code=proc.wait()
 if not clicked:raise RuntimeError('real dialog never appeared; no decline proven')
 (out/'driver-result.json').write_text(json.dumps({'isolatedDisplay':display,'action':'Return on untouched default-cancel selection','dialogObserved':clicked,'returncode':code,'positiveAnswerSent':False},indent=2))
 print(out)
 print((out/'test.log').read_text())
 sys.exit(code)
finally:
 if proc is not None and proc.poll()is None:proc.kill();proc.wait()
 x.terminate();x.wait(timeout=5)
