import * as fs from "node:fs";
const stringify = JSON.stringify;
JSON.stringify = function (...args) {
 const start = performance.now();
 const result = Reflect.apply(stringify, JSON, args);
 const ms = performance.now() - start;
 if (ms > 50 || (result?.length ?? 0) > 10_000_000) fs.appendFileSync(process.env.PROBE_GAPS!, stringify({type:"stringify",time:Date.now(),ms,bytes:result?.length,stack:new Error().stack})+"\n");
 return result;
};
let last=performance.now();
let read=0;
const io=()=>Number(/rchar: (\d+)/.exec(fs.readFileSync("/proc/self/io","utf8"))![1]);
read=io();
setInterval(()=>{const now=performance.now();const gap=now-last;last=now;const current=io();const rchar=current-read;read=current;if(gap>30)fs.appendFileSync(process.env.PROBE_GAPS!,stringify({time:Date.now(),gap,rchar})+"\n");},10).unref();
