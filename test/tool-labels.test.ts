import { describe, expect, it } from "vitest";
import { customToolTitle } from "../src/tools/labels.js";

describe("customToolTitle", () => {
	it("prefixes custom tool names with a gear", () => {
		expect(customToolTitle("example")).toBe("⚙ example");
	});
});
