"""Measure 10 ms heartbeat intervals overlapping each root turn; no startup samples."""
import json,sys,statistics,pathlib
ROOT='01a1921c-7697-72a8-b4a3-4efdbbf06221'
for arg in sys.argv[1:]:
 p=pathlib.Path(arg)
 rows=[json.loads(l) for l in (p/'gaps.jsonl').open()]
 gaps=[r for r in rows if 'gap' in r]
 ev=[json.loads(l) for l in (p/'turn-events.jsonl').open()]
 spans=[];start=None
 for e in ev:
  if e['session']!=ROOT:continue
  if e['type']=='turn_start':start=e['time']
  elif e['type']=='turn_end' and start is not None:
   group=[r for r in gaps if r['time']>=start and r['time']-r['gap']<=e['time']]
   top=max(group,key=lambda r:r['gap'],default={'gap':10,'rchar':0})
   spans.append({'start':start,'end':e['time'],'maxIntervalMs':top['gap'],'rcharAtMax':top.get('rchar'),'sampleEnd':top.get('time')});start=None
 values=[s['maxIntervalMs'] for s in spans]
 tools=[]
 for l in (p/'details.jsonl').open():
  m=json.loads(l).get('message',{})
  if isinstance(m,dict) and m.get('role')=='toolResult':
   tools.append({'tool':m.get('toolName'),'isError':m.get('isError'), 'outOfMemory':any('Out of memory' in b.get('text','') for b in m.get('content',[])), 'hasHistoryHeader':any('# Current branch' in b.get('text','') for b in m.get('content',[]))})
 result={'source':str(p),'heartbeatMs':10,'unit':'milliseconds','turns':spans,'p50TurnMaxMs':statistics.median(values),'maxTurnMs':max(values),'tools':tools}
 print(json.dumps(result,indent=2))
