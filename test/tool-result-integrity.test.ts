import { describe, expect, it } from "vitest";

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

function mockSdk(contentMap: Map<string, string>) {
	const make = (name: string) => (_cwd: string) => ({
		name,
		description: `${name} mock`,
		parameters: { type: "object", properties: {} },
		execute: async () => {
			const text = contentMap.get(name) ?? `content-for-${name}`;
			return { content: [{ type: "text", text }] };
		},
	});
	return {
		createReadToolDefinition: make("read"),
		createBashToolDefinition: make("bash"),
		createLsToolDefinition: make("ls"),
		createFindToolDefinition: make("find"),
		createGrepToolDefinition: make("grep"),
		getAgentDir: () => "/tmp/pi-pretty-test",
	};
}

/** Load the extension with all tools enabled, immune to ambient PRETTY_DISABLE_TOOLS. */
async function loadTools(contentMap: Map<string, string>) {
	const prevDisable = process.env.PRETTY_DISABLE_TOOLS;
	const prevEnable = process.env.PRETTY_ENABLE_TOOLS;
	delete process.env.PRETTY_DISABLE_TOOLS;
	delete process.env.PRETTY_ENABLE_TOOLS;
	const tools = new Map<string, any>();
	const handlers: string[] = [];
	const pi: any = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: (event: string) => {
			handlers.push(event);
		},
	};
	try {
		await piPrettyExtension(pi, {
			sdk: mockSdk(contentMap),
			TextComponent: MockText,
		} as any);
	} finally {
		if (prevDisable === undefined) delete process.env.PRETTY_DISABLE_TOOLS;
		else process.env.PRETTY_DISABLE_TOOLS = prevDisable;
		if (prevEnable === undefined) delete process.env.PRETTY_ENABLE_TOOLS;
		else process.env.PRETTY_ENABLE_TOOLS = prevEnable;
	}
	return { tools, handlers };
}

function joinText(result: any): string {
	return result.content
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("\n");
}

describe("tool_result data integrity (issue #10)", () => {
	it("does not register a tool_result handler that mutates content", async () => {
		const { handlers } = await loadTools(new Map());
		// Extension must not hook tool_result for presentation padding.
		// Data hooks belong to extensions that intentionally transform model-visible content (e.g., redaction).
		// Pretty-printing must use renderResult/renderCall (view layer) only.
		expect(handlers).not.toContain("tool_result");
	});

	it("leaves read/bash/grep content byte-exact when executed through registered tools", async () => {
		const cases: Array<[string, string]> = [
			["read", '{\n  "a": 1\n}\n'],
			["bash", "line1\n  indented\n\nline4"],
			["grep", "file.ts:10:  hello"],
		];

		for (const [toolName, text] of cases) {
			const { tools } = await loadTools(new Map([[toolName, text]]));
			const tool = tools.get(toolName);
			expect(tool, `tool ${toolName} should be registered`).toBeDefined();

			const result = await tool.execute("t1", { path: "dummy", command: "dummy", pattern: "dummy" }, null, null, {});
			// Content returned to the model must be identical to SDK output — no 4-space left pad, no trailing whitespace lines.
			expect(joinText(result)).toBe(text);
			// Verify no left-pad was injected on any line
			for (const line of joinText(result).split("\n")) {
				expect(line.startsWith("    "), `line ${JSON.stringify(line)} must not carry the 4-space pad`).toBe(
					line === "    " ? true : false,
				);
			}
		}
	});

	it("still renders with view-layer padding via renderResult (no data mutation needed)", async () => {
		const { tools } = await loadTools(new Map([["read", "hello\nworld"]]));

		const readTool = tools.get("read");
		const result = await readTool.execute("t1", { path: "src/index.ts" }, null, null, {});
		// execute content stays raw — no pad
		expect(joinText(result)).toBe("hello\nworld");

		// View layer adds its own indent (TOOL_RESULT_INDENT) — renderResult must work without data mutation
		const rendered = readTool.renderResult(
			{ ...result, details: { _type: "readFile", filePath: "src/index.ts", content: "hello\nworld", offset: 0, lineCount: 2 } },
			{},
			{ fg: (_k: string, s: string) => s, bg: (_k: string, s: string) => s, bold: (s: string) => s } as any,
			{ lastComponent: new MockText(), isError: false, state: {}, expanded: true, invalidate: () => {} },
		);
		expect(rendered.getText()).toContain("hello");
	});
});
