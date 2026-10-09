import { describe, expect, it } from "vitest";
import type { MarkdownTransformContext, MarkdownTransformer } from "@earendil-works/pi-coding-agent";

import piPrettyExtension from "../src/index.js";

async function loadMarkdownTransformer(): Promise<MarkdownTransformer> {
	let transformer: MarkdownTransformer | undefined;
	const pi = {
		registerMarkdownTransformer: (candidate: MarkdownTransformer) => {
			transformer = candidate;
		},
		registerTool: () => {},
		registerToolRenderer: () => {},
		registerCommand: () => {},
		on: () => {},
	};

	await piPrettyExtension(pi as never, {
		sdk: {},
		fffModule: undefined,
	});

	if (!transformer) throw new Error("pi-pretty did not register a Markdown transformer");
	return transformer;
}

function context(messageType: MarkdownTransformContext["messageType"]): MarkdownTransformContext {
	return { messageType, isStreaming: false, availableWidth: 80 };
}

describe("user message rendering", () => {
	it("prefixes user messages with a prompt icon using the message text color", async () => {
		const transform = await loadMarkdownTransformer();

		expect(transform("call some bash tool, no impact", context("user"))).toBe(
			" ❯ call some bash tool, no impact",
		);
	});

	it("does not prefix assistant or thinking Markdown", async () => {
		const transform = await loadMarkdownTransformer();

		expect(transform("assistant response", context("assistant"))).toBe("assistant response");
		expect(transform("internal thought", context("assistant-thinking"))).toBe("internal thought");
	});
});
