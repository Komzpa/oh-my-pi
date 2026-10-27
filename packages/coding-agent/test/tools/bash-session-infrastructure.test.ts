import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";

const refusal = "Session infrastructure is off-limits: report the anomaly to the lead; do not repair the host.";

function bashTool(): BashTool {
	return new BashTool({
		cwd: process.cwd(),
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		settings: Settings.isolated({
			"bash.patterns": [{ match: "*", approval: "allow" }],
			"bashInterceptor.enabled": false,
			"bash.allowCompoundCommands": true,
			"bash.autoBackground.enabled": false,
			"worktree.clone": false,
			shellPath: "/bin/sh",
		}),
	} as unknown as ToolSession);
}

const incidents = [
	"systemctl --user restart plasma-plasmashell.service",
	"timeout 5 killall plasmashell",
	"printf 'killall plasmashell\\n' | sh",
	"bash -c $'killall\\x20plasmashell'",
	'echo "$(killall plasmashell)"',
	"> /dev/null killall plasmashell",
	"if true; then killall plasmashell; fi",
	"kill $(pgrep -u user dbus-broker); dbus-broker --scope user &",
	"rm -f /run/user/1000/bus && dbus-daemon --session --address=unix:path=/run/user/1000/bus --fork",
];
// Payload nesting beyond the inspection depth is refused rather than trusted.
let deeplyNested = "true";
for (let i = 0; i < 6; i++) deeplyNested = `sh -c '${deeplyNested.replaceAll("'", `'\\''`)}'`;
const dangerous = [
	"systemctl --user stop plasma-kwin_wayland.service",
	"systemctl --user kill plasma-plasmashell@session.service",
	"pkill -f plasma-kwin_wayland",
	"timeout --signal TERM --kill-after=1 5 killall plasmashell",
	"timeout -k1 -s TERM 5 bash -c 'killall plasmashell'",
	"setsid --wait killall plasmashell",
	"stdbuf -oL killall plasmashell",
	"stdbuf -o L --error=0 sh -c 'killall plasmashell'",
	"doas -u root killall plasmashell",
	"doas -n killall plasmashell",
	"xargs killall <<< plasmashell",
	"printf 'plasmashell\\n' | xargs -n1 killall",
	"xargs -I{} killall {} <<< plasmashell",
	"xargs --replace=TARGET killall TARGET <<< plasmashell",
	"xargs -I {} sh -c {} <<< 'killall plasmashell'",
	"xargs -0 sh -c <<< 'killall plasmashell'",
	"xargs -d : killall <<< plasmashell:",
	"xargs --delimiter : killall <<< plasmashell:",
	"xargs --delimiter=: killall <<< plasmashell:",
	"xargs -- killall plasmashell",
	"xargs -n1 sh -c <<'EOF'\n'echo safe'\n'killall plasmashell'\nEOF",
	"xargs --max-args=1 sh -c <<'EOF'\n'echo safe'\n'killall plasmashell'\nEOF",
	"xargs -i{} killall {} <<< plasmashell",
	"xargs -rI{} killall {} <<< plasmashell",
	"xargs -rn1 sh -c <<'EOF'\n'echo safe'\n'killall plasmashell'\nEOF",
	"sh <(printf 'killall plasmashell')",
	"sh < <(printf 'killall plasmashell')",
	"cat <(printf 'killall plasmashell') | sh",
	"printf 'killall plasmashell' |\nsh",
	'bash -c $"killall plasmashell"',
	'$"killall" plasmashell',
	"cat <<$'E\\x4fF'\nsafe\nEOF\nkillall plasmashell",
	"sh <<$'E\\x4fF'\nkillall plasmashell\nEOF",
	"killall $'plasma\\x73hell'",
	"printf 'killall plasmashell' | sh -c 'cat' | sh",
	"printf '%s\\n' 'killall plasmashell' | sh",
	"printf '%b' 'killall\\040plasmashell' | bash",
	"printf '%s %s' killall plasmashell | sh",
	"echo 'killall plasmashell' | sh",
	"echo -e 'killall\\x20plasmashell' | sh",
	"printf 'killall plasmashell' | cat | sh",
	"cat <<'EOF' | sh\nkillall plasmashell\nEOF",
	"echo 'killall plasmashell' | sh -s -- arg",
	"bash -c $'killall\\040plasmashell'",
	"bash -c $'killall\\u0020plasmashell'",
	"bash -c $'killall\\U00000020plasmashell'",
	"$'kill\\x61ll' plasmashell",
	"bash -c pre$'fix;killall\\x20plasmashell'",
	"eval -- 'killall plasmashell'",
	"sh 3<<'EOF' <&3\nkillall plasmashell\nEOF",
	"env -S 'sh -c \"killall\\_plasmashell\"'",
	"zsh -oerrexit -c 'killall plasmashell'",
	"env -S 'sh -c \"killall plasmashell\"'",
	"env --split-string='killall plasmashell'",
	"bash +c 'killall plasmashell'",
	"sudo -n killall plasmashell",
	"sudo -u root -n killall plasmashell",
	"sudo --user=root killall plasmashell",
	"nice -n 5 killall plasmashell",
	"nice -n5 killall plasmashell",
	"ionice -c 3 killall plasmashell",
	"exec -a worker sh -c 'killall plasmashell'",
	"time -p killall plasmashell",
	"busybox sh -c 'killall plasmashell'",
	'echo "$(echo safe # )\nkillall plasmashell)"',
	"echo \"$(cat <<'EOF'\n)\nEOF\nkillall plasmashell)\"",
	"kill\\\nall plasmashell",
	'echo "$(kill\\\nall plasmashell)"',
	// Round 2: expansions execute independently of the receiving command.
	'echo "`pkill Xwayland`"',
	"echo $(killall plasmashell)",
	"echo `killall plasmashell`",
	'echo "$(echo "$(killall plasmashell)")"',
	"echo $(printf '%s' ')'; killall plasmashell)",
	'FOO="$(killall plasmashell)" true',
	'echo > "$(killall plasmashell)"',
	"cat <(killall plasmashell)",
	"echo ready > >(killall plasmashell)",
	"cat <<EOF\n$(killall plasmashell)\nEOF",
	"cat <<EOF\n'$(killall plasmashell)'\nEOF",
	"cat <<EOF\n`killall plasmashell`\nEOF",
	"cat <<EOF\n$(printf '%s' ')'; killall plasmashell)\nEOF",
	// Redirects can occur anywhere in a simple command, without whitespace.
	"2>/dev/null killall plasmashell",
	"2>&1 killall plasmashell",
	"<>/dev/null killall plasmashell",
	"&>/dev/null killall plasmashell",
	"3>&- >|/dev/null killall plasmashell",
	"FOO=1 > /dev/null killall plasmashell",
	"killall > /dev/null plasmashell",
	">/dev/null sh -c 'killall plasmashell'",
	"sh > /dev/null -c 'killall plasmashell'",
	"sh -c > /dev/null 'killall plasmashell'",
	"sh <<< 'killall plasmashell'",
	"sh -s -- arg <<'EOF'\nkillall plasmashell\nEOF",
	"bash --noprofile -o errexit <<'EOF'\nkillall plasmashell\nEOF",
	// Shell option operands and positional arguments have different boundaries.
	"bash -oc errexit 'killall plasmashell'",
	"bash -co errexit 'killall plasmashell'",
	"bash -c -e 'killall plasmashell'",
	"bash -c -- 'killall plasmashell'",
	"bash -O extglob -c 'killall plasmashell'",
	"bash --rcfile /dev/null -c 'killall plasmashell'",
	"dash -ec 'killall plasmashell'",
	"zsh -lc 'killall plasmashell'",
	"ksh -c 'killall plasmashell'",
	"ash -c 'killall plasmashell'",
	deeplyNested,
	"if killall plasmashell; then echo done; fi",
	"while false; do pkill Xwayland; done",
	"for item in one; do rm -f /run/user/1000/bus; done",
	"if false; then true; else systemctl --user stop dbus.service; fi",
	"{ killall plasmashell; }",
	"cat <<'EOF'\nkillall plasmashell\nEOF\nkillall Xwayland",
	"sh <<'EOF'\nkillall plasmashell\nEOF",
	"<<'EOF' sh\nkillall plasmashell\nEOF",
	"0<<'EOF' sh -s\nkillall plasmashell\nEOF",
	"cat <<'EOF'\n'\nEOF\nkillall plasmashell",
	"cat <<'EOF' # a comment with an unmatched quote ' \ntext\nEOF\nkillall plasmashell",
	...incidents,
	"kill -TERM $(pgrep -f 'systemd --user')",
	'kill "$(pgrep dbus-daemon)"',
	"kill `pgrep dbus-broker`",
	"echo ready && killall plasmashell",
	"sudo /usr/bin/pkill -f Xwayland",
	"rm -f '/run/user/1001/bus'",
	"rm -r /run/user/*/anything",
	"systemctl --user stop dbus.service",
	"systemctl restart --user dbus-broker.service",
	"systemctl --user kill 'dbus*'",
	`sh -c 'rm -f "$XDG_RUNTIME_DIR/bus"'`,
	"bash -lc 'killall dbus-broker'",
	"sudo env FOO=1 sh -c \"sh -c 'pkill plasmashell'\"",
	"eval 'rm -f /run/user/1000/bus'",
];
for (const target of [
	"dbus-broker",
	"dbus-daemon",
	"kwin_wayland",
	"kwin_x11",
	"kwin*",
	"plasmashell",
	"Xwayland",
	"yakuake",
]) {
	for (const command of ["kill", "pkill", "killall"]) dangerous.push(`${command} ${target}`);
}

const allowed = [
	"systemctl --user restart ordinary.service",
	"systemctl --user restart ordinary-plasmashell-helper.service",
	"echo plasma-plasmashell.service",
	"timeout 5 echo killall plasmashell",
	"timeout --kill-after 1 5 sh -c 'echo killall plasmashell'",
	"setsid echo killall plasmashell",
	"stdbuf --output L echo killall plasmashell",
	"doas -C config killall plasmashell",
	"doas -u root echo killall plasmashell",
	"xargs echo <<< 'killall plasmashell'",
	"xargs <<< 'killall plasmashell'",
	"xargs -I{} echo {} <<< 'killall plasmashell'",
	"xargs -I{} sh -c 'echo {}' <<< 'killall plasmashell'",
	"xargs -a input killall <<< plasmashell",
	"xargs sh -c 'echo safe' _ -c 'killall plasmashell'",
	"xargs -E STOP killall <<'EOF'\nSTOP\nplasmashell\nEOF",
	"xargs --help killall plasmashell",
	"timeout --help 5 killall plasmashell",
	"cat <(printf 'killall plasmashell')",
	"sh -c 'echo safe' <(printf 'killall plasmashell')",
	"sh -s <(printf 'killall plasmashell') </dev/null",
	"echo $'$(killall plasmashell)'",
	"echo $'escaped\\\'$(killall plasmashell)'",
	'echo $"killall plasmashell"',
	"cat <<$'E\\x4fF'\nkillall plasmashell\nEOF",
	"printf 'killall plasmashell\\n' | cat",
	"printf 'killall plasmashell\\n'; sh",
	"printf 'killall plasmashell\\n' && sh",
	"printf 'killall plasmashell\\n' | sh -c 'cat'",
	"printf 'killall plasmashell\\n' >/dev/null | sh",
	"printf 'killall plasmashell\\n' | sh </dev/null",
	"printf 'killall plasmashell\\n' | cat </dev/null | sh",
	"printf 'echo killall plasmashell\\n' | sh",
	"echo $'killall\\x20plasmashell'",
	"echo \"$'killall\\x20plasmashell'\"",
	"bash -c $'echo\\x20killall\\x20plasmashell'",
	"bash -c 'echo safe' _ $'killall\\x20plasmashell'",
	"eval -- 'echo killall plasmashell'",
	"sh 3<<'EOF' <&3 </dev/null\nkillall plasmashell\nEOF",
	"env -S 'killall; plasmashell'",
	"env -S 'echo killall plasmashell'",
	"env -S 'echo $(killall plasmashell)'",
	"command -v killall plasmashell",
	"echo \"$(cat <<'EOF'\n)\nkillall plasmashell\nEOF\n)\"",
	"nice -n 5 echo killall plasmashell",
	"sudo -n echo killall plasmashell",
	"echo '$(killall plasmashell)'",
	"echo '`killall plasmashell`'",
	'echo "\\$(killall plasmashell)"',
	'echo "\\`killall plasmashell\\`"',
	"echo \\`killall plasmashell\\`",
	"echo $(printf '%s' 'killall plasmashell')",
	'echo "$(printf %s "killall plasmashell")"',
	"echo '<(killall plasmashell)'",
	'echo "<(killall plasmashell)"',
	"cat <<EOF\nkillall plasmashell\nEOF",
	"cat <<EOF\n'\nkillall plasmashell\nEOF",
	"cat <<EOF\n\\$(killall plasmashell)\nEOF",
	"cat <<EOF\n\\`killall plasmashell\\`\nEOF",
	"cat <<EOF\n$(echo 'killall plasmashell')\nEOF",
	"sh 3<<'EOF'\nkillall plasmashell\nEOF",
	"sh <<'EOF' </dev/null\nkillall plasmashell\nEOF",
	"sh -c 'echo safe' <<'EOF'\nkillall plasmashell\nEOF",
	"bash -c 'printf \"%s\\n\" \"$@\"' _ -c 'killall plasmashell'",
	"bash script.sh -c 'killall plasmashell'",
	"bash -- -c 'killall plasmashell'",
	"bash - script.sh -c 'killall plasmashell'",
	"sh -s -- -c 'killall plasmashell' <<'EOF'\necho safe\nEOF",
	"bash -c 'echo safe' _ -lc 'killall plasmashell'",
	"bash --rcfile /dev/null script.sh -c 'killall plasmashell'",
	"printf '%s' '> /dev/null killall plasmashell'",
	"echo '2>&1 killall plasmashell'",
	">/dev/null echo killall plasmashell",
	"cat > /dev/null <<EOF\nkillall plasmashell\nEOF",
	"busctl --user list",
	"cat > /tmp/example.sh <<'EOF'\nkillall plasmashell\nEOF",
	'cat <<"EOF"\nkillall plasmashell\nEOF',
	"cat <<\\EOF\nkillall plasmashell\nEOF",
	"cat <<-'EOF'\n\tkillall plasmashell\n\tEOF",
	"cat <<'FIRST' <<'SECOND'\nkillall plasmashell\nFIRST\npkill Xwayland\nSECOND",
	"cat <<'EOF'\n$(killall plasmashell)\n`pkill Xwayland`\n'\nEOF",
	"sh script.sh <<'EOF'\nkillall plasmashell\nEOF",
	"sh <<'FIRST' <<'SECOND'\nkillall plasmashell\nFIRST\necho safe\nSECOND",
	"cat <<< 'killall plasmashell'",
	"echo then killall plasmashell",
	"if true; then echo killall plasmashell; fi",
	"pgrep dbus-broker",
	"systemctl --user status dbus",
	"systemctl --user restart my-worker",
	"killall my-worker",
	"kill $(pgrep my-worker)",
	"rm -f tmp/bus",
	"echo 'killall dbus-broker'",
	"printf '%s' '/run/user/1000/bus'",
	"pgrep dbus-broker; killall my-worker",
	"sh -c 'echo killall dbus-broker'",
	"bash -c 'killall my-worker'",
	"sh script.sh",
];

describe("bash session infrastructure default denies", () => {
	it("classifies review payloads without executing them", () => {
		const cases: Array<[string, boolean]> = [
			["printf '' | xargs -n1 killall plasmashell", true],
			["printf '' | xargs --max-args=1 killall plasmashell", true],
			["printf '' | xargs -rn1 killall plasmashell", false],
			["printf '' | xargs --no-run-if-empty -n1 killall plasmashell", false],
			["printf '' | xargs -I{} killall plasmashell", false],
			["printf 'killall plasmashell\\n' | sh -c 'true; sh'", true],
			["printf 'killall plasmashell\\n' | sh -c 'echo safe; sh'", true],
			["printf 'killall plasmashell\\n' | sh -c 'cat; sh'", false],
			["printf 'killall plasmashell\\n' | sh -c 'true; sh </dev/null'", false],
			["bash -n -c 'killall plasmashell'", false],
			["bash -nc 'killall plasmashell'", false],
			["bash -o noexec -c 'killall plasmashell'", false],
			["bash -n <<'EOF'\nkillall plasmashell\nEOF", false],
			["bash -n <(printf 'killall plasmashell')", false],
			["bash -n +n -c 'killall plasmashell'", true],
			["bash -n +o noexec -c 'killall plasmashell'", true],
			['bash -n -c "$(killall plasmashell)"', true],
			["bash -n <<EOF\n$(killall plasmashell)\nEOF", true],
			["printf '' | xargs -n1 echo killall plasmashell", false],
		];
		for (const [command, denied] of cases) {
			const decision = bashTool().approval({ command });
			expect(typeof decision === "object" && decision.policy === "deny", command).toBe(denied);
		}
	});
	it("runs safe review controls through the real shell consumer", async () => {
		for (const [command, expected] of [
			["printf '' | xargs -n1 printf empty-xargs", "empty-xargs"],
			["printf 'printf inherited-stdin\\n' | sh -c 'true; sh'", "inherited-stdin"],
			["bash -n -c 'printf syntax-must-not-run'", "(no output)"],
		]) {
			const result = await bashTool().execute("safe-review-control", { command });
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
			expect(text).toBe(expected);
		}
	});
	it("executes an allowed literal pipeline through the normal backend", async () => {
		const result = await bashTool().execute("literal-pipeline", {
			command: "printf 'printf verified-pipeline\\n' | sh",
		});
		expect(result.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("verified-pipeline") }),
			]),
		);
	});
	it("executes unquoted heredoc text and shell positional arguments as data", async () => {
		for (const command of [
			"cat <<EOF\nkillall plasmashell\nEOF",
			"bash -c 'printf \"%s\\n\" \"$@\"' _ -c 'killall plasmashell'",
		]) {
			// These strings are data even on the regression baseline.
			const result = await bashTool().execute("round-2-data", { command });
			expect(result.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "text", text: expect.stringContaining("killall plasmashell") }),
				]),
			);
		}
	});
	it("executes a literal heredoc as data through the normal backend", async () => {
		const result = await bashTool().execute("literal-heredoc", {
			command: "cat <<'EOF'\nkillall plasmashell\nEOF",
		});
		expect(result.content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "text", text: expect.stringContaining("killall plasmashell") }),
			]),
		);
	});
	for (const command of dangerous) {
		it(`denies ${command}`, () => {
			expect(bashTool().approval({ command })).toEqual({
				tier: "exec",
				override: true,
				policy: "deny",
				reason: refusal,
			});
		});
	}
	for (const command of allowed) {
		it(`allows inspection or unrelated work: ${command}`, () => {
			const decision = bashTool().approval({ command });
			expect(typeof decision === "object" ? decision.policy : undefined).not.toBe("deny");
		});
	}
	for (const command of incidents) {
		it(`refuses direct execution before any backend: ${command}`, async () => {
			const bash = bashTool();
			// Never execute incident commands on an unpatched baseline.
			expect(bash.approval({ command })).toMatchObject({ policy: "deny" });
			for (const mode of [{}, { async: true }, { pty: true }, { name: "forbidden-service" }]) {
				await expect(bash.execute("incident", { command, ...mode })).rejects.toThrow(refusal);
			}
		});
	}
});
