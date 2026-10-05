import { describe, expect, it } from "bun:test";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";

const refusal = "Session infrastructure is off-limits: report the anomaly to the lead; do not repair the host.";

function bashTool(): BashTool {
	return new BashTool({
		cwd: process.cwd(),
		hasUI: false,
		settings: Settings.isolated({
			"bash.patterns": [{ match: "*", approval: "allow" }],
			"bashInterceptor.enabled": false,
			"bash.allowCompoundCommands": true,
			shellPath: "/bin/sh",
		}),
	} as unknown as ToolSession);
}

const incidents = [
	"kill $(pgrep -u kom dbus-broker); dbus-broker --scope user &",
	"rm -f /run/user/1000/bus && dbus-daemon --session --address=unix:path=/run/user/1000/bus --fork",
];
const dangerous = [
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
	"busctl --user list",
	"pgrep dbus-broker",
	"systemctl --user status dbus",
	"systemctl --user restart my-worker",
	"killall my-worker",
	"kill $(pgrep my-worker)",
	"rm -f tmp/bus",
	"echo 'killall dbus-broker'",
	"printf '%s' '/run/user/1000/bus'",
	"pgrep dbus-broker; killall my-worker",
];

describe("bash session infrastructure default denies", () => {
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
