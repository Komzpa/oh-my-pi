# Keyed action-demand wakes

User lane: idle lead not answering blocking IRC or per-minute demands, DC session01a1921c, 2026-11-07. Scope and journal corrections are in PR23 evidence/ircwake.md. No install, updater, live sessions or config writes.

Canonical owner PR92 topic/rt-agent-runtime-core, base66e690ddb8495313a1d1683d716d20b2e7162131. lane_ask DECISION: keep peer/wait core in PR23 and dispatcher in PR92, disjoint changes. Preserve existing busy/idle guards rather than infer a busy bypass from the journal; it contains three empty assistant completions, and its incoming IRC was classified busy.

sendHarnessNotice now persists a separate action-wake reservation for demand.key, five minutes per key. Receipt/observation appends do not spend the allowance. Cooldown notices retain the concrete demand prompt in the queue; a different obligation can wake immediately. Worker-ask interrupts use their own direct sender and bypass this cooldown.

Regression on base66e690dd fails: the second minute requests a second wake, expected one (runtime-demand-base.log). Candidate fourteen wake-action tests cover repeated minute observations, reload, due retry, resolved demand, changed key and busy=>idle. Complete todo_dispatch suites:438 pass,0fail,8391assertions33files53.80s. No native code changed; tests use the preprovided lane native artifact2d1c1146c25e431985d63b832e1db810be341ed21f36d074c64f1ff2f6fe240b; its build provenance is unknown.

Full bun check: TS lint/format and package typechecks pass; Rust-format fails on untouched base file crates/pi-shell/src/bash/trace/viz/runtime_tests.rs49,93. Base and candidate file are identical. No claim of full check success. Both changed TS files were formatter-dirty at base; surrounding style retained without whole-file churn.

77-PR composite: fork/main9370e7bfe26e948d72f53f918e681b402e600383, exact fetched refs in manifest order, plus PR23 candidate46b6bc4edf1 and these two PR92 changed TS files. Generated catalog rules regenerated from KDL. All package typechecks pass, including reemxy-extensions2868files. Fresh upstream separately conflicts at PR16651 executor.ts before either candidate; lane_ask explicitly directed fork/main rehearsal, leaving unrelated branches unchanged.
