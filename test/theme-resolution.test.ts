import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTheme } from "../src/render.js";

const DEFAULT_THEME = "github-dark";
const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function makeHome(settingsJson: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-pretty-theme-"));
	const settingsDir = join(dir, ".pi", "agent");
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(join(settingsDir, "settings.json"), settingsJson);
	homes.push(dir);
	return dir;
}

describe("resolveTheme", () => {
	it("prefers a valid PRETTY_THEME env value", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(resolveTheme("github-dark", "")).toBe("github-dark");
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns and falls back when PRETTY_THEME is not a bundled Shiki theme", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(resolveTheme("dark", "")).toBe(DEFAULT_THEME);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('theme "dark" from PRETTY_THEME'));
		expect(warn).toHaveBeenCalledWith(expect.stringContaining(DEFAULT_THEME));
	});

	it("accepts a bundled theme from settings.json when no env is set", () => {
		vi.stubEnv("PRETTY_THEME", "");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const home = makeHome(JSON.stringify({ theme: "github-light" }));
		expect(resolveTheme(undefined, home)).toBe("github-light");
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns and falls back when settings.json theme is a pi TUI theme, not a Shiki theme", () => {
		vi.stubEnv("PRETTY_THEME", "");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const home = makeHome(JSON.stringify({ theme: "dark" }));
		expect(resolveTheme(undefined, home)).toBe(DEFAULT_THEME);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('theme "dark" from ~/.pi/agent/settings.json'));
	});

	it("falls back silently when settings.json is missing", () => {
		vi.stubEnv("PRETTY_THEME", "");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const home = mkdtempSync(join(tmpdir(), "pi-pretty-theme-empty-"));
		homes.push(home);
		expect(resolveTheme(undefined, home)).toBe(DEFAULT_THEME);
		expect(warn).not.toHaveBeenCalled();
	});

	it("falls back silently on malformed settings.json", () => {
		vi.stubEnv("PRETTY_THEME", "");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const home = makeHome("{not json");
		expect(resolveTheme(undefined, home)).toBe(DEFAULT_THEME);
		expect(warn).not.toHaveBeenCalled();
	});

	it("falls back silently when the home directory is unavailable", () => {
		vi.stubEnv("PRETTY_THEME", "");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(resolveTheme(undefined, "")).toBe(DEFAULT_THEME);
		expect(warn).not.toHaveBeenCalled();
	});

	it("ignores non-string theme values from settings.json", () => {
		vi.stubEnv("PRETTY_THEME", "");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const home = makeHome(JSON.stringify({ theme: 42 }));
		expect(resolveTheme(undefined, home)).toBe(DEFAULT_THEME);
		expect(warn).not.toHaveBeenCalled();
	});

	it("rejects Object.prototype member names that are not bundled themes", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(resolveTheme("toString", "")).toBe(DEFAULT_THEME);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});
