import { expect, it } from "bun:test";
import { browserSpawnCommand } from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";

it("removes session bus addresses only from the spawned browser on Linux", async () => {
	const launch = browserSpawnCommand({
		executablePath: process.execPath,
		args: [
			"-e",
			"console.log(JSON.stringify({ session: process.env.DBUS_SESSION_BUS_ADDRESS, starter: process.env.DBUS_STARTER_ADDRESS, owner: process.env.OMP_SESSION_ID }))",
		],
	});
	const env = {
		...process.env,
		DBUS_SESSION_BUS_ADDRESS: "session",
		DBUS_STARTER_ADDRESS: "starter",
		OMP_SESSION_ID: "owner",
	};
	const child = Bun.spawn([launch.application, ...launch.args], { env, stdout: "pipe", stderr: "pipe" });
	const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
	expect(exit).toBe(0);
	expect(JSON.parse(output)).toEqual(
		process.platform === "linux" ? { owner: "owner" } : { session: "session", starter: "starter", owner: "owner" },
	);
	expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("session");
	expect(env.DBUS_STARTER_ADDRESS).toBe("starter");
});
