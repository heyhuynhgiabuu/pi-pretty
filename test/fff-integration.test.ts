/**
 * Tests for pi-pretty FFF integration vs SDK fallback.
 *
 * 1. Unit tests for CursorStore + fffFormatGrepText (extracted helpers)
 * 2. Integration tests via dependency injection (PiPrettyDeps)
 *    - SDK fallback path (no FFF)
 *    - FFF path (FFF injected)
 *    - Graceful degradation (FFF fails → SDK fallback)
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFffAutocompleteProvider } from "../src/autocomplete.js";
import { CursorStore, fffFormatGrepText } from "../src/fff-helpers.js";
import { resetSharedFffServiceForTests } from "../src/fff.js";
import piPrettyExtension, { type PiPrettyDeps } from "../src/index.js";

// =========================================================================
// 1. Unit tests — pure functions
// =========================================================================

describe("FFF autocomplete", () => {
	it("returns @-mention completion values so it replaces Pi file autocomplete", async () => {
		const finder = {
			fileSearch: () => ({
				ok: true,
				value: {
					items: [
						{ relativePath: "src/index.ts", fileName: "index.ts" },
						{ relativePath: "docs/file with space.md", fileName: "file with space.md" },
					],
				},
			}),
		};
		const currentProvider = {
			shouldTriggerFileCompletion: () => true,
			getSuggestions: () => ({ items: [], prefix: "" }),
			applyCompletion: (_input: string, _cursor: number, item: { value: string }) => ({
				newInput: item.value,
				newCursor: item.value.length,
			}),
		};

		const provider = createFffAutocompleteProvider(currentProvider, () => finder);
		const suggestions = await provider.getSuggestions(["@ind"], 0, 4, {
			signal: new AbortController().signal,
		});

		expect(suggestions.prefix).toBe("@ind");
		expect(suggestions.items.map((item) => item.value)).toEqual([
			"@src/index.ts",
			'@"docs/file with space.md"',
		]);
	});
});

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
				items: [
					{ relativePath: "src/index.ts", fileName: "index.ts" },
					{ relativePath: "src/main.ts", fileName: "main.ts" },
				],
				totalMatched: 2,
			},
		}),
    		glob: vi.fn().mockReturnValue({
    			ok: true,
    			value: {
    				items: [{ relativePath: "src/index.ts" }, { relativePath: "src/main.ts" }],
    				totalMatched: 2,
    			},
    		}),
    		getBasePath: vi.fn().mockReturnValue({ ok: true, value: "/Users/test/proj" }),
		grep: vi.fn().mockReturnValue({
			ok: true,
			value: {
				items: [{ relativePath: "src/index.ts", lineNumber: 42, lineContent: "const x = 1;" }],
				totalMatched: 1,
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
		vi.useRealTimers();
		// Isolate from shell env so each test starts with a clean slate
		delete process.env.PRETTY_DISABLE_TOOLS;
		delete process.env.PRETTY_ENABLE_TOOLS;
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

	afterEach(() => {
		resetSharedFffServiceForTests();
		vi.useRealTimers();
	});

	async function loadWithFFF(finderOverrides?: Record<string, any>) {

		load(true, finderOverrides);
		const start = events.get("session_start")!;
		expect(start, "session_start not registered").toBeDefined();
		await start({}, { cwd: "/tmp/test" });
	}

	// ---- registration --------------------------------------------------

	describe("tool registration", () => {
		it("registers core tools except ls by default", () => {
			load();
			for (const n of ["find", "grep", "read", "bash"]) {
				expect(tools.has(n), `missing: ${n}`).toBe(true);
			}
			expect(tools.has("ls")).toBe(false);
		});

		it("enables ls when explicitly requested", () => {
			process.env.PRETTY_ENABLE_TOOLS = "ls";
			load(true);
			expect(tools.has("ls")).toBe(true);
		});

		it("registers session_start + session_shutdown", () => {
			load();
			expect(events.has("session_start")).toBe(true);
			expect(events.has("session_shutdown")).toBe(true);
		});

			it("skips tools listed in PRETTY_DISABLE_TOOLS", () => {
				process.env.PRETTY_DISABLE_TOOLS = "read,find";
				load();
				expect(tools.has("read"), "read should be disabled").toBe(false);
				expect(tools.has("find"), "find should be disabled").toBe(false);
				expect(tools.has("bash"), "bash should be enabled").toBe(true);
				expect(tools.has("grep"), "grep should be enabled").toBe(true);
				expect(tools.has("ls"), "ls should remain disabled by default").toBe(false);
				delete process.env.PRETTY_DISABLE_TOOLS;
			});

		it("lets PRETTY_DISABLE_TOOLS override PRETTY_ENABLE_TOOLS", () => {
			process.env.PRETTY_ENABLE_TOOLS = "ls";
			process.env.PRETTY_DISABLE_TOOLS = "ls";
			load();
			expect(tools.has("ls"), "ls should be disabled").toBe(false);
			expect(tools.has("read"), "read should still be enabled").toBe(true);
		});



		it("handles whitespace in PRETTY_DISABLE_TOOLS", () => {
			process.env.PRETTY_DISABLE_TOOLS = " bash , ls ";
			load();
			expect(tools.has("bash"), "bash should be disabled").toBe(false);
			expect(tools.has("ls"), "ls should be disabled").toBe(false);
			expect(tools.has("read"), "read should be enabled").toBe(true);
			expect(tools.has("grep"), "grep should be enabled").toBe(true);
			delete process.env.PRETTY_DISABLE_TOOLS;
		});

			it("empty PRETTY_DISABLE_TOOLS preserves the default disabled tools", () => {
				process.env.PRETTY_DISABLE_TOOLS = "";
				load();
				for (const n of ["find", "grep", "read", "bash"]) {
					expect(tools.has(n), `missing: ${n}`).toBe(true);
				}
				expect(tools.has("ls")).toBe(false);
				delete process.env.PRETTY_DISABLE_TOOLS;
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
    				glob: vi.fn().mockReturnValue({ ok: false, error: "fail" }),
    			});
    			await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
    			expect(findExec).toHaveBeenCalledOnce();
    		});

    		it("falls back to SDK on FFF throw", async () => {
    			await loadWithFFF({
    				glob: vi.fn().mockImplementation(() => { throw new Error("crash"); }),
    			});
    			await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
    			expect(findExec).toHaveBeenCalledOnce();
    		});

    		it("respects limit param", async () => {
    			const glob = vi.fn().mockReturnValue({
    				ok: true,
    				value: { items: Array.from({ length: 50 }, (_, i) => ({ relativePath: `f${i}.ts` })), totalMatched: 50 },
    			});
    			await loadWithFFF({ glob });
    			await tools.get("find")!.execute("t1", { pattern: "*.ts", limit: 5 }, null, null, {});
    			expect(glob).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ pageSize: 5 }));
    		});

    		it("combines path and pattern into glob pattern", async () => {
    			const glob = vi.fn().mockReturnValue({ ok: true, value: { items: [], totalMatched: 0 } });
    			await loadWithFFF({ glob });
    			await tools.get("find")!.execute("t1", { pattern: "*.ts", path: "src" }, null, null, {});
    			expect(glob).toHaveBeenCalledWith("src/**/*.ts", expect.any(Object));
    		});

    		it("shows partial-index + limit notices", async () => {
			await loadWithFFF({
				waitForScan: vi.fn().mockResolvedValue({ ok: true, value: false }),
				glob: vi.fn().mockReturnValue({
					ok: true,
					value: { items: Array.from({ length: 200 }, (_, i) => ({ relativePath: `f${i}` })), totalMatched: 500 },
				}),
    		});
    		const result = await tools.get("find")!.execute("t1", { pattern: "*", limit: 200 }, null, null, {});
			const notices = (result.details as any).notices as string[];
			expect(notices).toContain("FFF index incomplete; results may be missing files");
			expect(notices).toContain("200 limit reached");
			expect(notices).toContain("500 total matches");
		});
	// ---- grep: FFF path ------------------------------------------------
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

		it("delayed FFF status clear does not read a stale session ctx", async () => {
			vi.useFakeTimers();
			const setStatus = vi.fn();
			let stale = false;
			const ctx = {
				cwd: "/tmp/test",
				get ui() {
					if (stale) throw new Error("stale ctx");
					return { setStatus };
				},
			};

			load(true);
			const start = events.get("session_start")!;
			await start({}, ctx);
			stale = true;

			vi.advanceTimersByTime(3000);

			expect(setStatus).toHaveBeenNthCalledWith(1, "fff", "FFF indexed");
			expect(setStatus).toHaveBeenNthCalledWith(2, "fff", undefined);
		});

		it("shutdown keeps shared FFF service for session resume", async () => {
			await loadWithFFF();
			await events.get("session_shutdown")!();
			await tools.get("find")!.execute("t1", { pattern: "*.ts" }, null, null, {});
			expect(findExec).not.toHaveBeenCalled();
		});
	});
});
