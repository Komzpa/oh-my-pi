//! The shell's time zone, as the utility builtins see it.

use jiff::tz::TimeZone;

use crate::host::Host;

/// The time zone the shell's `TZ` selects, resolved as glibc's `tzset` does:
/// unset means the system zone, a leading `:` is dropped, empty means UTC, and
/// relative/absolute TZif paths are read through the shell filesystem, and a
/// value that is neither a readable TZif file, IANA name nor POSIX TZ string uses UTC.
///
/// Read from the shell environment, never the host process's, so `TZ=… date`
/// works at the prompt. Shared by `date`, `ls`, `touch`, `du --time`, and
/// `uptime`.
pub(crate) fn shell_time_zone(host: &Host) -> TimeZone {
	let Some(value) = host.var_os("TZ") else {
		return TimeZone::system();
	};
	let value = value.as_encoded_bytes().strip_prefix(b":").unwrap_or(value.as_encoded_bytes());
	// SAFETY: removing an ASCII prefix preserves the native encoding.
	let value = unsafe { std::ffi::OsStr::from_encoded_bytes_unchecked(value) };
	if value.is_empty() { return TimeZone::UTC; }
	if let Some(text) = value.to_str() {
		if let Ok(zone) = TimeZone::get(text).or_else(|_| TimeZone::posix(text)) { return zone; }
	}
	let path = host.resolve(std::path::Path::new(value));
	host.fs().read(path).ok().and_then(|bytes| TimeZone::tzif("TZ", &bytes).ok()).unwrap_or(TimeZone::UTC)
}
