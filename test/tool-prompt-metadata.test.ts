import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { registerFindTool } from "../src/tools/find.js";
import { registerGrepTool } from "../src/tools/grep.js";
import { registerLsTool } from "../src/tools/ls.js";
import { registerReadTool } from "../src/tools/read.js";

class MockText {
	setText(_value: string) {}
}

// grep/find deliberately omit promptSnippet/promptGuidelines so they do not
// advertise dedicated search tools next to the bash tool's `rg -n` guidance.
describe("host prompt metadata passthrough", () => {
	it("read forwards the host snippet, guidelines, and constrained sampling", () => {
		let definition: ToolDefinition | undefined;
		const pi = {
			registerTool: (d: ToolDefinition) => {
				definition = d;
			},
		} as unknown as ExtensionAPI;

		registerReadTool(
			pi,
			process.cwd(),
			undefined,
			{
				description: "read fixture",
				parameters: { type: "object", properties: {} },
				promptSnippet: "Read file contents",
				promptGuidelines: ["Use read to examine files instead of cat or sed."],
				constrainedSampling: { type: "json_schema", strict: "prefer" },
				execute: async () => ({ content: [], details: {} }),
			},
			MockText,
		);

		expect(definition?.promptSnippet).toBe("Read file contents");
		expect(definition?.promptGuidelines).toEqual(["Use read to examine files instead of cat or sed."]);
		expect(definition?.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
	});

	it("read forwards the host output schema", () => {
		let definition: ToolDefinition | undefined;
		const pi = {
			registerTool: (d: ToolDefinition) => {
				definition = d;
			},
		} as unknown as ExtensionAPI;
		const outputSchema = { type: "object", properties: { content: { type: "string" } } };

		registerReadTool(
			pi,
			process.cwd(),
			undefined,
			{
				parameters: { type: "object", properties: {} },
				outputSchema,
				execute: async () => ({ content: [], details: {} }),
			},
			MockText,
		);

		expect(definition?.outputSchema).toBe(outputSchema);
	});

	it("ls forwards the host snippet, guidelines, constrained sampling, and output schema", () => {
		let definition: ToolDefinition | undefined;
		const pi = {
			registerTool: (d: ToolDefinition) => {
				definition = d;
			},
		} as unknown as ExtensionAPI;
		const outputSchema = { type: "object", properties: { entries: { type: "array" } } };

		registerLsTool(
			pi,
			process.cwd(),
			undefined,
			{
				description: "ls fixture",
				parameters: { type: "object", properties: {} },
				promptSnippet: "List directory contents",
				promptGuidelines: ["Use ls for quick directory listings."],
				constrainedSampling: { type: "json_schema", strict: "prefer" },
				outputSchema,
				execute: async () => ({ content: [], details: {} }),
			},
			MockText,
		);

		expect(definition?.promptSnippet).toBe("List directory contents");
		expect(definition?.promptGuidelines).toEqual(["Use ls for quick directory listings."]);
		expect(definition?.constrainedSampling).toEqual({ type: "json_schema", strict: "prefer" });
		expect(definition?.outputSchema).toBe(outputSchema);
	});

	it("grep and find forward constrained sampling and output schema without advertising search snippets", () => {
		const outputSchema = { type: "object", properties: { matches: { type: "array" } } };
		const constrainedSampling = { type: "json_schema" as const, strict: "prefer" as const };

		for (const register of [registerGrepTool, registerFindTool]) {
			let definition: ToolDefinition | undefined;
			const pi = {
				registerTool: (d: ToolDefinition) => {
					definition = d;
				},
			} as unknown as ExtensionAPI;

			register(
				pi,
				process.cwd(),
				undefined,
				{
					description: "search fixture",
					parameters: { type: "object", properties: {} },
					promptSnippet: "Should not be forwarded",
					promptGuidelines: ["Should not be forwarded"],
					constrainedSampling,
					outputSchema,
					execute: async () => ({ content: [], details: {} }),
				},
				MockText,
			);

			expect(definition?.promptSnippet).toBeUndefined();
			expect(definition?.promptGuidelines).toBeUndefined();
			expect(definition?.constrainedSampling).toEqual(constrainedSampling);
			expect(definition?.outputSchema).toBe(outputSchema);
		}
	});
});

describe("SDK details preservation", () => {
	it("read preserves existing SDK details fields when attaching render metadata", async () => {
		let definition: ToolDefinition | undefined;
		const pi = {
			registerTool: (d: ToolDefinition) => {
				definition = d;
			},
		} as unknown as ExtensionAPI;

		registerReadTool(
			pi,
			process.cwd(),
			undefined,
			{
				parameters: { type: "object", properties: {} },
				execute: async () => ({
					content: [{ type: "text", text: "line 1\nline 2" }],
					details: { truncation: { truncated: true, totalLines: 500 } },
				}),
			},
			MockText,
		);

		expect(definition).toBeDefined();
		const result = await definition?.execute(
			"tid",
			{ path: "foo.ts" },
			undefined,
			undefined,
			{} as Parameters<ToolDefinition["execute"]>[4],
		);
		expect(result?.details).toMatchObject({
			_type: "readFile",
			filePath: "foo.ts",
			truncation: { truncated: true, totalLines: 500 },
		});
	});
});
