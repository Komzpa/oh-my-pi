//! Embedded Linux argv[0] launcher. Never interpret the payload environment.
use std::{env, os::unix::process::CommandExt, process::Command};

fn main() {
	let mut args = env::args_os().skip(1);
	let (Some(argv0), Some(executable)) = (args.next(), args.next()) else {
		eprintln!("omp-argv0: expected argv0 and executable");
		std::process::exit(2);
	};
	let error = Command::new(executable).arg0(argv0).args(args).exec();
	eprintln!("omp-argv0: {error}");
	std::process::exit(if error.kind() == std::io::ErrorKind::NotFound { 127 } else { 126 });
}
