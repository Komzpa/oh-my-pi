# Test launch capacity

The worker tool-call gate used to require zero other same-project test processes.
It now admits when running launch trees < N, where
`N = min(available CPUs, floor(max(0, MemAvailable - RAM floor) / 4 GiB))`.
The default RAM floor remains 8 GiB (`OMP_DISPATCH_MIN_RAM_GIB`). A runner and
its browser children count once. Every attempt takes a fresh snapshot; refusal
lists the count, PIDs, N, CPU count, memory and exact retry conditions.

On 2026-11-06 at 18:46:57 UTC this host had 32 CPUs and MemAvailable
45,394,644 KiB (43.29 GiB): N=8. With the owner's 53 GiB snapshot N=11.
This is a conservative snapshot gate, not a reservation scheduler: already
running memory is reflected in MemAvailable, and simultaneous launches may
observe the same snapshot. Do not treat N as a fixed machine-wide setting.

## Measurement

Measured in this worktree's `.tmp/browser-capacity`, without reading or writing
the live DC checkout. Playwright 1.64.1, Node 24.22.2, Chromium cache revision
1234, Bun 1.4.4. Three fresh Playwright runs of the fixture below, each with an
interactive 6000-row rack inventory, twelve 2048-square RGBA WebGL textures,
1920x1080 framebuffer, animation, control assertion and screenshot.

The sampler reads RSS pages from `/proc/<pid>/stat` every 50 ms and sums the
runner and all descendants at each sample. Peaks (bytes): 1,688,956,928;
1,621,098,496; 1,654,280,192. All three exited 0. Maximum 1.573 GiB;
4 GiB/run rounds above twice this peak (2.54x headroom). Shared pages can be
counted more than once; this deliberately overestimates RAM relative to PSS.
This sizes a realistic fixture, not the full DC suite. Re-measure if its shape
changes. The renderer was ANGLE SwiftShader: these are RAM receipts only and
provide no valid hardware timing result.

To reproduce, create a disposable directory under `.tmp`, install
`@playwright/test@1.64.1` there with its own package.json, save the fixture as
`fixture.spec.ts`, set `use.launchOptions.executablePath` in a Playwright config
to the local Chromium executable, and run the sampler from the worktree root.
The original config requested `--use-gl=angle --use-angle=gl --enable-webgl
--ignore-gpu-blocklist`; record the actual renderer regardless of requested flags.

```typescript
import { test, expect } from '@playwright/test';
test('interactive rack scene with inventory and framebuffer', async ({page}) => {
 await page.setContent(`<button id="change">Change redundancy</button><div id="inventory"></div><canvas width="1920" height="1080"></canvas><script>
 const inventory=document.querySelector('#inventory');
 for(let i=0;i<6000;i++){const d=document.createElement('div');d.textContent='Rack '+i+' · 42U · 12 kW · redundant power';inventory.append(d)}
 const gl=document.querySelector('canvas').getContext('webgl2');
 const textures=[];for(let i=0;i<12;i++){const t=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,t);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,2048,2048,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array(2048*2048*4));textures.push(t)}
 window.renderer=gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
 function frame(){gl.clearColor(Math.random(),0.2,0.3,1);gl.clear(gl.COLOR_BUFFER_BIT);requestAnimationFrame(frame)}frame();
 document.querySelector('button').onclick=()=>inventory.firstChild.textContent='Redundancy updated';
 </script>`);
 console.log('renderer='+await page.evaluate(()=>window.renderer));
 await page.locator('#change').click();
 await expect(page.locator('#inventory').first()).toContainText('Redundancy updated');
 await page.screenshot({path:test.info().outputPath('rack.png')});
 await page.waitForTimeout(3000);
});
```

```python
import subprocess,time,pathlib,json
for run in range(3):
 p=subprocess.Popen(['bun','x','playwright','test'],cwd=pathlib.Path(__file__).parent)
 peak=0
 while p.poll() is None:
  procs={}
  for d in pathlib.Path('/proc').glob('[0-9]*'):
   try:
    s=(d/'stat').read_text().split(') ')[1].split();procs[int(d.name)]=(int(s[1]),int(s[21])*4096)
   except (OSError,ValueError,IndexError):pass
  ids={p.pid}
  for _ in range(12):ids|={pid for pid,(parent,rss) in procs.items() if parent in ids}
  peak=max(peak,sum(procs.get(pid,(0,0))[1] for pid in ids))
  time.sleep(.05)
 print(json.dumps({'run':run+1,'treePeakRSSBytes':peak,'exit':p.returncode}),flush=True)
```

## GPU and isolation

Hardware runs opt in with `OMP_TEST_GPU=1`; explicit perf/performance/timing/
frame-cap arguments also trigger the gate. Browser tool callers can use
`gpu: true`. Always mark a full suite that contains hardware timing specs;
opaque package scripts cannot be inferred from their names alone.

`nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits` supplies
per-device free VRAM. Additional GPU capacity is the sum of
`floor(max(0, freeMiB - 1024) / 1024)` over devices; at least one device must
have 2048 MiB free. The 1 GiB/run budget and 1 GiB device floor are conservative
policy reserves, not measured DC VRAM consumption. At the snapshot above the
devices had 1834 and 714 MiB free, giving zero additional hardware runs.
Unknown VRAM refuses hardware runs; it never refuses functional runs.
Timing receipts must record the actual hardware renderer; SwiftShader is invalid.

The extension owns no project web server or Playwright config. Brief each run
with its own port and output/report paths; use `mktemp` directories and
Playwright `--output`, plus `PLAYWRIGHT_HTML_OUTPUT_DIR`. Configure webServer
and baseURL for that run's port (port 0 when supported). The managed browser
already uses `--remote-debugging-port=0`; its shared daemon supports separate
tabs/contexts rather than a test lock. No live project config was changed here.
The lead staffing notice and gate-runner, profiler and visual-qa profiles carry
the same rule. Historical failure receipts mentioning old slots remain evidence;
the executable fixture brief no longer requests flock.

## Regression receipt

Base: bca8844ff037d07e1055b9c538f62c9ad16d26a7. Ran the candidate test file
against the base preflight implementation, then restored the candidate.
Command: `bun test packages/reemxy-extensions/extensions/dispatch_preflight.test.ts`.
Base: 10 pass, 2 fail. Candidate: 12 pass, 0 fail.

- `three same-project suites admit a fourth with RAM capacity of at least four`:
  fails on base, passes after; also checks CPU saturation, PID exit and project isolation.
- `RAM below the floor refuses an idle project`: passes before and after.
- `low VRAM refuses hardware perf while functional e2e still runs`: fails on base,
  passes after; includes restored VRAM and failed-probe boundaries.

Combined dispatch_preflight, todo_dispatch*.test.ts and lead-instructions.test.ts:
440 pass, 0 fail across 29 files. Package `bun run --cwd packages/reemxy-extensions check`
passes (2770 files). Formatter: read-only executable from omp-butler-install.
Bun's local `bun run --help` documents script execution and --cwd; the earlier
check failure was the test helper's inferred probe type, fixed by explicitly
using HostResourceProbes. No install or live-session change is part of this patch.
