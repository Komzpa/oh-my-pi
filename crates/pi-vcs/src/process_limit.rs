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

/// Resolve a service-manager helper (`systemd-run`, `systemctl`, `env`,
/// `true`) against the host `PATH` once, so wrapped commands keep working
/// when the child clears or overrides `PATH`, and on layouts without
/// `/usr/bin` (e.g. NixOS). Falls back to the bare name when absent; without
/// a manager, enforcement fails closed later anyway.
#[cfg(target_os = "linux")]
fn resolved_binary(name: &str) -> OsString {
	if name.contains('/') {
		return OsString::from(name);
	}
	for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
		let candidate = dir.join(name);
		if candidate.is_file() {
			return candidate.into_os_string();
		}
	}
	OsString::from(name)
}

#[cfg(target_os = "linux")]
fn systemd_run_bin() -> &'static OsString {
	static BIN: std::sync::LazyLock<OsString> =
		std::sync::LazyLock::new(|| resolved_binary("systemd-run"));
	&BIN
}

#[cfg(target_os = "linux")]
fn systemctl_bin() -> &'static OsString {
	static BIN: std::sync::LazyLock<OsString> =
		std::sync::LazyLock::new(|| resolved_binary("systemctl"));
	&BIN
}

#[cfg(target_os = "linux")]
fn env_bin() -> &'static OsString {
	static BIN: std::sync::LazyLock<OsString> = std::sync::LazyLock::new(|| resolved_binary("env"));
	&BIN
}

#[cfg(target_os = "linux")]
fn true_bin() -> &'static OsString {
	static BIN: std::sync::LazyLock<OsString> = std::sync::LazyLock::new(|| resolved_binary("true"));
	&BIN
}

/// Lower only the scoped child, before it can run user code. Scope units do
/// not apply service execution properties such as `Nice=`; cgroup weights
/// also do not set per-process CPU/IO priorities. Resolve helpers against
/// the host PATH, not the command's possibly cleared environment.
#[cfg(target_os = "linux")]
fn background_priority_prefix() -> &'static [OsString; 5] {
	static PREFIX: std::sync::LazyLock<[OsString; 5]> = std::sync::LazyLock::new(|| {
		[
			resolved_binary("nice"),
			OsString::from("-n19"),
			resolved_binary("ionice"),
			OsString::from("-c2"),
			OsString::from("-n7"),
		]
	});
	&PREFIX
}

/// Parsed `systemctl --version` (`systemd 252 (...)` → `252`), probed once.
/// Unknown (no manager, unparsable output) means "assume old": the
/// `--expand-environment` flag is omitted and `$` is escaped instead.
#[cfg(target_os = "linux")]
fn systemd_version() -> Option<u32> {
	static VERSION: std::sync::LazyLock<Option<u32>> = std::sync::LazyLock::new(|| {
		let output = Command::new(systemctl_bin())
			.arg("--version")
			.output()
			.ok()?;
		if !output.status.success() {
			return None;
		}
		let mut parts = String::from_utf8_lossy(&output.stdout)
			.split_whitespace()
			.map(str::to_owned)
			.collect::<Vec<_>>()
			.into_iter();
		if parts.next().as_deref() != Some("systemd") {
			return None;
		}
		parts.next()?.parse().ok()
	});
	*VERSION
}

/// `--expand-environment=no` needs systemd 254+. Older managers reject it,
/// so it is passed only when the probed version supports it; otherwise
/// command arguments are escaped (see [`escape_manager_expansion`]).
#[cfg(target_os = "linux")]
fn expand_environment_flag() -> Option<&'static str> {
	match systemd_version() {
		Some(version) if version >= 254 => Some("--expand-environment=no"),
		_ => None,
	}
}

/// Escape `$` as `$$` (the manager's literal-`$` escape) for command
/// arguments when [`expand_environment_flag`] is unavailable, so user
/// commands containing `$` are passed through instead of expanded.
#[cfg(target_os = "linux")]
fn escape_manager_expansion(arg: &OsString) -> OsString {
	use std::os::unix::ffi::OsStringExt;
	let bytes = arg.as_encoded_bytes();
	if !bytes.contains(&b'$') {
		return arg.clone();
	}
	let mut out = Vec::with_capacity(bytes.len() + 2);
	for byte in bytes {
		if *byte == b'$' {
			out.extend_from_slice(b"$$");
		} else {
			out.push(*byte);
		}
	}
	OsString::from_vec(out)
}

/// Shared `systemd-run` prefix for real wraps and the enforcement probe, so
/// a passing probe proves the real launch path works: same binary, same
/// scope flags, same environment-expansion handling.
#[cfg(target_os = "linux")]
fn scope_prefix(slice: &str, unit: &str, wait_service: bool, stop_timeout: bool) -> Vec<OsString> {
	let mut args = vec![systemd_run_bin().clone(), OsString::from("--user")];
	if wait_service {
		// The probe is a transient *service*: `--wait` reports synchronously
		// whether a process could start inside the slice. Real commands run
		// as scopes, which preserve descriptors, rlimits and environment.
		args.extend([OsString::from("--pipe"), OsString::from("--wait")]);
	} else {
		args.push(OsString::from("--scope"));
	}
	args.extend([OsString::from("--collect"), OsString::from("--quiet")]);
	if let Some(flag) = expand_environment_flag() {
		args.push(OsString::from(flag));
	}
	args.extend([
		OsString::from("--slice"),
		OsString::from(slice),
		OsString::from("--unit"),
		OsString::from(unit),
	]);
	if stop_timeout {
		args.push(OsString::from("--property=TimeoutStopSec=2s"));
	}
	args.push(OsString::from("--"));
	args
}

/// `env` launcher with an `argv[0]` override, skipping `--argv0` (coreutils
/// 9.5+) when the override equals the executable. `$`-escaping is left to
/// the caller: [`ToolProcessLimit::wrap_scope_command`] escapes the whole
/// wrapped command once, so escaping here as well would double-escape.
#[cfg(target_os = "linux")]
fn env_exec(executable: &OsStr, argv0: &OsStr, extra: &[OsString]) -> Vec<OsString> {
	let mut command = vec![env_bin().clone()];
	if argv0 != executable {
		let mut argv0_arg = OsString::from("--argv0=");
		argv0_arg.push(argv0);
		command.push(argv0_arg);
	}
	command.push(executable.to_os_string());
	command.extend_from_slice(extra);
	command
}

/// Shared process limit for short-lived host invocations.
///
/// Creating, verifying and stopping a fresh slice per call costs four or more
/// manager round-trips each; the shared slice is verified once and lives
/// until process exit.
pub fn shared() -> std::sync::Arc<ToolProcessLimit> {
	static SHARED: std::sync::LazyLock<std::sync::Arc<ToolProcessLimit>> =
		std::sync::LazyLock::new(|| std::sync::Arc::new(ToolProcessLimit::default()));
	SHARED.clone()
}

#[derive(Debug)]
struct LimitState {
	initialized:     bool,
	created:         bool,
	next_command_id: u64,
}

#[derive(Debug)]
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
			let mut wrapped = scope_prefix(
				&self.slice,
				&format!("omp-tool-call-{}-{command_id}.scope", self.slice.trim_end_matches(".slice")),
				false,
				true,
			);
			wrapped.extend(
				background_priority_prefix()
					.iter()
					.chain(command)
					.map(|arg| {
						if expand_environment_flag().is_none() {
							escape_manager_expansion(arg)
						} else {
							arg.clone()
						}
					}),
			);
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
			let result = Command::new(systemctl_bin())
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
			let mut probe =
				scope_prefix(&self.slice, &probe_unit.replace(".scope", ".service"), true, false);
			let prefix_len = probe.len();
			probe.extend(env_exec(true_bin(), OsStr::new("omp-process-limit-probe"), &[]));
			if expand_environment_flag().is_none() {
				for arg in probe.iter_mut().skip(prefix_len) {
					*arg = escape_manager_expansion(arg);
				}
			}
			let result = Command::new(&probe[0]).args(&probe[1..]).output()?;
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
			let command = env_exec(executable, argv0, args);
			let mut wrapped = self.wrap_scope_command(&command)?;
			let runner = wrapped.remove(0);
			Ok(Some((runner, wrapped)))
		}
	}
}

impl Drop for ToolProcessLimit {
	fn drop(&mut self) {
		let created = self.state.get_mut().is_ok_and(|state| state.created);
		if !created {
			return;
		}
		#[cfg(target_os = "linux")]
		{
			let slice = self.slice.clone();
			let systemctl = systemctl_bin().clone();
			// Never block the dropping thread: this runs on the JS event loop
			// (`ToolResourceScope::close`), async workers, and scope guards.
			// Teardown is best-effort; `TimeoutStopSec` bounds it server-side.
			let _ = std::thread::spawn(move || {
				let _ = Command::new(systemctl)
					.args(["--user", "stop", &slice])
					.status();
			});
		}
	}
}

fn systemd_property(unit: &str, property: &str) -> io::Result<String> {
	#[cfg(target_os = "linux")]
	let manager = systemctl_bin().clone();
	#[cfg(not(target_os = "linux"))]
	let manager = OsString::from("systemctl");
	let result = Command::new(manager)
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
