import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerReadTool } from "../src/tools/read.js";
import type { ReadDetails, SdkToolDef, ThemeLike, ToolContent } from "../src/types.js";

const mockTheme = {
	fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
	bold: (text: string) => text,
};

afterEach(() => vi.unstubAllEnvs());

class MockText {
	private text = "";
	private updateCount = 0;

	setText(value: string) {
		this.text = value;
		this.updateCount++;
	}

	getText() {
		return this.text;
	}

	getUpdateCount() {
		return this.updateCount;
	}
}

interface ReadToolHarness {
	execute(
		toolCallId: string,
		params: { path: string; offset?: number },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: Record<string, never>,
	): Promise<AgentToolResult<ReadDetails>>;
	renderResult(
		result: AgentToolResult<ReadDetails>,
		options: Record<string, never>,
		theme: ThemeLike,
		context: {
			lastComponent: MockText;
			isError: boolean;
			state: Record<string, never>;
			expanded: boolean;
		},
	): MockText;
}

function loadReadTool(content: string): ReadToolHarness {
	let tool: ReadToolHarness | undefined;
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition as unknown as ReadToolHarness;
		},
	} as unknown as ExtensionAPI;
	const sdkTool: SdkToolDef = {
		description: "read fixture",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: content }] satisfies ToolContent[], details: {} }),
	};

	registerReadTool(pi, process.cwd(), undefined, sdkTool, MockText);
	if (!tool) throw new Error("read tool was not registered");
	return tool;
}

async function renderSkill(
	content: string,
	expanded: boolean,
	path = "/tmp/skills/directory-name/SKILL.md",
	offset?: number,
) {
	const tool = loadReadTool(content);
	const result = await tool.execute("t1", { path, offset }, undefined, undefined, {});
	return tool.renderResult(result, {}, mockTheme, {
		lastComponent: new MockText(),
		isError: false,
		state: {},
		expanded,
	});
}

const skillContent = `---
name: frontmatter-name
description: Test skill rendering.
---

# Instructions

Follow the workflow.`;

describe("read title padding parity with other tools", () => {
	const plainFile = "const a = 1;\nconst b = 2;\n";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR sequences from rendered output
	const SGR = /[\u001b+\[[0-9;]*m/g;
	const visible = (line: string): string => line.replace(SGR, "").trim();

	it("collapsed: one blank line between the read title and the info line (like bash/grep/find)", async () => {
		const rendered = await renderSkill(plainFile, false, "/tmp/project/src/index.ts");
		const lines = rendered.getText().split("\n");
		const titleIdx = lines.findIndex((l) => l.includes("→ read"));
		const infoIdx = lines.findIndex((l) => l.includes("ctrl+o to expand"));
		expect(titleIdx).toBeGreaterThanOrEqual(0);
		expect(infoIdx).toBeGreaterThan(titleIdx);
		expect(visible(lines[titleIdx + 1] ?? "")).toBe("");
		expect(infoIdx).toBe(titleIdx + 2);
	});

	it("expanded: one blank line between the read title and the rule line", async () => {
		const rendered = await renderSkill(plainFile, true, "/tmp/project/src/index.ts");
		const lines = rendered.getText().split("\n");
		const titleIdx = lines.findIndex((l) => l.includes("→ read"));
		const ruleIdx = lines.findIndex((l, i) => i > titleIdx && l.includes("─"));
		expect(titleIdx).toBeGreaterThanOrEqual(0);
		expect(ruleIdx).toBeGreaterThan(titleIdx);
		expect(visible(lines[titleIdx + 1] ?? "")).toBe("");
		expect(ruleIdx).toBe(titleIdx + 2);
	});

	it("skill header keeps the same blank line below it when expanded", async () => {
		const rendered = await renderSkill(skillContent, true);
		const lines = rendered.getText().split("\n");
		const titleIdx = lines.findIndex((l) => l.includes("[skill]"));
		expect(titleIdx).toBeGreaterThanOrEqual(0);
		expect(visible(lines[titleIdx + 1] ?? "")).toBe("");
	});
});

describe("read skill presentation", () => {
	it("renders a themed skill summary when collapsed", async () => {
		const rendered = await renderSkill(skillContent, false);
		const output = rendered.getText();

		expect(output).toContain("<accent>[skill]</accent>");
		expect(output).toContain("<toolTitle>frontmatter-name</toolTitle>");
		expect(output).toContain("<dim>ctrl+o to expand</dim>");
		expect(output).not.toContain("# Instructions");
		expect(output).not.toContain("→ read");
	});

	it("keeps the themed header and renders full content when expanded", async () => {
		const rendered = await renderSkill(skillContent, true);
		await vi.waitFor(() => expect(rendered.getUpdateCount()).toBeGreaterThanOrEqual(2));
		const output = rendered.getText();

		expect(output).toContain("<accent>[skill]</accent>");
		expect(output).toContain("<toolTitle>frontmatter-name</toolTitle>");
		expect(output).toContain("<dim>ctrl+o to collapse</dim>");
		expect(output).toContain("─");
		expect(output).toContain("Instructions");
		expect(output).toContain("Follow the workflow.");
		expect(output).not.toContain("→ read");
	});

	it("falls back to the parent directory when frontmatter has no name", async () => {
		const rendered = await renderSkill("# Instructions", false);
		expect(rendered.getText()).toContain("<toolTitle>directory-name</toolTitle>");
	});

	it("does not treat other markdown files as canonical SKILL.md files", async () => {
		const rendered = await renderSkill(skillContent, false, "/tmp/skills/frontmatter-name/README.md");
		expect(rendered.getText()).toContain("→ read");
		expect(rendered.getText()).not.toContain("[skill]");
	});
});

describe("read line numbering", () => {
	it("keeps offset line numbers within the terminal width after asynchronous highlighting", async () => {
		vi.stubEnv("COLUMNS", "28");
		const content = `const first = "${"x".repeat(80)}";\nconst second = 2;`;
		const rendered = await renderSkill(content, true, "/tmp/example.ts", 40);
		await vi.waitFor(() => expect(rendered.getUpdateCount()).toBeGreaterThanOrEqual(2));
		const output = stripVTControlCharacters(rendered.getText());

		expect(output).toMatch(/^[ \t]*41[ \t]+│/m);
		expect(output).toMatch(/^[ \t]*42[ \t]+│[ \t]+const second = 2;/m);
		const numberedLines = output.split("\n").filter((line) => line.includes("│"));
		expect(numberedLines).toHaveLength(2);
		for (const line of numberedLines) expect(line.length).toBeLessThanOrEqual(25);
	});

	it("reserves gutter width when offset line numbers cross a digit boundary", async () => {
		vi.stubEnv("COLUMNS", "28");
		const content = `${"x".repeat(80)}\n${"y".repeat(80)}`;
		const rendered = await renderSkill(content, true, "/tmp/example.ts", 998);
		const synchronousOutput = stripVTControlCharacters(rendered.getText());
		const synchronousLines = synchronousOutput.split("\n").filter((line) => line.includes("│"));
		expect(synchronousLines).toHaveLength(2);
		for (const line of synchronousLines) expect(line.length).toBeLessThanOrEqual(25);

		await vi.waitFor(() => expect(rendered.getUpdateCount()).toBeGreaterThanOrEqual(2));
		const output = stripVTControlCharacters(rendered.getText());
		expect(output).toMatch(/^[ \t]*999[ \t]+│/m);
		expect(output).toMatch(/^[ \t]*1000[ \t]+│/m);
		const numberedLines = output.split("\n").filter((line) => line.includes("│"));
		expect(numberedLines).toHaveLength(2);
		for (const line of numberedLines) expect(line.length).toBeLessThanOrEqual(25);
	});
});
