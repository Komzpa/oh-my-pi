use std::ffi::OsString;

use napi::{Error, Result};
use napi_derive::napi;
use pi_vcs::process_limit::ToolProcessLimit;

#[napi]
pub struct ToolResourceScope {
	owner: Option<ToolProcessLimit>,
}

impl Default for ToolResourceScope {
	fn default() -> Self {
		Self::new()
	}
}

#[napi]
impl ToolResourceScope {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self { owner: Some(ToolProcessLimit::default()) }
	}

	#[napi]
	pub fn wrap_command(&self, command: Vec<String>) -> Result<Vec<String>> {
		let owner = self
			.owner
			.as_ref()
			.ok_or_else(|| Error::from_reason("tool resource scope is closed"))?;
		let command = command.into_iter().map(OsString::from).collect::<Vec<_>>();
		owner
			.wrap_scope_command(&command)
			.map_err(|error| {
				Error::from_reason(format!("tool resource boundary unavailable: {error}"))
			})?
			.into_iter()
			.map(|argument| {
				argument
					.into_string()
					.map_err(|_| Error::from_reason("non-UTF-8 scoped command"))
			})
			.collect()
	}

	#[napi]
	pub fn close(&mut self) {
		drop(self.owner.take());
	}
}
