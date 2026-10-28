//! Environment variable retrieval (stub implementation).

/// Retrieves environment variables from the host process.
///
/// Stub implementation that returns no variables.
pub(crate) fn get_host_env_vars() -> impl Iterator<Item = (std::ffi::OsString, std::ffi::OsString)> {
	std::iter::empty()
}
