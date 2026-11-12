//! One test process owns its task-limit override before runtime threads start.
#![cfg(target_os = "linux")]

use pi_shell::{Shell, ShellOptions, ShellRunOptions, cancel::CancelToken};

#[test]
fn source_and_first_command_share_cap_and_next_command_gets_new_boundary() {
	let previous = std::env::var_os("OMP_TOOL_TASKS_MAX");
	// SAFETY: this test binary has one test; no runtime threads exist yet.
	unsafe {
		std::env::set_var("OMP_TOOL_TASKS_MAX", "64");
	}
	let runtime = tokio::runtime::Runtime::new().unwrap();
	runtime.block_on(async {
		let dir = tempfile::tempdir().unwrap();
		let source_scope = dir.path().join("source-scope");
		let main_scope = dir.path().join("main-scope");
		let snapshot = dir.path().join("snapshot");
		let source_errors = dir.path().join("errors");
		std::fs::write(&snapshot, format!(r#"python3 -c 'import os,time; children=[]; exec("for _ in range(36):\n pid=os.fork()\n if pid==0: time.sleep(2); os._exit(0)\n children.append(pid)"); open("{}","w").write(open("/proc/self/cgroup").read()); [os.waitpid(pid,0) for pid in children]' >/dev/null 2>'{}' &
while [ ! -f '{}' ]; do sleep .01; done
"#, source_scope.display(), source_errors.display(), source_scope.display())).unwrap();
		let shell = Shell::new(Some(ShellOptions {
			snapshot_path: Some(snapshot.to_str().unwrap().into()),
			..Default::default()
		}));
		let command = format!(r#"python3 -c 'import os,time; open("{}","w").write(open("/proc/self/cgroup").read()); children=[]; exec("for _ in range(36):\n try: pid=os.fork()\n except OSError: break\n if pid==0: time.sleep(.3); os._exit(0)\n children.append(pid)"); [os.waitpid(pid,0) for pid in children]'"#, main_scope.display());
		let error = shell.run(ShellRunOptions { command, ..Default::default() }, None, CancelToken::new(Some(10000))).await;
		let error = match error { Err(error) => error, Ok(result) => panic!("expected shared task cap, got {result:?}; source stderr: {:?}", std::fs::read_to_string(&source_errors)) };
		assert!(error.to_string().contains("tool process limit exceeded"), "{error}");
		let leaf = |text: &str| text.split('/').rfind(|part| part.starts_with("omp-tool-call-") && part.ends_with(".slice")).unwrap().to_owned();
		let source = std::fs::read_to_string(source_scope).unwrap();
		assert_eq!(leaf(&source), leaf(&std::fs::read_to_string(main_scope).unwrap()));
		let (tx, rx) = flume::unbounded();
		let next = shell.run(ShellRunOptions { command: "/bin/cat /proc/self/cgroup".into(), ..Default::default() }, Some(tx), CancelToken::new(Some(10000))).await.unwrap();
		assert_eq!(next.exit_code, Some(0));
		assert_ne!(leaf(&source), leaf(&rx.drain().collect::<String>()));
	});
	drop(runtime);
	// SAFETY: the runtime and its threads have ended.
	unsafe {
		match previous {
			Some(value) => std::env::set_var("OMP_TOOL_TASKS_MAX", value),
			None => std::env::remove_var("OMP_TOOL_TASKS_MAX"),
		}
	}
}
