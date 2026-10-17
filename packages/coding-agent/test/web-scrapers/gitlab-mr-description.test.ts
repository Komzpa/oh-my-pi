import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { handleGitLab } from "../../src/web/scrapers/gitlab";

// Recorded from the GitLab API (graphviz/graphviz MR !5060) on 2026-10-14; no live network in tests.
const mrFixtureText = await Bun.file(path.join(import.meta.dir, "fixtures", "gitlab-graphviz-mr-5060.json")).text();
const mr = JSON.parse(mrFixtureText) as { description: string };
const realFetch = globalThis.fetch;

beforeEach(() => {
	globalThis.fetch = (async (input: string | URL | Request) => {
		const { pathname } = new URL(String(input instanceof Request ? input.url : input));
		const json = (body: string) =>
			new Response(body, { status: 200, headers: { "content-type": "application/json" } });
		if (pathname === "/api/v4/projects/graphviz%2Fgraphviz" || pathname === "/api/v4/projects/graphviz/graphviz") {
			return json('{"id": 4207231}');
		}
		if (pathname === "/api/v4/projects/4207231/merge_requests/5060") return json(mrFixtureText);
		return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("gitlab merge request description", () => {
	test("renders the description text and never a stringified Promise", async () => {
		const result = await handleGitLab("https://gitlab.com/graphviz/graphviz/-/merge_requests/5060", 5);
		expect(result).not.toBeNull();
		expect(result!.content).not.toContain("[object Promise]");
		expect(mr.description).toContain("Along with some other related commits");
		expect(result!.content).toContain("Along with some other related commits");
		expect(result!.content).toContain("## Description");
	});
});
