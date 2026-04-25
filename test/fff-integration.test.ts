/**
 * Tests for pi-pretty FFF integration vs SDK fallback.
 *
 * 1. Unit tests for CursorStore + fffFormatGrepText (extracted helpers)
 * 2. Integration tests via dependency injection (PiPrettyDeps)
 *    - SDK fallback path (no FFF)
 *    - FFF path (FFF injected)
 *    - Graceful degradation (FFF fails → SDK fallback)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CursorStore, fffFormatGrepText } from "../src/fff-helpers.js";
import piPrettyExtension, { type PiPrettyDeps } from "../src/index.js";

// =========================================================================
// 1. Unit tests — pure functions
// =========================================================================

describe("CursorStore", () => {
	it("stores and retrieves a cursor", () => {
		const store = new CursorStore();
		const cursor = { page: 2, offset: 50 };
		const id = store.store(cursor);
		expect(id).toMatch(/^fff_c\d+$/);
		expect(store.get(id)).toBe(cursor);
	});

	it("returns undefined for unknown id", () => {
		expect(new CursorStore().get("fff_c999")).toBeUndefined();
	});

	it("increments ids sequentially", () => {
		const store = new CursorStore();
		const n1 = Number.parseInt(store.store("a").slice(5), 10);
		const n2 = Number.parseInt(store.store("b").slice(5), 10);
		expect(n2).toBe(n1 + 1);
	});

	it("evicts oldest when exceeding maxSize", () => {
		const store = new CursorStore(3);
		const id1 = store.store("a");
		store.store("b"); store.store("c");
		expect(store.size).toBe(3);
		store.store("d");
		expect(store.size).toBe(3);
		expect(store.get(id1)).toBeUndefined();
	});

	it("default maxSize is 200", () => {
		const store = new CursorStore();
		const ids: string[] = [];
		for (let i = 0; i < 201; i++) ids.push(store.store(i));
		expect(store.size).toBe(200);
		expect(store.get(ids[0])).toBeUndefined();
		expect(store.get(ids[200])).toBe(200);
	});
});

describe("fffFormatGrepText", () => {
	it("empty → 'No matches found'", () => {
		expect(fffFormatGrepText([], 100)).toBe("No matches found");
	});

	it("single match → file:line:content", () => {
		const items = [{ relativePath: "src/a.ts", lineNumber: 42, lineContent: "const x = 1;" }];
		expect(fffFormatGrepText(items, 100)).toBe("src/a.ts:42:const x = 1;");
	});

	it("groups by file with blank separator", () => {
		const items = [
			{ relativePath: "a.ts", lineNumber: 1, lineContent: "L1" },
			{ relativePath: "a.ts", lineNumber: 5, lineContent: "L5" },
			{ relativePath: "b.ts", lineNumber: 10, lineContent: "LB" },
		];
		expect(fffFormatGrepText(items, 100).split("\n")).toEqual(["a.ts:1:L1", "a.ts:5:L5", "", "b.ts:10:LB"]);
	});

	it("truncates >500 char lines", () => {
		const items = [{ relativePath: "a.ts", lineNumber: 1, lineContent: "x".repeat(600) }];
		expect(fffFormatGrepText(items, 100)).toBe(`a.ts:1:${"x".repeat(500)}...`);
	});

	it("respects limit", () => {
		const items = [
			{ relativePath: "a.ts", lineNumber: 1, lineContent: "one" },
			{ relativePath: "a.ts", lineNumber: 2, lineContent: "two" },
			{ relativePath: "a.ts", lineNumber: 3, lineContent: "three" },
		];
		expect(fffFormatGrepText(items, 2).split("\n")).toHaveLength(2);
	});

	it("contextBefore with dash format", () => {
		const items = [{
			relativePath: "a.ts", lineNumber: 5, lineContent: "match",
			contextBefore: ["before1", "before2"],
		}];
		const lines = fffFormatGrepText(items, 100).split("\n");
		expect(lines[0]).toBe("a.ts-3-before1");
		expect(lines[1]).toBe("a.ts-4-before2");
		expect(lines[2]).toBe("a.ts:5:match");
	});

	it("contextAfter with dash format", () => {
		const items = [{
			relativePath: "a.ts", lineNumber: 5, lineContent: "match",
			contextAfter: ["after1"],
		}];
		const lines = fffFormatGrepText(items, 100).split("\n");
		expect(lines[0]).toBe("a.ts:5:match");
		expect(lines[1]).toBe("a.ts-6-after1");
	});

	it("sanitizes CRLF and CR without injecting grep record newlines", () => {
		const items = [{
			relativePath: "a.ts",
			lineNumber: 5,
			lineContent: "match\r\ncontinued\rtrail",
			contextBefore: ["before\r\nline"],
			contextAfter: ["after\rline"],
		}];
		const text = fffFormatGrepText(items, 100);
		const lines = text.split("\n");

		expect(lines).toEqual([
			"a.ts-4-before\\nline",
			"a.ts:5:match\\ncontinued\\rtrail",
			"a.ts-6-after\\rline",
		]);
		expect(lines).toHaveLength(3);
	});

	it("strips trailing CR from CRLF-backed FFF records", () => {
		const items = [{ relativePath: "a.ts", lineNumber: 5, lineContent: "match\r" }];
		expect(fffFormatGrepText(items, 100)).toBe("a.ts:5:match");
	});
});

// =========================================================================
// 2. Integration tests — via PiPrettyDeps injection
// =========================================================================

// Mock SDK tool factories
function mockToolFactory(exec: ReturnType<typeof vi.fn>) {
	return (_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	});
}

// Mock FFF finder
function mkFinder(overrides?: Record<string, any>) {
	return {
		isDestroyed: false,
		waitForScan: vi.fn().mockResolvedValue({ ok: true, value: true }),
		fileSearch: vi.fn().mockReturnValue({
			ok: true,
			value: {
				items: [{ relativePath: "src/index.ts" }, { relativePath: "src/main.ts" }],
				totalMatched: 2,
			},
		}),
		grep: vi.fn().mockReturnValue({
			ok: true,
			value: {
				items: [{ relativePath: "src/index.ts", lineNumber: 42, lineContent: "const x = 1;" }],
				totalMatched: 1,
				nextCursor: null,
			},
		}),
		multiGrep: vi.fn().mockReturnValue({
			ok: true,
			value: {
				items: [
					{ relativePath: "src/index.ts", lineNumber: 10, lineContent: "import {foo}" },
					{ relativePath: "src/main.ts", lineNumber: 5, lineContent: "const baz" },
				],
				totalMatched: 2,
				nextCursor: null,
			},
		}),
		destroy: vi.fn(),
		...overrides,
	};
}

describe("piPrettyExtension integration", () => {
	let tools: Map<string, any>;
	let events: Map<string, Function>;
	let mockPi: any;

	// SDK execute mocks
	const findExec = vi.fn();
	const grepExec = vi.fn();
	const readExec = vi.fn();
	const bashExec = vi.fn();
	const lsExec = vi.fn();

	function makeDeps(withFFF: boolean, finderOverrides?: Record<string, any>): PiPrettyDeps {
		const finder = mkFinder(finderOverrides);
		const fffModule = finderOverrides?.FileFinder
			? { FileFinder: finderOverrides.FileFinder }
			: { FileFinder: { create: vi.fn().mockReturnValue({ ok: true, value: finder }) } };
		return {
			sdk: {
				createReadToolDefinition: mockToolFactory(readExec),
				createBashToolDefinition: mockToolFactory(bashExec),
				createLsToolDefinition: mockToolFactory(lsExec),
				createFindToolDefinition: mockToolFactory(findExec),
				createGrepToolDefinition: mockToolFactory(grepExec),
				getAgentDir: () => "/tmp/pi-pretty-test",
			},
			TextComponent: class { private t = ""; setText(v: string) { this.t = v; } getText() { return this.t; } },
			fffModule: withFFF ? fffModule : undefined,
		};
	}

	beforeEach(() => {
		tools = new Map();
		events = new Map();
		mockPi = {
			registerTool: vi.fn((t: any) => tools.set(t.name, t)),
			registerCommand: vi.fn((c: any) => {}),
			on: vi.fn((e: string, h: Function) => events.set(e, h)),
		};

		for (const fn of [findExec, grepExec, readExec, bashExec, lsExec]) fn.mockReset();
		findExec.mockResolvedValue({ content: [{ type: "text", text: "src/index.ts\nsrc/main.ts" }] });
		grepExec.mockResolvedValue({ content: [{ type: "text", text: "src/index.ts:10:const x = 1;" }] });
		readExec.mockResolvedValue({ content: [{ type: "text", text: "content" }] });
		bashExec.mockResolvedValue({ content: [{ type: "text", text: "output" }] });
		lsExec.mockResolvedValue({ content: [{ type: "text", text: "f1\nf2" }] });
	});

	function load(withFFF = false, finderOverrides?: Record<string, any>) {
		const deps = makeDeps(withFFF, finderOverrides);
		piPrettyExtension(mockPi, deps);
	}

	async function loadWithFFF(finderOverrides?: Record<string, any>) {
		load(true, finderOverrides);
		const start = events.get("session_start")!;
		expect(start, "session_start not registered").toBeDefined();
		await start({}, { cwd: "/tmp/test" });
	}

	// ---- registration --------------------------------------------------

	describe("tool registration", () => {
		it("registers core tools (find, grep, read, bash, ls)", () => {
			load();
			for (const n of ["find", "grep", "read", "bash", "ls"]) {
				expect(tools.has(n), `missing: ${n}`).toBe(true);
			}
		});

		it("registers multi_grep when FFF available", () => {
			load(true);
			expect(tools.has("multi_grep")).toBe(true);
		});

		it("registers multi_grep when grep SDK available", () => {
			load(false);
			expect(tools.has("multi_grep")).toBe(true);
		});

		it("registers session_start + session_shutdown", () => {
			load();
			expect(events.has("session_start")).toBe(true);
			expect(events.has("session_shutdown")).toBe(true);
		});
	});

	// ---- find: SDK fallback (no FFF) -----------------------------------

	describe("find — SDK fallback", () => {
		it("delegates to SDK when FFF not loaded", async () => {
			load(false);
			const r = await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
			expect(findExec).toHaveBeenCalledOnce();
			expect(r.details._type).toBe("findResult");
			expect(r.details.pattern).toBe("*.ts");
		});

		it("counts matches from SDK text", async () => {
			findExec.mockResolvedValue({ content: [{ type: "text", text: "a.ts\nb.ts\nc.ts" }] });
			load(false);
			const r = await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
			expect(r.details.matchCount).toBe(3);
		});
	});

	// ---- grep: SDK fallback (no FFF) -----------------------------------

	describe("grep — SDK fallback", () => {
		it("delegates to SDK when FFF not loaded", async () => {
			load(false);
			const r = await tools.get("grep")!.execute("t1", { pattern: "TODO" }, null, null, {});
			expect(grepExec).toHaveBeenCalledOnce();
			expect(r.details._type).toBe("grepResult");
		});

		it("counts ripgrep-style matches", async () => {
			grepExec.mockResolvedValue({
				content: [{ type: "text", text: "a.ts:1:TODO\na.ts:5:TODO\nb.ts:10:TODO" }],
			});
			load(false);
			const r = await tools.get("grep")!.execute("t1", { pattern: "TODO" }, null, null, {});
			expect(r.details.matchCount).toBe(3);
		});

		it("normalizes CRLF in SDK text results", async () => {
			grepExec.mockResolvedValue({
				content: [{ type: "text", text: "a.ts:1:TODO\r\na.ts:5:TODO\rb.ts:10:TODO" }],
			});
			load(false);
			const r = await tools.get("grep")!.execute("t1", { pattern: "TODO" }, null, null, {});
			expect(r.content[0].text).toBe("a.ts:1:TODO\na.ts:5:TODO\nb.ts:10:TODO");
			expect(r.details.text).toBe("a.ts:1:TODO\na.ts:5:TODO\nb.ts:10:TODO");
			expect(r.details.matchCount).toBe(3);
		});
	});

	// ---- read -----------------------------------------------------------

	describe("read", () => {
		it("normalizes CRLF in read details content", async () => {
			readExec.mockResolvedValue({
				content: [{ type: "text", text: "line1\r\nline2\rline3" }],
			});
			load(false);
			const r = await tools.get("read")!.execute("t1", { path: "file.txt" }, null, null, {});
			expect(r.details._type).toBe("readFile");
			expect(r.details.content).toBe("line1\nline2\nline3");
			expect(r.details.lineCount).toBe(3);
		});
	});

	// ---- find: FFF path ------------------------------------------------

	describe("find — FFF path", () => {
		it("uses FFF fileSearch when initialized", async () => {
			await loadWithFFF();
			const r = await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
			expect(findExec).not.toHaveBeenCalled();
			expect(r.details._type).toBe("findResult");
			expect(r.content[0].text).toContain("src/index.ts");
		});

		it("falls back to SDK on FFF { ok: false }", async () => {
			await loadWithFFF({
				fileSearch: vi.fn().mockReturnValue({ ok: false, error: "fail" }),
			});
			await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
			expect(findExec).toHaveBeenCalledOnce();
		});

		it("falls back to SDK on FFF throw", async () => {
			await loadWithFFF({
				fileSearch: vi.fn().mockImplementation(() => { throw new Error("crash"); }),
			});
			await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
			expect(findExec).toHaveBeenCalledOnce();
		});

		it("respects limit param", async () => {
			const fileSearch = vi.fn().mockReturnValue({
				ok: true,
				value: { items: Array.from({ length: 50 }, (_, i) => ({ relativePath: `f${i}.ts` })), totalMatched: 50 },
			});
			await loadWithFFF({ fileSearch });
			await tools.get("find")!.execute("t1", { pattern: "*.ts", limit: 5 }, null, null, {});
			expect(fileSearch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pageSize: 5 }));
		});

		it("includes path in search query", async () => {
			const fileSearch = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0 } });
			await loadWithFFF({ fileSearch });
			await tools.get("find")!.execute("t1", { pattern: "*.ts", path: "src/" }, null, null, {});
			expect(fileSearch).toHaveBeenCalledWith("src/ *.ts", expect.any(Object));
		});

		it("shows partial-index + limit notices", async () => {
			await loadWithFFF({
				waitForScan: vi.fn().mockResolvedValue({ ok: true, value: false }),
				fileSearch: vi.fn().mockReturnValue({
					ok: true,
					value: { items: Array.from({ length: 200 }, (_, i) => ({ relativePath: `f${i}` })), totalMatched: 500 },
				}),
			});
			const text = (await tools.get("find")!.execute("t1", { pattern: "*" }, null, null, {})).content[0].text;
			expect(text).toContain("partial file index");
			expect(text).toContain("200 limit reached");
			expect(text).toContain("500 total matches");
		});
	});

	// ---- grep: FFF path ------------------------------------------------

	describe("grep — FFF path", () => {
		it("uses FFF grep when initialized", async () => {
			await loadWithFFF();
			const r = await tools.get("grep")!.execute("t1", { pattern: "TODO" }, null, null, {});
			expect(grepExec).not.toHaveBeenCalled();
			expect(r.content[0].text).toContain("src/index.ts:42:const x = 1;");
		});

		it("sanitizes CRLF in FFF grep output without extra records", async () => {
			await loadWithFFF({
				grep: vi.fn().mockReturnValue({
					ok: true,
					value: {
						items: [{ relativePath: "src/index.ts", lineNumber: 42, lineContent: "const x = 1;\r\nconst y = 2;" }],
						totalMatched: 1,
						nextCursor: null,
					},
				}),
			});
			const r = await tools.get("grep")!.execute("t1", { pattern: "const" }, null, null, {});
			expect(r.content[0].text).toBe("src/index.ts:42:const x = 1;\\nconst y = 2;");
			expect(r.details.text.split("\n")).toHaveLength(1);
		});

		it("literal=true → mode=plain", async () => {
			const grep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ grep });
			await tools.get("grep")!.execute("t1", { pattern: "foo", literal: true }, null, null, {});
			expect(grep).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: "plain" }));
		});

		it("no literal → mode=regex", async () => {
			const grep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ grep });
			await tools.get("grep")!.execute("t1", { pattern: "foo.*bar" }, null, null, {});
			expect(grep).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: "regex" }));
		});

		it("glob constraints bypass FFF to avoid native Unicode path panic", async () => {
			const grep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ grep });
			await tools.get("grep")!.execute("t1", { pattern: "TODO", glob: "*.ts" }, null, null, {});
			expect(grep).not.toHaveBeenCalled();
			expect(grepExec).toHaveBeenCalledOnce();
		});

		it("path constraints bypass FFF to avoid native Unicode path panic", async () => {
			const grep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ grep });
			await tools.get("grep")!.execute("t1", { pattern: "TODO", path: "file_reviewapp/static/app.js" }, null, null, {});
			expect(grep).not.toHaveBeenCalled();
			expect(grepExec).toHaveBeenCalledOnce();
		});

		it("falls back to SDK on throw", async () => {
			await loadWithFFF({ grep: vi.fn().mockImplementation(() => { throw new Error("crash"); }) });
			const r = await tools.get("grep")!.execute("t1", { pattern: "TODO" }, null, null, {});
			expect(grepExec).toHaveBeenCalledOnce();
			expect(r.details._type).toBe("grepResult");
		});

		it("cursor notice when nextCursor present", async () => {
			await loadWithFFF({
				grep: vi.fn().mockReturnValue({
					ok: true,
					value: { items: [{ relativePath: "a.ts", lineNumber: 1, lineContent: "hit" }], totalMatched: 1, nextCursor: { p: 2 } },
				}),
			});
			const text = (await tools.get("grep")!.execute("t1", { pattern: "hit" }, null, null, {})).content[0].text;
			expect(text).toContain("More results available");
			expect(text).toMatch(/cursor="fff_c\d+"/);
		});
	});

	// ---- multi_grep (FFF only) -----------------------------------------

	describe("multi_grep", () => {
		it("error for empty patterns", async () => {
			await loadWithFFF();
			const r = await tools.get("multi_grep")!.execute("t1", { patterns: [] }, null, null, null);
			expect(r.content[0].text).toContain("patterns array must have at least 1 element");
		});

		it("falls back to SDK when FFF not initialized (no session_start)", async () => {
			load(true);
			const r = await tools.get("multi_grep")!.execute("t1", { patterns: ["foo"] }, null, null, null);
			expect(grepExec).toHaveBeenCalledOnce();
			expect(r.details._type).toBe("grepResult");
		});

		it("returns multiGrep results", async () => {
			await loadWithFFF();
			const r = await tools.get("multi_grep")!.execute("t1", { patterns: ["foo", "bar"] }, null, null, null);
			expect(r.details._type).toBe("grepResult");
			expect(r.content[0].text).toContain("src/index.ts");
		});

		it("aborted signal → Aborted", async () => {
			await loadWithFFF();
			const r = await tools.get("multi_grep")!.execute("t1", { patterns: ["x"] }, { aborted: true }, null, null);
			expect(r.content[0].text).toBe("Aborted");
		});

		it("multiGrep failure → error text", async () => {
			await loadWithFFF({
				multiGrep: vi.fn().mockReturnValue({ ok: false, error: "compile failed" }),
			});
			const r = await tools.get("multi_grep")!.execute("t1", { patterns: ["[bad"] }, null, null, null);
			expect(r.content[0].text).toContain("compile failed");
		});

		it("passes context to unconstrained FFF multiGrep", async () => {
			const multiGrep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ multiGrep });
			await tools.get("multi_grep")!.execute("t1", { patterns: ["a", "b"], context: 2 }, null, null, null);
			expect(multiGrep).toHaveBeenCalledWith(expect.objectContaining({
				patterns: ["a", "b"], beforeContext: 2, afterContext: 2,
			}));
			expect(multiGrep.mock.calls[0][0]).not.toHaveProperty("constraints");
		});

		it("glob constraints bypass FFF multiGrep and use SDK fallback", async () => {
			const multiGrep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ multiGrep });
			await tools.get("multi_grep")!.execute("t1", { patterns: ["a", "b"], constraints: "*.ts", context: 2 }, null, null, {});
			expect(multiGrep).not.toHaveBeenCalled();
			expect(grepExec).toHaveBeenCalledWith(
				"t1",
				expect.objectContaining({ pattern: "a|b", glob: "*.ts", context: 2 }),
				null,
				null,
				{},
			);
		});

		it("path and constraints together bypass FFF multiGrep", async () => {
			const multiGrep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ multiGrep });
			await tools.get("multi_grep")!.execute(
				"t1",
				{ patterns: ["a", "b"], path: "src", constraints: "*.ts" },
				null,
				null,
				{},
			);
			expect(multiGrep).not.toHaveBeenCalled();
			expect(grepExec).toHaveBeenCalledWith(
				"t1",
				expect.objectContaining({ pattern: "a|b", path: "src", glob: "*.ts" }),
				null,
				null,
				{},
			);
		});

		it("falls back to SDK when path is provided", async () => {
			const multiGrep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ multiGrep });
			await tools.get("multi_grep")!.execute("t1", { patterns: ["foo", "bar"], path: "src" }, null, null, {});
			expect(multiGrep).not.toHaveBeenCalled();
			expect(grepExec).toHaveBeenCalledWith(
				"t1",
				expect.objectContaining({ pattern: "foo|bar", path: "src", ignoreCase: true }),
				null,
				null,
				{},
			);
		});

		it("falls back to SDK when constraints resolve to an existing path", async () => {
			const multiGrep = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0, nextCursor: null } });
			await loadWithFFF({ multiGrep });
			await tools.get("multi_grep")!.execute("t1", { patterns: ["foo", "bar"], constraints: "src" }, null, null, {});
			expect(multiGrep).not.toHaveBeenCalled();
			expect(grepExec).toHaveBeenCalledWith(
				"t1",
				expect.objectContaining({ pattern: "foo|bar", path: "src" }),
				null,
				null,
				{},
			);
		});

		it("maps simple glob constraints into SDK fallback", async () => {
			await loadWithFFF();
			await tools.get("multi_grep")!.execute("t1", { patterns: ["foo", "bar"], path: "src", constraints: "*.ts" }, null, null, {});
			expect(grepExec).toHaveBeenCalledWith(
				"t1",
				expect.objectContaining({ pattern: "foo|bar", path: "src", glob: "*.ts" }),
				null,
				null,
				{},
			);
		});

		it("uses case-sensitive SDK fallback when any pattern contains uppercase", async () => {
			await loadWithFFF();
			await tools.get("multi_grep")!.execute("t1", { patterns: ["foo", "Bar"], path: "src" }, null, null, {});
			expect(grepExec).toHaveBeenCalledWith(
				"t1",
				expect.objectContaining({ pattern: "foo|Bar", ignoreCase: false }),
				null,
				null,
				{},
			);
		});
	});

	// ---- session lifecycle ---------------------------------------------

	describe("session lifecycle", () => {
		it("stores FFF data under a pi-pretty-specific directory", async () => {
			const create = vi.fn().mockReturnValue({ ok: true, value: mkFinder() });
			load(true, { FileFinder: { create } });
			const start = events.get("session_start")!;
			expect(start, "session_start not registered").toBeDefined();
			await start({}, { cwd: "/tmp/test" });
			expect(create).toHaveBeenCalledWith(expect.objectContaining({
				frecencyDbPath: "/tmp/pi-pretty-test/pi-pretty/fff/frecency.mdb",
				historyDbPath: "/tmp/pi-pretty-test/pi-pretty/fff/history.mdb",
			}));
		});

		it("shutdown → subsequent find falls back to SDK", async () => {
			await loadWithFFF();
			await events.get("session_shutdown")!();
			await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
			expect(findExec).toHaveBeenCalledOnce();
		});
	});
});
