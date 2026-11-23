//! Background priority for native tool-work children, never the omp process.

use std::{ffi::OsStr, process::Command};

/// Construct a tool-work command with Linux nice 19 and best-effort I/O level
/// 7. Other platforms retain their existing scheduling policy.
///
/// Only use this for children: `Command::exec` runs pre-exec hooks in the
/// caller.
pub fn background_command(program: impl AsRef<OsStr>) -> Command {
	let mut command = Command::new(program);
	background_child(&mut command);
	command
}

/// Apply background priority immediately before a child executes its program.
pub fn background_child(command: &mut Command) {
	#[cfg(target_os = "linux")]
	{
		use std::os::unix::process::CommandExt;

		// SAFETY: pre_exec runs after fork in a potentially multithreaded
		// process. It must only perform async-signal-safe operations: these
		// direct syscalls and last_os_error do not allocate, lock, log, or
		// touch shared state.
		unsafe {
			command.pre_exec(|| apply_priorities(real_ioprio_set));
		}
	}
	#[cfg(not(target_os = "linux"))]
	let _ = command;
}

/// Raw `ioprio_set(IOPRIO_WHO_PROCESS, self, BE class, level 7)`.
#[cfg(target_os = "linux")]
fn real_ioprio_set() -> libc::c_long {
	// IOPRIO_WHO_PROCESS=1, pid=0 (self), class BE=2 in bits 13..15.
	// SAFETY: a plain syscall with integer arguments; async-signal-safe.
	unsafe { libc::syscall(libc::SYS_ioprio_set, 1, 0, (2 << 13) | 7) }
}

/// Runs in the child between fork and exec. Nice is required; I/O priority is
/// advisory, so a sandbox that denies `ioprio_set` must not stop the child
/// starting. `ioprio_set` is a parameter so a test can simulate the denial.
#[cfg(target_os = "linux")]
fn apply_priorities(ioprio_set: fn() -> libc::c_long) -> std::io::Result<()> {
	// SAFETY: direct async-signal-safe syscall.
	if unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, 19) } != 0 {
		return Err(std::io::Error::last_os_error());
	}
	let _ = ioprio_set();
	Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use super::*;

	#[test]
	fn denied_ioprio_set_does_not_fail_child_setup() {
		// Run in a forked-off child process so nice 19 never touches the test
		// runner.
		let mut command = std::process::Command::new("/bin/sh");
		command.args(["-c", "exit 0"]);
		unsafe {
			use std::os::unix::process::CommandExt;
			command.pre_exec(|| apply_priorities(|| -1));
		}
		assert!(
			command
				.status()
				.expect("child must start despite denied ioprio_set")
				.success()
		);
	}
}
