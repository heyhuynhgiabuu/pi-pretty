import { visibleWidth } from "@earendil-works/pi-tui";
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
	render(_width: number) {
		return this.text.split("\n");
	}
}

const mockTheme = {
	fg: (_key: string, text: string) => text,
	bold: (text: string) => text,
};

const ansiMockTheme = {
	fg: (_key: string, text: string) => `\x1b[31m${text}\x1b[0m`,
	bg: (_key: string, text: string) => `\x1b[48;2;1;2;3m${text}`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

function mockToolFactory(exec: any) {
	return (_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function withStdoutColumns<T>(columns: number, fn: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
	try {
		return fn();
	} finally {
		if (descriptor) {
			Object.defineProperty(process.stdout, "columns", descriptor);
		} else {
			delete (process.stdout as NodeJS.WriteStream & { columns?: number }).columns;
		}
	}
}

function loadTools() {
	const noopExec = async () => ({ content: [{ type: "text", text: "" }] });
	const tools = new Map<string, any>();
	let startSession: (() => void) | undefined;
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string, handler: () => void) => {
			if (event === "session_start" && !startSession) startSession = handler;
		},
	};

	piPrettyExtension(pi, {
		sdk: {
			createReadToolDefinition: mockToolFactory(noopExec),
			createBashToolDefinition: mockToolFactory(noopExec),
			createLsToolDefinition: mockToolFactory(noopExec),
			createFindToolDefinition: mockToolFactory(noopExec),
			createGrepToolDefinition: mockToolFactory(noopExec),
			getAgentDir: () => "/tmp/pi-pretty-test",
		},
		TextComponent: MockText,
	});
	startSession?.();

	return tools;
}

function loadBashTool() {
	return loadTools().get("bash");
}

describe("bash renderCall expansion", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});

	it("adds one bottom padding row to every tool header", () => {
		const previousEnabledTools = process.env.PRETTY_ENABLE_TOOLS;
		const previousDisabledTools = process.env.PRETTY_DISABLE_TOOLS;
		process.env.PRETTY_ENABLE_TOOLS = "ls";
		delete process.env.PRETTY_DISABLE_TOOLS;
		const tools = loadTools();
		if (previousEnabledTools === undefined) {
			delete process.env.PRETTY_ENABLE_TOOLS;
		} else {
			process.env.PRETTY_ENABLE_TOOLS = previousEnabledTools;
		}
		if (previousDisabledTools === undefined) {
			delete process.env.PRETTY_DISABLE_TOOLS;
		} else {
			process.env.PRETTY_DISABLE_TOOLS = previousDisabledTools;
		}
		expect([...tools.keys()].sort()).toEqual(["bash", "find", "grep", "ls", "read"]);
		const headers: Array<[string, Record<string, unknown>, boolean]> = [
			["bash", { command: "pwd" }, false],
			["find", { pattern: "*.ts", path: "src" }, false],
			["grep", { pattern: "TODO", path: "src" }, false],
			["ls", { path: "src" }, false],
			["read", { path: "missing.ts" }, true],
		];

		for (const [name, args, isError] of headers) {
			const rendered = tools.get(name).renderCall(args, mockTheme, {
				lastComponent: new MockText(),
				isError,
				state: {},
				expanded: false,
				invalidate: () => {},
			});
			const lines = stripAnsi(rendered.getText()).split("\n");
			expect(lines.at(-1)?.trim(), name).toBe("");
			expect(lines.at(-2)?.trim(), name).not.toBe("");
		}
	});

	it("truncates long commands when collapsed", () => {
		const bashTool = loadBashTool();
		const command = `printf '${"x".repeat(120)}'`;

		const rendered = bashTool.renderCall({ command }, mockTheme, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: false,
			invalidate: () => {},
		});

		expect(rendered.getText()).toContain("$");
		expect(rendered.getText()).toContain("…");
		expect(rendered.getText()).not.toContain(command);
	});

	it("shows the full command when expanded", () => {
		const bashTool = loadBashTool();
		const command = `printf '${"x".repeat(120)}'`;

		const rendered = bashTool.renderCall({ command }, mockTheme, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: true,
			invalidate: () => {},
		});

		expect(rendered.getText()).toContain(command);
	});

	it("preserves timeout text in both collapsed and expanded states", () => {
		const bashTool = loadBashTool();
		const command = `printf '${"x".repeat(120)}'`;

		const collapsed = bashTool.renderCall({ command, timeout: 5 }, mockTheme, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: false,
			invalidate: () => {},
		});
		const expanded = bashTool.renderCall({ command, timeout: 5 }, mockTheme, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: true,
			invalidate: () => {},
		});

		expect(collapsed.getText()).toContain("(timeout 5s)");
		expect(expanded.getText()).toContain("(timeout 5s)");
	});

	it("truncates ANSI tool headers that exceed the terminal width", () => {
		withStdoutColumns(84, () => {
			const bashTool = loadBashTool();
			const command = `printf '${"界".repeat(120)}'`;

			const rendered = bashTool.renderCall({ command }, ansiMockTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: false,
				invalidate: () => {},
			});

			for (const line of rendered.getText().split("\n")) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(84);
			}
		});
	});

	it("does not exceed narrow terminal widths", () => {
		withStdoutColumns(24, () => {
			const bashTool = loadBashTool();
			const command = `printf '${"x".repeat(120)}'`;

			const rendered = bashTool.renderCall({ command }, ansiMockTheme, {
				lastComponent: new MockText(),
				isError: false,
				state: {},
				expanded: false,
				invalidate: () => {},
			});

			for (const line of rendered.getText().split("\n")) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(24);
			}
		});
	});

	it("does not add extra internal padding to the bash title in error state", () => {
		withStdoutColumns(48, () => {
			const bashTool = loadBashTool();
			const rendered = bashTool.renderCall({ command: "false" }, ansiMockTheme, {
				lastComponent: new MockText(),
				isError: true,
				state: {},
				expanded: false,
				invalidate: () => {},
			});

			const lines = stripAnsi(rendered.getText()).split("\n");
			expect(lines[1]).toMatch(/^ \$ false/);
			expect(rendered.getText()).toContain("\x1b[31m");
		});
	});

	it("collapses multi-line tool errors until expanded", () => {
		withStdoutColumns(48, () => {
			const bashTool = loadBashTool();
			const collapsed = bashTool.renderResult(
				{ content: [{ type: "text", text: "\nfirst error\n\n\nsecond error\n" }] },
				{},
				ansiMockTheme,
				{
					lastComponent: new MockText(),
					isError: true,
					state: {},
					expanded: false,
					invalidate: () => {},
				},
			);
			const collapsedLines = stripAnsi(collapsed.getText()).split("\n");
			expect(collapsedLines[0]).toContain("3 lines · ctrl+o to expand");
			expect(collapsedLines[0]).not.toContain("exit");
			expect(collapsedLines[1].trim()).toBe("");
			expect(collapsedLines.some((l) => l.includes("first error"))).toBe(false);

			const expanded = bashTool.renderResult(
				{ content: [{ type: "text", text: "\nfirst error\n\n\nsecond error\n" }] },
				{},
				ansiMockTheme,
				{
					lastComponent: new MockText(),
					isError: true,
					state: {},
					expanded: true,
					invalidate: () => {},
				},
			);
			const lines = stripAnsi(expanded.getText()).split("\n");
			expect(lines[1].trim()).toBe("");
			expect(lines[2]).toMatch(/^ first error/);
			expect(lines[4]).toMatch(/^ second error/);
			expect(lines.at(-1)?.trim()).toBe("");
		});
	});

	it("applies tool background correctly to bash results without unnecessary resets", () => {
		withStdoutColumns(64, () => {
			const bashTool = loadBashTool();
			const rendered = bashTool.renderResult(
				{
					content: [{ type: "text", text: "output" }],
					details: { _type: "bashResult", text: "output", exitCode: 1, command: "test" },
				},
				{},
				ansiMockTheme,
				{
					lastComponent: new MockText(),
					isError: true,
					state: { _tw: "64" },
					expanded: false,
					invalidate: () => {},
				},
			);

			expect(rendered.getText()).toMatch(/\x1b\[48;/); // tool background is applied
			expect(rendered.getText()).not.toContain("\x1b[0m");
			expect(rendered.getText()).not.toContain("\x1b[49m");
			for (const line of rendered.getText().split("\n")) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(64);
			}
		});
	});

	it("renders bash results using the component render width instead of stdout columns", () => {
		withStdoutColumns(120, () => {
			const bashTool = loadBashTool();
			const rendered = bashTool.renderResult(
				{ content: [{ type: "text", text: "hello world" }], details: { _type: "bashResult", text: "hello world", exitCode: 0, command: "echo hi" } },
				{},
				mockTheme,
				{
					lastComponent: new MockText(),
					isError: false,
					state: {},
					expanded: true,
					invalidate: () => {},
				},
			);

			rendered.render(80);
			const lines = stripAnsi(rendered.getText()).split("\n");
			expect(lines[1].trim()).toBe("");
			for (const line of rendered.getText().split("\n")) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(80);
			}
		});
	});
});
