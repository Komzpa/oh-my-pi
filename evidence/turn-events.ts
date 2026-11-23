import * as fs from 'node:fs';
export default function probe(pi) {
 pi.on('session_start',(_e,ctx) => {
  ctx.sessionManager.setCwdWithoutRelocation(process.env.PROBE_CWD);
  fs.appendFileSync(process.env.PROBE_EVENTS,JSON.stringify({time:Date.now(),type:'session_start',session:ctx.sessionManager.getSessionId(),cwd:ctx.cwd})+'\n');
 });
 for (const type of ['turn_start','turn_end','agent_start','agent_end','session_compact','tool_execution_start','tool_execution_end']) {
  pi.on(type,(e,ctx)=> {fs.appendFileSync(process.env.PROBE_EVENTS,JSON.stringify({time:Date.now(),type,session:ctx.sessionManager.getSessionId(),tool:e.toolName})+'\n');});
 }
}
