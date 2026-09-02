/**
 * omp-style shimmer working indicator (widget takeover).
 *
 * Ports the shimmer sweep from oh-my-pi's `modes/theme/shimmer.ts`: the sweep
 * is discretized into one pre-rendered frame per band position, cycled at
 * 1000/30 ms so the band travels 30 cells/second — omp's exact speed.
 *
 * Why a widget: the host `Loader` extends `Text` with a hardcoded paddingX=1,
 * and `setWorkingIndicator({ frames })` cannot change host component layout.
 * To render the row flush-left we hide the host loader
 * (`setWorkingVisible(false)`) and install our own zero-padding component via
 * `setWidget(..., "aboveEditor")`, animating it with a 33ms interval.
 *
 * Frame layout: `<dim spinner> <shimmer text> <dim interrupt hint>`, one full
 * sweep per phrase — `texts` rotates through phrases chapter by chapter with
 * a continuous spinner phase.
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { FG_BLUE, FG_DIM, FG_MUTED, type ThinkingIndicatorConfig, type WorkingIndicatorConfig } from "./config.js";
import { dimAccentHex, hexToAnsiFg, sessionAccentHex } from "./session-color.js";

// ─── Sweep tunables (oh-my-pi shimmer.ts) ────────────────────────────────────
const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;
const KITT_HEAD_HALF = 0.6;
const KITT_TRAIL_LEN = 7;
const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

/** One cell per frame at 33ms = omp's 30 cells/second band speed. */
export const WORKING_INTERVAL_MS = Math.round(1000 / 30);

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Spinner glyph advances every N frames (~99ms ≈ pi's default 80ms cadence). */
const SPINNER_STEP = 3;

const RESET_FG = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";
const ITALIC_OPEN = "\x1b[3m";
const ITALIC_CLOSE = "\x1b[23m";
/** Fallback for pi's thinkingText tier when no theme is available. */
const FG_THINKING_FALLBACK = "\x1b[38;2;148;148;184m";

// ─── Settings ────────────────────────────────────────────────────────────────

export type WorkingIndicatorMode = "shimmer" | "kitt" | "static";

/** Tier colors as config values: a pi theme color name or a `#rrggbb` hex. */
export interface WorkingIndicatorPalette {
	low: string;
	mid: string;
	high: string;
}

export interface WorkingIndicatorSettings {
	enabled: boolean;
	/** Phrases rotated chapter-by-chapter across the sweep. */
	texts: string[];
	mode: WorkingIndicatorMode;
	palette: WorkingIndicatorPalette;
	bold: boolean;
	hint: boolean;
	/** Tint mid/high tiers (and dim the spinner) with a per-session accent color. */
	sessionAccent: boolean;
	/** True when the user explicitly configured `mid`/`high` — accent then stays off. */
	tiersCustomized?: boolean;
}

export const WORKING_INDICATOR_DEFAULTS: WorkingIndicatorSettings = {
	enabled: true,
	texts: ["Working…"],
	mode: "shimmer",
	palette: { low: "dim", mid: "muted", high: "accent" },
	bold: true,
	hint: true,
	sessionAccent: true,
	tiersCustomized: false,
};

const MODES: readonly WorkingIndicatorMode[] = ["shimmer", "kitt", "static"];

function isMode(value: unknown): value is WorkingIndicatorMode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

function envFlag(value: string | undefined): boolean | undefined {
	const v = value?.trim().toLowerCase();
	if (!v) return undefined;
	if (v === "off" || v === "false" || v === "0") return false;
	if (v === "on" || v === "true" || v === "1") return true;
	return undefined;
}

/** Longest working label we build frames for (the sweep is one frame per code point + padding). */
const MAX_TEXT_CODE_POINTS = 120;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are exactly what we sanitize out of user text
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

/**
 * Accept a configured label only if it renders safely in the single-line
 * working row: no control characters (including newlines) and bounded length.
 * Returns undefined for anything invalid, falling back to the default.
 */
function sanitizeText(value: unknown): string | undefined {
	const text = typeof value === "string" ? value.trim() : undefined;
	if (!text) return undefined;
	if (CONTROL_CHARS_RE.test(text)) return undefined;
	if ([...text].length > MAX_TEXT_CODE_POINTS) return undefined;
	return text;
}

/** Sanitize a `string | string[]` config value into a valid phrase list. */
function sanitizeTexts(input: unknown): string[] | undefined {
	const list = Array.isArray(input) ? input : [input];
	const out: string[] = [];
	for (const item of list) {
		const text = sanitizeText(item);
		if (text) out.push(text);
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Resolve final settings from `pi-pretty.json`'s flat `workingIndicator` object
 * and env overrides. Precedence: env var > config > default; empty or invalid
 * env values mean unset (matching pi-pretty's config conventions).
 */
export function resolveWorkingIndicatorSettings(
	config: WorkingIndicatorConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): WorkingIndicatorSettings {
	const settings: WorkingIndicatorSettings = {
		...WORKING_INDICATOR_DEFAULTS,
		palette: { ...WORKING_INDICATOR_DEFAULTS.palette },
	};
	const envEnabled = envFlag(env.PRETTY_WORKING_INDICATOR);
	if (envEnabled !== undefined) settings.enabled = envEnabled;
	else if (typeof config?.enabled === "boolean") settings.enabled = config.enabled;

	const envMode = isMode(env.PRETTY_WORKING_INDICATOR_MODE) ? env.PRETTY_WORKING_INDICATOR_MODE : undefined;
	settings.mode = envMode ?? (isMode(config?.mode) ? config.mode : settings.mode);

	const envTexts = sanitizeTexts(env.PRETTY_WORKING_INDICATOR_TEXT?.split(",").map((part) => part.trim()));
	settings.texts = envTexts ?? sanitizeTexts(config?.text) ?? settings.texts;

	for (const tier of ["low", "mid", "high"] as const) {
		const value = config?.[tier];
		if (typeof value === "string" && value.trim() !== "") settings.palette[tier] = value;
	}
	if (typeof config?.bold === "boolean") settings.bold = config.bold;
	if (typeof config?.hint === "boolean") settings.hint = config.hint;
	if (typeof config?.sessionAccent === "boolean") settings.sessionAccent = config.sessionAccent;
	settings.tiersCustomized = typeof config?.mid === "string" || typeof config?.high === "string";
	return settings;
}

// ─── Palette resolution ──────────────────────────────────────────────────────

/** Tier colors as raw ANSI open sequences. */
export interface ResolvedPalette {
	low: string;
	mid: string;
	high: string;
}

interface ThemeAnsiSource {
	/** Narrowed tier names; pi's Theme (ThemeColor) satisfies this structurally. */
	getFgAnsi?: (name: "dim" | "muted" | "accent" | "thinkingText") => string;
}

function colorToAnsi(value: string, theme: ThemeAnsiSource | undefined, fallback: string): string {
	const hex = hexToAnsiFg(value);
	if (hex) return hex;
	try {
		// Pi's ThemeColor is a closed TS union, but getFgAnsi accepts any registered
		// theme color at runtime; unknown names throw or return non-ANSI garbage,
		// both handled below.
		const getFgAnsi = theme?.getFgAnsi as ((name: string) => string) | undefined;
		const viaTheme = getFgAnsi?.(value);
		if (viaTheme?.startsWith("\x1b[")) return viaTheme;
	} catch {
		// Unknown theme color name: fall through to the built-in constant.
	}
	return fallback;
}

/**
 * Resolve tier colors to ANSI open sequences. `#rrggbb` wins, then the active
 * pi theme (`getFgAnsi`), then pi-pretty's built-in constants.
 */
export function resolvePaletteAnsi(palette: WorkingIndicatorPalette, theme?: ThemeAnsiSource): ResolvedPalette {
	return {
		low: colorToAnsi(palette.low, theme, FG_DIM),
		mid: colorToAnsi(palette.mid, theme, FG_MUTED),
		high: colorToAnsi(palette.high, theme, FG_BLUE),
	};
}

// ─── Frame building ──────────────────────────────────────────────────────────

type Tier = "low" | "mid" | "high";

function tierFor(intensity: number): Tier {
	if (intensity >= TIER_HIGH) return "high";
	if (intensity >= TIER_MID) return "mid";
	return "low";
}

/** Smooth cosine bump sweeping left → right with edge padding. */
function classicIntensity(index: number, pos: number): number {
	const dist = Math.abs(index + CLASSIC_PADDING - pos);
	if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
	return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

/**
 * Knight Rider K.I.T.T. scanner: a single bright head ping-pongs across the
 * text with a quadratic-decay trail behind it (oh-my-pi shimmer.ts).
 */
function kittIntensity(index: number, head: number, goingRight: boolean): number {
	const delta = index - head;
	if (Math.abs(delta) <= KITT_HEAD_HALF) return 1;
	const behind = goingRight ? -delta : delta;
	if (behind <= KITT_HEAD_HALF) return 0;
	const t = (behind - KITT_HEAD_HALF) / KITT_TRAIL_LEN;
	if (t >= 1) return 0;
	const f = 1 - t;
	return f * f;
}

/** UTF-16 [start, end] index pairs per code point (surrogate-pair safe). */
function codePointRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let i = 0;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			const c2 = text.charCodeAt(i + 1);
			if (c2 >= 0xdc00 && c2 <= 0xdfff) {
				ranges.push([i, i + 2]);
				i += 2;
				continue;
			}
		}
		ranges.push([i, i + 1]);
		i += 1;
	}
	return ranges;
}

export interface WorkingFrameOptions {
	mode: WorkingIndicatorMode;
	/** Resolved ANSI open sequences per tier. */
	ansi: ResolvedPalette;
	bold?: boolean;
	spinner?: boolean;
	/** Spinner glyph color; defaults to `ansi.low` (omp tints it with the dim accent). */
	spinnerColor?: string;
	/** Wrap every frame in italic (pi's hidden-thinking label is italic). */
	italic?: boolean;
	/** Pre-colored suffix (e.g. the dim interrupt hint) appended to every frame. */
	hint?: string;
	intervalMs?: number;
}

/**
 * Build the frame list for the working row: one full sweep per phrase, in
 * order, with the spinner phase running continuously across chapter
 * boundaries. Same-tier runs share one ANSI pair (omp's run coalescing).
 */
export function buildWorkingFrames(
	texts: string[],
	options: WorkingFrameOptions,
): { frames: string[]; intervalMs: number } {
	const intervalMs = options.intervalMs ?? WORKING_INTERVAL_MS;
	const bold = options.bold ?? true;
	const suffix = options.hint ?? "";
	const withSpinner = options.spinner ?? true;
	const spinnerColor = options.spinnerColor ?? options.ansi.low;
	const highOpen = bold ? `${BOLD_OPEN}${options.ansi.high}` : options.ansi.high;
	const highClose = bold ? `${BOLD_CLOSE}${RESET_FG}` : RESET_FG;
	const seq: Record<Tier, { open: string; close: string }> = {
		low: { open: options.ansi.low, close: RESET_FG },
		mid: { open: options.ansi.mid, close: RESET_FG },
		high: { open: highOpen, close: highClose },
	};

	const spinnerPrefix = (frameIndex: number): string => {
		if (!withSpinner) return "";
		const glyph = SPINNER_FRAMES[Math.floor(frameIndex / SPINNER_STEP) % SPINNER_FRAMES.length] ?? "";
		return `${spinnerColor}${glyph}${RESET_FG} `;
	};

	const paintFrame = (text: string, ranges: Array<[number, number]>, tiers: Tier[]): string => {
		const total = ranges.length;
		let out = "";
		let runStart = 0;
		let runTier: Tier | null = null;
		const flush = (endIndex: number): void => {
			if (runTier === null || endIndex <= runStart) return;
			const s = seq[runTier];
			out += `${s.open}${text.slice(ranges[runStart][0], ranges[endIndex - 1][1])}${s.close}`;
		};
		for (let i = 0; i < total; i++) {
			if (tiers[i] !== runTier) {
				flush(i);
				runTier = tiers[i] ?? null;
				runStart = i;
			}
		}
		flush(total);
		return options.italic ? `${ITALIC_OPEN}${out}${ITALIC_CLOSE}` : out;
	};

	const frames: string[] = [];
	let spinnerIndex = 0;

	for (const raw of texts) {
		const text = raw.trim();
		const ranges = codePointRanges(text);
		const total = ranges.length;
		if (total === 0) continue;

		if (options.mode === "static") {
			// Static mode: one unanimated frame — only the first phrase renders.
			frames.push(
				`${spinnerPrefix(spinnerIndex++)}${paintFrame(
					text,
					ranges,
					Array.from({ length: total }, () => "mid" as Tier),
				)}${suffix}`,
			);
			return { frames, intervalMs };
		}

		if (options.mode === "kitt") {
			const range = total - 1;
			if (range <= 0) {
				frames.push(
					`${spinnerPrefix(spinnerIndex++)}${paintFrame(
						text,
						ranges,
						Array.from({ length: total }, () => "high" as Tier),
					)}${suffix}`,
				);
				continue;
			}
			const cycleCells = 2 * range;
			for (let sweep = 0; sweep < cycleCells; sweep++) {
				const goingRight = sweep < range;
				const head = goingRight ? sweep : cycleCells - sweep;
				const tiers = Array.from({ length: total }, (_, i) => tierFor(kittIntensity(i, head, goingRight)));
				frames.push(`${spinnerPrefix(spinnerIndex++)}${paintFrame(text, ranges, tiers)}${suffix}`);
			}
		} else {
			const period = total + CLASSIC_PADDING * 2;
			for (let pos = 0; pos < period; pos++) {
				const tiers = Array.from({ length: total }, (_, i) => tierFor(classicIntensity(i, pos)));
				frames.push(`${spinnerPrefix(spinnerIndex++)}${paintFrame(text, ranges, tiers)}${suffix}`);
			}
		}
	}
	return { frames, intervalMs };
}

// ─── Widget ──────────────────────────────────────────────────────────────────

/** Slice of the pi-tui TUI instance the widget needs. */
export interface WidgetTuiLike {
	requestRender(): void;
}

/**
 * Zero-padding working-row component. The host renders whatever `render()`
 * returns with no margins, so the row sits flush-left — the thing the frames
 * API could not do.
 */
export class WorkingWidget {
	#frames: string[] = [];
	#index = 0;
	#intervalMs = WORKING_INTERVAL_MS;
	#interval: ReturnType<typeof setInterval> | undefined;
	#tui: WidgetTuiLike | undefined;
	#started = false;
	#disposed = false;

	setFrames(frames: string[], intervalMs: number): void {
		this.#frames = frames;
		this.#intervalMs = intervalMs;
		this.#index = 0;
	}

	attach(tui: WidgetTuiLike): void {
		this.#tui = tui;
	}

	start(): void {
		if (this.#disposed || this.#started) return;
		this.#started = true;
		this.#index = 0;
		// A single frame has nothing to cycle — skip the 30fps render churn.
		if (this.#frames.length <= 1) return;
		this.#interval = setInterval(() => {
			this.#index = (this.#index + 1) % Math.max(1, this.#frames.length);
			this.#tui?.requestRender();
		}, this.#intervalMs);
	}

	stop(): void {
		this.#started = false;
		if (this.#interval) {
			clearInterval(this.#interval);
			this.#interval = undefined;
		}
	}

	/** Flush-left single line; invisible (no lines) while stopped. */
	render(width: number): string[] {
		if (!this.#started || this.#frames.length === 0) return [];
		const frame = this.#frames[this.#index % this.#frames.length] ?? "";
		return [truncateToWidth(frame, Math.max(1, width))];
	}

	invalidate(): void {
		// Stateless per render — nothing to invalidate.
	}

	dispose(): void {
		this.stop();
		this.#disposed = true;
	}
}

// ─── Thinking label ───────────────────────────────────────────────────────────

export interface ThinkingIndicatorSettings {
	enabled: boolean;
}

export const THINKING_INDICATOR_DEFAULTS: ThinkingIndicatorSettings = { enabled: true };

/**
 * Resolve thinking-label shimmer settings from `pi-pretty.json`'s
 * `thinkingIndicator` object and env overrides (env > config > default).
 */
export function resolveThinkingIndicatorSettings(
	config: ThinkingIndicatorConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): ThinkingIndicatorSettings {
	const settings: ThinkingIndicatorSettings = { ...THINKING_INDICATOR_DEFAULTS };
	const envEnabled = envFlag(env.PRETTY_THINKING_INDICATOR);
	if (envEnabled !== undefined) settings.enabled = envEnabled;
	else if (typeof config?.enabled === "boolean") settings.enabled = config.enabled;
	return settings;
}

export interface ThinkingUiLike {
	theme?: WorkingThemeLike;
	setHiddenThinkingLabel(label?: string): void;
}

export interface ThinkingLabelAnimator {
	/** Apply the next shimmer frame to the hidden-thinking label. */
	tick(): void;
	/** Restore pi's default static label. */
	restore(): void;
	/** Pre-rendered label frames (exposed for diagnostics). */
	readonly frames: readonly string[];
}

const THINKING_LABEL = "Thinking...";

/**
 * True while a streaming assistant message is currently emitting a thinking
 * block (its last content block). Used to gate label ticks to the thinking
 * phase — once text or tool calls stream, the label is frozen back to pi's
 * default instead of rebuilding the transcript for a row nobody watches.
 */
export function thinkingBlockActive(message: unknown): boolean {
	const content = (message as { content?: Array<{ type?: string }> } | undefined)?.content;
	if (!Array.isArray(content) || content.length === 0) return false;
	return content[content.length - 1]?.type === "thinking";
}

/**
 * Animate pi's hidden-thinking label ("Thinking...") with the same shimmer as
 * the working row. Pi renders the label as static italic `thinkingText` text;
 * the only extension lever is `setHiddenThinkingLabel(label)`, which rebuilds
 * chat children — the streaming component already rebuilds per delta, so the
 * animator is driven at a throttled cadence (100ms) from index.ts while the
 * agent streams and thinking blocks are hidden.
 *
 * Tiers: low = theme `thinkingText` (pi's own label look), mid/high = session
 * accent when enabled; every frame is italic like pi's label; no spinner.
 */
export function createThinkingLabelAnimator(
	ui: ThinkingUiLike,
	workSettings: WorkingIndicatorSettings,
	sessionName?: string,
	thinking?: ThinkingIndicatorSettings,
): ThinkingLabelAnimator {
	const noop: ThinkingLabelAnimator = {
		tick() {},
		restore() {},
		frames: [],
	};
	if (thinking && !thinking.enabled) return noop;
	if (typeof ui.setHiddenThinkingLabel !== "function") return noop;

	const ansiResolved = resolvePaletteAnsi(workSettings.palette, ui.theme);
	let ansi: ResolvedPalette = {
		...ansiResolved,
		low: colorToAnsi("thinkingText", ui.theme, FG_THINKING_FALLBACK),
	};
	if (workSettings.sessionAccent && sessionName && !workSettings.tiersCustomized) {
		const accent = hexToAnsiFg(sessionAccentHex(sessionName));
		if (accent) ansi = { ...ansi, mid: accent, high: accent };
	}
	const { frames } = buildWorkingFrames([THINKING_LABEL], {
		mode: workSettings.mode,
		ansi,
		bold: workSettings.bold,
		spinner: false,
		italic: true,
	});
	if (frames.length === 0) return noop;

	let index = 0;
	let applied = false;
	return {
		frames,
		tick(): void {
			// A single frame (static mode) never changes — skip redundant rebuilds.
			if (applied && frames.length === 1) return;
			ui.setHiddenThinkingLabel(frames[index % frames.length]);
			index++;
			applied = true;
		},
		restore(): void {
			// undefined → pi falls back to its default static label.
			ui.setHiddenThinkingLabel(undefined);
		},
	};
}

// ─── Installation ────────────────────────────────────────────────────────────

/** Structural slice of pi's Theme needed for the hint, palette, and thinking label. */
export interface WorkingThemeLike {
	/** Narrowed to the only color the hint needs; pi's ThemeColor satisfies it. */
	fg?: (name: "dim", text: string) => string;
	getFgAnsi?: (name: "dim" | "muted" | "accent" | "thinkingText") => string;
}

export interface WorkingUiLike {
	theme?: WorkingThemeLike;
	setWorkingVisible(visible: boolean): void;
	setWidget(
		key: string,
		factory: ((tui: WidgetTuiLike, theme: unknown) => WorkingWidget) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

export interface KeybindingsLike {
	getKeys(name: string): string[];
}

export interface WorkingIndicatorController {
	/** Streaming began — show and animate the row. */
	start(): void;
	/** Streaming ended — hide the row and pause the animation. */
	stop(): void;
	/** Remove the widget and stop the animation. */
	dispose(): void;
	/** Pre-rendered frames (exposed for diagnostics). */
	readonly frames: readonly string[];
}

const WIDGET_KEY = "pi-pretty-working";

async function loadHostKeybindings(): Promise<KeybindingsLike | undefined> {
	try {
		const tui = (await import("@earendil-works/pi-tui")) as typeof import("@earendil-works/pi-tui");
		return tui.getKeybindings?.();
	} catch {
		return undefined;
	}
}

function formatKeyText(keys: string[]): string {
	const darwin = process.platform === "darwin";
	return keys
		.join("/")
		.split("/")
		.map((key) =>
			key
				.split("+")
				.map((part) => (darwin && part.toLowerCase() === "alt" ? "option" : part))
				.join("+"),
		)
		.join("/");
}

async function resolveHint(
	ui: WorkingUiLike,
	deps?: { getKeybindings?: () => KeybindingsLike | undefined | Promise<KeybindingsLike | undefined> },
): Promise<string | undefined> {
	try {
		const loader = deps?.getKeybindings ?? loadHostKeybindings;
		const keybindings = await loader();
		const keys = keybindings?.getKeys?.("app.interrupt");
		if (!keys?.length) return undefined;
		const text = ` (${formatKeyText(keys)} to interrupt)`;
		return ui.theme?.fg ? ui.theme.fg("dim", text) : text;
	} catch {
		return undefined;
	}
}

/**
 * Take over pi's working row with our own flush-left shimmer widget.
 *
 * Installs a zero-padding component above the editor and hides the host
 * loader; returns a controller the host lifecycle drives (`start` on
 * agent_start, `stop` on agent_end). No-op (host defaults untouched) when
 * disabled or the phrase list is empty.
 */
export async function installWorkingIndicator(
	ui: WorkingUiLike,
	settings: WorkingIndicatorSettings,
	deps?: { getKeybindings?: () => KeybindingsLike | undefined | Promise<KeybindingsLike | undefined> },
	sessionName?: string,
): Promise<WorkingIndicatorController> {
	const noopController: WorkingIndicatorController = {
		start() {},
		stop() {},
		dispose() {},
		frames: [],
	};
	if (!settings.enabled) return noopController;
	const texts = settings.texts.map((t) => t.trim()).filter((t) => t.length > 0);
	if (texts.length === 0) return noopController;

	const ansiResolved = resolvePaletteAnsi(settings.palette, ui.theme);
	let ansi = ansiResolved;
	let spinnerColor: string | undefined;
	if (settings.sessionAccent && sessionName && !settings.tiersCustomized) {
		const accentHex = sessionAccentHex(sessionName);
		const accent = hexToAnsiFg(accentHex);
		if (accent) {
			ansi = { ...ansi, mid: accent, high: accent };
			spinnerColor = hexToAnsiFg(dimAccentHex(accentHex));
		}
	}
	const hint = settings.hint ? await resolveHint(ui, deps) : undefined;
	const { frames, intervalMs } = buildWorkingFrames(texts, {
		mode: settings.mode,
		ansi,
		bold: settings.bold,
		spinnerColor,
		hint,
	});
	if (frames.length === 0) return noopController;

	const widget = new WorkingWidget();
	widget.setFrames(frames, intervalMs);
	// Widget first, visibility second: if setWidget throws (older host without
	// the API) the host loader was never hidden and pi's default remains.
	ui.setWidget(
		WIDGET_KEY,
		(tui) => {
			widget.attach(tui);
			return widget;
		},
		{ placement: "aboveEditor" },
	);
	ui.setWorkingVisible(false);
	return {
		start: () => widget.start(),
		stop: () => widget.stop(),
		dispose: () => {
			widget.dispose();
			ui.setWidget(WIDGET_KEY, undefined);
		},
		frames,
	};
}
