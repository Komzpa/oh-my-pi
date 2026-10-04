/**
 * Conservative shell command tokenizer shared by the bash approval-pattern
 * matcher, the gh-cache invalidator, and the session anonymizer.
 *
 * Splits a bash command into independent command segments, each a list of word
 * tokens. Handles single/double-quoted strings, backslash escapes, and the
 * standard operators (`;`, `&&`, `||`, `|`, `&`, `(`, `)`, newlines) as segment
 * boundaries so callers treat the pieces as independent command sequences.
 *
 * It is deliberately not a full POSIX parser — heredocs, command substitution,
 * and arithmetic expansion are out of scope; callers fall through when they
 * cannot find the structure they need.
 */
export function tokenizeShellSegments(command: string): string[][] {
	const segments: string[][] = [];
	let current: string[] = [];
	for (const token of lexShellCommand(command)) {
		if (token.kind === "word") {
			// Empty quoted words (`''`) carry no argument text.
			if (token.value.length > 0) current.push(token.value);
		} else if (/[\n;&|()]/.test(token.raw) && current.length > 0) {
			segments.push(current);
			current = [];
		}
	}
	if (current.length > 0) segments.push(current);
	return segments;
}

interface ShellHereDocument {
	body: string;
	quoted: boolean;
	fd: number;
}

interface PendingShellHereDocument {
	delimiter: string;
	stripTabs: boolean;
	document: ShellHereDocument;
}

function readShellHereDocumentHeader(
	command: string,
	start: number,
): { length: number; pending: PendingShellHereDocument } | undefined {
	if (command[start - 1] === "<" || command[start + 2] === "<") return undefined;
	const operator = /^<<-?[ \t]*/u.exec(command.slice(start))?.[0];
	if (!operator) return undefined;
	const delimiter = lexShellCommand(command.slice(start + operator.length))[0];
	if (delimiter?.kind !== "word") return undefined;
	const normalized = lexShellCommand(delimiter.raw, true)[0];
	return {
		length: operator.length + delimiter.raw.length,
		pending: {
			delimiter: normalized?.kind === "word" ? normalized.value : delimiter.value,
			stripTabs: operator.startsWith("<<-"),
			document: { body: "", quoted: /['"\\]/u.test(delimiter.raw), fd: 0 },
		},
	};
}

function readShellHereDocumentBodies(command: string, start: number, pending: PendingShellHereDocument[]): number {
	let cursor = start;
	for (const { delimiter, stripTabs, document } of pending.splice(0)) {
		while (cursor < command.length) {
			const end = command.indexOf("\n", cursor);
			const next = end < 0 ? command.length : end + 1;
			const line = command.slice(cursor, end < 0 ? command.length : end);
			cursor = next;
			const content = stripTabs ? line.replace(/^\t+/u, "") : line;
			if (content === delimiter) break;
			document.body += content + (end < 0 ? "" : "\n");
		}
	}
	return cursor;
}

interface ShellWordToken {
	kind: "word";
	raw: string;
	value: string;
	hereDocument?: ShellHereDocument;
	/** Active substitutions are code even when the containing word is data. */
	substitutions?: string[];
	/** The following word is the redirect operand, not an argv entry. */
	redirection?: { operator: string; fd: number };
	dynamic?: boolean;
}

/** Bash ANSI-C quoting and printf share the basic backslash escape alphabet. */
export function decodeShellEscapes(text: string): string {
	const escapes: Record<string, string> = {
		a: "\x07",
		b: "\b",
		e: "\x1b",
		E: "\x1b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\v",
		"\\": "\\",
		"'": "'",
		'"': '"',
		"?": "?",
	};
	return text.replace(
		/\\(?:x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/gu,
		escape => {
			const code = escape[1];
			if (code === "x" || code === "u" || code === "U") {
				const point = Number.parseInt(escape.slice(2), 16);
				return point <= 0x10ffff ? String.fromCodePoint(point) : escape;
			}
			if (/[0-7]/u.test(code)) return String.fromCharCode(Number.parseInt(escape.slice(1), 8) & 255);
			if (code === "c") return String.fromCharCode(escape[2] === "?" ? 127 : escape.charCodeAt(2) & 31);
			return escapes[code] ?? escape;
		},
	);
}

/** Read one substitution without letting its quotes or operators alter the outer command. */
function readShellSubstitution(command: string, start: number, depth = 0): { end: number; body: string } | undefined {
	const backtick = command[start] === "`";
	if (!backtick && !("$<>".includes(command[start]) && command[start + 1] === "(")) return undefined;
	const bodyStart = start + (backtick ? 1 : 2);
	if (depth > 64) return { end: command.length, body: command.slice(bodyStart) };
	let quote: "'" | '"' | undefined;
	let nesting = 1;
	const pending: PendingShellHereDocument[] = [];
	for (let i = bodyStart; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && quote !== "'") {
			i++;
			continue;
		}
		// Backticks terminate even inside quotes; their escaped spelling is
		// unescaped once before the shell parses the contained command.
		if (backtick && ch === "`") {
			return { end: i + 1, body: command.slice(bodyStart, i).replace(/\\([\\$`])/gu, "$1") };
		}
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			continue;
		}
		if (!quote && ch === "$" && command[i + 1] === "'") {
			i += 2;
			for (; i < command.length && command[i] !== "'"; i++) {
				if (command[i] === "\\") i++;
			}
			continue;
		}
		const nested = readShellSubstitution(command, i, depth + 1);
		if (nested) {
			i = nested.end - 1;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			continue;
		}
		const document = ch === "<" ? readShellHereDocumentHeader(command, i) : undefined;
		if (document) {
			pending.push(document.pending);
			i += document.length - 1;
			continue;
		}
		if (ch === "\n" && pending.length) {
			i = readShellHereDocumentBodies(command, i + 1, pending) - 1;
			continue;
		}
		if (ch === "#" && (i === bodyStart || /[\s;|&()]/u.test(command[i - 1]))) {
			const newline = command.indexOf("\n", i);
			i = (newline < 0 ? command.length : newline) - 1;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (!backtick && ch === "(") nesting++;
		else if (!backtick && ch === ")" && --nesting === 0) return { end: i + 1, body: command.slice(bodyStart, i) };
	}
	return { end: command.length, body: command.slice(bodyStart) };
}

/** Heredoc text has no quoting syntax: only backslash, $, and backticks are special. */
export function shellHereDocumentSubstitutions(body: string): string[] {
	const substitutions: string[] = [];
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "\\" && /[\\$`\n]/u.test(body[i + 1] ?? "")) {
			i++;
			continue;
		}
		if (body[i] !== "$" && body[i] !== "`") continue;
		const substitution = readShellSubstitution(body, i);
		if (!substitution) continue;
		substitutions.push(substitution.body);
		i = substitution.end - 1;
	}
	return substitutions;
}

/** One lexical piece of a shell command: a word, or its intervening separators. */
export type ShellToken = ShellWordToken | { kind: "separator"; raw: string };

/** env -S has quote removal, but shell operators are literal and \_ splits words. */
export function splitEnvCommand(command: string): string[] {
	let quoted: "'" | '"' | undefined;
	let literal = "";
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quoted === "'") {
			literal += ch;
			if (ch === "'") quoted = undefined;
			continue;
		}
		if (ch === "\\") {
			const next = command[++i] ?? "";
			if (next === "c") break;
			if (next === "_") literal += " ";
			else {
				const escapes: Record<string, string> = { f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
				literal += `\\${escapes[next] ?? next}`;
			}
			continue;
		}
		if (ch === quoted) quoted = undefined;
		else if (!quoted && (ch === "'" || ch === '"')) quoted = ch;
		else if (!quoted && ch === "#" && (i === 0 || /\s/u.test(command[i - 1]))) break;
		if (!quoted && /[;&|()<>]/u.test(ch)) literal += "\\";
		literal += ch;
	}
	return lexShellCommand(literal).flatMap(token => (token.kind === "word" ? [token.value] : []));
}

/** Execution-oriented segments retain quoting and attach stdin to its owning command.
 * Other lexical consumers keep their existing, lossless token stream.
 */
export function tokenizeShellExecutionSegments(command: string): { words: ShellWordToken[]; pipedStdin: boolean }[] {
	const segments: { words: ShellWordToken[]; pipedStdin: boolean }[] = [];
	let current: ShellWordToken[] = [];
	let pipedStdin = false;
	for (const token of lexShellCommand(command, true)) {
		if (token.kind === "word") current.push(token);
		else if (/[\n;&|()]/.test(token.raw) && current.length > 0) {
			segments.push({ words: current, pipedStdin });
			current = [];
			pipedStdin = /^\s*\|&?\s*$/u.test(token.raw);
		}
	}
	if (current.length > 0) segments.push({ words: current, pipedStdin });
	return segments;
}

/**
 * Lex a command into words and separators with their source text, so callers can rewrite words
 * and reassemble the command. Word boundaries match {@link tokenizeShellSegments}: `value` is the
 * quote/escape-removed word, `raw` its verbatim spelling; separators are runs of spaces, tabs, and
 * the operator characters `\n ; & | ( )`.
 */
export function lexShellCommand(command: string, hereDocuments = false): ShellToken[] {
	const tokens: ShellToken[] = [];
	const pending: PendingShellHereDocument[] = [];
	let value = "";
	let wordStart = -1;
	let separatorStart = -1;
	let inSingle = false;
	let inDouble = false;
	let substitutions: string[] = [];
	let dynamic = false;
	const startWord = (index: number) => {
		if (wordStart >= 0) return;
		if (separatorStart >= 0) {
			tokens.push({ kind: "separator", raw: command.slice(separatorStart, index) });
			separatorStart = -1;
		}
		wordStart = index;
	};
	const endWord = (index: number) => {
		if (wordStart < 0) return;
		tokens.push({
			kind: "word",
			raw: command.slice(wordStart, index),
			value,
			...(substitutions.length ? { substitutions } : {}),
			...(dynamic ? { dynamic } : {}),
		});
		substitutions = [];
		dynamic = false;
		value = "";
		wordStart = -1;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else value += ch;
			continue;
		}
		if (hereDocuments && ch === "\\" && command[i + 1] === "\n") {
			i++;
			continue;
		}
		if (hereDocuments && !inDouble && ch === "$" && command[i + 1] === "'") {
			startWord(i);
			const start = i + 2;
			i = start;
			for (; i < command.length && command[i] !== "'"; i++) {
				if (command[i] === "\\") i++;
			}
			value += decodeShellEscapes(command.slice(start, i)).split("\0")[0];
			continue;
		}
		if (hereDocuments && !inDouble && ch === "$" && command[i + 1] === '"') {
			startWord(i);
			inDouble = true;
			i++;
			continue;
		}
		if (hereDocuments && (inDouble ? ch === "$" || ch === "`" : "$`<>".includes(ch))) {
			const substitution = readShellSubstitution(command, i);
			if (substitution) {
				startWord(i);
				value += command.slice(i, substitution.end);
				dynamic = true;
				substitutions.push(substitution.body);
				i = substitution.end - 1;
				continue;
			}
		}
		if (hereDocuments && ch === "$" && /[A-Za-z_\d{*@$?!#-]/u.test(command[i + 1] ?? "")) dynamic = true;
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					value += next;
					i++;
					continue;
				}
			}
			if (ch === '"') inDouble = false;
			else value += ch;
			continue;
		}
		// Delimiter words use shell quote removal, but their bodies are data until
		// the next unquoted newline. Never lex literal bodies as commands.
		if (hereDocuments && ch === "<" && command[i - 1] !== "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			const redirectStart = wordStart >= 0 && /^\d+$/u.test(value) ? wordStart : i;
			if (redirectStart < i) {
				value = "";
				wordStart = -1;
			} else endWord(i);
			const header = readShellHereDocumentHeader(command, i);
			if (header) {
				startWord(redirectStart);
				const document = header.pending.document;
				document.fd = Number(command.slice(redirectStart, i) || "0");
				tokens.push({
					kind: "word",
					raw: command.slice(redirectStart, i + header.length),
					value: "",
					hereDocument: document,
				});
				pending.push(header.pending);
				wordStart = -1;
				i += header.length - 1;
				continue;
			}
		}
		if (hereDocuments && (ch === "<" || ch === ">" || (ch === "&" && command[i + 1] === ">"))) {
			const fdStart = wordStart >= 0 && /^(?:\d+|\{\w+\})$/u.test(value) ? wordStart : i;
			if (fdStart < i) {
				value = "";
				wordStart = -1;
			} else endWord(i);
			const operator = /^(?:&>>?|<<<|>>|<>|[<>][&|]?)/u.exec(command.slice(i))![0];
			startWord(fdStart);
			tokens.push({
				kind: "word",
				raw: command.slice(fdStart, i + operator.length),
				value: "",
				redirection: {
					operator,
					fd: Number(command.slice(fdStart, i) || (ch === "<" ? "0" : "1")),
				},
			});
			wordStart = -1;
			i += operator.length - 1;
			continue;
		}
		if (hereDocuments && ch === "#" && wordStart < 0) {
			// A comment may itself contain quotes or fake heredoc operators.
			if (separatorStart < 0) separatorStart = i;
			const newline = command.indexOf("\n", i);
			i = (newline < 0 ? command.length : newline) - 1;
			continue;
		}
		if (hereDocuments && ch === "\n" && pending.length > 0) {
			endWord(i);
			if (separatorStart < 0) separatorStart = i;
			i = readShellHereDocumentBodies(command, i + 1, pending) - 1;
			continue;
		}
		if (
			ch === " " ||
			ch === "\t" ||
			ch === "\n" ||
			ch === ";" ||
			ch === "&" ||
			ch === "|" ||
			ch === "(" ||
			ch === ")"
		) {
			endWord(i);
			if (separatorStart < 0) separatorStart = i;
			continue;
		}
		startWord(i);
		if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			inDouble = true;
		} else if (ch === "\\" && i + 1 < command.length) {
			value += command[i + 1];
			i++;
		} else {
			value += ch;
		}
	}
	endWord(command.length);
	if (separatorStart >= 0) tokens.push({ kind: "separator", raw: command.slice(separatorStart) });
	return tokens;
}

/** A command in a conservative, flat `&&` chain. */
interface LiteralShellCommandSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/** Literal argv after shell quote removal. */
	argv: string[];
}
const SHELL_STATEFUL_COMMANDS = new Set([
	"!",
	".",
	// Bash test -v evaluates array subscripts, including command substitutions.
	"test",
	"[",
	"[[",
	// Zsh also runs behind the Bash tool; its builtins can mutate shell state.
	"-",
	"autoload",
	"bindkey",
	"bye",
	"chdir",
	"disable",
	"emulate",
	"functions",
	"limit",
	"print",
	"rehash",
	"sched",
	"setopt",
	"unfunction",
	"unhash",
	"unlimit",
	"unsetopt",
	"vared",
	"zle",
	"zmodload",
	"zparseopts",
	"zstyle",
	"alias",
	"bg",
	"break",
	"builtin",
	"case",
	"cd",
	"command",
	"coproc",
	"continue",
	"declare",
	"dirs",
	"disown",
	"do",
	"done",
	"elif",
	"else",
	"enable",
	"esac",
	"eval",
	"exec",
	"exit",
	"export",
	"fc",
	"fg",
	"fi",
	"for",
	"function",
	"getopts",
	"hash",
	"history",
	"if",
	"in",
	"jobs",
	"let",
	"logout",
	"mapfile",
	"local",
	"popd",
	// Bash's printf -v can write BASH_CMDS and retarget a later command.
	"printf",
	"pushd",
	"readonly",
	"read",
	"readarray",
	"return",
	"select",
	"set",
	"shift",
	"shopt",
	"source",
	"suspend",
	"then",
	"time",
	"times",
	"trap",
	"typeset",
	"ulimit",
	"umask",
	"unalias",
	"unset",
	"until",
	"wait",
	"while",
]);

const SHELL_INTERPRETER_COMMANDS: Record<string, true> = {
	ash: true,
	bash: true,
	busybox: true,
	csh: true,
	dash: true,
	env: true,
	nocorrect: true,
	noglob: true,
	fish: true,
	ksh: true,
	sh: true,
	sudo: true,
	tcsh: true,
	zsh: true,
};

const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/u;
const SHELL_REINTERPRET_OPTION = /^(?:-[^-]*[ce]|--(?:command|eval)(?:=.*)?)$/u;

/**
 * Parses the deliberately small command language eligible for compound-command
 * approval: two or more literal argv commands joined only by `&&`.
 *
 * Anything that needs shell interpretation beyond quote removal is rejected.
 * In particular, this excludes expansion, globbing, redirection, comments,
 * assignments, control flow, shell wrappers/interpreters, and commands that
 * mutate the current shell. Rejection is a normal result: callers must retain
 * their existing approval behavior.
 */
export function extractLiteralAndChainSegments(command: string): LiteralShellCommandSegment[] | null {
	for (let i = 0; i < command.length; i++) {
		const code = command.charCodeAt(i);
		if ((code < 0x20 && code !== 0x09) || code === 0x7f) return null;
	}
	const segments: LiteralShellCommandSegment[] = [];
	let argv: string[] = [];
	let token = "";
	let tokenStarted = false;
	let quote: "'" | '"' | undefined;
	let segmentStart = 0;

	const pushToken = () => {
		if (!tokenStarted) return;
		argv.push(token);
		token = "";
		tokenStarted = false;
	};
	const pushSegment = (end: number): boolean => {
		pushToken();
		if (argv.length === 0) return false;
		const executable = argv[0];
		if (executable.length === 0) return false;
		const commandName = executable.slice(Math.max(executable.lastIndexOf("/"), executable.lastIndexOf("\\")) + 1);
		if (
			argv.some(argument => SHELL_ASSIGNMENT.test(argument)) ||
			argv.some((argument, index) => index > 0 && SHELL_REINTERPRET_OPTION.test(argument)) ||
			SHELL_STATEFUL_COMMANDS.has(commandName) ||
			Object.hasOwn(SHELL_INTERPRETER_COMMANDS, commandName)
		) {
			return false;
		}
		segments.push({ text: command.slice(segmentStart, end).trim(), argv });
		argv = [];
		return true;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") {
				quote = undefined;
			} else {
				token += ch;
			}
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			if (ch === "$" || ch === "`" || ch === "\n" || ch === "\r") return null;
			if (ch === "\\") {
				const next = command[i + 1];
				if (next === undefined || next === "\n" || next === "\r") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					token += next;
					i++;
				} else {
					token += ch;
				}
				continue;
			}
			token += ch;
			continue;
		}

		if (ch === "'" || ch === '"') {
			quote = ch;
			tokenStarted = true;
			continue;
		}
		if (ch === "\\") {
			const next = command[i + 1];
			if (next === undefined || next === "\n" || next === "\r") return null;
			token += next;
			tokenStarted = true;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushToken();
			continue;
		}
		if (ch === "&" && command[i + 1] === "&") {
			if (!pushSegment(i)) return null;
			i++;
			segmentStart = i + 1;
			continue;
		}
		if (
			ch === "\n" ||
			ch === "\r" ||
			ch === "&" ||
			ch === "|" ||
			ch === ";" ||
			ch === "<" ||
			ch === ">" ||
			ch === "`" ||
			ch === "$" ||
			ch === "(" ||
			ch === ")" ||
			ch === "*" ||
			ch === "?" ||
			ch === "[" ||
			ch === "]" ||
			ch === "{" ||
			ch === "}" ||
			ch === "~" ||
			(ch === "#" && !tokenStarted)
		) {
			return null;
		}
		if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f) return null;
		token += ch;
		tokenStarted = true;
	}

	if (quote || !pushSegment(command.length) || segments.length < 2) return null;
	return segments;
}

/**
 * A flat shell command segment with the context needed to decide interception.
 *
 * @see extractFlatShellCommandSegments
 */
interface FlatShellCommandSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/**
	 * True when this segment consumes the previous stage's stdout via an
	 * unquoted `|` or `|&`. Blank and comment-only continuation lines preserve
	 * the pending pipe state. Such a stage reads piped stdin, so path-based
	 * dedicated tools (read/grep/glob) cannot replace it. `||`, `;`, `&`, and
	 * `&&` start an independent command and leave this false.
	 */
	pipedStdin: boolean;
}

/**
 * Returns the flat shell command segments with the original text of each. Unlike
 * `tokenizeShellSegments`, this preserves quoting and escaping so the results
 * are safe to match against user-configured regular expressions, and flags
 * segments that receive piped stdin.
 *
 * The extractor deliberately declines to split syntax whose execution context
 * cannot be determined with this small scanner (heredocs, command substitution,
 * backticks, grouping, and malformed quoting). Callers must still check the
 * complete input in that case.
 */
export function extractFlatShellCommandSegments(command: string): FlatShellCommandSegment[] {
	const segments: FlatShellCommandSegment[] = [];
	let segmentStart = 0;
	let inSingle = false;
	let inDouble = false;
	let atWordStart = true;
	let currentPiped = false;

	const pushSegment = (end: number): boolean => {
		const segment = command.slice(segmentStart, end).trim();
		if (segment.length === 0) return false;
		segments.push({ text: segment, pipedStdin: currentPiped });
		return true;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return [];
				i++;
				continue;
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			if (ch === "`" || (ch === "$" && command[i + 1] === "(")) return [];
			continue;
		}

		if (ch === "'") {
			inSingle = true;
			atWordStart = false;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			atWordStart = false;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return [];
			i++;
			atWordStart = false;
			continue;
		}
		if (
			ch === "`" ||
			ch === "(" ||
			ch === ")" ||
			(ch === "$" && command[i + 1] === "(") ||
			(ch === "$" && command[i + 1] === "{") ||
			(ch === "<" && command[i + 1] === "<") ||
			((ch === "{" || ch === "}") &&
				atWordStart &&
				(command[i + 1] === undefined || /[ \t\n;]/.test(command[i + 1])))
		) {
			return [];
		}
		if (ch === "#" && atWordStart) {
			const pushed = pushSegment(i);
			const newline = command.indexOf("\n", i + 1);
			if (newline === -1) return segments;
			i = newline;
			segmentStart = newline + 1;
			atWordStart = true;
			// Preserve a pending pipe through a comment-only continuation.
			if (pushed) currentPiped = false;
			continue;
		}
		const isRedirectionOperatorCharacter =
			ch === "|"
				? command[i - 1] === ">"
				: ch === "&"
					? command[i - 1] === ">" || command[i - 1] === "<" || command[i + 1] === ">"
					: false;
		if ((ch === "\n" || ch === ";" || ch === "|" || ch === "&") && !isRedirectionOperatorCharacter) {
			const pushed = pushSegment(i);
			const doubled = (ch === "|" || ch === "&") && command[i + 1] === ch;
			const pipeStderr = ch === "|" && command[i + 1] === "&";
			if (doubled || pipeStderr) i++;
			// `|` and `|&` pipe into the next segment. Blank continuation
			// lines preserve that pending state; all other operators reset it.
			if (pushed || ch !== "\n") currentPiped = ch === "|" && !doubled;
			segmentStart = i + 1;
			atWordStart = true;
			continue;
		}
		atWordStart = ch === " " || ch === "\t";
	}

	if (inSingle || inDouble) return [];
	pushSegment(command.length);
	return segments;
}

/**
 * Shell metacharacters that end an unquoted `cd` target token. A redirect,
 * extra argument, or any operator in this set means the leading construct is
 * more than a bare `cd <path>`, so extraction must bail.
 */
const CD_TARGET_TERMINATORS: Record<string, true> = {
	" ": true,
	"\t": true,
	"\n": true,
	"\r": true,
	"&": true,
	"|": true,
	";": true,
	"<": true,
	">": true,
	"(": true,
	")": true,
};

/**
 * Parses a leading `cd <path> && ...` prefix so the bash tool can route the
 * target through its structured `cwd` parameter when the model omits it.
 *
 * Returns the single path token (quotes and backslash escapes resolved to their
 * literal value) and the command remainder after the top-level `&&`, or `null`
 * when the command does not begin with exactly `cd`, one path token, and a
 * top-level `&&`. The scanner deliberately bails on anything else in the prefix
 * — redirects (`cd /tmp 2>/dev/null && ...`), extra arguments, or paths needing
 * shell expansion (`$`, backticks, `(`) — leaving the whole command for the
 * shell instead of absorbing shell syntax into `cwd`.
 */
export function extractLeadingCdTarget(command: string): { path: string; rest: string } | null {
	const prefix = /^cd[ \t]+/.exec(command);
	if (!prefix) return null;
	let i = prefix[0].length;
	let path = "";
	let inSingle = false;
	let inDouble = false;
	for (; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			path += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1];
				// A line continuation crosses the first physical line. Leave it to
				// the shell rather than turning the escaped newline into cwd text.
				if (next === "\n" || next === "\r") return null;
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					path += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			path += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			// Preserve shell line-continuation semantics by declining extraction.
			if (command[i + 1] === "\n" || command[i + 1] === "\r") return null;
			path += command[i + 1];
			i++;
			continue;
		}
		if (CD_TARGET_TERMINATORS[ch]) break;
		path += ch;
	}
	// Unterminated quote or empty target: leave the command for the shell.
	if (inSingle || inDouble || path.length === 0) return null;
	// A path needing shell expansion can't be resolved literally through cwd.
	if (/[$`(]/.test(path)) return null;
	// Skip inter-token whitespace, then require a top-level `&&` (a single `&`,
	// `||`, `;`, `|`, or a redirect all mean this is not a bare `cd <path>`).
	while (command[i] === " " || command[i] === "\t") i++;
	if (command[i] !== "&" || command[i + 1] !== "&") return null;
	i += 2;
	while (command[i] === " " || command[i] === "\t") i++;
	return { path, rest: command.slice(i) };
}

/**
 * Reads one shell-style word from the start of `text`: quoted and unquoted
 * runs concatenate as a shell would (`a"b c"d` → `ab cd`), quoting/escaping
 * follows the same rules as {@link tokenizeShellSegments} (no escapes inside
 * single quotes; `\"`, `\\`, `\$`, `` \` `` inside double quotes; backslash
 * escapes the next character when unquoted), and the word ends at the first
 * unquoted whitespace character (space, tab, `\n`, or `\r`) or the end of
 * the string.
 *
 * Shared so callers reading one quoted flag value (`/loop --until "…"`) do not
 * each maintain their own `indexOf`-based quote scanner, which breaks on an
 * escaped instance of the closing delimiter.
 *
 * Returns `undefined` when `text` is empty or all leading whitespace, and
 * `"unterminated"` for an unclosed quote.
 */
export function readShellWord(text: string): { value: string; rest: string } | "unterminated" | undefined {
	let i = 0;
	while (i < text.length && /[ \t\n\r]/.test(text[i])) i++;
	if (i >= text.length) return undefined;

	let value = "";
	let inSingle = false;
	let inDouble = false;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (inSingle) {
			if (ch === "'") {
				inSingle = false;
				continue;
			}
			value += ch;
			continue;
		}
		if (inDouble) {
			if (ch === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					value += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			value += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\" && i + 1 < text.length) {
			value += text[i + 1];
			i++;
			continue;
		}
		if (/[ \t\n\r]/.test(ch)) break;
		value += ch;
	}
	if (inSingle || inDouble) return "unterminated";
	return { value, rest: text.slice(i).trim() };
}
