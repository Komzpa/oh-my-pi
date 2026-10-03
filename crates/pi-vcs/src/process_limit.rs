//! Linux per-tool process boundaries for external shell commands.
//!
//! Each shell execution owns a transient systemd slice with `TasksMax=500`.
//! External programs run as transient scopes beneath that slice, so their
//! descendants and forks are counted together by cgroup v2. Scopes preserve
//! inherited descriptors, resource limits, and the caller's environment.
//! The kernel limit is read back before user code runs; unavailable or
//! mismatched enforcement fails closed. Dropping the owner stops only its
//! transient slice and all remaining descendants.
//!
//! This requires Linux cgroup v2 and a usable systemd user manager. Linux
//! sessions without that support reject external commands; unsupported
//! platforms retain normal shell behavior without this process-count guarantee.
//! Service-manager and remote execution are separate control planes, not an
//! adversarial sandbox boundary around arbitrary same-user actions.

use std::{
	ffi::{OsStr, OsString},
	io,
	process::Command,
	sync::{
		Mutex,
		atomic::{AtomicU64, Ordering},
	},
};

use brush_core::ExternalCommandWrapper;

const DEFAULT_TASK_LIMIT: u32 = 500;
static NEXT_SCOPE_ID: AtomicU64 = AtomicU64::new(1);

struct LimitState {
	initialized:     bool,
	created:         bool,
	next_command_id: u64,
}

pub struct ToolProcessLimit {
	slice: String,
	limit: u32,
	state: Mutex<LimitState>,
}

impl Default for ToolProcessLimit {
	fn default() -> Self {
		Self::new(DEFAULT_TASK_LIMIT)
	}
}

impl ToolProcessLimit {
	pub fn wrap_scope_command(&self, command: &[OsString]) -> io::Result<Vec<OsString>> {
		if command.is_empty() {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty scoped command"));
		}
		#[cfg(not(target_os = "linux"))]
		return Ok(command.to_vec());
		#[cfg(target_os = "linux")]
		{
			let mut state = self
				.state
				.lock()
				.map_err(|_| io::Error::other("process limit state poisoned"))?;
			self.ensure_enforced(&mut state)?;
			let command_id = state.next_command_id;
			state.next_command_id += 1;
			let unit =
				format!("omp-tool-call-{}-{command_id}.scope", self.slice.trim_end_matches(".slice"));
			let mut wrapped = vec![
				"systemd-run".into(),
				"--user".into(),
				"--scope".into(),
				"--collect".into(),
				"--quiet".into(),
				"--expand-environment=no".into(),
				"--slice".into(),
				self.slice.clone().into(),
				"--unit".into(),
				unit.into(),
				"--property=TimeoutStopSec=2s".into(),
				"--".into(),
			];
			wrapped.extend_from_slice(command);
			Ok(wrapped)
		}
	}

	pub fn new(limit: u32) -> Self {
		let id = NEXT_SCOPE_ID.fetch_add(1, Ordering::Relaxed);
		Self {
			slice: format!("omp-tool-call-{}-{id}.slice", std::process::id()),
			limit,
			state: Mutex::new(LimitState {
				initialized:     false,
				created:         false,
				next_command_id: 0,
			}),
		}
	}

	fn ensure_enforced(&self, state: &mut LimitState) -> io::Result<()> {
		if state.initialized {
			return Ok(());
		}
		#[cfg(not(target_os = "linux"))]
		{
			return Err(io::Error::new(
				io::ErrorKind::Unsupported,
				"per-tool process limits require Linux cgroup v2 and a systemd user manager",
			));
		}
		#[cfg(target_os = "linux")]
		{
			state.created = true;
			let result = Command::new("systemctl")
				.args(["--user", "set-property", "--runtime", &self.slice])
				.arg(format!("TasksMax={}", self.limit))
				.output()?;
			if !result.status.success() {
				return Err(io::Error::other(format!(
					"systemd could not create the per-tool process limit: {}",
					String::from_utf8_lossy(&result.stderr).trim()
				)));
			}
			let probe_unit =
				format!("omp-tool-call-probe-{}.scope", self.slice.trim_end_matches(".slice"));
			let result = Command::new("systemd-run")
				.args([
					"--user",
					"--pipe",
					"--wait",
					"--collect",
					"--quiet",
					"--slice",
					&self.slice,
					"--unit",
					&probe_unit.replace(".scope", ".service"),
					"--",
					"/usr/bin/env",
					"--argv0=omp-process-limit-probe",
					"/usr/bin/true",
				])
				.output()?;
			if !result.status.success() {
				return Err(io::Error::other(format!(
					"systemd could not start a process inside the per-tool limit: {}",
					String::from_utf8_lossy(&result.stderr).trim()
				)));
			}

			let cgroup = systemd_property(&self.slice, "ControlGroup")?;
			let pids_max = std::fs::read_to_string(format!("/sys/fs/cgroup{cgroup}/pids.max"))?;
			if pids_max.trim() != self.limit.to_string() {
				return Err(io::Error::other(format!(
					"per-tool process limit readback mismatch: expected {}, got {}",
					self.limit,
					pids_max.trim()
				)));
			}
			state.initialized = true;
		}
		Ok(())
	}

	pub fn limit_was_hit(&self) -> io::Result<bool> {
		let state = self
			.state
			.lock()
			.map_err(|_| io::Error::other("process limit state poisoned"))?;
		if !state.initialized {
			return Ok(false);
		}
		#[cfg(target_os = "linux")]
		{
			let cgroup = systemd_property(&self.slice, "ControlGroup")?;
			let events = std::fs::read_to_string(format!("/sys/fs/cgroup{cgroup}/pids.events"))?;
			Ok(events
				.lines()
				.any(|line| line.starts_with("max ") && line != "max 0"))
		}
		#[cfg(not(target_os = "linux"))]
		Ok(false)
	}

	pub fn has_live_tasks(&self) -> io::Result<bool> {
		let state = self
			.state
			.lock()
			.map_err(|_| io::Error::other("process limit state poisoned"))?;
		if !state.initialized {
			return Ok(false);
		}
		#[cfg(target_os = "linux")]
		{
			let cgroup = systemd_property(&self.slice, "ControlGroup")?;
			let count = std::fs::read_to_string(format!("/sys/fs/cgroup{cgroup}/pids.current"))?;
			Ok(count.trim().parse::<u64>().unwrap_or(0) > 0)
		}
		#[cfg(not(target_os = "linux"))]
		Ok(false)
	}
}

impl ExternalCommandWrapper for ToolProcessLimit {
	fn wrap_external_command(
		&self,
		executable: &OsStr,
		argv0: &OsStr,
		args: &[OsString],
	) -> io::Result<Option<(OsString, Vec<OsString>)>> {
		#[cfg(not(target_os = "linux"))]
		{
			return Ok(None);
		}
		#[cfg(target_os = "linux")]
		{
			let mut command = vec![OsString::from("/usr/bin/env")];
			let mut argv0_arg = OsString::from("--argv0=");
			argv0_arg.push(argv0);
			command.push(argv0_arg);
			command.push(executable.to_os_string());
			command.extend_from_slice(args);
			let mut wrapped = self.wrap_scope_command(&command)?;
			let runner = wrapped.remove(0);
			Ok(Some((runner, wrapped)))
		}
	}
}

impl Drop for ToolProcessLimit {
	fn drop(&mut self) {
		let created = self.state.get_mut().is_ok_and(|state| state.created);
		if created {
			let _ = Command::new("systemctl")
				.args(["--user", "stop", &self.slice])
				.status();
		}
	}
}

fn systemd_property(unit: &str, property: &str) -> io::Result<String> {
	let result = Command::new("systemctl")
		.args(["--user", "show", unit, "--property", property, "--value"])
		.output()?;
	if !result.status.success() {
		return Err(io::Error::other(format!(
			"systemd readback failed for {unit} {property}: {}",
			String::from_utf8_lossy(&result.stderr).trim()
		)));
	}
	let value = String::from_utf8_lossy(&result.stdout).trim().to_owned();
	if value.is_empty() {
		return Err(io::Error::other(format!("systemd returned an empty {property} for {unit}")));
	}
	Ok(value)
}

#[cfg(test)]
mod tests {
	use std::{
		io::{BufRead, BufReader},
		process::{Child, Command, Stdio},
		time::{Duration, Instant},
	};

	use brush_core::ExternalCommandWrapper;

	use super::ToolProcessLimit;

	fn wrapped_command(limit: &ToolProcessLimit, program: &str, args: &[&str]) -> Command {
		let (runner, wrapped_args) = limit
			.wrap_external_command(
				program.as_ref(),
				program.as_ref(),
				&args.iter().map(Into::into).collect::<Vec<_>>(),
			)
			.expect("per-tool systemd process boundary")
			.expect("Linux command wrapper");
		let mut command = Command::new(runner);
		command.args(wrapped_args);
		command
	}

	fn wait_for_exit(child: &mut Child) {
		let deadline = Instant::now() + Duration::from_secs(3);
		loop {
			if child.try_wait().expect("check process").is_some() {
				return;
			}
			assert!(Instant::now() < deadline, "owned worker did not stop with its cgroup");
			std::thread::sleep(Duration::from_millis(25));
		}
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn kernel_cap_contains_forks_preserves_manager_operations_and_keeps_neighbor_independent() {
		let process_limit = ToolProcessLimit::new(32);
		let mut fork = wrapped_command(&process_limit, "/usr/bin/python3", &[
			"-c",
			"import os,time\nchildren=[]\nfor _ in range(256):\n try: pid=os.fork()\n except OSError \
			 as e: print('fork-blocked',e.errno,flush=True); break\n if pid == 0: time.sleep(1); \
			 os._exit(0)\n children.append(pid)\nfor pid in children: os.waitpid(pid,0)",
		]);
		let output = fork.output().expect("run bounded fork fixture");
		assert!(
			output.status.success(),
			"fixture failed: {}",
			String::from_utf8_lossy(&output.stderr)
		);
		assert!(String::from_utf8_lossy(&output.stdout).contains("fork-blocked"));
		assert!(
			process_limit
				.limit_was_hit()
				.expect("read kernel pids.events")
		);

		let mut escape = wrapped_command(&process_limit, "/usr/bin/systemd-run", &[
			"--user",
			"--wait",
			"--collect",
			"--quiet",
			"--",
			"/usr/bin/true",
		]);
		let escape_output = escape.output().expect("probe manager escape");
		assert!(escape_output.status.success(), "explicit managed-service operation failed");

		let mut systemctl = wrapped_command(&process_limit, "/usr/bin/systemctl", &[
			"--user",
			"list-units",
			"--no-pager",
		]);
		let systemctl_output = systemctl.output().expect("probe read-only manager command");
		assert!(
			systemctl_output.status.success(),
			"read-only systemctl failed: {}",
			String::from_utf8_lossy(&systemctl_output.stderr)
		);

		let neighbor = ToolProcessLimit::new(32);
		let output = wrapped_command(&neighbor, "/usr/bin/printf", &["neighbor-ok"])
			.output()
			.expect("run independent neighboring tool call");
		assert!(output.status.success());
		assert_eq!(String::from_utf8_lossy(&output.stdout), "neighbor-ok");
		assert!(
			!neighbor
				.limit_was_hit()
				.expect("read neighboring pids.events")
		);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn dropping_call_boundary_kills_escaped_session_descendants() {
		let process_limit = ToolProcessLimit::new(32);
		let mut child = wrapped_command(&process_limit, "/usr/bin/python3", &[
			"-c",
			"import os,time\npid=os.fork()\nif pid == 0:\n os.setsid()\n time.sleep(30)\n \
			 os._exit(0)\nprint(pid,flush=True)\ntime.sleep(30)",
		])
		.stdout(Stdio::piped())
		.spawn()
		.expect("spawn isolated long-running process tree");
		let descendant_pid = BufReader::new(child.stdout.take().expect("stdout"))
			.lines()
			.next()
			.expect("worker pid line")
			.expect("read worker pid")
			.parse::<i32>()
			.expect("numeric worker pid");
		drop(process_limit);
		wait_for_exit(&mut child);
		let state = std::fs::read_to_string(format!("/proc/{descendant_pid}/stat")).ok();
		assert!(state.is_none_or(|stat| stat.split_whitespace().nth(2) == Some("Z")));
	}
}
