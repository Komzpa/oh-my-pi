//! Environment variable retrieval for Unix platforms.

/// Retrieves environment variables from the host process.
///
/// Names and values retain their native bytes without `std::env::vars()`
/// panicking on non-Unicode entries.
pub(crate) fn get_host_env_vars() -> impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)> {
	std::env::vars_os()
}

#[cfg(test)]
mod tests {
	use std::os::unix::ffi::OsStrExt;

	use super::*;

	/// Invalid native values remain usable without `std::env::vars()` panicking.
	#[test]
	fn get_host_env_vars_preserves_non_utf8_values() {
		// SAFETY: the corrupt + sentinel keys are unique to this test and the
		// environment is not contended elsewhere in this process.
		unsafe {
			std::env::set_var("OMP_TEST_BAD_VALUE_8925", std::ffi::OsStr::from_bytes(&[0x9d, 0xd9, 0x50]));
			std::env::set_var(std::ffi::OsStr::from_bytes(b"\xffOMP_TEST_BAD_KEY_8925"), "value");
			std::env::set_var("OMP_TEST_KEEP_8925", "kept");
		}

		let entries: Vec<(std::ffi::OsString, std::ffi::OsString)> = get_host_env_vars().collect();

		assert!(
			entries.iter().any(|(key, value)| key == "OMP_TEST_BAD_VALUE_8925" && value.as_bytes() == [0x9d, 0xd9, 0x50]),
			"a non-UTF-8 value must be preserved"
		);
		assert!(
			entries.iter().any(|(key, _)| key.as_bytes() == b"\xffOMP_TEST_BAD_KEY_8925"),
			"a non-UTF-8 key must be preserved"
		);
		assert!(
			entries.iter().any(|(key, value)| key == "OMP_TEST_KEEP_8925" && value == "kept"),
			"valid entries must still be returned"
		);

		// SAFETY: reads are done; restore the host environment.
		unsafe {
			std::env::remove_var("OMP_TEST_BAD_VALUE_8925");
			std::env::remove_var(std::ffi::OsStr::from_bytes(b"\xffOMP_TEST_BAD_KEY_8925"));
			std::env::remove_var("OMP_TEST_KEEP_8925");
		}
	}
}
