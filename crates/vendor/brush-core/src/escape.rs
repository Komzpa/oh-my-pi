//! String escaping utilities

use std::borrow::Cow;

use itertools::Itertools;

use crate::{error, int_utils};

/// Quotes native values as executable shell syntax, preserving undecodable bytes.
pub fn force_quote_native(value: &std::ffi::OsStr, mode: QuoteMode) -> String {
	if let Some(text) = value.to_str() { return force_quote(text, mode); }
	use std::fmt::Write;
	let mut result = String::from("$'");
	for byte in value.as_encoded_bytes() { let _ = write!(result, "\\x{byte:02x}"); }
	result.push('\'');
	result
}

/// Quotes only when needed, including native byte values.
pub fn quote_native_if_needed(value: &std::ffi::OsStr, mode: QuoteMode) -> Cow<'_, str> {
	match value.to_str() {
		Some(text) => quote_if_needed(text, mode),
		None => force_quote_native(value, mode).into(),
	}
}

/// Applies a character mapping without changing invalid native byte sequences.
pub fn map_native_chars(value: &std::ffi::OsStr, mut map: impl FnMut(char) -> String) -> std::ffi::OsString {
	let mut bytes = Vec::with_capacity(value.len());
	for unit in EscapeScalars(value.as_encoded_bytes()) {
		match unit { EscapeScalar::Char(c) => bytes.extend(map(c).as_bytes()), EscapeScalar::Byte(b) => bytes.push(b) }
	}
	// SAFETY: only complete Unicode scalars are replaced with valid Unicode strings.
	unsafe { std::ffi::OsString::from_encoded_bytes_unchecked(bytes) }
}


/// Escape expansion mode.
#[derive(Clone, Copy)]
pub enum EscapeExpansionMode {
	/// echo builtin mode.
	EchoBuiltin,
	/// ANSI-C quotes.
	AnsiCQuotes,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EscapeScalar {
	Char(char),
	Byte(u8),
}

impl EscapeScalar {
	fn character(self) -> Option<char> {
		match self { Self::Char(c) => Some(c), Self::Byte(_) => None }
	}

	fn bytes(self) -> Vec<u8> {
		match self { Self::Char(c) => c.to_string().into_bytes(), Self::Byte(b) => vec![b] }
	}
}

#[derive(Clone)]
struct EscapeScalars<'a>(&'a [u8]);

impl Iterator for EscapeScalars<'_> {
	type Item = EscapeScalar;

	fn next(&mut self) -> Option<Self::Item> {
		let first = *self.0.first()?;
		let width = match first { 0x00..=0x7f => 1, 0xc2..=0xdf => 2, 0xe0..=0xef => 3, 0xf0..=0xf4 => 4, _ => 0 };
		if width > 0 && self.0.len() >= width {
			if let Ok(s) = std::str::from_utf8(&self.0[..width]) {
				self.0 = &self.0[width..];
				return Some(EscapeScalar::Char(s.chars().next().expect("non-empty UTF-8 scalar")));
			}
		}
		self.0 = &self.0[1..];
		Some(EscapeScalar::Byte(first))
	}
}

/// Expands backslash escapes in the provided string.
///
/// # Arguments
///
/// * `s` - The string to expand.
/// * `mode` - The mode to use for expansion.
#[expect(clippy::too_many_lines)]
pub fn expand_backslash_escapes(
	s: &str,
	mode: EscapeExpansionMode,
) -> Result<(Vec<u8>, bool), error::Error> {
	expand_backslash_escapes_bytes(s.as_bytes(), mode)
}

/// Expands escapes while preserving bytes that are not UTF-8.
#[expect(clippy::too_many_lines)]
pub fn expand_backslash_escapes_bytes(
	s: &[u8],
	mode: EscapeExpansionMode,
) -> Result<(Vec<u8>, bool), error::Error> {
	let mut result: Vec<u8> = Vec::with_capacity(s.len());
	let mut it = EscapeScalars(s);
	while let Some(c) = it.next() {
		if c != EscapeScalar::Char('\\') {
			result.extend(c.bytes());
			continue;
		}

		let Some(escape_cmd) = it.next() else {
			// Trailing backslash.
			result.push(b'\\');
			continue;
		};
		let Some(escape_cmd) = escape_cmd.character() else {
			result.push(b'\\');
			result.extend(escape_cmd.bytes());
			continue;
		};

		match escape_cmd {
			'a' => result.push(b'\x07'),
			'b' => result.push(b'\x08'),
			'c' => {
				match mode {
					EscapeExpansionMode::EchoBuiltin => {
						// Stop all additional output!
						return Ok((result, false));
					},
					EscapeExpansionMode::AnsiCQuotes => {
						if let Some(char_value) = it.next() {
							// Special case backslash. If it's immediately followed by another
							// backslash, then we consume both; if not, we still will use the
							// backslash character as the one to apply the control transformation
							// to.
							if char_value == EscapeScalar::Char('\\') {
								let orig_it = it.clone();
								if !matches!(it.next(), Some(EscapeScalar::Char('\\'))) {
									// Didn't find another backslash; restore iterator.
									it = orig_it;
								}
							}

							let mut bytes = match char_value {
								EscapeScalar::Char(c) if c.is_ascii_lowercase() => vec![c.to_ascii_uppercase() as u8],
								other => other.bytes(),
							};

							if !bytes.is_empty() {
								if bytes[0] == b'?' {
									// We can't explain why this is the case, but it is.
									bytes[0] = 0x7f;
								} else {
									bytes[0] &= 0x1f;
								}
							}

							result.append(bytes.as_mut());
						} else {
							result.push(b'\\');
							result.push(b'c');
						}
					},
				}
			},
			'e' | 'E' => result.push(b'\x1b'),
			'f' => result.push(b'\x0c'),
			'n' => result.push(b'\n'),
			'r' => result.push(b'\r'),
			't' => result.push(b'\t'),
			'v' => result.push(b'\x0b'),
			'\\' => result.push(b'\\'),
			'\'' if matches!(mode, EscapeExpansionMode::AnsiCQuotes) => result.push(b'\''),
			'\"' if matches!(mode, EscapeExpansionMode::AnsiCQuotes) => result.push(b'\"'),
			'?' if matches!(mode, EscapeExpansionMode::AnsiCQuotes) => result.push(b'?'),
			'0' => {
				// Consume 0-3 valid octal chars
				let mut taken_so_far = 0;
				let mut octal_chars: String = it
					.take_while_ref(|c| {
						if taken_so_far < 3 && matches!(c.character(), Some('0'..='7')) {
							taken_so_far += 1;
							true
						} else {
							false
						}
					})
					.map(|c| c.character().expect("octal scalar"))
					.collect();

				if octal_chars.is_empty() {
					octal_chars.push('0');
				}

				let value = int_utils::parse::<u8>(octal_chars.as_str(), 8)?;
				result.push(value);
			},
			'x' => {
				// Consume 1-2 valid hex chars (or unlimited with braces in ANSI-C mode)
				let mut hex_chars = String::new();
				let mut invalid_prefix = false;
				let mut hexits_consumed = 0;
				let mut start_brace_consumed = false;

				loop {
					// Save the original in case we go too far and need to restore.
					let orig_it = it.clone();

					let Some(next_c) = it.next() else {
						break;
					};

					if matches!(mode, EscapeExpansionMode::AnsiCQuotes)
						&& !start_brace_consumed
						&& next_c == EscapeScalar::Char('{')
					{
						start_brace_consumed = true;
					} else if start_brace_consumed && next_c == EscapeScalar::Char('}') {
						break;
					} else if ((start_brace_consumed && !invalid_prefix)
						|| (!start_brace_consumed && hexits_consumed < 2))
						&& next_c.character().is_some_and(|c| c.is_ascii_hexdigit())
					{
						hex_chars.push(next_c.character().expect("hex scalar"));
						hexits_consumed += 1;
					} else if start_brace_consumed && hexits_consumed == 0 {
						invalid_prefix = true;
					} else {
						// Went too far; restore iterator and break.
						it = orig_it;
						break;
					}
				}

				if hex_chars.is_empty() {
					if start_brace_consumed {
						result.push(0);
					} else {
						result.push(b'\\');
						result.append(escape_cmd.to_string().into_bytes().as_mut());
					}
				} else {
					let value32 = int_utils::parse::<u32>(hex_chars.as_str(), 16)?;
					let value8: u8 = (value32 & 0xff) as u8;
					result.push(value8);
				}
			},
			'u' => {
				// Consume 1-4 hex digits
				let mut taken_so_far = 0;
				let hex_chars: String = it
					.take_while_ref(|next_c| {
						if taken_so_far < 4 && next_c.character().is_some_and(|c| c.is_ascii_hexdigit()) {
							taken_so_far += 1;
							true
						} else {
							false
						}
					})
					.map(|c| c.character().expect("hex scalar"))
					.collect();

				if hex_chars.is_empty() {
					result.push(b'\\');
					result.append(escape_cmd.to_string().into_bytes().as_mut());
				} else {
					let value = int_utils::parse::<u16>(hex_chars.as_str(), 16)?;
					if let Some(decoded) = char::from_u32(u32::from(value)) {
						result.append(decoded.to_string().into_bytes().as_mut());
					} else {
						result.push(b'\\');
						result.append(escape_cmd.to_string().into_bytes().as_mut());
					}
				}
			},
			'U' => {
				// Consume 1-8 hex digits
				let mut taken_so_far = 0;
				let hex_chars: String = it
					.take_while_ref(|next_c| {
						if taken_so_far < 8 && next_c.character().is_some_and(|c| c.is_ascii_hexdigit()) {
							taken_so_far += 1;
							true
						} else {
							false
						}
					})
					.map(|c| c.character().expect("hex scalar"))
					.collect();

				if hex_chars.is_empty() {
					result.push(b'\\');
					result.append(escape_cmd.to_string().into_bytes().as_mut());
				} else {
					let value = int_utils::parse::<u32>(hex_chars.as_str(), 16)?;
					if let Some(decoded) = char::from_u32(value) {
						result.append(decoded.to_string().into_bytes().as_mut());
					} else {
						result.push(b'\\');
						result.append(escape_cmd.to_string().into_bytes().as_mut());
					}
				}
			},
			first_octal @ '1'..='7' if matches!(mode, EscapeExpansionMode::AnsiCQuotes) => {
				// We've already consumed the first octal digit.
				let mut octal_chars = String::new();
				octal_chars.push(first_octal);

				// Consume up to 2 more valid octal chars
				let mut taken_so_far = 1;
				for next_c in it.take_while_ref(|next_c| {
					if taken_so_far < 3 && matches!(next_c.character(), Some('0'..='7')) {
						taken_so_far += 1;
						true
					} else {
						false
					}
				}) {
					octal_chars.push(next_c.character().expect("octal scalar"));
				}

				let value = int_utils::parse::<u8>(octal_chars.as_str(), 8)?;
				result.push(value);
			},
			unknown => {
				// Not a valid escape sequence.
				result.push(b'\\');
				result.append(unknown.to_string().into_bytes().as_mut());
			},
		}
	}

	// In ANSI-C quotes, we crop the result at the first NUL.
	if matches!(mode, EscapeExpansionMode::AnsiCQuotes) {
		if let Some(nul_index) = result.iter().position(|&b| b == 0) {
			result.truncate(nul_index);
		}
	}

	Ok((result, true))
}

/// Quoting mode to use for escaping.
#[derive(Clone, Copy, Default)]
pub enum QuoteMode {
	/// Single-quote.
	#[default]
	SingleQuote,
	/// Double-quote.
	DoubleQuote,
	/// Backslash-escape.
	BackslashEscape,
}

/// Options influencing how to escape/quote an input string.
#[derive(Default)]
pub(crate) struct QuoteOptions {
	/// Whether or not to *always* escape or quote the input; if false, then
	/// escaping/quoting will only be applied if the input contains characters
	/// that *require* it.
	pub always_quote:                 bool,
	/// Preferred mode for quoting/escaping. Quoting may be "upgraded" to a more
	/// expressive format if the input is not expressible otherwise.
	pub preferred_mode:               QuoteMode,
	/// Whether or not to *avoid* using ANSI C quoting just for the benefit of
	/// newline characters. Default is for newline characters to require
	/// upgrading the string's quoting to ANSI C quoting.
	pub avoid_ansi_c_quoting_newline: bool,
}

pub(crate) fn quote<'a>(s: &'a str, options: &QuoteOptions) -> Cow<'a, str> {
	let use_ansi_c_quotes = s.contains(|c| {
		needs_ansi_c_quoting(c) && (!options.avoid_ansi_c_quoting_newline || c != '\n')
	});

	if use_ansi_c_quotes {
		return ansi_c_quote(s).into();
	}

	let use_default_quotes =
		!use_ansi_c_quotes && (options.always_quote || s.is_empty() || s.contains(needs_escaping));

	if !use_default_quotes {
		return s.into();
	}

	match options.preferred_mode {
		QuoteMode::BackslashEscape => backslash_escape(s),
		QuoteMode::SingleQuote => single_quote(s),
		QuoteMode::DoubleQuote => double_quote(s).into(),
	}
}

/// Escape the given string, forcing quoting.
///
/// # Arguments
///
/// * `s` - The string to escape.
/// * `mode` - The quoting mode to use.
pub fn force_quote(s: &str, mode: QuoteMode) -> String {
	let options = QuoteOptions { always_quote: true, preferred_mode: mode, ..Default::default() };

	quote(s, &options).to_string()
}

/// Applies the given quoting mode to the provided string, only changing it if
/// required.
///
/// # Arguments
///
/// * `s` - The string to escape.
/// * `mode` - The quoting mode to use.
pub fn quote_if_needed(s: &str, mode: QuoteMode) -> Cow<'_, str> {
	let options = QuoteOptions { always_quote: false, preferred_mode: mode, ..Default::default() };

	quote(s, &options)
}

fn backslash_escape(s: &str) -> Cow<'_, str> {
	if s.is_empty() {
		// An empty string must be represented as '' to be a valid shell word.
		Cow::Owned("''".to_string())
	} else if !s.chars().any(needs_escaping) {
		Cow::Borrowed(s)
	} else {
		let mut output = String::with_capacity(s.len());
		for c in s.chars() {
			if needs_escaping(c) {
				output.push('\\');
			}
			output.push(c);
		}
		Cow::Owned(output)
	}
}

fn single_quote(s: &str) -> Cow<'_, str> {
	// Special-case the empty string.
	if s.is_empty() {
		return Cow::Borrowed("''");
	}

	let mut result = String::with_capacity(s.len());

	// Go through the string; put everything in single quotes except for
	// the single quote character itself. It will get escaped outside
	// all quoting.
	let mut first = true;
	for part in s.split('\'') {
		if !first {
			result.push('\\');
			result.push('\'');
		} else {
			first = false;
		}

		if !part.is_empty() {
			result.push('\'');
			result.push_str(part);
			result.push('\'');
		}
	}

	Cow::Owned(result)
}

fn double_quote(s: &str) -> String {
	let mut result = String::with_capacity(s.len());

	result.push('"');

	for c in s.chars() {
		if matches!(c, '$' | '`' | '"' | '\\') {
			result.push('\\');
		}

		result.push(c);
	}

	result.push('"');

	result
}

fn ansi_c_quote(s: &str) -> String {
	let mut result = String::with_capacity(s.len());
	result.push_str("$'");

	for c in s.chars() {
		match c {
			'\x07' => result.push_str("\\a"),
			'\x08' => result.push_str("\\b"),
			'\x1b' => result.push_str("\\E"),
			'\x0c' => result.push_str("\\f"),
			'\n' => result.push_str("\\n"),
			'\r' => result.push_str("\\r"),
			'\t' => result.push_str("\\t"),
			'\x0b' => result.push_str("\\v"),
			'\\' => result.push_str("\\\\"),
			'\'' => result.push_str("\\'"),
			c if needs_ansi_c_quoting(c) => {
				result.push_str(std::format!("\\{:03o}", c as u8).as_str());
			},
			_ => result.push(c),
		}
	}

	result.push('\'');

	result
}

// Returns whether or not the given character needs to be escaped (or quoted) if
// outside quotes.
const fn needs_escaping(c: char) -> bool {
	matches!(
		c,
		'(' | ')'
			| '[' | ']'
			| '{' | '}'
			| '$' | '*'
			| '?' | '|'
			| '&' | ';'
			| '<' | '>'
			| '`' | '\\'
			| '"' | '!'
			| '^' | ','
			| ' ' | '\''
	)
}

const fn needs_ansi_c_quoting(c: char) -> bool {
	c.is_ascii_control()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn native_escape_input_preserves_bytes_and_ansi_control_behavior() {
		let expand = |s| expand_backslash_escapes_bytes(s, EscapeExpansionMode::AnsiCQuotes).unwrap().0;
		assert_eq!(expand(b"a\xff\\tb"), b"a\xff\tb");
		assert_eq!(expand(b"\\c\xffz"), b"\x1fz");
		assert_eq!(expand(b"a\\x{\xff}z"), b"a");
		assert_eq!(expand("é\\n".as_bytes()), "é\n".as_bytes());
	}

	#[test]
	fn test_backslash_escape() {
		assert_eq!(quote_if_needed("a", QuoteMode::BackslashEscape), "a");
		assert_eq!(quote_if_needed("a b", QuoteMode::BackslashEscape), r"a\ b");
		assert_eq!(quote_if_needed("", QuoteMode::BackslashEscape), "''");
	}

	#[test]
	fn test_single_quote_escape() {
		assert_eq!(quote_if_needed("a", QuoteMode::SingleQuote), "a");
		assert_eq!(quote_if_needed("a b", QuoteMode::SingleQuote), "'a b'");
		assert_eq!(quote_if_needed("", QuoteMode::SingleQuote), "''");
		assert_eq!(quote_if_needed("'", QuoteMode::SingleQuote), "\\'");
	}

	fn assert_echo_expands_to(unexpanded: &str, expected: &str) {
		assert_eq!(
			String::from_utf8(
				expand_backslash_escapes(unexpanded, EscapeExpansionMode::EchoBuiltin)
					.unwrap()
					.0
			)
			.unwrap(),
			expected
		);
	}

	#[test]
	fn test_echo_expansion() {
		assert_echo_expands_to("a", "a");
		assert_echo_expands_to(r"\M", "\\M");
		assert_echo_expands_to(r"a\nb", "a\nb");
		assert_echo_expands_to(r"\a", "\x07");
		assert_echo_expands_to(r"\b", "\x08");
		assert_echo_expands_to(r"\e", "\x1b");
		assert_echo_expands_to(r"\f", "\x0c");
		assert_echo_expands_to(r"\n", "\n");
		assert_echo_expands_to(r"\r", "\r");
		assert_echo_expands_to(r"\t", "\t");
		assert_echo_expands_to(r"\v", "\x0b");
		assert_echo_expands_to(r"\\", "\\");
		assert_echo_expands_to(r"\'", "\\'");
		assert_echo_expands_to(r#"\""#, r#"\""#);
		assert_echo_expands_to(r"\?", "\\?");
		assert_echo_expands_to(r"\0", "\0");
		assert_echo_expands_to(r"\00", "\0");
		assert_echo_expands_to(r"\000", "\0");
		assert_echo_expands_to(r"\081", "\081");
		assert_echo_expands_to(r"\0101", "A");
		assert_echo_expands_to(r"abc\", "abc\\");
		assert_echo_expands_to(r"\x41", "A");
		assert_echo_expands_to(r"\xf0\x9f\x90\x8d", "🐍");
		assert_echo_expands_to(r"\u2620", "☠");
		assert_echo_expands_to(r"\U0001f602", "😂");
	}
}
