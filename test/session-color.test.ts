import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Session accent tint (omp session-color.ts port, OKLCH essence).
 *
 * Seam: pure color functions + accent override behavior through
 * applyWorkingIndicator with a structural ui fake.
 */

const THEME_DIM = "\x1b[38;5;240m";
const THEME_MUTED = "\x1b[38;5;245m";
const THEME_ACCENT = "\x1b[38;5;39m";
const RESET = "\x1b[39m";

function stripAnsi(s: string): string {
	return s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

async function freshModule<T>(path: string): Promise<T> {
	vi.resetModules();
	return (await import(path)) as T;
}

beforeEach(() => {
	vi.stubEnv("PRETTY_ICONS", "nerd");
	vi.stubEnv("PRETTY_MAX_HL_CHARS", "");
	vi.stubEnv("PRETTY_MAX_PREVIEW_LINES", "");
	vi.stubEnv("PRETTY_CACHE_LIMIT", "");
	vi.stubEnv("PRETTY_THEME", "");
	vi.stubEnv("PRETTY_WORKING_INDICATOR", "");
	vi.stubEnv("PRETTY_WORKING_INDICATOR_MODE", "");
	vi.stubEnv("PRETTY_WORKING_INDICATOR_TEXT", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("session color derivation", () => {
	it("is deterministic per session name", async () => {
		const { sessionAccentHex } = await freshModule<typeof import("../src/session-color.js")>("../src/session-color.js");
		expect(sessionAccentHex("alpha")).toBe(sessionAccentHex("alpha"));
		expect(sessionAccentHex("alpha")).not.toBe(sessionAccentHex("beta"));
	});

	it("produces valid in-gamut hex for a spread of names", async () => {
		const { sessionAccentHex } = await freshModule<typeof import("../src/session-color.js")>("../src/session-color.js");
		const names = ["a", "session one", "pi-pretty", "x".repeat(64), "日本語", "", "0"];
		for (const name of names) {
			expect(sessionAccentHex(name)).toMatch(/^#[0-9a-f]{6}$/i);
		}
	});

	it("avoids the yellow and over-light cyan hues omp excludes on dark themes", async () => {
		const { sessionAccentHue } = await freshModule<typeof import("../src/session-color.js")>("../src/session-color.js");
		for (let i = 0; i < 500; i++) {
			const hue = sessionAccentHue(`name-${i}`);
			const excluded = (hue >= 94 && hue <= 138) || (hue >= 158 && hue <= 200);
			expect(excluded).toBe(false);
		}
	});

	it("matches the golden OKLCH value for a known name", async () => {
		const { sessionAccentHex } = await freshModule<typeof import("../src/session-color.js")>("../src/session-color.js");
		// Independent reference (Ottosson OKLCH matrices): djb2("golden") maps to
		// hue 46 on the dark arc; oklch(0.75, 0.14, 46) -> #f58f5d.
		expect(sessionAccentHex("golden")).toBe("#f58f5d");
		expect(sessionAccentHex("alpha")).toBe("#de8cd9");
	});

	it("dims the accent exactly like omp's adjustHsv(s*0.55, v*0.65)", async () => {
		const { sessionAccentHex, dimAccentHex } =
			await freshModule<typeof import("../src/session-color.js")>("../src/session-color.js");
		const accent = sessionAccentHex("alpha");
		const dim = dimAccentHex(accent);
		expect(dim).toMatch(/^#[0-9a-f]{6}$/i);
		expect(dim).not.toBe(accent);
		// #ff0000 → HSV(0,1,1); ×s0.55 ×v0.65 → HSV(0,0.55,0.65) → #a64b4b
		expect(dimAccentHex("#ff0000")).toBe("#a64b4b");
		// #00ff00 → HSV(120,0.55,0.65) → #4ba64b
		expect(dimAccentHex("#00ff00")).toBe("#4ba64b");
	});
});

describe("installWorkingIndicator session accent", () => {
	function makeUi() {
		const visible: boolean[] = [];
		const widgets: Array<{
			key: string;
			factory: ((tui: { requestRender(): void }, theme: unknown) => unknown) | undefined;
		}> = [];
		return {
			visible,
			widgets,
			ui: {
				theme: {
					fg: (name: "dim", text: string) => `<${name}>${text}</${name}>`,
					getFgAnsi: (name: "dim" | "muted" | "accent") =>
						name === "dim" ? THEME_DIM : name === "muted" ? THEME_MUTED : THEME_ACCENT,
				},
				setWorkingVisible: (value: boolean) => {
					visible.push(value);
				},
				setWidget: (
					key: string,
					factory: ((tui: { requestRender(): void }, theme: unknown) => unknown) | undefined,
				) => {
					widgets.push({ key, factory });
				},
			},
		};
	}

	async function installAt(
		settings: import("../src/working-indicator.js").WorkingIndicatorSettings,
		sessionName?: string,
	) {
		const mod = await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, visible, widgets } = makeUi();
		const controller = await mod.installWorkingIndicator(ui, settings, undefined, sessionName);
		const component = widgets[0]?.factory?.({ requestRender() {} }, undefined) as {
			render(width: number): string[];
		};
		controller.start();
		return { controller, component, visible, widgets };
	}

	function frameAt(component: { render(width: number): string[] }, index: number): string {
		// Advance the interval one tick per frame (intervalMs = 33).
		vi.advanceTimersByTime(33 * index);
		return component.render(80)[0] ?? "";
	}

	it("tints mid/high tiers with the session accent and the spinner with the dim variant", async () => {
		vi.useFakeTimers();
		const { WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { sessionAccentHex, dimAccentHex } =
			await freshModule<typeof import("../src/session-color.js")>("../src/session-color.js");
		const { controller, component, visible } = await installAt(WORKING_INDICATOR_DEFAULTS, "alpha");
		expect(visible).toEqual([false]);

		const accent = sessionAccentHex("alpha");
		const accentAnsi = `\x1b[38;2;${Number.parseInt(accent.slice(1, 3), 16)};${Number.parseInt(
			accent.slice(3, 5),
			16,
		)};${Number.parseInt(accent.slice(5, 7), 16)}m`;
		const dim = dimAccentHex(accent);
		const dimAnsi = `\x1b[38;2;${Number.parseInt(dim.slice(1, 3), 16)};${Number.parseInt(
			dim.slice(3, 5),
			16,
		)};${Number.parseInt(dim.slice(5, 7), 16)}m`;

		// Spinner (frame 0) uses the dim variant; text on frame 0 is all low tier.
		const frame0 = frameAt(component, 0);
		expect(frame0.startsWith(`${dimAnsi}⠋${RESET}`)).toBe(true);
		expect(frame0.includes(`${THEME_DIM}Working…`)).toBe(true);
		expect(controller.frames?.length ?? 0).toBe(28);
		// Frame 10 (band on text): high tier run "Wor" + mid tier run "ki" carry
		// the accent; theme muted/accent colors are fully replaced.
		const frame10 = frameAt(component, 10);
		expect(frame10.includes(`\x1b[1m${accentAnsi}Wor`)).toBe(true);
		expect(frame10.includes(`${accentAnsi}ki`)).toBe(true);
		// Low tier keeps the theme dim color + glyph/space/text shape.
		expect(stripAnsi(frame0).slice(2)).toBe("Working…");
	});

	it("keeps the theme palette when no session name exists", async () => {
		vi.useFakeTimers();
		const { WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { component } = await installAt(WORKING_INDICATOR_DEFAULTS, undefined);
		const frame10 = frameAt(component, 10);
		expect(frame10.includes(`\x1b[1m${THEME_ACCENT}Wor`)).toBe(true);
		expect(frame10.includes(`${THEME_MUTED}ki`)).toBe(true);
	});

	it("keeps the theme palette when sessionAccent is disabled", async () => {
		vi.useFakeTimers();
		const { WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { component } = await installAt({ ...WORKING_INDICATOR_DEFAULTS, sessionAccent: false }, "alpha");
		const frame10 = frameAt(component, 10);
		expect(frame10.includes(`${THEME_MUTED}ki`)).toBe(true);
	});

	it("explicit user mid/high palette wins over the session accent", async () => {
		vi.useFakeTimers();
		const { WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { component } = await installAt(
			{
				...WORKING_INDICATOR_DEFAULTS,
				palette: { ...WORKING_INDICATOR_DEFAULTS.palette, mid: "#101010", high: "#202020" },
				tiersCustomized: true,
			},
			"alpha",
		);
		const frame10 = frameAt(component, 10);
		// mid #101010 = rgb(16,16,16) on the mid run "ki"; high #202020 on "Wor"
		expect(frame10.includes("\x1b[38;2;16;16;16mki")).toBe(true);
		expect(frame10.includes(`\x1b[1m\x1b[38;2;32;32;32mWor`)).toBe(true);
	});
});

describe("resolveWorkingIndicatorSettings sessionAccent", () => {
	it("defaults sessionAccent to true and honors config", async () => {
		const { resolveWorkingIndicatorSettings, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		expect(WORKING_INDICATOR_DEFAULTS.sessionAccent).toBe(true);
		expect(resolveWorkingIndicatorSettings({ sessionAccent: false }).sessionAccent).toBe(false);
		expect(resolveWorkingIndicatorSettings({ sessionAccent: true }).sessionAccent).toBe(true);
		expect(resolveWorkingIndicatorSettings({}).sessionAccent).toBe(true);
	});
});
