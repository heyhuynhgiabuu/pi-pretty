import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

import piPrettyExtension from "../src/index.js";
import { registerBashTool } from "../src/tools/bash.js";
import type { SdkToolDef } from "../src/types.js";
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
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerToolRenderer: captureBashRenderer(tools),
		registerCommand: () => {},
		on: () => {},
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

	return tools;
}

function loadBashTool() {
	return loadTools().get("bash");
}

/** Register the bash tool with a mock SDK definition and return the registered tool. */
function registerBashToolWith(sdkTool: SdkToolDef) {
	const registerTool = vi.fn();
	const tools = new Map<string, any>();
	registerBashTool({ registerTool, registerToolRenderer: captureBashRenderer(tools, sdkTool as any) } as any, MockText);
	expect(registerTool).not.toHaveBeenCalled();
	expect(tools.get("bash").execute).toBe(sdkTool.execute);
	return tools.get("bash");
}

describe("bash output schema", () => {
	it("forwards the SDK schema for structured Codemode results", () => {
		const outputSchema = {
			type: "object",
			properties: { output: { type: "string" } },
		};
		const tool = registerBashToolWith({
			parameters: {},
			outputSchema,
			execute: vi.fn(),
		});

		expect(tool.outputSchema).toBe(outputSchema);
	});
});

describe("bash ripgrep guidance", () => {
	it("preserves the host guidelines without adding ripgrep guidance", () => {
		const tool = registerBashToolWith({
			description: "Execute a bash command.",
			parameters: {},
			promptSnippet: "native snippet",
			promptGuidelines: ["You can inspect PI_* environment variables for current model and session details."],
			constrainedSampling: { type: "json_schema", strict: "prefer" },
			execute: vi.fn(),
		});
		const guidelines = (tool.promptGuidelines as string[]).join("\n");

		expect(tool.promptGuidelines[0]).toBe(
			"You can inspect PI_* environment variables for current model and session details.",
		);
		expect(tool.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		expect(tool.promptSnippet).toBe("native snippet");
		expect(tool.description).toBe("Execute a bash command.");
		expect(guidelines).toBe("You can inspect PI_* environment variables for current model and session details.");
	});

	it("does not inject ripgrep guidance when the SDK tool provides none", () => {
		const tool = registerBashToolWith({ description: "Execute a bash command.", parameters: {}, execute: vi.fn() });
		const guidelines = tool.promptGuidelines as string[];
		expect(guidelines).toBeUndefined();
	});
});

describe("bash execution", () => {
	it("renders host-supplied execution metrics for error rendering", async () => {
		const registerTool = vi.fn();
		const tools = new Map<string, any>();
		registerBashTool(
			{ registerTool, registerToolRenderer: captureBashRenderer(tools, {
				description: "bash",
				parameters: {},
				execute: vi.fn().mockRejectedValue(new Error("command failed")),
			} as any) } as any,
			MockText,
		);

		const tool = tools.get("bash");
		await expect(tool.execute("metrics-error", { command: "false" }, undefined, undefined, {})).rejects.toThrow(
			"command failed",
		);
		const rendered = tool.renderResult(
			{ content: [{ type: "text", text: "command failed" }], details: {} },
			{},
			mockTheme,
			{
				lastComponent: new MockText(),
				isError: true,
				state: {},
				expanded: false,
				toolCallId: "metrics-error",
				durationMs: 123,
			},
		);

		expect(rendered.getText()).toMatch(/\d+ms/);
		expect(rendered.getText()).toContain("chars");
	});

	it("preserves rejected SDK executions as tool failures", async () => {
		const failure = new Error("command failed");
		const registerTool = vi.fn();
		const tools = new Map<string, any>();
		registerBashTool(
			{ registerTool, registerToolRenderer: captureBashRenderer(tools, {
				description: "bash",
				parameters: {},
				execute: vi.fn().mockRejectedValue(failure),
			} as any) } as any,
			MockText,
		);

		const tool = tools.get("bash");
		await expect(tool.execute("t1", { command: "false" }, undefined, undefined, {})).rejects.toBe(failure);
	});
});

describe("bash renderer registration", () => {
	it("passes unrelated tools to the next resolver", () => {
		const registerToolRenderer = vi.fn();
		registerBashTool({ registerToolRenderer } as any, MockText);
		const next = vi.fn(() => ({ renderShell: "default" }));
		const resolver = registerToolRenderer.mock.calls[0][0];
		expect(resolver("read", next)).toEqual({ renderShell: "default" });
		expect(next).toHaveBeenCalledOnce();
	});

	it.each([false, true])("handles empty and streaming partial results (expanded=%s)", (expanded) => {
		const tool = loadBashTool();
		const state = {};
		const call = tool.renderCall({ command: "printf test" }, mockTheme, { state, expanded });
		let component = new MockText();
		for (const content of [[], [{ type: "text", text: "" }], [{ type: "text", text: "test" }]]) {
			const result = { content, details: undefined };
			const original = structuredClone(result);
			const rendered = tool.renderResult(result, { isPartial: true }, mockTheme, {
				state,
				expanded,
				lastComponent: component,
			});
			expect(rendered).toBe(component);
			component = rendered;
			const output = stripAnsi(`${call.getText()}\n${component.getText()}`);
			expect(output).toContain("running…");
			expect(output).not.toContain("done");
			expect(output).not.toContain("lines");
			expect(result).toEqual(original);
		}
		tool.renderResult({ content: [{ type: "text", text: "test" }] }, { isPartial: false }, mockTheme, {
			state,
			expanded,
			lastComponent: component,
		});
		expect(stripAnsi(`${call.getText()}\n${component.getText()}`)).not.toContain("running…");
	});
});

describe("bash renderCall expansion", () => {
	beforeEach(() => {
		process.stdout.columns = 100;
	});

	it("adds one blank row above and below every tool header", () => {
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
			expect(lines).toHaveLength(3);
			expect(lines[0]?.trim(), name).toBe("");
			expect(lines[1]?.trim(), name).not.toBe("");
			expect(lines[2]?.trim(), name).toBe("");
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
			expect(lines[0]?.trim()).toBe("");
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
			expect(collapsedLines[0]).toContain("3 lines · 28 chars · ctrl+o to expand");
			expect(collapsedLines[0]).not.toContain("exit");
			expect(collapsedLines.at(-1)?.trim()).toBe("");
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
