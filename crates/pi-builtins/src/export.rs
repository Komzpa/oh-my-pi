use std::io::Write;

use brush_core::{
	ExecutionExitCode, ExecutionResult, builtins,
	env::{EnvironmentLookup, EnvironmentScope},
};
use clap::Parser;
use itertools::Itertools;

/// Add or update exported shell variables.
#[derive(Parser)]
pub(crate) struct ExportCommand {
	/// Names are treated as function names.
	#[arg(short = 'f')]
	names_are_functions: bool,

	/// Un-export the names.
	#[arg(short = 'n')]
	unexport: bool,

	/// Display all exported names.
	#[arg(short = 'p')]
	display_exported_names: bool,

	//
	// Declarations
	//
	// N.B. These are skipped by clap, but filled in by the BuiltinDeclarationCommand trait.
	#[clap(skip)]
	declarations: Vec<brush_core::CommandArg>,
}

impl builtins::DeclarationCommand for ExportCommand {
	fn set_declarations(&mut self, declarations: Vec<brush_core::CommandArg>) {
		self.declarations = declarations;
	}
}

impl builtins::Command for ExportCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.declarations.is_empty() {
			display_all_exported_vars(&context)?;
			return Ok(ExecutionResult::success());
		}

		let mut result = ExecutionResult::success();
		for decl in &self.declarations {
			let current_result = self.process_decl(&mut context, decl)?;
			if !current_result.is_success() {
				result = current_result;
			}
		}

		Ok(result)
	}
}

impl ExportCommand {
	fn process_decl(
		&self,
		context: &mut brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		decl: &brush_core::CommandArg,
	) -> Result<ExecutionResult, brush_core::Error> {
		match decl {
			brush_core::CommandArg::String(s) => {
				let s = s.to_str().ok_or_else(|| brush_core::Error::from(brush_core::ErrorKind::InternalError("export name is not valid UTF-8".into())))?;
				// See if this is supposed to be a function name.
				if self.names_are_functions {
					// Try to find the function already present; if we find it, then mark it
					// exported.
					if let Some(func) = context.shell.func_mut(s) {
						if self.unexport {
							func.unexport();
						} else {
							func.export();
						}
					} else {
						writeln!(context.stderr(), "{s}: not a function")?;
						return Ok(ExecutionExitCode::InvalidUsage.into());
					}
				}
				// Try to find the variable already present; if we find it, then mark it
				// exported.
				else if let Some((_, variable)) = context.shell.env_mut().get_mut(s) {
					if self.unexport {
						variable.unexport();
					} else {
						variable.export();
					}
				}
			},
			brush_core::CommandArg::Assignment(assignment) => {
				if assignment.index.is_some() {
					writeln!(context.stderr(), "not a valid variable name")?;
					return Ok(ExecutionExitCode::InvalidUsage.into());
				}
				let name = &assignment.name;

				let value = assignment.value.clone();

				// Update the variable with the provided value and then mark it exported.
				context.shell.env_mut().update_or_add(
					name,
					value,
					|var| {
						if self.unexport {
							var.unexport();
						} else {
							var.export();
						}
						Ok(())
					},
					EnvironmentLookup::Anywhere,
					EnvironmentScope::Global,
				)?;
			},
		}

		Ok(ExecutionResult::success())
	}
}

fn display_all_exported_vars(
	context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
) -> Result<(), brush_core::Error> {
	// Enumerate variables, sorted by key.
	for (name, variable) in context.shell.env().iter().sorted_by_key(|v| v.0) {
		if variable.is_exported() {
			let value = variable.value().try_get_cow_os(context.shell);
			write!(context.stdout(), "declare -x ")?;
			context.stdout().write_all(name.as_encoded_bytes())?;
			if let Some(value) = value {
				writeln!(context.stdout(), "={}", brush_core::escape::force_quote_native(&value, brush_core::escape::QuoteMode::DoubleQuote))?;
			} else {
				writeln!(context.stdout())?;
			}
		}
	}

	Ok(())
}
