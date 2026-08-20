import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

describe("read syntax highlighting", () => {
	it("maps Pi's dark theme to a bundled Shiki theme", async () => {
		vi.stubEnv("PRETTY_THEME", "dark");
		vi.resetModules();
		const { renderFileContent } = await import("../src/render.js");

		const output = await renderFileContent("const answer: number = 42;", "example.ts", 0, 80, 200);

		expect(stripVTControlCharacters(output)).toBe("const answer: number = 42;");
		expect(output).toContain("\x1b[38;2;");
	});

	it("falls back to the default theme for an unknown theme", async () => {
		vi.stubEnv("PRETTY_THEME", "not-a-shiki-theme");
		vi.resetModules();
		const { renderFileContent } = await import("../src/render.js");

		const output = await renderFileContent("const answer: number = 42;", "example.ts", 0, 80, 200);

		expect(output).toContain("\x1b[38;2;");
	});
});
