import { afterEach, describe, expect, it } from "vitest";

import { registerReadTool } from "../src/tools/read.js";
import type { ToolContent } from "../src/types.js";

const mockTheme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };

class MockText {
	private text = "";
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
	render() {
		return this.text ? [this.text] : [];
	}
}

function loadReadTool(content: ToolContent[]) {
	let tool: any;
	registerReadTool(
		{ registerTool: (definition: any) => (tool = definition) } as any,
		process.cwd(),
		undefined,
		{
			description: "read fixture",
			parameters: { type: "object", properties: {} },
			execute: async () => ({ content, details: {} }),
		},
		MockText,
	);
	return tool;
}

async function executeAndRender(content: ToolContent[]) {
	const tool = loadReadTool(content);
	const result = await tool.execute("t1", { path: "media/image.png" }, null, null, {});
	const rendered = tool.renderResult(result, {}, mockTheme, {
		lastComponent: new MockText(),
		isError: false,
		state: {},
		expanded: false,
	});
	return { result, rendered };
}

const originalMarker = process.env.HERDR_KITTY_GRAPHICS;
afterEach(() => {
	if (originalMarker === undefined) delete process.env.HERDR_KITTY_GRAPHICS;
	else process.env.HERDR_KITTY_GRAPHICS = originalMarker;
});

describe("read image presentation ownership", () => {
	it("preserves ordered image blocks while keeping payload out of details", async () => {
		const content: ToolContent[] = [
			{ type: "image", data: "first", mimeType: "image/png" },
			{ type: "text", text: "between" },
			{ type: "image", data: "second", mimeType: "image/jpeg" },
		];
		const { result } = await executeAndRender(content);
		expect(result.content).toEqual(content);
		expect(result.content).toHaveLength(3);
		expect(result.details).toMatchObject({ _type: "readImage", filePath: "media/image.png" });
		expect(result.details).not.toHaveProperty("data");
		expect(result.details).not.toHaveProperty("mimeType");
	});

	it("returns empty non-image presentation without raw graphics escapes", async () => {
		const { rendered } = await executeAndRender([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
		expect(rendered).toBeInstanceOf(MockText);
		expect(rendered.getText()).toBe("");
		const output = rendered.render(80).join("\n");
		expect(output).not.toContain("\x1b_G");
		expect(output).not.toContain("\x1b]1337;File=");
	});

	it("is invariant before host rendering when the exact Herdr marker is present", async () => {
		const image: ToolContent[] = [{ type: "image", data: "same", mimeType: "image/png" }];
		delete process.env.HERDR_KITTY_GRAPHICS;
		const absent = await executeAndRender(image);
		process.env.HERDR_KITTY_GRAPHICS = "1";
		const present = await executeAndRender(image);
		expect(present.result.content).toEqual(absent.result.content);
		expect({ _type: present.result.details._type, filePath: present.result.details.filePath }).toEqual({
			_type: absent.result.details._type,
			filePath: absent.result.details.filePath,
		});
		expect(present.rendered.getText()).toBe(absent.rendered.getText());
	});

	it("keeps text and error rendering behavior", async () => {
		const tool = loadReadTool([{ type: "text", text: "example" }]);
		const result = await tool.execute("t1", { path: "src/example.ts" }, null, null, {});
		expect(
			tool.renderResult(result, {}, mockTheme, { lastComponent: new MockText(), state: {}, expanded: false }).getText(),
		).toContain("→ read");
		expect(
			tool
				.renderResult({ content: [{ type: "text", text: "boom" }] }, {}, mockTheme, {
					lastComponent: new MockText(),
					state: {},
					isError: true,
				})
				.getText(),
		).toContain("boom");
	});
});
