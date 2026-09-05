import { beforeEach, describe, expect, it } from "vitest";

import piPrettyExtension from "../src/index.js";

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
	state: Record<string, never>;
	expanded: boolean;
	invalidate: () => void;
};

function ctx(expanded: boolean): Ctx {
	return { lastComponent: new MockText(), isError: false, state: {}, expanded, invalidate: () => {} };
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

describe("tool title spacing (no blank row between title and result)", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});

	it("bash collapsed: info line sits directly below the title, footer blank retained", () => {
		const tool = loadTools().get("bash");
		const call = tool.renderCall({ command: "echo out" }, mockTheme, ctx(false));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "out" }], details: { _type: "bashResult", text: "out", exitCode: 0, command: "echo out" } },
			{},
			mockTheme,
			ctx(false),
		);
		const rows = stackedRows(call, result);
		expect(rows[0]?.trim()).toBe(""); // top padding preserved
		expect(rows[1]?.trim()).toBe("$ echo out");
		expect(rows[2]).toContain("1 lines"); // info directly below title
		expect(rows.at(-1)?.trim()).toBe(""); // footer spacing preserved
	});

	it("bash expanded: info → blank → body internal spacing preserved, no gap below title", () => {
		const tool = loadTools().get("bash");
		const call = tool.renderCall({ command: "echo out" }, mockTheme, ctx(true));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "out" }], details: { _type: "bashResult", text: "out", exitCode: 0, command: "echo out" } },
			{},
			mockTheme,
			ctx(true),
		);
		const rows = stackedRows(call, result);
		expect(rows[1]?.trim()).toBe("$ echo out");
		expect(rows[2]).toContain("1 lines");
		expect(rows[3]?.trim()).toBe(""); // info → body separator (not title padding)
		expect(rows[4]).toContain("out");
		expect(rows.at(-1)?.trim()).toBe(""); // footer spacing preserved
	});

	it("grep collapsed: line count sits directly below the title", () => {
		const tool = loadTools().get("grep");
		const call = tool.renderCall({ pattern: "todo" }, mockTheme, ctx(false));
		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "a.ts:1: todo" }],
				details: { _type: "grepResult", text: "a.ts:1: todo", pattern: "todo", matchCount: 1 },
			},
			{},
			mockTheme,
			ctx(false),
		);
		const rows = stackedRows(call, result);
		expect(rows[1]?.trim()).toContain("✱ grep");
		expect(rows[2]).toContain("1 lines"); // directly below title
		expect(rows.at(-1)?.trim()).toBe(""); // footer spacing preserved
	});

	it("find expanded: match count sits directly below the title", () => {
		const tool = loadTools().get("find");
		const call = tool.renderCall({ pattern: "*.ts" }, mockTheme, ctx(true));
		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
				details: { _type: "findResult", text: "src/a.ts\nsrc/b.ts", pattern: "*.ts", matchCount: 2 },
			},
			{},
			mockTheme,
			ctx(true),
		);
		const rows = stackedRows(call, result);
		expect(rows[1]?.trim()).toContain("✱ find");
		expect(rows[2]).toContain("2 files"); // directly below title
		expect(rows.at(-1)?.trim()).toBe(""); // footer spacing preserved
	});

	it("find with no matches: zero-count line sits directly below the title", () => {
		const tool = loadTools().get("find");
		const call = tool.renderCall({ pattern: "*.missing" }, mockTheme, ctx(false));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "" }], details: { _type: "findResult", text: "", pattern: "*.missing", matchCount: 0 } },
			{},
			mockTheme,
			ctx(false),
		);
		const rows = stackedRows(call, result);
		expect(rows[1]?.trim()).toContain("✱ find");
		expect(rows[2]).toContain("0 files"); // directly below title
	});

	it("find fallback (no details): preview text sits directly below the title", () => {
		const tool = loadTools().get("find");
		const call = tool.renderCall({ pattern: "*.ts" }, mockTheme, ctx(false));
		const result = tool.renderResult({ content: [{ type: "text", text: "src/a.ts" }] }, {}, mockTheme, ctx(false));
		const rows = stackedRows(call, result);
		expect(rows[1]?.trim()).toContain("✱ find");
		expect(rows[2]).toContain("src/a.ts"); // directly below title
	});

	it("ls collapsed: entry count sits directly below the title", () => {
		const tool = loadTools().get("ls");
		const call = tool.renderCall({ path: "src" }, mockTheme, ctx(false));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "a.ts" }], details: { _type: "lsResult", text: "a.ts", path: "src", entryCount: 1 } },
			{},
			mockTheme,
			ctx(false),
		);
		const rows = stackedRows(call, result);
		expect(rows[1]?.trim()).toBe("ls src");
		expect(rows[2]).toContain("1 entries"); // directly below title
		expect(rows.at(-1)?.trim()).toBe(""); // footer spacing preserved
	});

	it("ls expanded: entry count sits directly below the title", () => {
		const tool = loadTools().get("ls");
		const call = tool.renderCall({ path: "src" }, mockTheme, ctx(true));
		const result = tool.renderResult(
			{ content: [{ type: "text", text: "a.ts" }], details: { _type: "lsResult", text: "a.ts", path: "src", entryCount: 1 } },
			{},
			mockTheme,
			ctx(true),
		);
		const rows = stackedRows(call, result);
		expect(rows[1]?.trim()).toBe("ls src");
		expect(rows[2]).toContain("1 entries"); // directly below title
		expect(rows.at(-1)?.trim()).toBe(""); // footer spacing preserved
	});
});
