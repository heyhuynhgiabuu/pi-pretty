import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const homes: string[] = [];

afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function makeConfigDir(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-pretty-config-"));
	writeFileSync(join(dir, "pi-pretty.json"), contents);
	homes.push(dir);
	return dir;
}

function makeEmptyDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-pretty-config-empty-"));
	homes.push(dir);
	return dir;
}

/** Fresh module instance so env-stubbed module-level bindings reset per test. */
async function freshModule<T>(path: string): Promise<T> {
	vi.resetModules();
	return (await import(path)) as T;
}

describe("normalizeToolList", () => {
	it("trims, lowercases, and drops non-strings and empties", async () => {
		const { normalizeToolList } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		expect(normalizeToolList([" LS ", "grep", 1, null, ""])).toEqual(["ls", "grep"]);
		expect(normalizeToolList("ls")).toEqual([]);
		expect(normalizeToolList(undefined)).toEqual([]);
	});
});

describe("loadConfig", () => {
	it("parses and validates all supported keys", async () => {
		const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		const dir = makeConfigDir(
			JSON.stringify({
				background: { tool: "#1e1e2e", error: "#2a1e1e" },
				theme: "github-dark",
				icons: "none",
				enableTools: ["LS", " grep "],
				disableTools: ["grep"],
				maxHlChars: 42,
				maxPreviewLines: 10,
				cacheLimit: 5,
				fff: { enableHomeScanning: true, enableRootScanning: false },
			}),
		);
		expect(loadConfig(dir)).toEqual({
			background: { tool: "#1e1e2e", error: "#2a1e1e" },
			theme: "github-dark",
			icons: "none",
			enableTools: ["ls", "grep"],
			disableTools: ["grep"],
			maxHlChars: 42,
			maxPreviewLines: 10,
			cacheLimit: 5,
			fff: { enableHomeScanning: true, enableRootScanning: false },
		});
	});

	it("merges every claudeStyle key instead of dropping the others", async () => {
		// The earlier implementation assigned `config.claudeStyle` wholesale, so a second key
		// silently erased the first. Both must survive, and tool names are normalised like
		// enableTools/disableTools.
		const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		const dir = makeConfigDir(
			JSON.stringify({
				toolStyle: "claudecode",
				claudeStyle: { expandFileTools: true, groupInlineTools: [" Bash ", "codemode", 7, ""] },
			}),
		);
		expect(loadConfig(dir).claudeStyle).toEqual({
			expandFileTools: true,
			groupInlineTools: ["bash", "codemode"],
		});
	});

	it("rejects a non-array groupInlineTools without losing expandFileTools", async () => {
		const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		const dir = makeConfigDir(JSON.stringify({ claudeStyle: { expandFileTools: false, groupInlineTools: "bash" } }));
		expect(loadConfig(dir).claudeStyle).toEqual({ expandFileTools: false });
	});

	it("validates FFF broad-scan settings", async () => {
		const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		const dir = makeConfigDir(
			JSON.stringify({
				fff: {
					enableHomeScanning: true,
					enableRootScanning: "yes",
					other: true,
				},
			}),
		);
		expect(loadConfig(dir)).toEqual({ fff: { enableHomeScanning: true } });
	});

	it("silently drops invalid fields", async () => {
		const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		const dir = makeConfigDir(
			JSON.stringify({
				background: { tool: "not-a-color", error: "#123456" },
				theme: 42,
				icons: true,
				enableTools: "ls",
				disableTools: [1, null],
				maxHlChars: 0,
				maxPreviewLines: -1,
				cacheLimit: 1.5,
			}),
		);
		expect(loadConfig(dir)).toEqual({ background: { error: "#123456" } });
	});

	it("returns {} for a missing or malformed config file", async () => {
		const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		expect(loadConfig(makeEmptyDir())).toEqual({});
		expect(loadConfig(makeConfigDir("{not json"))).toEqual({});
	});

	it("returns {} when the config directory override is empty", async () => {
		vi.stubEnv("PRETTY_CONFIG_DIR", "");
		const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		expect(loadConfig()).toEqual({});
	});

	it("reads ~/.pi/agent from os.homedir() when HOME is unset (Windows)", async () => {
		const home = makeEmptyDir();
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "pi-pretty.json"), JSON.stringify({ enableTools: ["ls"] }));
		vi.stubEnv("HOME", "");
		vi.stubEnv("PRETTY_CONFIG_DIR", undefined);
		vi.doMock("node:os", async (importOriginal) => ({
			...(await importOriginal<typeof import("node:os")>()),
			homedir: () => home,
		}));
		const config = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		vi.doUnmock("node:os");
		expect(config.getDefaultAgentDir()).toBe(join(home, ".pi", "agent"));
		expect(config.loadConfig()).toEqual({ enableTools: ["ls"] });
	});
});

describe("applyConfig", () => {
	it("applies config values when env vars are unset", async () => {
		vi.stubEnv("PRETTY_MAX_HL_CHARS", "");
		vi.stubEnv("PRETTY_MAX_PREVIEW_LINES", "");
		vi.stubEnv("PRETTY_CACHE_LIMIT", "");
		vi.stubEnv("PRETTY_ICONS", "");
		const config = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		config.applyConfig({ maxHlChars: 42, maxPreviewLines: 10, cacheLimit: 5, icons: "none" });
		expect(config.MAX_HL_CHARS).toBe(42);
		expect(config.MAX_PREVIEW_LINES).toBe(10);
		expect(config.CACHE_LIMIT).toBe(5);
		expect(config.USE_ICONS).toBe(false);
	});

	it("keeps env values when env vars are set", async () => {
		vi.stubEnv("PRETTY_MAX_HL_CHARS", "999");
		vi.stubEnv("PRETTY_ICONS", "nerd");
		const config = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		config.applyConfig({ maxHlChars: 42, icons: "none" });
		expect(config.MAX_HL_CHARS).toBe(999);
		expect(config.USE_ICONS).toBe(true);
	});

	it("treats icons 'off' like 'none'", async () => {
		vi.stubEnv("PRETTY_ICONS", "");
		const config = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		config.applyConfig({ icons: "off" });
		expect(config.USE_ICONS).toBe(false);
	});
});

describe("resolveFffScanSettings", () => {
	it("uses safe defaults", async () => {
		vi.stubEnv("PRETTY_FFF_HOME_SCAN", "");
		vi.stubEnv("PRETTY_FFF_ROOT_SCAN", "");
		const { resolveFffScanSettings } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		expect(resolveFffScanSettings({})).toEqual({ enableHomeScanning: false, enableRootScanning: false });
	});

	it("applies config, then environment, then CLI flags", async () => {
		vi.stubEnv("PRETTY_FFF_HOME_SCAN", "false");
		vi.stubEnv("PRETTY_FFF_ROOT_SCAN", "true");
		const { resolveFffScanSettings } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		expect(
			resolveFffScanSettings(
				{ fff: { enableHomeScanning: false, enableRootScanning: false } },
				{ enableHomeScanning: true },
			),
		).toEqual({ enableHomeScanning: true, enableRootScanning: true });
	});

	it("ignores invalid boolean overrides", async () => {
		vi.stubEnv("PRETTY_FFF_HOME_SCAN", "maybe");
		vi.stubEnv("PRETTY_FFF_ROOT_SCAN", "");
		const { resolveFffScanSettings } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		expect(resolveFffScanSettings({ fff: { enableHomeScanning: true } })).toEqual({
			enableHomeScanning: true,
			enableRootScanning: false,
		});
	});
});

describe("resolveToolSets", () => {
	it("prefers non-empty env sets over config arrays", async () => {
		const { resolveToolSets } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		expect(
			resolveToolSets(new Set(["read"]), new Set(["ls"]), { disableTools: ["grep"], enableTools: ["find"] }),
		).toEqual({ disabledTools: new Set(["read"]), enabledTools: new Set(["ls"]) });
	});

	it("falls back to config arrays when env sets are empty", async () => {
		const { resolveToolSets } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
		expect(resolveToolSets(new Set(), new Set(), { disableTools: ["grep"], enableTools: ["ls"] })).toEqual({
			disabledTools: new Set(["grep"]),
			enabledTools: new Set(["ls"]),
		});
	});
});

describe("getTheme", () => {
	it("uses the theme from pi-pretty.json when env is unset", async () => {
		vi.stubEnv("PRETTY_THEME", "");
		vi.stubEnv("PRETTY_CONFIG_DIR", makeConfigDir(JSON.stringify({ theme: "github-light" })));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const render = await freshModule<typeof import("../src/render.js")>("../src/render.js");
		expect(render.getTheme()).toBe("github-light");
		expect(warn).not.toHaveBeenCalled();
	});

	it("warns and falls back for an invalid config theme", async () => {
		vi.stubEnv("PRETTY_THEME", "");
		vi.stubEnv("PRETTY_CONFIG_DIR", makeConfigDir(JSON.stringify({ theme: "dark" })));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const render = await freshModule<typeof import("../src/render.js")>("../src/render.js");
		expect(render.getTheme()).toBe("github-dark");
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('theme "dark" from pi-pretty.json'));
	});

	it("lets PRETTY_THEME override the config theme", async () => {
		vi.stubEnv("PRETTY_THEME", "github-dark");
		vi.stubEnv("PRETTY_CONFIG_DIR", makeConfigDir(JSON.stringify({ theme: "github-light" })));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const render = await freshModule<typeof import("../src/render.js")>("../src/render.js");
		expect(render.getTheme()).toBe("github-dark");
		expect(warn).not.toHaveBeenCalled();
	});
});
