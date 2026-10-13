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

		// SAFETY: pre_exec runs after fork in a potentially multithreaded process.
		// It must only perform async-signal-safe operations: these direct syscalls
		// and last_os_error do not allocate, lock, log, or touch shared state.
		unsafe {
			command.pre_exec(|| {
				if libc::setpriority(libc::PRIO_PROCESS, 0, 19) != 0 {
					return Err(std::io::Error::last_os_error());
				}
				// IOPRIO_WHO_PROCESS=1, pid=0 (self), class BE=2 in bits 13..15.
				if libc::syscall(libc::SYS_ioprio_set, 1, 0, (2 << 13) | 7) != 0 {
					return Err(std::io::Error::last_os_error());
				}
				Ok(())
			});
		}
	}
	#[cfg(not(target_os = "linux"))]
	let _ = command;
}
