/** Build the offline harness or CLI floor with the production compiler, bytecode and JSON plugins. */
import * as path from "node:path";
import { compileCodingAgent } from "../scripts/compile-binary";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cli = process.argv.includes("--cli");
await compileCodingAgent({
	repoRoot,
	entrypoint: path.join(import.meta.dir, cli ? "../src/cli.ts" : "restart-end-to-end.ts"),
	outfile: path.resolve(process.argv[2] ?? path.join(repoRoot, ".tmp", cli ? "omp-restart-floor" : "restart-e2e")),
	native: { platform: process.platform, arch: process.arch },
});
