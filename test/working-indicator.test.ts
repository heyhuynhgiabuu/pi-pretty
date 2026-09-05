import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * omp-style shimmer working indicator (widget takeover).
 *
 * The host Loader hardcodes paddingX=1, so flush-left rendering requires
 * owning the row: setWorkingVisible(false) + setWidget(factory) with our own
 * interval-driven component.
 *
 * Seam: pure frame builder + settings/palette resolvers + WorkingWidget +
 * installWorkingIndicator against a structural ui fake.
 */

const L = "\x1b[30m";
const M = "\x1b[31m";
const H = "\x1b[32m";
const RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

/** Strip all SGR sequences so only visible text remains. */
const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function stripAnsi(s: string): string {
	return s.replace(SGR_RE, "");
}

const THEME_THINKING = "\x1b[38;5;117m";
const ANSI = { low: L, mid: M, high: H };

async function freshModule<T>(path: string): Promise<T> {
	vi.resetModules();
	return (await import(path)) as T;
}

beforeEach(() => {
	// config.js reads several PRETTY_* vars at import time; stub them neutral.
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
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("buildWorkingFrames (classic shimmer)", () => {
	it("produces one frame per band position: codePoints + 2*padding", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames, intervalMs } = buildWorkingFrames(["abcdefghij"], {
			mode: "shimmer",
			ansi: ANSI,
			spinner: false,
		});
		expect(frames).toHaveLength(10 + 20);
		expect(intervalMs).toBe(33);
	});

	it("renders the exact coalesced tier runs at a known band position", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["abcdefghij"], { mode: "shimmer", ansi: ANSI, spinner: false });
		// Band center lands on text index 0 (pos = padding): tiers high(0-2) mid(3-4) low(5-9)
		expect(frames[10]).toBe(`${BOLD_OPEN}${H}abc${BOLD_CLOSE}${RESET}${M}de${RESET}${L}fghij${RESET}`);
		// Band fully off-text: single low run
		expect(frames[0]).toBe(`${L}abcdefghij${RESET}`);
	});

	it("keeps the visible text intact in every frame", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["Working…"], { mode: "shimmer", ansi: ANSI, spinner: false });
		expect(frames).toHaveLength(28);
		for (const frame of frames) expect(stripAnsi(frame)).toBe("Working…");
	});

	it("never splits surrogate pairs (emoji is one cell)", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["a🎉b"], { mode: "shimmer", ansi: ANSI, spinner: false });
		// 3 code points + 20 padding; a UTF-16-unit implementation would yield 24
		expect(frames).toHaveLength(23);
		for (const frame of frames) expect(stripAnsi(frame)).toBe("a🎉b");
	});

	it("omits bold when bold=false", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["abcdefghij"], {
			mode: "shimmer",
			ansi: ANSI,
			bold: false,
			spinner: false,
		});
		expect(frames[10]).toBe(`${H}abc${RESET}${M}de${RESET}${L}fghij${RESET}`);
		expect(frames.some((f) => f.includes(BOLD_OPEN))).toBe(false);
	});

	it("wraps frames in italic when italic=true", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["abc"], {
			mode: "shimmer",
			ansi: ANSI,
			bold: false,
			spinner: false,
			italic: true,
		});
		expect(frames[0]).toBe(`\x1b[3m${L}abc${RESET}\x1b[23m`);
		for (const frame of frames) expect(stripAnsi(frame)).toBe("abc");
	});

	it("keeps exactly one space between spinner glyph and text", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["abcdefghij"], { mode: "shimmer", ansi: ANSI });
		expect(frames[0].startsWith(`${L}⠋${RESET}`)).toBe(true);
		expect(frames[3].startsWith(`${L}⠙${RESET}`)).toBe(true);
		expect(frames[6].startsWith(`${L}⠹${RESET}`)).toBe(true);
		for (const frame of frames) {
			const stripped = stripAnsi(frame);
			// Glyph + one space + text (the leading host padding is removed by the
			// widget takeover, not here).
			expect(stripped.slice(2)).toBe("abcdefghij");
			expect(stripped[1]).toBe(" ");
			expect(stripped[0]).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		}
	});

	it("appends the pre-colored hint suffix verbatim", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const hint = `${L} (ctrl+esc to interrupt)${RESET}`;
		const { frames } = buildWorkingFrames(["Working…"], { mode: "shimmer", ansi: ANSI, spinner: false, hint });
		expect(frames[0].endsWith(hint)).toBe(true);
	});
});

describe("buildWorkingFrames (rotating phrases)", () => {
	it("plays one full sweep per phrase, concatenated in order", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["ab…", "xyz"], { mode: "shimmer", ansi: ANSI, spinner: false });
		// "ab…" = 3 code points → 23 frames; "xyz" = 3 code points → 23 frames
		expect(frames).toHaveLength(46);
		for (let i = 0; i < 23; i++) expect(stripAnsi(frames[i])).toBe("ab…");
		for (let i = 23; i < 46; i++) expect(stripAnsi(frames[i])).toBe("xyz");
	});

	it("keeps the spinner phase continuous across phrase boundaries", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["ab…", "xyz"], { mode: "shimmer", ansi: ANSI });
		// Chapter boundary at frame 23: floor(22/3)=7 → ⠏; floor(23/3)=7 → ⠏
		const boundaryGlyph = stripAnsi(frames[22])[0];
		const nextGlyph = stripAnsi(frames[23])[0];
		expect(boundaryGlyph).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		expect(nextGlyph).toBe(boundaryGlyph);
		// ...and it advances 3 frames later as usual
		expect(stripAnsi(frames[26])[0]).not.toBe(nextGlyph);
	});

	it("appends the hint to every frame across all chapters", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const hint = `${L} (esc to interrupt)${RESET}`;
		const { frames } = buildWorkingFrames(["ab…", "xyz"], { mode: "shimmer", ansi: ANSI, spinner: false, hint });
		for (const frame of frames) expect(frame.endsWith(hint)).toBe(true);
	});

	it("skips empty phrases and yields no frames when all are empty", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const onlyEmpty = buildWorkingFrames(["", "   "], { mode: "shimmer", ansi: ANSI });
		expect(onlyEmpty.frames).toEqual([]);
		const mixed = buildWorkingFrames(["", "ok"], { mode: "shimmer", ansi: ANSI, spinner: false });
		expect(mixed.frames).toHaveLength(22);
		for (const frame of mixed.frames) expect(stripAnsi(frame)).toBe("ok");
	});
});

describe("buildWorkingFrames (kitt scanner)", () => {
	it("ping-pongs: one frame per sweep position, head chars are high", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["abc"], { mode: "kitt", ansi: ANSI, spinner: false });
		// cycle = 2*(3-1) = 4
		expect(frames).toHaveLength(4);
		// Head starts on the first char
		expect(frames[0].includes(`${BOLD_OPEN}${H}a`)).toBe(true);
		// Last sweep has the head on the last char
		expect(frames[3].includes(`${BOLD_OPEN}${H}bc`)).toBe(true);
		for (const frame of frames) expect(stripAnsi(frame)).toBe("abc");
	});
});

describe("buildWorkingFrames (static)", () => {
	it("emits a single mid-colored frame with no animation", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames, intervalMs } = buildWorkingFrames(["abc"], { mode: "static", ansi: ANSI, spinner: false });
		expect(frames).toEqual([`${M}abc${RESET}`]);
		expect(intervalMs).toBe(33);
	});

	it("renders only the first phrase in static mode (no flicker)", async () => {
		const { buildWorkingFrames } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { frames } = buildWorkingFrames(["one", "two"], { mode: "static", ansi: ANSI, spinner: false });
		expect(frames).toEqual([`${M}one${RESET}`]);
	});
});

describe("WorkingWidget", () => {
	it("renders flush-left only while started, cycles at intervalMs, disposes cleanly", async () => {
		vi.useFakeTimers();
		const { WorkingWidget } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const widget = new WorkingWidget();
		widget.setFrames([`${L}a${RESET}`, `${L}b${RESET}`, `${L}c${RESET}`], 33);
		const renders: number[] = [];
		widget.attach({ requestRender: () => void renders.push(1) });
		// Not started → renders nothing (row invisible when idle)
		expect(widget.render(80)).toEqual([]);
		widget.start();
		// Flush-left: the line starts with the frame, no leading padding
		expect(widget.render(80)).toEqual([`${L}a${RESET}`]);
		vi.advanceTimersByTime(33);
		expect(renders).toHaveLength(1);
		expect(widget.render(80)).toEqual([`${L}b${RESET}`]);
		vi.advanceTimersByTime(66);
		expect(widget.render(80)).toEqual([`${L}a${RESET}`]);
		widget.stop();
		expect(widget.render(80)).toEqual([]);
		vi.advanceTimersByTime(66);
		expect(renders).toHaveLength(3); // nothing after stop
		expect(() => widget.dispose()).not.toThrow();
	});

	it("truncates rendered lines to the viewport width", async () => {
		vi.useFakeTimers();
		const { WorkingWidget } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const widget = new WorkingWidget();
		widget.setFrames([`${H}abcdefgh${RESET}`], 33);
		widget.start();
		const line = widget.render(5)[0];
		expect(stripAnsi(line).length).toBeLessThanOrEqual(5);
	});

	it("does not tick the animation for a single frame", async () => {
		vi.useFakeTimers();
		const { WorkingWidget } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const widget = new WorkingWidget();
		widget.setFrames([`${H}static${RESET}`], 33);
		const renders: number[] = [];
		widget.attach({ requestRender: () => void renders.push(1) });
		widget.start();
		expect(widget.render(80)).toEqual([`${H}static${RESET}`]);
		vi.advanceTimersByTime(330);
		expect(renders).toHaveLength(0);
	});

	it("exposes requestRender through the attached tui", async () => {
		const { WorkingWidget } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const widget = new WorkingWidget();
		const tuiCalls: number[] = [];
		widget.attach({ requestRender: () => void tuiCalls.push(1) });
		widget.requestRender();
		expect(tuiCalls).toHaveLength(1);
		// No tui attached → still safe
		const bare = new WorkingWidget();
		expect(() => bare.requestRender()).not.toThrow();
	});

	it("appends the dim stats suffix after the frame, truncated to width", async () => {
		const { WorkingWidget } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const widget = new WorkingWidget();
		widget.setFrames([`${H}Working…${RESET}`], 33);
		widget.start();
		expect(widget.render(80)).toEqual([`${H}Working…${RESET}`]);
		widget.setStats(" (↓ 1,234 tokens)");
		const line = widget.render(80)[0] ?? "";
		expect(stripAnsi(line)).toBe("Working… (↓ 1,234 tokens)");
		expect(line).toContain("\u001b[38;2;80;80;80m"); // dim styling from the widget
		// Narrow viewport truncates the combined line, never overflows
		const narrow = widget.render(8)[0] ?? "";
		expect(stripAnsi(narrow).length).toBeLessThanOrEqual(8);
		widget.setStats(undefined);
		expect(widget.render(80)).toEqual([`${H}Working…${RESET}`]);
	});
});

describe("resolveWorkingIndicatorSettings", () => {
	it("falls back to defaults when nothing is configured", async () => {
		const { resolveWorkingIndicatorSettings, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		expect(resolveWorkingIndicatorSettings(undefined)).toEqual(WORKING_INDICATOR_DEFAULTS);
		expect(WORKING_INDICATOR_DEFAULTS.enabled).toBe(true);
		expect(WORKING_INDICATOR_DEFAULTS.texts).toEqual(["Working…"]);
		expect(WORKING_INDICATOR_DEFAULTS.mode).toBe("shimmer");
	});

	it("applies valid config values over defaults", async () => {
		const { resolveWorkingIndicatorSettings } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const settings = resolveWorkingIndicatorSettings({
			enabled: false,
			text: "Thinking…",
			mode: "kitt",
			low: "#101010",
			high: "accent",
			bold: false,
			hint: false,
		});
		expect(settings.enabled).toBe(false);
		expect(settings.texts).toEqual(["Thinking…"]);
		expect(settings.mode).toBe("kitt");
		expect(settings.palette.low).toBe("#101010");
		expect(settings.palette.high).toBe("accent");
		expect(settings.palette.mid).toBe("muted");
		expect(settings.bold).toBe(false);
		expect(settings.hint).toBe(false);
	});

	it("accepts an array of phrases and drops invalid entries", async () => {
		const { resolveWorkingIndicatorSettings } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const settings = resolveWorkingIndicatorSettings({
			text: ["Working…", "  ", "Thinking…", 42 as unknown as string, "Bad\nPhrase"],
		});
		expect(settings.texts).toEqual(["Working…", "Thinking…"]);

		const allInvalid = resolveWorkingIndicatorSettings({ text: ["   ", ""] });
		expect(allInvalid.texts).toEqual(["Working…"]);
	});

	it("drops text with control characters or beyond 120 code points", async () => {
		const { resolveWorkingIndicatorSettings } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const newline = resolveWorkingIndicatorSettings({ text: "Working\n…" });
		expect(newline.texts).toEqual(["Working…"]);
		const control = resolveWorkingIndicatorSettings({ text: `W\u0007orking` });
		expect(control.texts).toEqual(["Working…"]);
		const tooLong = resolveWorkingIndicatorSettings({ text: "x".repeat(121) });
		expect(tooLong.texts).toEqual(["Working…"]);
		const atLimit = resolveWorkingIndicatorSettings({ text: "x".repeat(120) });
		expect(atLimit.texts).toEqual(["x".repeat(120)]);
	});

	it("lets env vars win over config; empty/invalid env means unset", async () => {
		const { resolveWorkingIndicatorSettings } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const env = {
			PRETTY_WORKING_INDICATOR: "off",
			PRETTY_WORKING_INDICATOR_MODE: "kitt",
			PRETTY_WORKING_INDICATOR_TEXT: "Building…",
		} as NodeJS.ProcessEnv;
		const settings = resolveWorkingIndicatorSettings({ enabled: true, mode: "static" }, env);
		expect(settings.enabled).toBe(false);
		expect(settings.mode).toBe("kitt");
		expect(settings.texts).toEqual(["Building…"]);

		const untouched = resolveWorkingIndicatorSettings({ enabled: false, mode: "kitt", text: "Keep" }, {
			PRETTY_WORKING_INDICATOR: "",
			PRETTY_WORKING_INDICATOR_MODE: "bogus",
			PRETTY_WORKING_INDICATOR_TEXT: "  ",
		} as NodeJS.ProcessEnv);
		expect(untouched.enabled).toBe(false);
		expect(untouched.mode).toBe("kitt");
		expect(untouched.texts).toEqual(["Keep"]);
	});

	it("splits comma-separated env text into a phrase list", async () => {
		const { resolveWorkingIndicatorSettings } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const settings = resolveWorkingIndicatorSettings({ text: "FromFile" }, {
			PRETTY_WORKING_INDICATOR_TEXT: "One…,Two…, Three … ,  ",
		} as NodeJS.ProcessEnv);
		expect(settings.texts).toEqual(["One…", "Two…", "Three …"]);
	});
});

describe("resolvePaletteAnsi", () => {
	it("resolves hex colors to truecolor ANSI", async () => {
		const { resolvePaletteAnsi } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const ansi = resolvePaletteAnsi({ low: "#101010", mid: "#202020", high: "#303030" });
		expect(ansi.low).toBe("\x1b[38;2;16;16;16m");
		expect(ansi.high).toBe("\x1b[38;2;48;48;48m");
	});

	it("resolves theme color names through the active theme", async () => {
		const { resolvePaletteAnsi } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const ansi = resolvePaletteAnsi(
			{ low: "dim", mid: "muted", high: "accent" },
			{
				getFgAnsi: (name: string) => `\x1b[38;5;${name.length}m`,
			},
		);
		expect(ansi.low).toBe("\x1b[38;5;3m");
		expect(ansi.high).toBe("\x1b[38;5;6m");
	});

	it("falls back to pi-pretty constants for unknown names or missing theme", async () => {
		const { resolvePaletteAnsi } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const ansi = resolvePaletteAnsi({ low: "not-a-color", mid: "muted", high: "accent" });
		expect(ansi.low).toBe("\x1b[38;2;80;80;80m");
		const themed = resolvePaletteAnsi(
			{ low: "dim", mid: "muted", high: "accent" },
			{
				getFgAnsi: (name: string) => {
					if (name === "muted") throw new Error("boom");
					return "\x1b[38;5;9m";
				},
			},
		);
		expect(themed.low).toBe("\x1b[38;5;9m");
		expect(themed.mid).toBe("\x1b[38;2;139;148;158m");
	});
});

describe("installWorkingIndicator", () => {
	function makeUi() {
		const visible: boolean[] = [];
		const widgets: Array<{
			key: string;
			factory: ((tui: { requestRender(): void }, theme: unknown) => unknown) | undefined;
			options?: { placement?: string };
		}> = [];
		return {
			visible,
			widgets,
			ui: {
				theme: {
					fg: (name: string, text: string) => `<${name}>${text}</${name}>`,
					getFgAnsi: (name: string) => `\x1b[38;5;${name.length}m`,
				},
				setWorkingVisible: (value: boolean) => {
					visible.push(value);
				},
				setWidget: (
					key: string,
					factory: ((tui: { requestRender(): void }, theme: unknown) => unknown) | undefined,
					options?: { placement?: string },
				) => {
					widgets.push({ key, factory, options });
				},
			},
		};
	}

	it("hides the host loader and installs a flush-left animated widget", async () => {
		vi.useFakeTimers();
		const { installWorkingIndicator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, visible, widgets } = makeUi();
		const controller = await installWorkingIndicator(ui, WORKING_INDICATOR_DEFAULTS, {
			getKeybindings: () => ({ getKeys: () => ["ctrl+esc"] }),
		});
		// Host loader hidden, widget installed above the editor
		expect(visible).toEqual([false]);
		expect(widgets).toHaveLength(1);
		expect(widgets[0].key).toBe("pi-pretty-working");
		expect(widgets[0].options).toEqual({ placement: "aboveEditor" });
		// Factory is invoked by the host once with (tui, theme)
		const component = widgets[0].factory?.({ requestRender() {} }, undefined) as {
			render(width: number): string[];
		};
		controller.start();
		const line = component.render(80)[0];
		// Flush-left: visible text starts with the spinner glyph — no leading padding
		expect(stripAnsi(line)).toMatch(/^⠋ /);
		expect(line).toContain("(ctrl+esc to interrupt)");
		controller.stop();
		expect(component.render(80)).toEqual([]);
	});

	it("controller exposes setStats and requestRender passthroughs", async () => {
		vi.useFakeTimers();
		const { installWorkingIndicator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, widgets } = makeUi();
		const controller = await installWorkingIndicator(ui, WORKING_INDICATOR_DEFAULTS, {
			getKeybindings: () => ({ getKeys: () => ["ctrl+esc"] }),
		});
		const tuiRenders: number[] = [];
		const component = widgets[0].factory?.({ requestRender: () => void tuiRenders.push(1) }, undefined) as {
			render(width: number): string[];
		};
		controller.start();
		controller.requestRender();
		expect(tuiRenders).toHaveLength(1);
		controller.setStats(" (↓ 42 tokens)");
		expect(stripAnsi(component.render(80)[0] ?? "")).toContain("(↓ 42 tokens)");
	});

	it("start/stop follow the streaming lifecycle idempotently", async () => {
		vi.useFakeTimers();
		const { installWorkingIndicator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, widgets } = makeUi();
		const controller = await installWorkingIndicator(ui, WORKING_INDICATOR_DEFAULTS);
		const component = widgets[0].factory?.({ requestRender() {} }, undefined) as {
			render(width: number): string[];
		};
		controller.start();
		controller.start();
		expect(component.render(80).length).toBe(1);
		vi.advanceTimersByTime(33 * 5);
		controller.stop();
		controller.stop();
		expect(component.render(80)).toEqual([]);
	});

	it("dispose removes the widget and stops the animation", async () => {
		vi.useFakeTimers();
		const { installWorkingIndicator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, widgets } = makeUi();
		const controller = await installWorkingIndicator(ui, WORKING_INDICATOR_DEFAULTS);
		controller.dispose();
		expect(widgets).toHaveLength(2);
		expect(widgets[1].key).toBe("pi-pretty-working");
		expect(widgets[1].factory).toBeUndefined();
		const component = widgets[0].factory?.({ requestRender() {} }, undefined) as {
			render(width: number): string[];
		};
		controller.start();
		expect(component.render(80)).toEqual([]);
	});

	it("does not hide the host loader when widget installation fails", async () => {
		const { installWorkingIndicator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const calls: Array<[string, unknown]> = [];
		const ui = {
			theme: {},
			setWorkingVisible: (value: boolean) => {
				calls.push(["visible", value]);
			},
			setWidget: () => {
				throw new Error("no widgets on this host");
			},
		};
		await expect(installWorkingIndicator(ui, WORKING_INDICATOR_DEFAULTS)).rejects.toThrow("no widgets");
		// setWorkingVisible(false) must not have run before the failure
		expect(calls).toEqual([]);
	});

	it("does nothing when disabled or when every phrase is blank", async () => {
		const { installWorkingIndicator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, visible, widgets } = makeUi();
		await installWorkingIndicator(ui, { ...WORKING_INDICATOR_DEFAULTS, enabled: false });
		await installWorkingIndicator(ui, { ...WORKING_INDICATOR_DEFAULTS, texts: ["  ", ""] });
		expect(visible).toEqual([]);
		expect(widgets).toEqual([]);
	});

	it("still installs when keybindings are unavailable (hint dropped)", async () => {
		vi.useFakeTimers();
		const { installWorkingIndicator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, widgets } = makeUi();
		await installWorkingIndicator(ui, WORKING_INDICATOR_DEFAULTS, {
			getKeybindings: () => {
				throw new Error("no keybindings");
			},
		});
		const component = widgets[0]?.factory?.({ requestRender() {} }, undefined) as {
			render(width: number): string[];
		};
		component.render(0); // smoke: render callable
		expect(widgets[0].factory).toBeDefined();
	});
});

describe("thinkingBlockActive", () => {
	it("is true only while the last content block is a thinking block", async () => {
		const { thinkingBlockActive } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		expect(thinkingBlockActive({ content: [{ type: "thinking", thinking: "hmm" }] })).toBe(true);
		expect(
			thinkingBlockActive({
				content: [
					{ type: "thinking", thinking: "hmm" },
					{ type: "text", text: "hi" },
				],
			}),
		).toBe(false);
		expect(thinkingBlockActive({ content: [] })).toBe(false);
		expect(thinkingBlockActive(undefined)).toBe(false);
		expect(thinkingBlockActive({})).toBe(false);
	});
});

describe("createThinkingLabelAnimator guards", () => {
	function baseUi(extra: Record<string, unknown> = {}) {
		return {
			theme: {
				fg: (_name: "dim", text: string) => text,
				getFgAnsi: (name: "dim" | "muted" | "accent" | "thinkingText") =>
					name === "dim" ? L : name === "muted" ? M : name === "accent" ? H : THEME_THINKING,
			},
			...extra,
		};
	}

	it("is a no-op when the host lacks setHiddenThinkingLabel", async () => {
		const { createThinkingLabelAnimator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const ui = baseUi();
		const animator = createThinkingLabelAnimator(ui as never, WORKING_INDICATOR_DEFAULTS);
		expect(() => animator.tick()).not.toThrow();
		expect(() => animator.restore()).not.toThrow();
	});

	it("applies a single static frame only once", async () => {
		const { createThinkingLabelAnimator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const labels: Array<string | undefined> = [];
		const ui = baseUi({
			setHiddenThinkingLabel: (label?: string) => {
				labels.push(label);
			},
		});
		const animator = createThinkingLabelAnimator(ui, { ...WORKING_INDICATOR_DEFAULTS, mode: "static" });
		expect(animator.frames).toHaveLength(1);
		animator.tick();
		animator.tick();
		animator.tick();
		expect(labels).toHaveLength(1);
	});
});

describe("resolveThinkingIndicatorSettings", () => {
	it("defaults to enabled and parses config + env", async () => {
		const { resolveThinkingIndicatorSettings, THINKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		expect(THINKING_INDICATOR_DEFAULTS.enabled).toBe(true);
		expect(resolveThinkingIndicatorSettings(undefined).enabled).toBe(true);
		expect(resolveThinkingIndicatorSettings({ enabled: false }).enabled).toBe(false);
		expect(
			resolveThinkingIndicatorSettings({ enabled: true }, { PRETTY_THINKING_INDICATOR: "off" } as NodeJS.ProcessEnv)
				.enabled,
		).toBe(false);
		expect(
			resolveThinkingIndicatorSettings({ enabled: false }, { PRETTY_THINKING_INDICATOR: "" } as NodeJS.ProcessEnv)
				.enabled,
		).toBe(false);
	});
});

describe("working row token stats", () => {
	it("estimates tokens from visible chars and prefers provider usage.output", async () => {
		const module = (await freshModule("../src/working-indicator.js")) as Record<string, unknown>;
		const workingTokens = module.workingTokens as (message: unknown) => number;
		// 200 visible chars → 50 estimated tokens
		expect(
			workingTokens({
				content: [
				{ type: "text", text: "a".repeat(120) },
			{ type: "thinking", thinking: "b".repeat(80) },
			],
			}),
		).toBe(50);
		// Provider output wins over the estimate
		expect(workingTokens({ content: [{ type: "text", text: "x".repeat(400) }], usage: { output: 1234 } })).toBe(1234);
		// Invalid/zero usage falls back to the estimate
		expect(workingTokens({ content: [{ type: "text", text: "x".repeat(400) }], usage: { output: 0 } })).toBe(100);
		expect(
			workingTokens({ content: [{ type: "text", text: "x".repeat(400) }], usage: { output: Number.NaN } }),
		).toBe(100);
		// Nothing visible yet
		expect(workingTokens({ content: [] })).toBe(0);
		expect(workingTokens(undefined)).toBe(0);
		expect(workingTokens({})).toBe(0);
		// Non-string blocks ignored
		expect(workingTokens({ content: [{ type: "text", text: 42 }, { type: "toolCall" }] })).toBe(0);
	});
});

describe("thinking elapsed timer", () => {
	it("formats whole-second durations compactly", async () => {
		const module = (await freshModule("../src/working-indicator.js")) as Record<string, unknown>;
		const formatThinkingDuration = module.formatThinkingDuration as (elapsedMs: number) => string;
		expect(formatThinkingDuration(0)).toBe("0s");
		expect(formatThinkingDuration(999)).toBe("0s");
		expect(formatThinkingDuration(12_999)).toBe("12s");
		expect(formatThinkingDuration(60_000)).toBe("1m 00s");
		expect(formatThinkingDuration(3_723_999)).toBe("1h 02m 03s");
	});

	it("shows elapsed time while active, freezes the completion label, and restores on cleanup", async () => {
		const module = (await freshModule("../src/working-indicator.js")) as Record<string, unknown>;
		const createThinkingTimer = module.createThinkingTimer as (
			animator: {
				tick(label?: string): void;
				show(label: string): void;
				restore(): void;
				readonly frames: readonly string[];
			},
			now: () => number,
			startElapsedMs?: number,
		) => { tick(): void; complete(): number | undefined; restore(): void };
		const events: string[] = [];
		const animator = {
			frames: [],
			tick: (label = "") => events.push(`tick:${label}`),
			show: (label: string) => events.push(`show:${label}`),
			restore: () => events.push("restore"),
		};
		let now = 1_000;
		const timer = createThinkingTimer(animator, () => now);
		timer.tick();
		now = 13_999;
		timer.tick();
		const done = timer.complete();
		expect(done).toBe(12_999);
		now = 99_000;
		timer.tick(); // Completion is frozen; later ticks do nothing.
		expect(timer.complete()).toBeUndefined();
		timer.restore();
		timer.tick();
		timer.complete();
		expect(events).toEqual(["tick:Thinking... 0s", "tick:Thinking... 12s", "show:Thought for 12s", "restore"]);
	});

	it("resumes a later run in the same message from the accumulated elapsed time", async () => {
		const module = (await freshModule("../src/working-indicator.js")) as Record<string, unknown>;
		const createThinkingTimer = module.createThinkingTimer as (
			animator: { tick(label?: string): void; show(label: string): void; restore(): void; frames: readonly string[] },
			now: () => number,
			startElapsedMs?: number,
		) => { tick(): void; complete(): number | undefined; restore(): void };
		const labels: string[] = [];
		const animator = {
			frames: [],
			tick: (label = "") => labels.push(label),
			show: (label: string) => labels.push(label),
			restore: () => labels.push("<restore>"),
		};
		let now = 5_000;
		const run1 = createThinkingTimer(animator, () => now);
		run1.tick();
		now = 10_000;
		const done1 = run1.complete();
		expect(done1).toBe(5_000);
		// Second run in the same message resumes from run 1's total.
		now = 12_000;
		const run2 = createThinkingTimer(animator, () => now, done1);
		run2.tick();
		now = 20_500;
		run2.tick();
		const done2 = run2.complete();
		expect(labels.at(-1)).toBe("Thought for 13s"); // 5s + 8.5s
		expect(done2).toBe(13_500);
	});
});

describe("per-row hidden-thinking labels", () => {
	class FakeRow {
		label: string | undefined;
		lastMessage: { timestamp: number } | undefined;
		setHiddenThinkingLabel(label?: string): void {
			this.label = label;
		}
	}

	it("substitutes each row's own label: active animates, completed freezes, unknown defaults", async () => {
		const { installPerRowThinkingLabels } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const rows = [new FakeRow(), new FakeRow(), new FakeRow()];
		rows[0].lastMessage = { timestamp: 1 };
		rows[1].lastMessage = { timestamp: 2 };
		rows[2].lastMessage = { timestamp: 3 };
		const perRow = installPerRowThinkingLabels(FakeRow);
		expect(perRow).toBeDefined();
		perRow!.complete(2, 4_000);
		perRow!.setActive(1);
		for (const row of rows) row.setHiddenThinkingLabel("frameX");
		expect(rows[0].label).toBe("frameX"); // streaming row keeps the animating frame
		expect(rows[1].label).toBe("Thought for 4s"); // completed row keeps its own duration
		expect(rows[2].label).toBe("Thinking..."); // unknown row gets the default
		perRow!.uninstall();
	});

	it("passes the incoming label through when the row has no usable timestamp", async () => {
		const { installPerRowThinkingLabels } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		class BadRow {
			label: string | undefined;
		lastMessage: unknown;
		setHiddenThinkingLabel(label?: string): void {
			this.label = label;
		}
		}
		const perRow = installPerRowThinkingLabels(BadRow)!;
		const row = new BadRow();
		row.setHiddenThinkingLabel("frameX");
		expect(row.label).toBe("frameX"); // no lastMessage
		row.lastMessage = { timestamp: "not-a-number" };
		row.setHiddenThinkingLabel("frameY");
		expect(row.label).toBe("frameY"); // non-number timestamp
		perRow.uninstall();
	});

	it("transitions: active row completes and freezes; a new active row takes over", async () => {
		const { installPerRowThinkingLabels } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const row1 = new FakeRow();
		const row2 = new FakeRow();
		row1.lastMessage = { timestamp: 1 };
		row2.lastMessage = { timestamp: 2 };
		const perRow = installPerRowThinkingLabels(FakeRow)!;
		perRow.setActive(1);
		row1.setHiddenThinkingLabel("f1");
		row2.setHiddenThinkingLabel("f1");
		expect(row1.label).toBe("f1");
		expect(row2.label).toBe("Thinking...");
		perRow.complete(1, 3_000);
		perRow.setActive(2);
		row1.setHiddenThinkingLabel("f2");
		row2.setHiddenThinkingLabel("f2");
		expect(row1.label).toBe("Thought for 3s");
		expect(row2.label).toBe("f2");
		perRow.clearActive();
		row2.setHiddenThinkingLabel("f3");
		expect(row2.label).toBe("Thinking...");
		perRow.uninstall();
	});

	it("uninstall restores the original setter and double install reuses the controller", async () => {
		const { installPerRowThinkingLabels } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const row = new FakeRow();
		row.lastMessage = { timestamp: 1 };
		const first = installPerRowThinkingLabels(FakeRow)!;
		expect(installPerRowThinkingLabels(FakeRow)).toBe(first);
		first.uninstall();
		expect(installPerRowThinkingLabels(FakeRow)).not.toBe(first);
		const second = installPerRowThinkingLabels(FakeRow)!;
		second.complete(1, 9_000);
		row.setHiddenThinkingLabel("frameX");
		expect(row.label).toBe("Thought for 9s");
		second.uninstall();
		row.setHiddenThinkingLabel("plain");
		expect(row.label).toBe("plain");
	});

	it("returns undefined for unusable component classes", async () => {
		const { installPerRowThinkingLabels } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		expect(installPerRowThinkingLabels(undefined)).toBeUndefined();
		expect(installPerRowThinkingLabels("nope")).toBeUndefined();
		expect(installPerRowThinkingLabels(function noSetter() {})).toBeUndefined();
	});
});

describe("createThinkingLabelAnimator", () => {
	function makeUi() {
		const labels: Array<string | undefined> = [];
		return {
			labels,
			ui: {
				theme: {
					fg: (name: "dim", text: string) => `<${name}>${text}</${name}>`,
					getFgAnsi: (name: "dim" | "muted" | "accent" | "thinkingText") =>
						name === "dim" ? L : name === "muted" ? M : name === "accent" ? H : THEME_THINKING,
				},
				setHiddenThinkingLabel: (label?: string) => {
					labels.push(label);
				},
			},
		};
	}

	it("cycles italic shimmer frames of the pi default label and restores on demand", async () => {
		const { createThinkingLabelAnimator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, labels } = makeUi();
		const animator = createThinkingLabelAnimator(ui, WORKING_INDICATOR_DEFAULTS, undefined);
		expect(animator.frames.length).toBe(31); // "Thinking..." = 11 cps + 20 padding
		animator.tick();
		for (let i = 0; i < 10; i++) animator.tick();
		expect(labels).toHaveLength(11);
		// Frames 0-3 are the identical all-low lead-in; the band arrives later.
		expect(labels[0]).not.toBe(labels[10]);
		for (const label of labels) expect(stripAnsi(label)).toBe("Thinking...");
		// Italic + thinkingText low tier; no spinner glyph on the label row.
		expect(labels[0]).toContain(`\x1b[3m`);
		expect(labels[0]).toContain(`${THEME_THINKING}Thinking`);
		expect(labels[0].startsWith(`⠋`)).toBe(false);
		animator.restore();
		expect(labels[labels.length - 1]).toBeUndefined();
	});

	it("rebuilds shimmer frames for elapsed wording and applies completion wording without animation", async () => {
		const { createThinkingLabelAnimator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, labels } = makeUi();
		const animator = createThinkingLabelAnimator(ui, WORKING_INDICATOR_DEFAULTS);
		animator.tick("Thinking... 7s");
		expect(stripAnsi(labels.at(-1) ?? "")).toBe("Thinking... 7s");
		expect(animator.frames.every((frame) => stripAnsi(frame) === "Thinking... 7s")).toBe(true);
		animator.show("Thought for 7s");
		expect(labels.at(-1)).toBe("Thought for 7s");
	});

	it("tints mid/high tiers with the session accent", async () => {
		const { createThinkingLabelAnimator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { sessionAccentHex } = await freshModule<typeof import("../src/session-color.js")>("../src/session-color.js");
		const { ui, labels } = makeUi();
		const animator = createThinkingLabelAnimator(ui, WORKING_INDICATOR_DEFAULTS, "alpha");
		animator.tick();
		const accent = sessionAccentHex("alpha");
		const accentAnsi = `\x1b[38;2;${Number.parseInt(accent.slice(1, 3), 16)};${Number.parseInt(
			accent.slice(3, 5),
			16,
		)};${Number.parseInt(accent.slice(5, 7), 16)}m`;
		// 11 ticks → frame 10 (band center on text): high run "Thi", mid run "nk"
		for (let i = 0; i < 11; i++) animator.tick();
		const frame10 = labels[10];
		expect(frame10.includes(`\x1b[1m${accentAnsi}Thi`)).toBe(true);
		expect(frame10.includes(`${accentAnsi}nk`)).toBe(true);
		expect(frame10.includes(M)).toBe(false);
	});

	it("is a no-op when disabled", async () => {
		const { createThinkingLabelAnimator, WORKING_INDICATOR_DEFAULTS } =
			await freshModule<typeof import("../src/working-indicator.js")>("../src/working-indicator.js");
		const { ui, labels } = makeUi();
		const animator = createThinkingLabelAnimator(ui, WORKING_INDICATOR_DEFAULTS, undefined, {
			enabled: false,
		});
		animator.tick();
		animator.restore();
		expect(labels).toEqual([]);
	});
});

describe("loadConfig parses workingIndicator", () => {
	it("keeps valid fields and drops invalid ones", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pi-pretty-wi-"));
		try {
			writeFileSync(
				join(dir, "pi-pretty.json"),
				JSON.stringify({
					workingIndicator: {
						enabled: false,
						text: ["Building…", "Deploying…", 7, ""],
						mode: "kitt",
						low: "#101010",
						mid: 7,
						high: "accent",
						bold: true,
						hint: false,
						extra: "ignored",
					},
				}),
			);
			const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
			const config = loadConfig(dir);
			expect(config.workingIndicator).toEqual({
				enabled: false,
				text: ["Building…", "Deploying…"],
				mode: "kitt",
				low: "#101010",
				high: "accent",
				bold: true,
				hint: false,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps a plain-string text and drops empty arrays", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pi-pretty-wi-"));
		try {
			writeFileSync(join(dir, "pi-pretty.json"), JSON.stringify({ workingIndicator: { text: "Solo" } }));
			const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
			expect(loadConfig(dir).workingIndicator).toEqual({ text: "Solo" });
			writeFileSync(join(dir, "pi-pretty.json"), JSON.stringify({ workingIndicator: { text: [] } }));
			expect(loadConfig(dir).workingIndicator).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("parses thinkingIndicator enabled flag", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pi-pretty-ti-"));
		try {
			writeFileSync(join(dir, "pi-pretty.json"), JSON.stringify({ thinkingIndicator: { enabled: false } }));
			const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
			expect(loadConfig(dir).thinkingIndicator).toEqual({ enabled: false });
			writeFileSync(join(dir, "pi-pretty.json"), JSON.stringify({ thinkingIndicator: "nope" }));
			expect(loadConfig(dir).thinkingIndicator).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns no workingIndicator when the field is absent or not an object", async () => {
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pi-pretty-wi-"));
		try {
			writeFileSync(join(dir, "pi-pretty.json"), JSON.stringify({ workingIndicator: "nope" }));
			const { loadConfig } = await freshModule<typeof import("../src/config.js")>("../src/config.js");
			expect(loadConfig(dir).workingIndicator).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
