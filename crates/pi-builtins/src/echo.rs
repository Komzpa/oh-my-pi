use std::io::Write;

use brush_core::{ExecutionResult, builtins, escape};
use clap::Parser;

/// Echo text to standard output.
#[derive(Parser)]
#[clap(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct EchoCommand {
	/// Suppress the trailing newline from the output.
	#[arg(short = 'n')]
	no_trailing_newline: bool,

	/// Interpret backslash escapes in the provided text.
	#[arg(short = 'e')]
	interpret_backslash_escapes: bool,

	/// Do not interpret backslash escapes in the provided text.
	#[arg(short = 'E')]
	no_interpret_backslash_escapes: bool,

	/// Tokens to echo to standard output.
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<std::ffi::OsString>,
}

impl builtins::Command for EchoCommand {
	type Error = brush_core::Error;

	/// bash semantics, without building a clap parser per call: leading words
	/// of the form `-[neE]+` are options, applied in order (a later `-E`
	/// cancels an earlier `-e`); the first other word, including `--` and a
	/// lone `-`, starts the text.
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = std::ffi::OsString>,
	{
		let mut this = Self {
			no_trailing_newline:            false,
			interpret_backslash_escapes:    false,
			no_interpret_backslash_escapes: false,
			args:                           Vec::new(),
		};
		// `args` starts with the command name.
		let mut args = args.into_iter().skip(1).peekable();
		while let Some(word) = args.next_if(|word| {
			word.to_str().is_some_and(|word| word.len() > 1
				&& word.starts_with('-')
				&& word[1..].bytes().all(|flag| matches!(flag, b'n' | b'e' | b'E')))
		}) {
			for flag in word.to_str().expect("option was checked above")[1..].bytes() {
				match flag {
					b'n' => this.no_trailing_newline = true,
					b'e' => this.interpret_backslash_escapes = true,
					_ => this.interpret_backslash_escapes = false,
				}
			}
		}
		this.args = args.collect();
		Ok(this)
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut trailing_newline = !self.no_trailing_newline;
		let mut bytes = Vec::new();
		for (i, arg) in self.args.iter().enumerate() {
			if i > 0 {
				bytes.push(b' ');
			}
			if self.interpret_backslash_escapes {
				let (expanded_arg, keep_going) = escape::expand_backslash_escapes_bytes(arg.as_encoded_bytes(), escape::EscapeExpansionMode::EchoBuiltin)?;
				bytes.extend(expanded_arg);
				if !keep_going {
					trailing_newline = false;
					break;
				}
			} else {
				bytes.extend_from_slice(arg.as_encoded_bytes());
			}
		}
		if trailing_newline {
			bytes.push(b'\n');
		}
		let mut stdout = context.stdout();
		stdout.write_all(&bytes)?;
		stdout.flush()?;

		Ok(ExecutionResult::success())
	}
}


#[cfg(test)]
mod tests {
	use brush_core::builtins::Command;

	use super::EchoCommand;

	#[test]
	fn escapes_preserve_invalid_utf8_and_stop_at_control_escape() {
		let expand = |input| brush_core::escape::expand_backslash_escapes_bytes(input, brush_core::escape::EscapeExpansionMode::EchoBuiltin).unwrap();
		assert_eq!(expand(b"a\xff\\tb\\\xff\\cignored"), (b"a\xff\tb\\\xff".to_vec(), false));
		assert_eq!(expand(b"x\\x41\xffz"), (b"xA\xffz".to_vec(), true));
	}

	fn parse(words: &[&str]) -> (bool, bool, Vec<String>) {
		let echo = EchoCommand::new(
			std::iter::once("echo").chain(words.iter().copied()).map(std::ffi::OsString::from),
		)
		.unwrap();
		(echo.no_trailing_newline, echo.interpret_backslash_escapes, echo.args.into_iter().map(|arg| arg.into_string().unwrap()).collect())
	}

	/// Contract: bash's echo option rules — combined and repeated flags
	/// apply in order, and option parsing stops at the first other word.
	#[test]
	fn leading_neE_words_are_options_until_the_first_other_word() {
		assert_eq!(parse(&["-ne", "a\\tb"]), (true, true, vec!["a\\tb".to_owned()]));
		assert_eq!(parse(&["-e", "-E", "x"]), (false, false, vec!["x".to_owned()]));
		assert_eq!(parse(&["-n", "a", "-n"]), (true, false, vec!["a".to_owned(), "-n".to_owned()]));
		assert_eq!(parse(&["--", "-n"]), (false, false, vec!["--".to_owned(), "-n".to_owned()]));
		assert_eq!(parse(&["-nx", "a"]), (false, false, vec!["-nx".to_owned(), "a".to_owned()]));
		assert_eq!(parse(&["-", "-n"]), (false, false, vec!["-".to_owned(), "-n".to_owned()]));
	}
}
