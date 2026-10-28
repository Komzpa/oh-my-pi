use std::{env, ffi::OsString, path::PathBuf, process::Command};

fn main() {
	println!("cargo:rerun-if-changed=src/argv0_launcher.rs");
	if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
		return;
	}
	let target = env::var("TARGET").expect("TARGET");
	let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("omp-argv0");
	let linker_key =
		format!("CARGO_TARGET_{}_LINKER", target.replace(['-', '.'], "_").to_ascii_uppercase());
	println!("cargo:rerun-if-env-changed={linker_key}");
	println!("cargo:rerun-if-env-changed=RUSTC_LINKER");
	println!("cargo:rerun-if-env-changed=CARGO_ENCODED_RUSTFLAGS");
	let mut command = Command::new(env::var_os("RUSTC").expect("RUSTC"));
	command
		.args(["--crate-name=omp_argv0", "--crate-type=bin", "--edition=2024", "--target"])
		.arg(&target)
		.args(["-Copt-level=z", "-Ccodegen-units=1", "-Cpanic=abort", "-Cstrip=symbols"])
		.arg("src/argv0_launcher.rs")
		.arg("-o")
		.arg(&output);
	if let Ok(flags) = env::var("CARGO_ENCODED_RUSTFLAGS") {
		command.args(flags.split('\u{1f}').filter(|flag| !flag.is_empty()));
	}
	if let Some(linker) = env::var_os(&linker_key).or_else(|| env::var_os("RUSTC_LINKER")) {
		let mut flag = OsString::from("linker=");
		flag.push(linker);
		command.arg("-C").arg(flag);
	}
	let result = command.output().expect("compile target argv0 launcher");
	assert!(
		result.status.success(),
		"argv0 launcher for {target}: {}",
		String::from_utf8_lossy(&result.stderr)
	);
	println!("cargo:rustc-env=OMP_ARGV0_LAUNCHER={}", output.display());
}
