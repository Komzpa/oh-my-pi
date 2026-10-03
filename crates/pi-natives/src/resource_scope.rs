use std::{ffi::OsString, sync::Arc};

use napi::{Error, Result};
use napi_derive::napi;
use pi_vcs::process_limit::ToolProcessLimit;

use crate::task::{self, blocking};

#[napi]
pub struct ToolResourceScope {
	owner: Option<Arc<ToolProcessLimit>>,
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
		Self { owner: Some(Arc::new(ToolProcessLimit::default())) }
	}

	fn scoped(&self, command: Vec<String>) -> Result<Vec<String>> {
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
	pub fn wrap_command(&self, command: Vec<String>) -> Result<Vec<String>> {
		self.scoped(command)
	}

	/// Off-thread variant of [`ToolResourceScope::wrap_command`]: the systemd
	/// subprocesses behind first-use enforcement run on libuv's thread pool,
	/// so the JS event loop is never blocked. Resolves to the same argv.
	#[napi]
	pub fn wrap_command_async(&self, command: Vec<String>) -> task::Promise<Vec<String>> {
		let owner = self.owner.clone();
		blocking("tool-resource-scope.wrap_command", (), move |_| {
			let owner = owner
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
		})
	}

	/// Dropping the owner only hands teardown to a detached thread
	/// ([`ToolProcessLimit`] never blocks the dropping thread), so this
	/// returns immediately; no async variant is needed.
	#[napi]
	pub fn close(&mut self) {
		drop(self.owner.take());
	}
}
