import json, subprocess, pathlib, hashlib
root=pathlib.Path.cwd(); out=root/'evidence'
def git(*args): return subprocess.check_output(['git',*args],text=True).strip()
manifest=pathlib.Path('/home/kom/.config/tasks-loop/omp-live-stack.json').read_bytes()
(out/'oneshotgates-manifest.json').write_bytes(manifest)
rows=json.loads(manifest)['prs']; assert len(rows)==77
branches=['main']+[r['branch'] for r in rows]
subprocess.run(['git','fetch','fork',*[f'refs/heads/{b}:refs/remotes/fork/{b}' for b in branches]],check=True)
heads={b:git('rev-parse',f'fork/{b}') for b in branches}; heads['topic/rt-agent-runtime-core']=git('rev-parse','HEAD')
(out/'oneshotgates-heads.json').write_text(json.dumps(heads,indent=2)+'\n')
def merge(left,right,label):
 p=subprocess.run(['git','merge-tree','--write-tree',left,right],text=True,capture_output=True)
 (out/f'oneshotgates-{label}.merge.log').write_text(p.stdout+p.stderr)
 if p.returncode:
  conflicts=[line.split('\t')[-1] for line in p.stdout.splitlines() if line.startswith('100644 ')]
  if p.returncode!=1 or set(conflicts)!={'packages/catalog/src/compat/rules.json'}: raise RuntimeError(label+' '+p.stdout+p.stderr)
 return subprocess.check_output(['git','commit-tree',p.stdout.splitlines()[0],'-p',left,'-p',right],input=label+'\n',text=True).strip()
a=merge(heads['main'],heads['topic/rt-agent-runtime-core'],'main92')
c=heads['main']; ledger=[]
for i,row in enumerate(rows):
 h=heads[row['branch']]; c=merge(c,h,f'full-{i:02d}'); ledger.append({**row,'sha':h,'merge':c})
for row in ledger: subprocess.run(['git','merge-base','--is-ancestor',row['sha'],c],check=True)
for name,sha in [('full',c)]: subprocess.run(['git','worktree','add','--detach',str(root.parent/f'oneshotgates-{name}'),sha],check=True)
(out/'oneshotgates-merges.json').write_text(json.dumps({'main92':a,'full':c,'rows':ledger,'manifestSha256':hashlib.sha256(manifest).hexdigest()},indent=2)+'\n')
print('PASS: 77/77 pinned heads are ancestors; manifest order')
