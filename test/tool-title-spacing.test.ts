import { beforeEach, describe, expect, it } from "vitest";

import piPrettyExtension from "../src/index.js";
import { captureBashRenderer } from "./bash-renderer-harness.js";

class MockText {
	private text = "";
	constructor(_text = "", _x = 0, _y = 0) {}
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
}

const mockTheme = {
	fg: (_key: string, text: string) => text,
	bold: (text: string) => text,
};

function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR sequences from rendered output
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function loadTools() {
	const noopExec = async () => ({ content: [{ type: "text", text: "" }] });
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerToolRenderer: captureBashRenderer(tools),
		registerCommand: () => {},
		on: () => {},
	};

	// ls sits in DEFAULT_DISABLED_TOOLS — enable it for the render sweep.
	const previousEnabledTools = process.env.PRETTY_ENABLE_TOOLS;
	process.env.PRETTY_ENABLE_TOOLS = "ls";
	try {
		piPrettyExtension(pi, {
			sdk: {
				createReadToolDefinition: noopCwd(noopExec),
				createBashToolDefinition: noopCwd(noopExec),
				createLsToolDefinition: noopCwd(noopExec),
				createFindToolDefinition: noopCwd(noopExec),
				createGrepToolDefinition: noopCwd(noopExec),
				getAgentDir: () => "/tmp/pi-pretty-test",
			},
			TextComponent: MockText,
		});
	} finally {
		if (previousEnabledTools === undefined) {
			delete process.env.PRETTY_ENABLE_TOOLS;
		} else {
			process.env.PRETTY_ENABLE_TOOLS = previousEnabledTools;
		}
	}

	return tools;
}

function noopCwd(exec: any) {
	return (_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	});
}

type Ctx = {
	lastComponent: MockText;
	isError: boolean;
	state: Record<string, unknown>;
	expanded: boolean;
	invalidate: () => void;
};

function ctx(expanded: boolean, state: Record<string, unknown> = {}): Ctx {
	return { lastComponent: new MockText(), isError: false, state, expanded, invalidate: () => {} };
}

/**
 * The host (ToolExecutionComponent, renderShell "self") stacks the renderCall
 * component and the renderResult component with no spacer between them, so the
 * visible rows are exactly the concatenation of both text payloads.
 */
function stackedRows(call: { getText(): string }, result: { getText(): string }): string[] {
	const callRows = call.getText() ? call.getText().split("\n") : [];
	return [...callRows, ...(result.getText() ? result.getText().split("\n") : [])].map(stripAnsi);
}

describe("tool title/result spacing (blank rows around titles)", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});

	it("bash collapsed: summary moves into the title row", () => {
		const tool = loadTools().get("bash");
		const state: Record<string, unknown> = {};
		const call = tool.renderCall({ command: "echo out" }, mockTheme, ctx(false, state));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "out" }], details: { _type: "bashResult", text: "out", exitCode: 0, command: "echo out" } },
			{},
			mockTheme,
			ctx(false, state),
		);
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]).toContain("$ echo out");
		expect(rows[1]).toContain("1 lines · ctrl+o to expand");
		expect(rows[2]?.trim()).toBe("");
		expect(rows).toHaveLength(3);
	});

	it("bash expanded: title padding does not remove internal info/body spacing", () => {
		const tool = loadTools().get("bash");
		const state: Record<string, unknown> = {};
		const call = tool.renderCall({ command: "echo out" }, mockTheme, ctx(true, state));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "out" }], details: { _type: "bashResult", text: "out", exitCode: 0, command: "echo out" } },
			{},
			mockTheme,
			ctx(true, state),
		);
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]?.trim()).toBe("$ echo out");
		expect(rows[2]?.trim()).toBe("");
		expect(rows[3]).toContain("1 lines");
		expect(rows[4]?.trim()).toBe(""); // info → body separator
		expect(rows[5]).toContain("out");
		expect(rows.at(-1)?.trim()).toBe("");
	});

	it("grep collapsed: summary moves into the title row", () => {
		const tool = loadTools().get("grep");
		const state: Record<string, unknown> = {};
		const call = tool.renderCall({ pattern: "todo" }, mockTheme, ctx(false, state));
		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "a.ts:1: todo" }],
				details: { _type: "grepResult", text: "a.ts:1: todo", pattern: "todo", matchCount: 1 },
			},
			{},
			mockTheme,
			ctx(false, state),
		);
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]).toContain("✱ grep");
		expect(rows[1]).toContain("1 lines — ctrl+o to expand");
		expect(rows[2]?.trim()).toBe("");
		expect(rows).toHaveLength(3);
	});

	it("find expanded: title has top and bottom padding", () => {
		const tool = loadTools().get("find");
		const state: Record<string, unknown> = {};
		const call = tool.renderCall({ pattern: "*.ts" }, mockTheme, ctx(true, state));
		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
				details: { _type: "findResult", text: "src/a.ts\nsrc/b.ts", pattern: "*.ts", matchCount: 2 },
			},
			{},
			mockTheme,
			ctx(true, state),
		);
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]?.trim()).toContain("✱ find");
		expect(rows[2]?.trim()).toBe("");
		expect(rows[3]).toContain("2 files");
		expect(rows.at(-1)?.trim()).toBe("");
	});

	it("find with no matches: zero-count summary moves into the title row", () => {
		const tool = loadTools().get("find");
		const state: Record<string, unknown> = {};
		const call = tool.renderCall({ pattern: "*.missing" }, mockTheme, ctx(false, state));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "" }], details: { _type: "findResult", text: "", pattern: "*.missing", matchCount: 0 } },
			{},
			mockTheme,
			ctx(false, state),
		);
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]).toContain("✱ find");
		expect(rows[1]).toContain("0 files");
		expect(rows[2]?.trim()).toBe("");
		expect(rows).toHaveLength(3);
	});

	it("find fallback (no details): title padding remains before preview text", () => {
		const tool = loadTools().get("find");
		const call = tool.renderCall({ pattern: "*.ts" }, mockTheme, ctx(false));
		const result = tool.renderResult({ content: [{ type: "text", text: "src/a.ts" }] }, {}, mockTheme, ctx(false));
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]?.trim()).toContain("✱ find");
		expect(rows[2]?.trim()).toBe("");
		expect(rows[3]).toContain("src/a.ts");
		expect(rows.at(-1)?.trim()).toBe("");
	});

	it("ls collapsed: summary moves into the title row", () => {
		const tool = loadTools().get("ls");
		const state: Record<string, unknown> = {};
		const call = tool.renderCall({ path: "src" }, mockTheme, ctx(false, state));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "a.ts" }], details: { _type: "lsResult", text: "a.ts", path: "src", entryCount: 1 } },
			{},
			mockTheme,
			ctx(false, state),
		);
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]?.trim()).toBe("ls src 1 entries — ctrl+o to expand");
		expect(rows[2]?.trim()).toBe("");
		expect(rows).toHaveLength(3);
	});

	it("ls expanded: title has top and bottom padding", () => {
		const tool = loadTools().get("ls");
		const state: Record<string, unknown> = {};
		const call = tool.renderCall({ path: "src" }, mockTheme, ctx(true, state));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "a.ts" }], details: { _type: "lsResult", text: "a.ts", path: "src", entryCount: 1 } },
			{},
			mockTheme,
			ctx(true, state),
		);
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe("");
		expect(rows[1]?.trim()).toBe("ls src");
		expect(rows[2]?.trim()).toBe("");
		expect(rows[3]).toContain("1 entries");
		expect(rows.at(-1)?.trim()).toBe("");
	});
});
