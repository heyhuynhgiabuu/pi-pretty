import { afterEach, beforeEach, describe, expect, it } from "vitest";

import piPrettyExtension, { __imageInternals } from "../src/index.js";

const ENV_KEYS = [
	"TMUX",
	"TERM",
	"TERM_PROGRAM",
	"LC_TERMINAL",
	"GHOSTTY_RESOURCES_DIR",
	"KITTY_WINDOW_ID",
	"KITTY_PID",
	"WEZTERM_EXECUTABLE",
	"WEZTERM_CONFIG_DIR",
	"WEZTERM_CONFIG_FILE",
	"COLORTERM",
	"PRETTY_IMAGE_PROTOCOL",
] as const;

class MockText {
	private text = "";
	constructor(_text = "", _x = 0, _y = 0) {}
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
}

function mockToolFactory(exec: any) {
	return (_cwd: string) => ({
		name: "mock",
		description: "mock",
		parameters: { type: "object", properties: {} },
		execute: exec,
	});
}

function loadReadTool(readExec: any) {
	const noopExec = async () => ({ content: [{ type: "text", text: "" }] });
	const tools = new Map<string, any>();
	const pi = {
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: () => {},
		on: () => {},
	};

	piPrettyExtension(pi, {
		sdk: {
			createReadToolDefinition: mockToolFactory(readExec),
			createBashToolDefinition: mockToolFactory(noopExec),
			createLsToolDefinition: mockToolFactory(noopExec),
			createFindToolDefinition: mockToolFactory(noopExec),
			createGrepToolDefinition: mockToolFactory(noopExec),
			getAgentDir: () => "/tmp/pi-pretty-test",
		},
		TextComponent: MockText,
	});

	return tools.get("read");
}

describe("image rendering terminal detection", () => {
	const envSnapshot = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const key of ENV_KEYS) {
			envSnapshot.set(key, process.env[key]);
			delete process.env[key];
		}
		__imageInternals.resetCachesForTests();
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const value = envSnapshot.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		__imageInternals.resetCachesForTests();
	});

	it("detects kitty protocol inside tmux via KITTY_WINDOW_ID", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,123,0";
		process.env.TERM_PROGRAM = "tmux";
		process.env.KITTY_WINDOW_ID = "1";

		expect(__imageInternals.getOuterTerminal()).toBe("kitty");
		expect(__imageInternals.detectImageProtocol()).toBe("kitty");
	});

	it("detects wezterm protocol inside tmux via WEZTERM_EXECUTABLE", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,123,0";
		process.env.TERM_PROGRAM = "tmux";
		process.env.WEZTERM_EXECUTABLE = "/Applications/WezTerm.app/Contents/MacOS/wezterm";

		expect(__imageInternals.getOuterTerminal()).toBe("WezTerm");
		expect(__imageInternals.detectImageProtocol()).toBe("iterm2");
	});

	it("falls back to tmux client term for outer terminal detection", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,123,0";
		process.env.TERM_PROGRAM = "tmux";
		__imageInternals.setTmuxClientTermOverrideForTests("xterm-kitty");

		expect(__imageInternals.getOuterTerminal()).toBe("kitty");
		expect(__imageInternals.detectImageProtocol()).toBe("kitty");
	});

	it("reports warning when tmux allow-passthrough is off", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,123,0";
		__imageInternals.setTmuxAllowPassthroughOverrideForTests(false);

		expect(__imageInternals.getTmuxPassthroughWarning("kitty")).toContain("allow-passthrough is off");
	});

	it("does not warn when tmux allow-passthrough is enabled", () => {
		process.env.TMUX = "/tmp/tmux-1000/default,123,0";
		__imageInternals.setTmuxAllowPassthroughOverrideForTests(true);

		expect(__imageInternals.getTmuxPassthroughWarning("kitty")).toBeNull();
	});

	it("renders explicit warning for read image when tmux passthrough is off", async () => {
		process.env.TMUX = "/tmp/tmux-1000/default,123,0";
		process.env.TERM_PROGRAM = "tmux";
		process.env.KITTY_WINDOW_ID = "1";
		__imageInternals.setTmuxAllowPassthroughOverrideForTests(false);

		const readTool = loadReadTool(async () => ({
			content: [{ type: "image", data: Buffer.from("fake").toString("base64"), mimeType: "image/png" }],
		}));

		const result = await readTool.execute("t1", { path: "media/inline-image.png" }, null, null, {});
		const rendered = readTool.renderResult(result, {}, {}, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: false,
			invalidate: () => {},
		});

		expect(rendered.getText()).toContain("allow-passthrough is off");
	});

	it("warns on non-PNG payloads for kitty protocol", async () => {
		process.env.TERM_PROGRAM = "kitty";

		const readTool = loadReadTool(async () => ({
			content: [{ type: "image", data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" }],
		}));

		const result = await readTool.execute("t1", { path: "media/photo.jpg" }, null, null, {});
		const rendered = readTool.renderResult(result, {}, {}, {
			lastComponent: new MockText(),
			isError: false,
			state: {},
			expanded: false,
			invalidate: () => {},
		});

		expect(rendered.getText()).toContain("supports PNG payloads");
	});
});
