//! Environment support for shell.

use std::borrow::Cow;

use crate::{ShellVariable, error};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {
	/// Tries to retrieve a variable from the shell's environment, converting it
	/// into its string form.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	pub fn env_str(&self, name: &str) -> Result<Option<Cow<'_, str>>, error::Error> {
		self.env.get_str(name, self)
	}

	/// Retrieves a variable without converting native bytes to text.
	pub fn env_os(&self, name: &str) -> Option<Cow<'_, std::ffi::OsStr>> {
		self.env.get(name).map(|(_, var)| var.value().to_cow_os(self))
	}

	/// Tries to retrieve a variable from the shell's environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to retrieve.
	pub fn env_var(&self, name: &str) -> Option<&ShellVariable> {
		self.env.get(name).map(|(_, var)| var)
	}

	/// Tries to set a global variable in the shell's environment.
	///
	/// # Arguments
	///
	/// * `name` - The name of the variable to add.
	/// * `var` - The variable contents to add.
	pub fn set_env_global(&mut self, name: &str, var: ShellVariable) -> Result<(), error::Error> {
		self.env.set_global(name, var)
	}
}
