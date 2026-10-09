import { beforeEach, describe, expect, it } from "vitest";

import piPrettyExtension from "../src/index.js";
import { registerReadTool } from "../src/tools/read.js";
import { captureBashRenderer } from "./bash-renderer-harness.js";

class MockText {
	protected text = "";
	constructor(_text = "", _x = 0, _y = 0) {}
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
}

class RenderableText extends MockText {
	render(_width: number): string[] {
		return this.text.split("\n");
	}
}

const theme = { fg: (_k: string, t: string) => t, bold: (t: string) => t };

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR sequences
const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");

type Opts = { Text?: typeof MockText; exec?: (...a: any[]) => Promise<any> };

function loadTools({ Text = MockText, exec }: Opts = {}) {
	const noopExec = exec ?? (async () => ({ content: [{ type: "text", text: "" }] }));
	const tools = new Map<string, any>();
	const pi = { registerTool: (t: any) => tools.set(t.name, t), registerToolRenderer: captureBashRenderer(tools, { execute: noopExec } as any), registerCommand: () => {}, on: () => {} };
	const prev = process.env.PRETTY_ENABLE_TOOLS;
	process.env.PRETTY_ENABLE_TOOLS = "ls";
	try {
		const mk = (_cwd: string) => ({
			name: "mock",
			description: "mock",
			parameters: { type: "object", properties: {} },
			execute: noopExec,
		});
		piPrettyExtension(pi, {
			sdk: {
				createReadToolDefinition: mk,
				createBashToolDefinition: mk,
				createLsToolDefinition: mk,
				createFindToolDefinition: mk,
				createGrepToolDefinition: mk,
				getAgentDir: () => "/tmp/pi-pretty-test",
			},
			TextComponent: Text,
		});
	} finally {
		if (prev === undefined) delete process.env.PRETTY_ENABLE_TOOLS;
		else process.env.PRETTY_ENABLE_TOOLS = prev;
	}
	return tools;
}

type Extra = { outputPad?: number; durationMs?: number; isError?: boolean };

function mkCtx(expanded: boolean, state: Record<string, unknown>, extra: Extra, Text = MockText) {
	return { lastComponent: new Text(), isError: false, state, expanded, invalidate: () => {}, ...extra };
}

const SCENARIOS: Record<string, { args: any; result: any; errorText?: string }> = {
	bash: {
		args: { command: "echo out" },
		result: {
			content: [{ type: "text", text: "out" }],
			details: { _type: "bashResult", text: "out", exitCode: 0, command: "echo out" },
		},
	},
	grep: {
		args: { pattern: "todo" },
		result: {
			content: [{ type: "text", text: "a.ts:1: todo" }],
			details: { _type: "grepResult", text: "a.ts:1: todo", pattern: "todo", matchCount: 1 },
		},
	},
	find: {
		args: { pattern: "*.ts" },
		result: {
			content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
			details: { _type: "findResult", text: "src/a.ts\nsrc/b.ts", pattern: "*.ts", matchCount: 2, notices: ["n1"] },
		},
	},
	ls: {
		args: { path: "src" },
		result: {
			content: [{ type: "text", text: "a.ts\nb/" }],
			details: { _type: "lsResult", text: "a.ts\nb/", path: "src", entryCount: 2 },
		},
	},
	read: {
		args: { path: "a.ts" },
		result: {
			content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }],
			details: { _type: "readFile", filePath: "a.ts", content: "const a = 1;\nconst b = 2;", offset: 0, lineCount: 2 },
		},
	},
};

function render(name: string, expanded: boolean, extra: Extra, kind: "ok" | "error" = "ok") {
	const tool = loadTools().get(name);
	const sc = SCENARIOS[name];
	const state: Record<string, unknown> = {};
	const err = kind === "error";
	const call = tool.renderCall(sc.args, theme, mkCtx(expanded, state, { ...extra, isError: err }));
	const result = tool.renderResult(
		err ? { content: [{ type: "text", text: "boom\nsecond" }] } : sc.result,
		{},
		theme,
		mkCtx(expanded, state, { ...extra, isError: err }),
	);
	return `${call.getText()}\u0000${result.getText()}`;
}

function nonBlankRows(raw: string): string[] {
	return raw
		.replaceAll("\u0000", "\n")
		.split("\n")
		.map(strip)
		.filter((r) => r.trim() !== "");
}
const lead = (r: string) => r.length - r.trimStart().length;

const TOOLS = ["read", "bash", "ls", "find", "grep"];
const MODES: Array<[string, boolean, "ok" | "error"]> = [
	["collapsed", false, "ok"],
	["expanded", true, "ok"],
	["error", false, "error"],
];

describe("outputPad threading", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});

	for (const name of TOOLS) {
		for (const [label, expanded, kind] of MODES) {
			it(`${name} ${label}: pad undefined equals pad 1 exactly`, () => {
				expect(render(name, expanded, {}, kind)).toBe(render(name, expanded, { outputPad: 1 }, kind));
			});
			it(`${name} ${label}: pad 0 and pad 3 set the left indent`, () => {
				for (const pad of [0, 3]) {
					const rows = nonBlankRows(render(name, expanded, { outputPad: pad }, kind));
					expect(rows.length).toBeGreaterThan(0);
					expect(Math.min(...rows.map(lead))).toBe(pad);
					// Every row's smallest indent is the configured one (no hard-coded single space).
					if (pad === 0 && name !== "read" && name !== "find" && name !== "ls") expect(rows.every((r) => !r.startsWith(" "))).toBe(true);
				}
			});
		}
	}

	it("invalid outputPad values fall back to 1", () => {
		const base = render("ls", true, { outputPad: 1 });
		for (const bad of [-1, 1.5, Number.NaN, "2" as unknown as number]) {
			expect(render("ls", true, { outputPad: bad })).toBe(base);
		}
	});

	it("ls expanded nested rows scale with pad", () => {
		const rows = render("ls", true, { outputPad: 3 })
			.replaceAll("\u0000", "\n")
			.split("\n")
			.map(strip);
		expect(rows.some((r) => r.startsWith("   ├── a.ts"))).toBe(true);
	});

	it("read expanded line-number rows use the configured pad", () => {
		const rows = render("read", true, { outputPad: 3 })
			.replaceAll("\u0000", "\n")
			.split("\n")
			.map(strip);
		expect(rows.some((r) => /^ {3} {2}1 │ const a/.test(r))).toBe(true);
	});

	it("read image result stays host-owned and unindented regardless of pad", () => {
		const tool = loadTools().get("read");
		const result = {
			content: [
				{ type: "text", text: "Read image file" },
				{ type: "image", data: "x", mimeType: "image/png" },
			],
			details: { _type: "readImage", filePath: "a.png" },
		};
		const a = tool.renderResult(result, {}, theme, mkCtx(false, {}, {})).getText();
		const b = tool.renderResult(result, {}, theme, mkCtx(false, {}, { outputPad: 0 })).getText();
		expect(b).toBe(a);
		expect(result.content[1]).toEqual({ type: "image", data: "x", mimeType: "image/png" });
	});

	it("trailing blank row preserved for every pad", () => {
		for (const pad of [0, 1, 3]) {
			const raw = render("find", true, { outputPad: pad });
			const result = raw.split("\u0000")[1];
			expect(strip(result.split("\n").at(-1) ?? "x").trim()).toBe("");
		}
	});

	it("bash title at pad 0 starts at column 0", () => {
		const tool = loadTools().get("bash");
		const state: Record<string, unknown> = {};
		const call = tool.renderCall(SCENARIOS.bash.args, theme, mkCtx(false, state, { outputPad: 0 }));
		expect(strip(call.getText()).split("\n")[1].startsWith("$ echo out")).toBe(true);
	});
});

describe("durationMs preference", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});
	const withElapsed = (name: string) => {
		const r = structuredClone(SCENARIOS[name].result);
		r.details.__prettyElapsedMs = 500;
		return r;
	};
	const rows = (name: string, durationMs: number | undefined, expanded = false) => {
		const tool = loadTools().get(name);
		const state: Record<string, unknown> = {};
		const call = tool.renderCall(SCENARIOS[name].args, theme, mkCtx(expanded, state, { durationMs }));
		const res = tool.renderResult(withElapsed(name), {}, theme, mkCtx(expanded, state, { durationMs }));
		return strip(`${call.getText()}\n${res.getText()}`);
	};

	for (const name of ["bash", "find", "ls"]) {
		for (const expanded of [false, true]) {
			it(`${name} ${expanded ? "expanded" : "collapsed"}: durationMs 0 wins over metadata`, () => {
				const out = rows(name, 0, expanded);
				expect(out).toContain("0ms");
				expect(out).not.toContain("500ms");
			});
			it(`${name} ${expanded ? "expanded" : "collapsed"}: undefined falls back to metadata`, () => {
				expect(rows(name, undefined, expanded)).toContain("500ms");
			});
			it(`${name} ${expanded ? "expanded" : "collapsed"}: final host duration replaces metadata`, () => {
				const out = rows(name, 1500, expanded);
				expect(out).toContain("1.5s");
				expect(out).not.toContain("500ms");
			});
		}
	}

	it("rejected bash: final host duration wins, rejected chars remain", async () => {
		const tools = loadTools({
			exec: async () => {
				throw new Error("kaboom!");
			},
		});
		const tool = tools.get("bash");
		await expect(tool.execute("tc-1", {}, undefined, undefined, {})).rejects.toThrow("kaboom!");
		const state: Record<string, unknown> = {};
		const mk = () => ({ ...mkCtx(false, state, { durationMs: 2000, isError: true }), toolCallId: "tc-1" });
		const call = tool.renderCall({ command: "x" }, theme, mk());
		const res = tool.renderResult({ content: [{ type: "text", text: "kaboom!" }] }, {}, theme, mk());
		const out = strip(`${call.getText()}\n${res.getText()}`);
		expect(out).toContain("2.0s");
		expect(out).toContain("7 chars");
	});

	it("rejected bash: without host duration, no elapsed is invented", async () => {
		const tools = loadTools({
			exec: async () => {
				await new Promise((r) => setTimeout(r, 20));
				throw new Error("kaboom!");
			},
		});
		const tool = tools.get("bash");
		await expect(tool.execute("tc-2", {}, undefined, undefined, {})).rejects.toThrow();
		const state: Record<string, unknown> = {};
		const mk = () => ({ ...mkCtx(false, state, { isError: true }), toolCallId: "tc-2" });
		const call = tool.renderCall({ command: "x" }, theme, mk());
		const res = tool.renderResult({ content: [{ type: "text", text: "kaboom!" }] }, {}, theme, mk());
		expect(strip(`${call.getText()}\n${res.getText()}`)).not.toMatch(/\d+ms/);
	});
});

describe("bash render cache", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});
	it("re-renders when host duration or pad changes for the same component", () => {
		const tool = loadTools({ Text: RenderableText }).get("bash");
		const state: Record<string, unknown> = {};
		const c1 = mkCtx(true, state, { durationMs: 100, outputPad: 1 }, RenderableText);
		const comp = tool.renderResult(SCENARIOS.bash.result, {}, theme, c1);
		const first = comp.render(80).map(strip).join("\n");
		expect(first).toContain("100ms");
		expect(comp.render(80).map(strip).join("\n")).toBe(first);

		// Host mutates ctx in place (final duration arrives, pad setting changes).
		(c1 as any).durationMs = 250;
		(c1 as any).outputPad = 3;
		const second = comp.render(80).map(strip).join("\n");
		expect(second).toContain("250ms");
		expect(second).not.toContain("100ms");
		expect(
			second
				.split("\n")
				.find((r) => r.includes("1 lines"))
				?.startsWith("   1 lines"),
		).toBe(true);

		// Re-rendering with the reused component restores and rebuilds from new ctx.
		const c2 = { ...mkCtx(true, state, { durationMs: 0, outputPad: 0 }, RenderableText), lastComponent: comp };
		const comp2 = tool.renderResult(SCENARIOS.bash.result, {}, theme, c2);
		expect(comp2).toBe(comp);
		const third = comp2.render(80).map(strip).join("\n");
		expect(third).toContain("0ms");
		expect(
			third
				.split("\n")
				.find((r) => r.includes("1 lines"))
				?.startsWith("1 lines"),
		).toBe(true);
	});
});

describe("find hierarchy is structural", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});
	const bodyRows = (pad: number) =>
		render("find", true, { outputPad: pad }).split("\u0000")[1].split("\n").map(strip);
	for (const [pad, dirLead] of [
		[0, 0],
		[1, 1],
		[3, 3],
	] as const) {
		it(`pad ${pad}: directory at pad, files exactly one space deeper`, () => {
			const rows = bodyRows(pad);
			const dir = rows.find((r) => r.trim() === "src/");
			const file = rows.find((r) => r.trim() === "a.ts");
			expect(dir && lead(dir)).toBe(dirLead);
			expect(file && lead(file)).toBe(dirLead + 1);
		});
	}
});

describe("host duration validity", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});
	for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5]) {
		it(`ignores ${bad} and falls back to metadata`, () => {
			const tool = loadTools().get("find");
			const r = structuredClone(SCENARIOS.find.result);
			r.details.__prettyElapsedMs = 500;
			const ctx = mkCtx(true, {}, { durationMs: bad });
			expect(strip(tool.renderResult(r, {}, theme, ctx).getText())).toContain("500ms");
		});
	}
});

describe("oversized pad", () => {
	it("falls back to 1 when pad exceeds the terminal width", () => {
		process.stdout.columns = 40;
		expect(render("ls", true, { outputPad: 1_000_000_000 })).toBe(render("ls", true, { outputPad: 1 }));
		expect(render("ls", true, { outputPad: 41 })).toBe(render("ls", true, { outputPad: 1 }));
		expect(Math.min(...nonBlankRows(render("ls", true, { outputPad: 40 })).map(lead))).toBe(40);
	});
});

describe("read width budget and highlight seam", () => {
	const longLine = "x".repeat(200);
	const content = `${longLine}\nshort`;
	const result = {
		content: [{ type: "text", text: content }],
		details: { _type: "readFile", filePath: "a.txt", content, offset: 0, lineCount: 2 },
	};
	function setup(renderContent: any) {
		let tool: any;
		registerReadTool(
			{ registerTool: (t: any) => (tool = t) } as any,
			"/tmp",
			undefined,
			{ execute: async () => ({ content: [] }), parameters: {} } as any,
			MockText,
			renderContent,
		);
		return tool;
	}
	const cols = 30;
	beforeEach(() => {
		process.stdout.columns = cols;
	});

	// pad 1 is the pre-existing baseline; larger pads may not exceed it, smaller pads gain width.
	it("plain rows: pad 1 baseline unchanged, pad 0/3 consistent", () => {
		const tool = setup(async () => "");
		const rowWidth = (pad: number) => {
			const text = tool.renderResult(result, {}, theme, mkCtx(true, {}, { outputPad: pad })).getText();
			const rows = text.split("\n").map(strip);
			return {
				code: rows.find((r: string) => r.includes("│") && r.includes("xx"))!,
				divider: rows.find((r: string) => r.includes("───"))!,
			};
		};
		// gw = nw(3)+3 = 6; default cw = 30-6 = 24 chars (24th replaced by ›) => 23 x's.
		const base = rowWidth(1);
		expect(base.code.match(/x/g)!.length).toBe(23);
		expect(base.divider.trim().length).toBe(cols - 1);
		const p0 = rowWidth(0);
		expect(p0.code.match(/x/g)!.length).toBe(23);
		expect(p0.divider.trim().length).toBe(cols);
		const p3 = rowWidth(3);
		expect(p3.code.match(/x/g)!.length).toBe(21);
		expect(p3.divider.trim().length).toBe(cols - 3);
		// Total plain width never grows with pad beyond the pad-1 baseline.
		expect(p3.code.length).toBeLessThanOrEqual(base.code.length);
		expect(p3.divider.length).toBe(cols);
	});

	for (const pad of [0, 1, 3]) {
		it(`highlighted skill divider/code budget (pad ${pad})`, async () => {
			const skill = "---\nname: s\n---\nbody";
			const skillResult = {
				content: [{ type: "text", text: skill }],
				details: { _type: "readFile", filePath: "SKILL.md", content: skill, offset: 0, lineCount: 4 },
			};
			let seenWidth = -1;
			const tool = setup(async (_c: string, _f: string, _o: number, _m: number, w: number) => {
				seenWidth = w;
				return "HL";
			});
			const comp = tool.renderResult(skillResult, {}, theme, mkCtx(true, {}, { outputPad: pad }));
			await new Promise((r) => setTimeout(r, 0));
			expect(seenWidth).toBe(Math.max(1, cols - 6 - Math.max(0, pad - 1)));
			const rows = comp.getText().split("\n").map(strip);
			const divider = rows.find((r: string) => r.includes("───"))!;
			expect(divider.trim().length).toBe(Math.max(1, cols - pad));
		});
	}

	it("controlled highlight: plain first, highlighted after flush, stale discarded after pad change", async () => {
		const resolvers: Array<(v: string) => void> = [];
		let invalidated = 0;
		const tool = setup(() => new Promise<string>((r) => resolvers.push(r)));
		const state: Record<string, unknown> = {};
		const c1 = { ...mkCtx(true, state, { outputPad: 1 }), invalidate: () => invalidated++ };
		const comp = tool.renderResult(result, {}, theme, c1);
		expect(strip(comp.getText())).toContain("xxxx");
		expect(comp.getText()).not.toContain("HL-A");

		// pad changes -> new render of the same component supersedes the first promise
		const c2 = { ...mkCtx(true, state, { outputPad: 3 }), lastComponent: comp, invalidate: () => invalidated++ };
		tool.renderResult(result, {}, theme, c2);
		expect(resolvers).toHaveLength(2);

		resolvers[0]("HL-A\nHL-A2");
		await new Promise((r) => setTimeout(r, 0));
		expect(comp.getText()).not.toContain("HL-A");
		expect(invalidated).toBe(0);

		resolvers[1]("HL-B\nHL-B2");
		await new Promise((r) => setTimeout(r, 0));
		const rows = strip(comp.getText()).split("\n");
		expect(rows.some((r) => /^ {3} {2}1 │ HL-B$/.test(r))).toBe(true);
		expect(invalidated).toBe(1);
	});
});
