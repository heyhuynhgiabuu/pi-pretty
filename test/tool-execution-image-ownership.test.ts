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
		["multiple", [{ type: "image", data: "Zmlyc3Q=", mimeType: "image/png" }, { type: "image", data: "c2Vjb25k", mimeType: "image/png" }]],
	] as const)("uses one host-generic Image per %s preserved block set", async (_case, content) => {
		hostTui.setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		const tool = readTool([...content]);
		const result = await tool.execute("t1", { path: "image.png" }, null, null, {});
		const host = new ToolExecutionComponent("read", "t1", { path: "image.png" }, { showImages: true }, tool, { requestRender() {} } as any, process.cwd());
		host.updateResult({ ...result, isError: false });
		expect((host as any).resultRendererComponent).not.toBeInstanceOf(PackageImage);
		expect((host as any).imageComponents).toHaveLength(content.length);
		expect((host as any).imageComponents.every((component: any) => component instanceof hostTui.Image)).toBe(true);
		expect(result.content).toEqual(content);
	});

	it.each([
		["hidden", "iterm2", false],
		["denied", null, true],
	] as const)("preserves content but creates no image when host display is %s", async (_case, images, showImages) => {
		hostTui.setCapabilities({ images, trueColor: true, hyperlinks: true });
		const tool = readTool();
		const result = await tool.execute("t1", { path: "image.png" }, null, null, {});
		const host = new ToolExecutionComponent("read", "t1", {}, { showImages }, tool, { requestRender() {} } as any, process.cwd());
		host.updateResult({ ...result, isError: false });
		expect((host as any).resultRendererComponent).not.toBeInstanceOf(PackageImage);
		expect((host as any).imageComponents).toHaveLength(0);
		expect(result.content).toHaveLength(1);
	});
});
