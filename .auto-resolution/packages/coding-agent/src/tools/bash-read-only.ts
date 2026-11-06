/**
 * Conservative read-only classifier for bash command lines.
 *
 * A line is read-only only when every simple command in it is on a short allow-list and none of the
 * constructs that can write, execute or expand arbitrary text appears. The bash tool reports the
 * `read` approval tier for such a line, so planning admission (which refuses every non-`read` tool
 * while the plan is incomplete) lets inspection through. Anything this file does not recognise is
 * not read-only: callers keep their `exec` fallback.
 */
import { extractFlatShellCommandSegments, lexShellCommand } from "./shell-tokenize";

const PLAIN_READ_COMMANDS = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "grep"]);
const GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]);
const GIT_BRANCH_ARGS = new Set(["--list", "-a", "-v"]);
const FIND_FORBIDDEN = /^-(?:exec|execdir|ok|okdir|delete|fprint\w*|fls)$/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/u;
/** git accepts any unambiguous prefix of a long option, so a prefix of a forbidden option is forbidden too. */
const GIT_FORBIDDEN_LONG_OPTIONS = ["--output", "--ext-diff", "--textconv"];

/** True when `raw` (one lexed word) has unquoted redirection or any expansion syntax. */
function hasUnsafeSyntax(raw: string): boolean {
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "$" || ch === "`") return true;
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === ">" || ch === "<") return true;
	}
	return false;
}

function isForbiddenGitOption(arg: string): boolean {
	if (!arg.startsWith("--") || arg === "--") return false;
	const name = arg.split("=", 1)[0]!;
	return GIT_FORBIDDEN_LONG_OPTIONS.some(option => option.startsWith(name));
}

function isReadOnlyGit(args: string[]): boolean {
	const subcommand = args[0];
	// Any option before the subcommand (-c, --exec-path, -C, --git-dir, ...) changes what git runs.
	if (subcommand === undefined || subcommand.startsWith("-")) return false;
	const rest = args.slice(1);
	if (subcommand === "branch") return rest.every(arg => GIT_BRANCH_ARGS.has(arg));
	if (!GIT_READ_SUBCOMMANDS.has(subcommand)) return false;
	return !rest.some(isForbiddenGitOption);
}

function isReadOnlyCommand(words: string[]): boolean {
	const [name, ...args] = words;
	if (name === undefined || ASSIGNMENT.test(name)) return false;
	if (PLAIN_READ_COMMANDS.has(name)) return true;
	switch (name) {
		case "git":
			return isReadOnlyGit(args);
		case "find":
			return !args.some(arg => FIND_FORBIDDEN.test(arg));
		case "rg":
			// --pre runs an arbitrary preprocessor per file; --hostname-bin runs a program.
			return !args.some(arg => arg.startsWith("--pre") || arg.startsWith("--hostname-bin"));
		default:
			return false;
	}
}

/** True when every simple command of `command` is an allow-listed, side-effect-free inspection. */
export function isReadOnlyBashCommand(command: string): boolean {
	if (command.trim() === "") return false;
	for (let i = 0; i < command.length; i++) {
		const code = command.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) return false;
	}
	// Returns [] for command/process substitution, heredocs, grouping, backticks and malformed quoting.
	const segments = extractFlatShellCommandSegments(command);
	if (segments.length === 0) return false;
	for (const segment of segments) {
		const words = lexShellCommand(segment.text).filter(token => token.kind === "word");
		if (words.length === 0 || words.some(word => hasUnsafeSyntax(word.raw))) return false;
		if (!isReadOnlyCommand(words.map(word => word.value))) return false;
	}
	return true;
}
