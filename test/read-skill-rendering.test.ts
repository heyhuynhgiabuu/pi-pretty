import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerReadTool } from "../src/tools/read.js";
import type { ReadDetails, SdkToolDef, ThemeLike, ToolContent } from "../src/types.js";

const mockTheme = {
	fg: (key: string, text: string) => `<${key}>${text}</${key}>`,
	bold: (text: string) => text,
};

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
		params: { path: string },
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

async function renderSkill(content: string, expanded: boolean, path = "/tmp/skills/directory-name/SKILL.md") {
	const tool = loadReadTool(content);
	const result = await tool.execute("t1", { path }, undefined, undefined, {});
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
