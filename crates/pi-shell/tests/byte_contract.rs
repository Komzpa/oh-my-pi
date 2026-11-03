//! Native byte values must survive the engine and external process boundary.
#![cfg(unix)]

use pi_shell::{ShellExecuteOptions, StreamSinks, cancel::CancelToken, execute_shell_streams};

#[tokio::test(flavor = "multi_thread")]
async fn byte_contract_survives_expansion_export_read_and_serialization() {
	let script = r#"
v=$'\xffa'; export RAW="$v"
python3 -c 'import os,sys; os.write(1,os.fsencode(sys.argv[1])+b"|"+os.environb[b"RAW"]+b"\n")' "$v"
printf '%s|%s\n' "${v:0:1}" "${v/a/b}"
printf '\377'; echo -e '\0376'
case "$v" in $'\xff'*) printf 'case\n';; *) exit 21;; esac
[[ "$v" =~ $'\xff' ]] || exit 22
printf 'regex\n'
IFS=: read -r left right <<< $'\xff:\xfe'
printf '%s|%s\n' "$left" "$right"
saved=$(declare -p v); unset v; eval "$saved"
printf '%s\n' "$v"
"#;
	let (stdout, output) = flume::unbounded();
	let (stderr, errors) = flume::unbounded();
	let result = execute_shell_streams(
		ShellExecuteOptions { command: script.into(), ..Default::default() },
		StreamSinks { stdout: Some(stdout), stderr: Some(stderr) },
		CancelToken::default(),
	)
	.await
	.unwrap();
	let errors: Vec<u8> = errors.drain().flat_map(|b| b.to_vec()).collect();
	assert_eq!(result.exit_code, Some(0), "{}", String::from_utf8_lossy(&errors));
	let output: Vec<u8> = output.drain().flat_map(|b| b.to_vec()).collect();
	assert_eq!(output, b"\xffa|\xffa\n\xff|\xffb\n\xff\xfe\ncase\nregex\n\xff|\xfe\n\xffa\n");
}
