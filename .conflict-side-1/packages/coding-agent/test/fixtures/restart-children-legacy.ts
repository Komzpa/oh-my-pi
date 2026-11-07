import { restartChildrenEnvironment } from "../../src/restart-children";
const [wrapper, successor, mode] = process.argv.slice(2);
const inherited = mode === "late" ? restartChildrenEnvironment() : {};
// The old Bun runtime loses its subprocess handle on exec, before child exit.
const child = Bun.spawn(["sh", "-c", "sleep .1"], { stdout: "ignore", stderr: "ignore" });
const env = { ...process.env };
delete env.OMP_RESTART_CHILDREN;
Object.assign(env, inherited);
process.execve!(Bun.which("python3")!, ["python3", wrapper!, process.execPath, successor!, String(child.pid)], env);
