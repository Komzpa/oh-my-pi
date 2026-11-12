import os,json,time,threading,subprocess,pathlib,sys,pty,select,signal,fcntl,termios,struct
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
ROOT=pathlib.Path(__file__).resolve().parents[1]; BASE=ROOT.parent
OUT=ROOT/'evidence'/sys.argv[1]; OUT.mkdir(exist_ok=True)
os.environ.update(HOME=str(BASE/'home'),XDG_CONFIG_HOME=str(BASE/'xdg/config'),XDG_STATE_HOME=str(BASE/'xdg/state'),XDG_CACHE_HOME=str(BASE/'xdg/cache'),PROBE_HUD=str(OUT/'hud.jsonl'),PROBE_EVENTS=str(OUT/'turn-events.jsonl'),PROBE_CWD=str(BASE/'cwd'),PROBE_GAPS=str(OUT/'gaps.jsonl'),TERM='xterm-256color')
subprocess.run(['ip','link','set','lo','up'],check=True)
class Handler(BaseHTTPRequestHandler):
 count=0
 parentCount=0
 def log_message(self,*a): pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
  with open(OUT/'requests.jsonl','a') as f:f.write(json.dumps({'time':time.time(),'path':self.path,'messages':len(body.get('messages',[]))})+'\n')
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  Handler.count+=1
  time.sleep(2)
  worker=body.get('model')=='offline-worker'
  critic='Trajectory (untrusted data)' in json.dumps(body)
  parent=not worker and not critic and len(body.get('messages',[]))>8
  if parent: Handler.parentCount+=1
  tool=parent and Handler.parentCount%2==1
  def event(kind,data):
   self.wfile.write(('event: '+kind+'\ndata: '+json.dumps(data)+'\n\n').encode())
  event('message_start',{'type':'message_start','message':{'id':'claude-opus-5-5','type':'message','role':'assistant','model':'claude-opus-5-5','content':[],'stop_reason':None,'usage':{'input_tokens':105000,'output_tokens':0}}})
  actions={
   1:('task',{'context':'Offline reproduction. No real provider or checkout writes.','tasks':[{'agent':'task','name':'VerifyLevelledPowerOffline','task':'Verify levelled power inventory and incomplete inputs. Offline reproduction: reply briefly without tools.','solutionSpace':'Stub response only; no file changes.','model':'anthropic/offline-worker','tools':[],'readOnly':True}]}),
   3:('read',{'path':'history://current/full:1-80'}),
   5:('read',{'path':'history://current/full:1-80'}),
   7:('grep',{'path':'history://current/full','pattern':'Current branch','literal':True,'limit':1})}
  action=actions.get(Handler.parentCount,('todo',{'op':'view'}))
  block={'type':'tool_use','id':'probe_'+str(Handler.count),'name':action[0],'input':{}} if tool else {'type':'text','text':''}
  event('content_block_start',{'type':'content_block_start','index':0,'content_block':block})
  delta={'type':'input_json_delta','partial_json':json.dumps(action[1])} if tool else {'type':'text_delta','text':json.dumps({'converging':True,'criticalPathBlocker':None,'falseDependencies':[],'split':[],'cut':[],'escalate':[],'actions':[]}) if critic else 'Offline probe complete.'}
  event('content_block_delta',{'type':'content_block_delta','index':0,'delta':delta})
  event('content_block_stop',{'type':'content_block_stop','index':0})
  event('message_delta',{'type':'message_delta','delta':{'stop_reason':'tool_use' if tool else 'end_turn','stop_sequence':None},'usage':{'output_tokens':10}})
  event('message_stop',{'type':'message_stop'})
(BASE/'home/.omp/agent/provider-cooldowns.json').write_text('{}')
server=ThreadingHTTPServer(('127.0.0.1',18767),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
class MemoryHandler(BaseHTTPRequestHandler):
 def log_message(self,*a):pass
 def do_POST(self):self.respond()
 def do_GET(self):self.respond()
 def do_PUT(self):self.respond()
 def respond(self):
  body=self.rfile.read(int(self.headers.get('Content-Length',0)))
  with open(OUT/'memory-requests.jsonl','a') as f:f.write(json.dumps({'time':time.time(),'path':self.path,'bytes':len(body)})+'\n')
  data=json.dumps({'items':[],'total':0,'results':[],'success':True,'bank_id':'offline'}).encode()
  self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
ms=ThreadingHTTPServer(('127.0.0.1',18768),MemoryHandler);threading.Thread(target=ms.serve_forever,daemon=True).start()
model={'id':'claude-opus-5-5','name':'claude-opus-5-5','reasoning':False,'input':['text','image'],'cost':{'input':0,'output':0,'cacheRead':0,'cacheWrite':0},'contextWindow':400000,'maxTokens':1000}
(BASE/'home/.omp/agent/models.yml').write_text(json.dumps({'providers':{'anthropic':{'api':'anthropic-messages','baseUrl':'http://127.0.0.1:18767/v1','apiKey':'offline','models':[model,{**model,'id':'offline-worker','name':'offline-worker'}]}}}))
(BASE/'home/.omp/agent/config.yml').write_text(json.dumps({'extensions':[str(BASE/'offline-source/packages/reemxy-extensions/extensions'/x) for x in ['goal_deadlines.ts','todo_dispatch.ts','agent_router.ts']],'modelRoles':{'task':'anthropic/offline-worker'},'task':{'perCallModel':'on','perCallModelAllow':['anthropic/offline-worker']},'retry':{'enabled':True,'usageAwareFallback':True},'compaction':{'enabled':True,'midTurnEnabled':True,'asyncEnabled':True,'methodOrder':['remote','snapcompact','shake','soft','handoff'],'thresholdTokens':80000,'keepRecentTokens':40000,'autoContinue':True,'supersedeReads':False,'dropUseless':False,'experimentalContextManagement':True}}))
journal=next((BASE/'home/.omp/agent/sessions/-proj-sunbim-datacenter-decision-graph').glob('*.jsonl'))
# Restore the exact frozen input for every run; rewrite both title/session header records.
with open('/home/kom/proj/ai_pr/omp-turnfreeze-20261107/fresh.jsonl','rb') as source,open(str(journal)+'.new','wb') as out:
 for _ in range(2):
  row=json.loads(source.readline())
  if row['type']=='session':row['cwd']=str(BASE/'cwd')
  out.write((json.dumps(row)+'\n').encode())
 import shutil
 shutil.copyfileobj(source,out,1024*1024)
pathlib.Path(str(journal)+'.new').replace(journal)
cmd=['/home/kom/.bun/bin/bun','--cpu-prof','--cpu-prof-dir='+str(OUT),'--preload',str(ROOT/'evidence/heartbeat.ts'),str(BASE/'offline-source/packages/coding-agent/src/cli.ts'),'--mode','rpc','--session',str(journal),'--provider','anthropic','--model','claude-opus-5-5','--no-title','--no-lsp','--extension',str(ROOT/'evidence/turn-events.ts')]
p=subprocess.Popen(cmd,cwd=BASE/'cwd',stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(OUT/'stderr.log','w'),text=True)
def send(n):
 p.stdin.write(json.dumps({'type':'prompt','id':str(n),'message':'Offline turn '+str(n)+'. Reply briefly.'})+'\n');p.stdin.flush()
n=1
for line in p.stdout:
 try:e=json.loads(line)
 except:continue
 typ=e.get('type')
 if typ=='extension_ui_request' and e.get('method') in ['confirm','select','input','editor']:
  p.stdin.write(json.dumps({'type':'extension_ui_response','id':e['id'],'cancelled':True})+'\n');p.stdin.flush()
 if typ=='ready':
  p.stdin.write(json.dumps({'type':'set_model','provider':'anthropic','modelId':'claude-opus-5-5'})+'\n');p.stdin.flush();send(1)
 if typ in ['notice','message_end','prompt_result']:
  with open(OUT/'details.jsonl','a') as f:f.write(json.dumps(e)+'\n')
 if typ not in ['message_update']:
  with open(OUT/'events.jsonl','a') as f:f.write(json.dumps({'time':time.time(),'type':typ,'success':e.get('success'),'error':e.get('error')})+'\n')
 if typ=='turn_end':
  n+=1
  if n>8:break
time.sleep(2)
p.send_signal(signal.SIGINT)
try:p.communicate(timeout=30)
except subprocess.TimeoutExpired:
 p.kill();p.communicate()
print('exit',p.returncode,'turns',n-1)
