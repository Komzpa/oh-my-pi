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

/// Stable parent for a session's tool processes, including across exec.
pub fn session_slice_name(session_id: &str) -> io::Result<String> {
	if session_id.is_empty() {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "session id must not be empty"));
	}
	let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha256);
	hasher.update(session_id.as_bytes());
	let digest = hasher.try_finalize().map_err(io::Error::other)?;
	Ok(format!("omp-tool-{}.slice", digest.to_hex_with_len(12)))
}

fn call_slice_name(base: &str, session_id: Option<&OsStr>) -> io::Result<String> {
	let Some(session_id) = session_id else {
		return Ok(base.to_owned());
	};
	let session_id = session_id
		.to_str()
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "non-UTF-8 session id"))?;
	let parent = session_slice_name(session_id)?;
	Ok(format!("{}-{}", parent.trim_end_matches(".slice"), base.trim_start_matches("omp-tool-")))
}

/// Manager bindings and process ownership from the payload's effective
/// environment.
///
/// `None` is absent; `Some("")` is present with an empty value. Manager access
/// uses separate bindings and must never become the payload's environment.
#[derive(Clone, Debug, Default)]
pub struct ScopeEnvironment {
	pub bus_address: Option<OsString>,
	pub runtime_dir: Option<OsString>,
	pub session_id:  Option<OsString>,
}

impl ScopeEnvironment {
	pub fn from_lookup(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Self {
		Self {
			bus_address: lookup("DBUS_SESSION_BUS_ADDRESS"),
			runtime_dir: lookup("XDG_RUNTIME_DIR"),
			session_id:  lookup("OMP_SESSION_ID"),
		}
	}

	/// Only for launches that inherit these bindings without overrides.
	pub fn inherited() -> Self {
		Self::from_lookup(|name| std::env::var_os(name))
	}
}

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

/// The desktop mask may replace `XDG_RUNTIME_DIR` with a private worker
/// directory. Only the launcher uses the real manager environment, derived from
/// the uid.
#[cfg(target_os = "linux")]
fn systemd_user_manager_env(bus_address: Option<OsString>, uid: u32) -> (OsString, OsString) {
	let runtime_dir = OsString::from(format!("/run/user/{uid}"));
	let trusted_prefix = format!("unix:path=/run/user/{uid}/");
	let bus_address = bus_address
		.filter(|address| {
			address.to_str().is_some_and(|address| {
				address
					.split(';')
					.all(|address| address.starts_with(&trusted_prefix))
			})
		})
		.unwrap_or_else(|| OsString::from(format!("unix:path=/run/user/{uid}/bus")));
	(runtime_dir, bus_address)
}

#[cfg(target_os = "linux")]
fn systemd_user_manager_command(program: &OsStr) -> Command {
	// SAFETY: geteuid has no preconditions and does not access pointers.
	let uid = unsafe { libc::geteuid() };
	let (runtime_dir, bus_address) =
		systemd_user_manager_env(std::env::var_os("DBUS_SESSION_BUS_ADDRESS"), uid);
	let mut command = Command::new(program);
	command
		.env("XDG_RUNTIME_DIR", runtime_dir)
		.env("DBUS_SESSION_BUS_ADDRESS", bus_address);
	command
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
		let output = systemd_user_manager_command(systemctl_bin())
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

/// One launcher for real scopes and the enforcement probe. Manager credentials
/// precede systemd-run; the inner env restores the payload's own bindings.
#[cfg(target_os = "linux")]
fn build_scope_argv(
	slice: &str,
	unit: &str,
	wait_service: bool,
	stop_timeout: bool,
	command: &[OsString],
	payload_env: &ScopeEnvironment,
) -> Vec<OsString> {
	// SAFETY: geteuid has no preconditions and does not access pointers.
	let uid = unsafe { libc::geteuid() };
	let (runtime_dir, bus_address) =
		systemd_user_manager_env(std::env::var_os("DBUS_SESSION_BUS_ADDRESS"), uid);
	let mut runtime = OsString::from("XDG_RUNTIME_DIR=");
	runtime.push(runtime_dir);
	let mut bus = OsString::from("DBUS_SESSION_BUS_ADDRESS=");
	bus.push(bus_address);
	let mut args =
		vec![env_bin().clone(), runtime, bus, systemd_run_bin().clone(), OsString::from("--user")];
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
	args.extend([
		env_bin().clone(),
		OsString::from("-u"),
		OsString::from("DBUS_SESSION_BUS_ADDRESS"),
		OsString::from("-u"),
		OsString::from("XDG_RUNTIME_DIR"),
	]);
	for (name, value) in [
		("DBUS_SESSION_BUS_ADDRESS=", &payload_env.bus_address),
		("XDG_RUNTIME_DIR=", &payload_env.runtime_dir),
	] {
		if let Some(value) = value {
			let mut assignment = OsString::from(name);
			assignment.push(value);
			args.push(assignment);
		}
	}
	let priority = if wait_service {
		&[][..]
	} else {
		&background_priority_prefix()[..]
	};
	args.extend(priority.iter().chain(command).map(|arg| {
		if expand_environment_flag().is_none() {
			escape_manager_expansion(arg)
		} else {
			arg.clone()
		}
	}));
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
	slice:           String,
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
	pub fn wrap_scope_command(
		&self,
		command: &[OsString],
		payload_env: &ScopeEnvironment,
	) -> io::Result<Vec<OsString>> {
		if command.is_empty() {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "empty scoped command"));
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = payload_env;
			return Ok(command.to_vec());
		}
		#[cfg(target_os = "linux")]
		{
			let mut state = self
				.state
				.lock()
				.map_err(|_| io::Error::other("process limit state poisoned"))?;
			if !state.initialized {
				state.slice = call_slice_name(&self.slice, payload_env.session_id.as_deref())?;
			}
			self.ensure_enforced(&mut state)?;
			let command_id = state.next_command_id;
			state.next_command_id += 1;
			Ok(build_scope_argv(
				&state.slice,
				&format!("omp-tool-call-{}-{command_id}.scope", state.slice.trim_end_matches(".slice")),
				false,
				true,
				command,
				payload_env,
			))
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
				slice:           format!("omp-tool-call-{}-{id}.slice", std::process::id()),
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
			#[cfg(not(test))]
			sweep_once_in_background();
			state.created = true;
			let result = systemd_user_manager_command(systemctl_bin())
				.args(["--user", "set-property", "--runtime", &state.slice])
				.arg(format!("TasksMax={}", self.limit))
				.output()?;
			if !result.status.success() {
				return Err(io::Error::other(format!(
					"systemd could not create the per-tool process limit: {}",
					String::from_utf8_lossy(&result.stderr).trim()
				)));
			}
			let probe_unit =
				format!("omp-tool-call-probe-{}.scope", state.slice.trim_end_matches(".slice"));
			let probe = build_scope_argv(
				&state.slice,
				&probe_unit.replace(".scope", ".service"),
				true,
				false,
				&env_exec(true_bin(), OsStr::new("omp-process-limit-probe"), &[]),
				&ScopeEnvironment::default(),
			);
			let result = Command::new(&probe[0]).args(&probe[1..]).output()?;
			if !result.status.success() {
				return Err(io::Error::other(format!(
					"systemd could not start a process inside the per-tool limit: {}",
					String::from_utf8_lossy(&result.stderr).trim()
				)));
			}

			let cgroup = systemd_property(&state.slice, "ControlGroup")?;
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
			let cgroup = systemd_property(&state.slice, "ControlGroup")?;
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
			let cgroup = systemd_property(&state.slice, "ControlGroup")?;
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
		env: &[(OsString, OsString)],
	) -> io::Result<Option<(OsString, Vec<OsString>)>> {
		#[cfg(not(target_os = "linux"))]
		{
			let _ = env;
			return Ok(None);
		}
		#[cfg(target_os = "linux")]
		{
			let command = env_exec(executable, argv0, args);
			let payload_env = ScopeEnvironment::from_lookup(|name| {
				env.iter()
					.find(|(key, _)| key.as_os_str() == OsStr::new(name))
					.map(|(_, value)| value.clone())
			});
			let mut wrapped = self.wrap_scope_command(&command, &payload_env)?;
			let runner = wrapped.remove(0);
			Ok(Some((runner, wrapped)))
		}
	}
}

impl Drop for ToolProcessLimit {
	fn drop(&mut self) {
		let state = self.state.get_mut();
		let created = state.as_ref().is_ok_and(|state| state.created);
		if !created {
			return;
		}
		#[cfg(target_os = "linux")]
		{
			let slice = state.expect("created state").slice.clone();
			let systemctl = systemctl_bin().clone();
			// Never block the dropping thread: this runs on the JS event loop
			// (`ToolResourceScope::close`), async workers, and scope guards.
			// Teardown is best-effort; `TimeoutStopSec` bounds it server-side.
			let _ = std::thread::spawn(move || {
				let _ = systemd_user_manager_command(&systemctl)
					.args(["--user", "stop", &slice])
					.status();
				// `set-property --runtime` writes `<slice>.d/` under the manager's runtime
				// directory, and `stop` does not remove it. Revert after stop so the
				// drop-in does not outlive the call.
				let _ = systemd_user_manager_command(&systemctl)
					.args(["--user", "revert", &slice])
					.output();
			});
		}
	}
}

fn systemd_property(unit: &str, property: &str) -> io::Result<String> {
	#[cfg(target_os = "linux")]
	let manager = systemctl_bin().clone();
	#[cfg(not(target_os = "linux"))]
	let manager = OsString::from("systemctl");
	#[cfg(target_os = "linux")]
	let mut command = systemd_user_manager_command(&manager);
	#[cfg(not(target_os = "linux"))]
	let mut command = Command::new(manager);
	let result = command
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

/// Sweep runs once per process, on a detached thread, before the first slice is
/// enforced. Failures are reported and never block a tool call.
#[cfg(all(target_os = "linux", not(test)))]
static SWEEP_ONCE: std::sync::Once = std::sync::Once::new();

/// Batch size for `systemctl revert`: one manager call per chunk, never per
/// unit.
#[cfg(target_os = "linux")]
const REVERT_BATCH: usize = 200;

#[cfg(all(target_os = "linux", not(test)))]
fn sweep_once_in_background() {
	SWEEP_ONCE.call_once(|| {
		let spawned = std::thread::Builder::new()
			.name("omp-tool-dropin-sweep".into())
			.spawn(|| {
				if let Err(error) = sweep_stale_call_dropins() {
					eprintln!("omp: stale tool slice drop-in sweep failed: {error}");
				}
			});
		if let Err(error) = spawned {
			eprintln!("omp: could not start stale tool slice drop-in sweep: {error}");
		}
	});
}

/// Owner pid of a per-call tool slice: `omp-tool-call-<pid>-<id>.slice`, or
/// `omp-tool-<session hash>-call-<pid>-<id>.slice` when session-parented.
#[cfg(target_os = "linux")]
fn call_slice_owner_pid(unit: &str) -> Option<u32> {
	fn all_digits(text: &str) -> bool {
		!text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
	}
	let stem = unit.strip_prefix("omp-tool-")?.strip_suffix(".slice")?;
	let call = if let Some(call) = stem.strip_prefix("call-") {
		call
	} else {
		let (hash, call) = stem.split_once('-')?;
		if hash.len() != 12 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
			return None;
		}
		call.strip_prefix("call-")?
	};
	let (pid, id) = call.split_once('-')?;
	if !all_digits(pid) || !all_digits(id) {
		return None;
	}
	pid.parse().ok()
}

/// Whether a pid has a visible `/proc/<pid>` entry. Anything uncertain counts
/// as alive, so the sweep keeps a drop-in rather than removing it wrongly.
#[cfg(target_os = "linux")]
fn process_alive(pid: u32) -> bool {
	if pid == 0 {
		return true;
	}
	match std::fs::metadata(std::path::Path::new("/proc").join(pid.to_string())) {
		Ok(_) => true,
		Err(error) if error.kind() == io::ErrorKind::NotFound => false,
		Err(_) => true,
	}
}

/// Unit names whose drop-in may be reverted: the owner process is gone and the
/// unit is not active. Any other name is never returned.
#[cfg(target_os = "linux")]
fn stale_call_slice_units<'a>(
	units: impl IntoIterator<Item = &'a str>,
	is_alive: impl Fn(u32) -> bool,
	is_active: impl Fn(&str) -> bool,
) -> Vec<&'a str> {
	units
		.into_iter()
		.filter(|unit| {
			call_slice_owner_pid(unit).is_some_and(|pid| {
				// An alive owner may be between set-property and scope start; unit
				// inactivity does not make its in-flight drop-in stale.
				!is_alive(pid) && !is_active(unit)
			})
		})
		.collect()
}

/// Active slice units. A failed query is an error, so the sweep keeps every
/// drop-in rather than guessing.
#[cfg(target_os = "linux")]
fn active_slice_units() -> io::Result<std::collections::HashSet<String>> {
	let output = systemd_user_manager_command(systemctl_bin())
		.args(["--user", "list-units", "--type=slice", "--state=active", "--no-legend", "--plain"])
		.output()?;
	if !output.status.success() {
		return Err(io::Error::other(format!(
			"systemd could not list active slices: {}",
			String::from_utf8_lossy(&output.stderr).trim()
		)));
	}
	Ok(String::from_utf8_lossy(&output.stdout)
		.lines()
		.filter_map(|line| line.split_whitespace().next())
		.map(str::to_owned)
		.collect())
}

/// Reverts drop-ins of tool-call slices whose owner process is gone and whose
/// unit is inactive. Called once per process from [`sweep_once_in_background`].
#[cfg(all(target_os = "linux", not(test)))]
fn sweep_stale_call_dropins() -> io::Result<()> {
	// SAFETY: geteuid has no preconditions and does not access pointers.
	let uid = unsafe { libc::geteuid() };
	let (runtime_dir, _) = systemd_user_manager_env(None, uid);
	sweep_stale_call_dropins_in(&std::path::Path::new(&runtime_dir).join("systemd/user.control"))
}

/// Sweep over an explicit `user.control` directory; tests pass a temp
/// directory.
#[cfg(target_os = "linux")]
#[allow(
	clippy::case_sensitive_file_extension_comparisons,
	reason = "systemd unit type suffixes are lowercase by definition"
)]
fn sweep_stale_call_dropins_in(control: &std::path::Path) -> io::Result<()> {
	let entries = match std::fs::read_dir(control) {
		Ok(entries) => entries,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(error),
	};
	let mut dropins = Vec::new();
	for entry in entries {
		let name = entry?.file_name();
		let Some(unit) = name.to_str().and_then(|name| name.strip_suffix(".d")) else {
			continue;
		};
		if unit.starts_with("omp-tool-") && unit.ends_with(".slice") {
			dropins.push(unit.to_owned());
		}
	}
	if dropins.is_empty() {
		return Ok(());
	}
	let active = active_slice_units()?;
	let stale = stale_call_slice_units(dropins.iter().map(String::as_str), process_alive, |unit| {
		active.contains(unit)
	});
	for chunk in stale.chunks(REVERT_BATCH) {
		let result = systemd_user_manager_command(systemctl_bin())
			.args(["--user", "revert"])
			.args(chunk)
			.output()?;
		if !result.status.success() {
			eprintln!(
				"omp: could not revert {} stale tool slice drop-ins: {}",
				chunk.len(),
				String::from_utf8_lossy(&result.stderr).trim()
			);
		}
	}
	Ok(())
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

	#[test]
	fn session_slice_naming_and_call_parenting() {
		assert_eq!(
			super::session_slice_name("0123abcd-rest").unwrap(),
			"omp-tool-edce6fe48f3f.slice"
		);
		assert_eq!(
			super::call_slice_name("omp-tool-call-42-1.slice", Some("0123abcd-rest".as_ref()))
				.unwrap(),
			"omp-tool-edce6fe48f3f-call-42-1.slice"
		);
		assert_eq!(
			super::call_slice_name("omp-tool-call-42-1.slice", None).unwrap(),
			"omp-tool-call-42-1.slice"
		);
		assert!(super::session_slice_name("").is_err());
	}

	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "requires a reachable systemd user manager; run explicitly on a live host"]
	fn session_call_uses_parent_slice() {
		let session_id = format!("{:08x}-qa-slice", std::process::id());
		let parent = super::session_slice_name(&session_id).unwrap();
		let limit = ToolProcessLimit::new(32);
		let env = super::ScopeEnvironment {
			session_id: Some(session_id.into()),
			..super::ScopeEnvironment::inherited()
		};
		let argv = limit
			.wrap_scope_command(&[super::true_bin().clone()], &env)
			.unwrap();
		let slice_arg = argv.iter().position(|arg| arg == "--slice").unwrap();
		let slice = argv[slice_arg + 1].to_str().unwrap();
		assert!(
			slice.starts_with(parent.trim_end_matches(".slice")),
			"{slice} is not under {parent}"
		);
		let cgroup = super::systemd_property(slice, "ControlGroup").unwrap();
		assert!(cgroup.contains(&format!("/{parent}/")), "{cgroup}");
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn systemd_user_manager_env_derives_run_user_without_bus() {
		let (runtime, bus) = super::systemd_user_manager_env(None, 1000);
		assert_eq!(runtime, "/run/user/1000");
		assert_eq!(bus, "unix:path=/run/user/1000/bus");
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn systemd_user_manager_env_keeps_only_bus_under_run_user() {
		let trusted = "unix:path=/run/user/1000/custom-bus,guid=1234";
		let (runtime, bus) = super::systemd_user_manager_env(Some(trusted.into()), 1000);
		assert_eq!(runtime, "/run/user/1000");
		assert_eq!(bus, trusted);
		for masked in
			["", "unix:path=/tmp/omp-worker-runtime-x-1000/bus", "unix:path=/run/user/10000/bus"]
		{
			let (runtime, bus) = super::systemd_user_manager_env(Some(masked.into()), 1000);
			assert_eq!(runtime, "/run/user/1000");
			assert_eq!(bus, "unix:path=/run/user/1000/bus");
		}
	}

	/// Manager access must not replace the environment observed by user code.
	/// Re-exec keeps PATH and the helper LazyLocks isolated from other tests.
	#[cfg(target_os = "linux")]
	#[test]
	fn scoped_payload_preserves_effective_session_environment() {
		use std::os::unix::fs::{PermissionsExt, symlink};

		const CASE_ENV: &str = "OMP_SCOPE_ENV_TEST_CASE";
		const KEYS: [&str; 2] = ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"];
		const CASES: [(&str, [Option<&str>; 2]); 4] = [
			("unset", [None, None]),
			("present-empty", [Some(""), Some("")]),
			("custom", [Some("unix:path=/tmp/custom bus,$token"), Some("/tmp/custom runtime=$value")]),
			("masked-private", [None, Some("/tmp/omp-worker-runtime-test")]),
		];
		if let Ok(case) = std::env::var(CASE_ENV) {
			let (_, values) = CASES
				.iter()
				.find(|(name, _)| *name == case)
				.expect("known case");
			let payload = [super::env_bin().clone(), "-0".into()];
			let payload_env = super::ScopeEnvironment {
				bus_address: values[0].map(Into::into),
				runtime_dir: values[1].map(Into::into),
				session_id:  None,
			};
			let argv = super::build_scope_argv(
				"test.slice",
				"test.scope",
				false,
				true,
				&payload,
				&payload_env,
			);
			let mut command = Command::new(&argv[0]);
			command
				.args(&argv[1..])
				.env_clear()
				.env("PATH", std::env::var_os("PATH").unwrap());
			for (key, value) in KEYS.iter().zip(values) {
				if let Some(value) = value {
					command.env(key, value);
				}
			}
			let output = command.output().expect("run synthetic scope launcher");
			assert!(
				output.status.success(),
				"{case}: {:?}: {}",
				output.status,
				String::from_utf8_lossy(&output.stderr)
			);
			for (key, value) in KEYS.iter().zip(values) {
				let prefix = format!("{key}=");
				let actual = output
					.stdout
					.split(|byte| *byte == 0)
					.find_map(|entry| entry.strip_prefix(prefix.as_bytes()));
				assert_eq!(actual, value.map(str::as_bytes), "{case}: payload changed {key}");
			}
			std::fs::write(std::env::var_os("OMP_SCOPE_TEST_RESULT").unwrap(), case).unwrap();
			return;
		}

		let fixtures = tempfile::tempdir().expect("private launcher fixtures");
		let shell = super::resolved_binary("sh");
		assert!(std::path::Path::new(&shell).is_absolute(), "sh must be available");
		symlink(super::resolved_binary("env"), fixtures.path().join("env")).unwrap();
		// SAFETY: geteuid has no preconditions and does not access pointers.
		let uid = unsafe { libc::geteuid() };
		let manager_bus = format!("unix:path=/run/user/{uid}/manager-test-bus");
		let manager = format!(
			r#"[ "$XDG_RUNTIME_DIR" = '/run/user/{uid}' ] || exit 91
[ "$DBUS_SESSION_BUS_ADDRESS" = '{manager_bus}' ] || exit 92
while [ "$#" -gt 0 ] && [ "$1" != '--' ]; do shift; done
[ "$#" -gt 0 ] || exit 93
shift
exec "$@"
"#
		);
		for (name, body) in [
			(
				"systemctl",
				"[ \"$#\" -eq 1 ] && [ \"$1\" = '--version' ] || exit 94\nprintf 'systemd %s\\n' \
				 \"$OMP_SCOPE_SYSTEMD_VERSION\"\n",
			),
			("systemd-run", manager.as_str()),
			("nice", "[ \"$1\" = '-n19' ] || exit 95\nshift\nexec \"$@\"\n"),
			("ionice", "[ \"$1\" = '-c2' ] && [ \"$2\" = '-n7' ] || exit 96\nshift 2\nexec \"$@\"\n"),
		] {
			let path = fixtures.path().join(name);
			std::fs::write(&path, format!("#!{}\n{body}", shell.to_string_lossy())).unwrap();
			std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
		}
		let mut failed = Vec::new();
		for version in ["253", "254"] {
			for (case, _) in CASES {
				let result_path = fixtures.path().join(format!("result-{version}-{case}"));
				let output = Command::new(std::env::current_exe().unwrap())
					.args([
						"--exact",
						"process_limit::tests::scoped_payload_preserves_effective_session_environment",
						"--nocapture",
					])
					.env_clear()
					.env("PATH", fixtures.path())
					.env(CASE_ENV, case)
					.env("OMP_SCOPE_TEST_RESULT", &result_path)
					.env("OMP_SCOPE_SYSTEMD_VERSION", version)
					.env("DBUS_SESSION_BUS_ADDRESS", &manager_bus)
					.env("XDG_RUNTIME_DIR", "/host-runtime-must-not-reach-payload")
					.output()
					.expect("run isolated environment case");
				if !output.status.success()
					|| std::fs::read_to_string(&result_path).ok().as_deref() != Some(case)
				{
					failed.push(format!(
						"systemd {version}, {case}: {:?}\n{}\n{}",
						output.status,
						String::from_utf8_lossy(&output.stdout),
						String::from_utf8_lossy(&output.stderr)
					));
				}
			}
		}
		assert!(failed.is_empty(), "{}", failed.join("\n"));
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn scope_argv_keeps_intentionally_unset_session_bindings_absent() {
		let argv = super::build_scope_argv(
			"test.slice",
			"test.scope",
			false,
			true,
			&[super::true_bin().clone()],
			&super::ScopeEnvironment::default(),
		);
		assert_eq!(&argv[0], super::env_bin());
		// SAFETY: geteuid has no preconditions and does not access pointers.
		let uid = unsafe { libc::geteuid() };
		assert_eq!(argv[1], std::ffi::OsString::from(format!("XDG_RUNTIME_DIR=/run/user/{uid}")));
		assert!(
			argv[2]
				.to_string_lossy()
				.starts_with("DBUS_SESSION_BUS_ADDRESS=unix:path=")
		);
		assert_eq!(&argv[3], super::systemd_run_bin());
		assert_eq!(argv[4], "--user");
		let separator = argv
			.iter()
			.position(|arg| arg == "--")
			.expect("scope separator");
		let payload = &argv[separator + 1..];
		assert_eq!(&payload[0], super::env_bin());
		assert_eq!(&payload[1..5], ["-u", "DBUS_SESSION_BUS_ADDRESS", "-u", "XDG_RUNTIME_DIR"]);
		assert_eq!(&payload[5..10], super::background_priority_prefix());
		assert_eq!(payload.last(), Some(super::true_bin()));
	}

	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "requires a reachable systemd user manager; run explicitly on a live host"]
	fn masked_worker_reaches_manager_without_leaking_desktop_env() {
		// Probe availability only through systemd-run, never a separate bus client.
		let available = super::systemd_user_manager_command(super::systemd_run_bin())
			.args(["--user", "--scope", "--quiet", "--"])
			.arg(super::true_bin())
			.output();
		if !available.is_ok_and(|output| output.status.success()) {
			eprintln!("skipping live check: systemd user manager is unavailable");
			return;
		}
		let limit = ToolProcessLimit::new(32);
		for program in [super::true_bin(), super::env_bin()] {
			let argv = super::build_scope_argv(
				&limit.slice,
				&format!(
					"{}-{}.scope",
					limit.slice,
					if program == super::true_bin() {
						"true"
					} else {
						"env"
					}
				),
				false,
				true,
				std::slice::from_ref(program),
				&super::ScopeEnvironment {
					bus_address: Some("".into()),
					runtime_dir: Some("/tmp/x".into()),
					session_id:  None,
				},
			);
			let output = Command::new(&argv[0])
				.args(&argv[1..])
				.env_clear()
				.env("DBUS_SESSION_BUS_ADDRESS", "")
				.env("XDG_RUNTIME_DIR", "/tmp/x")
				.output()
				.expect("launch with a masked worker environment");
			assert!(
				output.status.success(),
				"masked launch failed: {}",
				String::from_utf8_lossy(&output.stderr)
			);
			if program == super::env_bin() {
				let payload_env = String::from_utf8_lossy(&output.stdout);
				assert!(
					payload_env
						.lines()
						.any(|line| line == "DBUS_SESSION_BUS_ADDRESS="),
					"{payload_env}"
				);
				assert!(
					payload_env
						.lines()
						.any(|line| line == "XDG_RUNTIME_DIR=/tmp/x"),
					"{payload_env}"
				);
				assert!(!payload_env.contains("/run/user/"), "{payload_env}");
			}
		}
	}

	fn wrapped_command(limit: &ToolProcessLimit, program: &str, args: &[&str]) -> Command {
		let (runner, wrapped_args) = limit
			.wrap_external_command(
				program.as_ref(),
				program.as_ref(),
				&args.iter().map(Into::into).collect::<Vec<_>>(),
				&std::env::vars_os().collect::<Vec<_>>(),
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

		// Explicit manager operations must opt back in; ordinary payloads stay masked.
		// SAFETY: geteuid has no preconditions and does not access pointers.
		let uid = unsafe { libc::geteuid() };
		let (runtime, bus) = super::systemd_user_manager_env(None, uid);
		let runtime = format!("XDG_RUNTIME_DIR={}", runtime.to_string_lossy());
		let bus = format!("DBUS_SESSION_BUS_ADDRESS={}", bus.to_string_lossy());
		let mut escape = wrapped_command(&process_limit, "/usr/bin/env", &[
			&runtime,
			&bus,
			"/usr/bin/systemd-run",
			"--user",
			"--wait",
			"--collect",
			"--quiet",
			"--",
			"/usr/bin/true",
		]);
		let escape_output = escape.output().expect("probe manager escape");
		assert!(
			escape_output.status.success(),
			"explicit managed-service operation failed: {}",
			String::from_utf8_lossy(&escape_output.stderr)
		);

		let mut systemctl = wrapped_command(&process_limit, "/usr/bin/env", &[
			&runtime,
			&bus,
			"/usr/bin/systemctl",
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
		// systemd-run can exit before the manager finishes killing every descendant.
		let deadline = Instant::now() + Duration::from_secs(3);
		loop {
			let state = std::fs::read_to_string(format!("/proc/{descendant_pid}/stat")).ok();
			if state.is_none_or(|stat| stat.split_whitespace().nth(2) == Some("Z")) {
				break;
			}
			assert!(Instant::now() < deadline, "escaped descendant did not stop with its cgroup");
			std::thread::sleep(Duration::from_millis(25));
		}
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn call_slice_owner_pid_parses_plain_and_session_names() {
		use super::call_slice_owner_pid;
		assert_eq!(call_slice_owner_pid("omp-tool-call-4242-7.slice"), Some(4242));
		assert_eq!(call_slice_owner_pid("omp-tool-0123456789ab-call-4242-7.slice"), Some(4242));
		assert_eq!(call_slice_owner_pid("omp-tool-0123456789ab.slice"), None);
		assert_eq!(call_slice_owner_pid("omp-tool-call-4242.slice"), None);
		assert_eq!(call_slice_owner_pid("omp-tool-call-+4242-7.slice"), None);
		assert_eq!(call_slice_owner_pid("omp-tool-short-call-4242-7.slice"), None);
		assert_eq!(call_slice_owner_pid("user@1000.service"), None);
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn stale_sweep_keeps_live_owner_and_active_unit() {
		use super::stale_call_slice_units;
		let own = format!("omp-tool-call-{}-1.slice", std::process::id());
		let dead = "omp-tool-call-4194303-1.slice";
		let active = "omp-tool-call-4194302-1.slice";
		let own_pid = std::process::id();
		// Live owner: kept.
		assert!(stale_call_slice_units([own.as_str()], |pid| pid == own_pid, |_| false).is_empty());
		// Dead owner, inactive unit: reverted.
		assert_eq!(stale_call_slice_units([dead], |_| false, |_| false), vec![dead]);
		// Dead owner but active unit: kept.
		assert!(stale_call_slice_units([active], |_| false, |unit| unit == active).is_empty());
		// Names that are not tool-call slices are never touched.
		assert!(stale_call_slice_units(["user@1000.service"], |_| false, |_| false).is_empty());
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn stale_sweep_keeps_live_owner_when_unit_is_inactive() {
		let own = format!("omp-tool-call-{}-1.slice", std::process::id());
		assert!(
			super::stale_call_slice_units([own.as_str()], super::process_alive, |_| false).is_empty()
		);
	}

	/// Slice name enforced by `limit`, read from its state.
	#[cfg(target_os = "linux")]
	fn enforced_slice(limit: &ToolProcessLimit) -> String {
		let _ = limit
			.wrap_scope_command(
				&[std::ffi::OsString::from("true")],
				&super::ScopeEnvironment::default(),
			)
			.expect("enforce per-tool limit");
		limit.state.lock().expect("state").slice.clone()
	}

	/// Runtime drop-in path that `set-property --runtime` writes for `slice`.
	#[cfg(target_os = "linux")]
	fn runtime_dropin(slice: &str) -> std::path::PathBuf {
		// SAFETY: geteuid has no preconditions and does not access pointers.
		let uid = unsafe { libc::geteuid() };
		let (runtime, _) = super::systemd_user_manager_env(None, uid);
		std::path::Path::new(&runtime)
			.join("systemd/user.control")
			.join(format!("{slice}.d"))
	}

	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "requires a reachable systemd user manager; run explicitly on a live host"]
	fn dropping_limit_removes_its_runtime_dropin() {
		let process_limit = ToolProcessLimit::new(32);
		let slice = enforced_slice(&process_limit);
		assert_eq!(super::systemd_property(&slice, "TasksMax").expect("readback"), "32");
		let dropin = runtime_dropin(&slice);
		assert!(dropin.exists(), "set-property --runtime should write {}", dropin.display());
		let show = super::systemd_user_manager_command(super::systemctl_bin())
			.args(["--user", "show", "-p", "TasksMax", &slice])
			.output()
			.expect("read TasksMax from systemd");
		assert!(show.status.success(), "systemctl show failed: {:?}", show.status);
		eprintln!(
			"systemctl --user show -p TasksMax {slice}: {}",
			String::from_utf8_lossy(&show.stdout).trim()
		);
		let control_group = super::systemd_user_manager_command(super::systemctl_bin())
			.args(["--user", "show", "--value", "-p", "ControlGroup", &slice])
			.output()
			.expect("read slice ControlGroup");
		assert!(control_group.status.success(), "systemctl ControlGroup failed");
		let pids_max = std::fs::read_to_string(
			std::path::Path::new("/sys/fs/cgroup")
				.join(
					String::from_utf8_lossy(&control_group.stdout)
						.trim()
						.trim_start_matches('/'),
				)
				.join("pids.max"),
		)
		.expect("read enforced slice pids.max");
		eprintln!("pids.max while enforced: {}", pids_max.trim());
		drop(process_limit);
		let deadline = Instant::now() + Duration::from_secs(10);
		while dropin.exists() {
			assert!(Instant::now() < deadline, "runtime drop-in survived drop: {}", dropin.display());
			std::thread::sleep(Duration::from_millis(25));
		}
	}

	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "requires a reachable systemd user manager; run explicitly on a live host"]
	fn sweep_keeps_runtime_dropin_of_live_owner() {
		// Temp directory only: never the host's user.control.
		let pid = std::process::id();
		let dir = std::env::temp_dir().join(format!("omp-dropin-neighbour-{pid}"));
		let own = dir.join(format!("omp-tool-call-{pid}-1.slice.d"));
		std::fs::create_dir_all(&own).expect("create neighbour drop-in");
		super::sweep_stale_call_dropins_in(&dir).expect("sweep temp dir");
		let kept = own.exists();
		let _ = std::fs::remove_dir_all(&dir);
		assert!(kept, "sweep removed a live owner's drop-in");
	}

	#[cfg(target_os = "linux")]
	#[test]
	#[ignore = "requires a reachable systemd user manager; run explicitly on a live host"]
	fn fifty_enforce_drop_cycles_leave_no_dropins_for_this_process() {
		let pid = std::process::id();
		let prefix = format!("omp-tool-call-{pid}-");
		let count = || {
			// SAFETY: geteuid has no preconditions and does not access pointers.
			let uid = unsafe { libc::geteuid() };
			let (runtime, _) = super::systemd_user_manager_env(None, uid);
			std::fs::read_dir(std::path::Path::new(&runtime).join("systemd/user.control"))
				.expect("read user.control")
				.filter_map(Result::ok)
				.filter(|entry| {
					entry
						.file_name()
						.to_str()
						.is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".slice.d"))
				})
				.count()
		};
		let before = count();
		for _ in 0..50 {
			let process_limit = ToolProcessLimit::new(32);
			let slice = enforced_slice(&process_limit);
			assert_eq!(super::systemd_property(&slice, "TasksMax").expect("readback"), "32");
			drop(process_limit);
		}
		let deadline = Instant::now() + Duration::from_secs(30);
		while count() > 0 && Instant::now() < deadline {
			std::thread::sleep(Duration::from_millis(100));
		}
		eprintln!("marker drop-ins before={before} after={}", count());
		assert_eq!(count(), 0, "leaked drop-ins for pid {pid}");
	}
}
