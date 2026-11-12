import { describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { isReadOnlyBashCommand } from "@oh-my-pi/pi-coding-agent/tools/bash-read-only";

describe("isReadOnlyBashCommand", () => {
	it.each([
		"git diff --stat",
		"git status -sb",
		"git log --oneline -n 5",
		"git show HEAD~1",
		"git rev-parse --abbrev-ref HEAD",
		"git ls-files",
		"git branch",
		"git branch --list",
		"git branch -a",
		"git branch -v",
		"rg foo | head",
		"rg 'a > b' src | wc -l",
		"ls -la packages",
		"cat a.txt && tail -n 3 b.txt",
		"grep -rn foo . | head -20",
		"find . -name '*.ts' -not -path './node_modules/*'",
		"pwd",
		"git diff --no-ext-diff --stat",
	])("accepts %s", command => {
		expect(isReadOnlyBashCommand(command)).toBe(true);
	});

	it.each([
		"",
		"git diff --output=x",
		"git diff --outp=x",
		"git log --output x",
		"git diff --ext-diff",
		"git show --textconv HEAD:a",
		"git -c core.pager=sh log",
		"git --exec-path status",
		"git -C /tmp status",
		"git commit -m x",
		"git branch -d topic",
		"git branch new-topic",
		"git push",
		"rm x",
		"ls > f",
		"ls >> f",
		"ls 2>&1",
		"ls &> f",
		"cat < f",
		"cat $(x)",
		"cat `x`",
		"cat $HOME/x",
		"cat <(x)",
		"cat <<EOF\nx\nEOF",
		"echo hi | tee f",
		"FOO=1 ls",
		"find . -delete",
		"find . -exec rm {} ;",
		"find . -fprint out",
		"find . -ok rm {} ;",
		"rg --pre ./x foo",
		"ls; rm x",
		"ls && git commit",
		"cat a | sh",
		"/bin/ls",
		"(ls)",
		'ls "unterminated',
	])("rejects %j", command => {
		expect(isReadOnlyBashCommand(command)).toBe(false);
	});
});

function approvalOf(command: string, shell = "/bin/bash") {
	const settings = Settings.isolated({
		"async.enabled": false,
		"bash.autoBackground.enabled": false,
	});
	spyOn(settings, "getShellConfig").mockReturnValue({ shell, args: ["-c"], env: {}, prefix: undefined });
	const tool = new BashTool({ settings } as unknown as ConstructorParameters<typeof BashTool>[0]);
	if (typeof tool.approval !== "function") throw new Error("Bash approval must be dynamic");
	return tool.approval({ command });
}

describe("BashTool.approval read tier", () => {
	it("reports read for allow-listed inspection and exec otherwise", () => {
		expect(approvalOf("git diff --stat")).toBe("read");
		expect(approvalOf("rg foo | head")).toBe("read");
		expect(approvalOf("git commit -m x")).toBe("exec");
		expect(approvalOf("rm x")).toBe("exec");
		expect(approvalOf("ls > f")).toBe("exec");
	});

	it("does not classify under a non-POSIX shell", () => {
		expect(approvalOf("git status", "/usr/bin/fish")).toBe("exec");
	});
});
