import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Image as PackageImage } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { registerReadTool } from "../src/tools/read.js";
import type { ToolContent } from "../src/types.js";

class MockText {
	text = "";
	setText(value: string) {
		this.text = value;
	}
	render() {
		return this.text ? [this.text] : [];
	}
}

function readTool(content: ToolContent[] = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]) {
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

let hostTui: typeof import("@earendil-works/pi-tui");
beforeAll(async () => {
	initTheme("dark");
	const codingAgentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const hostTuiEntry = createRequire(codingAgentEntry).resolve("@earendil-works/pi-tui");
	hostTui = await import(pathToFileURL(hostTuiEntry).href);
});
afterEach(() => hostTui.setCapabilities({ images: null, trueColor: false, hyperlinks: false }));

describe("compatible host ToolExecution image ownership", () => {
	it.each([
		["single", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]],
		[
			"multiple",
			[
				{ type: "image", data: "Zmlyc3Q=", mimeType: "image/png" },
				{ type: "image", data: "c2Vjb25k", mimeType: "image/png" },
			],
		],
	] as const)("uses one host-generic Image per %s preserved block set", async (_case, content) => {
		hostTui.setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const tool = readTool([...content]);
		const result = await tool.execute("t1", { path: "image.png" }, null, null, {});
		const host = new ToolExecutionComponent(
			"read",
			"t1",
			{ path: "image.png" },
			{ showImages: true },
			tool,
			{ requestRender() {} } as any,
			process.cwd(),
		);
		host.updateResult({ ...result, isError: false });
		expect((host as any).resultRendererComponent).not.toBeInstanceOf(PackageImage);
		expect((host as any).imageComponents).toHaveLength(content.length);
		expect((host as any).imageComponents.every((component: any) => component instanceof hostTui.Image)).toBe(true);
		expect(result.content).toEqual(content);
	});

	it("renders SVG through one host-owned component without throwing", async () => {
		hostTui.setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const svg = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
		).toString("base64");
		const tool = readTool([
			{ type: "text", text: "Read image file [image/svg+xml]" },
			{ type: "image", data: svg, mimeType: "image/svg+xml" },
		]);
		const result = await tool.execute("t1", { path: "image.svg" }, null, null, {});
		const host = new ToolExecutionComponent(
			"read",
			"t1",
			{},
			{ showImages: true },
			tool,
			{ requestRender() {} } as any,
			process.cwd(),
		);
		host.updateResult({ ...result, isError: false });

		const rendered = host.render(80).join("\n");
		expect((host as any).imageComponents).toHaveLength(1);
		expect((host as any).imageComponents[0]).toBeInstanceOf(hostTui.Image);
		expect(rendered.split("\x1b]1337;File=")).toHaveLength(2);
	});

	it.each([
		["hidden", "iterm2", false],
		["denied", null, true],
	] as const)("preserves content but creates no image when host display is %s", async (_case, images, showImages) => {
		hostTui.setCapabilities({ images, trueColor: true, hyperlinks: true });
		const tool = readTool();
		const result = await tool.execute("t1", { path: "image.png" }, null, null, {});
		const host = new ToolExecutionComponent(
			"read",
			"t1",
			{},
			{ showImages },
			tool,
			{ requestRender() {} } as any,
			process.cwd(),
		);
		host.updateResult({ ...result, isError: false });
		expect((host as any).resultRendererComponent).not.toBeInstanceOf(PackageImage);
		expect((host as any).imageComponents).toHaveLength(0);
		expect(result.content).toHaveLength(1);
	});

	it("keeps SDK image notes visible when host image display is disabled", async () => {
		hostTui.setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const note = "Read image file [image/png]\nImage attachments are unavailable for this model.";
		const content: ToolContent[] = [
			{ type: "text", text: note },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		];
		const tool = readTool(content);
		const result = await tool.execute("t1", { path: "image.png" }, null, null, {});
		const host = new ToolExecutionComponent(
			"read",
			"t1",
			{},
			{ showImages: false },
			tool,
			{ requestRender() {} } as any,
			process.cwd(),
		);
		host.updateResult({ ...result, isError: false });

		const rendered = host.render(80).join("\n");
		for (const line of note.split("\n")) expect(rendered).toContain(line);
		expect(rendered).not.toContain("\x1b_G");
		expect(rendered).not.toContain("\x1b]1337;File=");
	});
});
