/**
 * omp-style shimmer working indicator.
 *
 * Ports the shimmer sweep from oh-my-pi's `modes/theme/shimmer.ts`: the sweep
 * is discretized into one pre-rendered frame per band position, cycled at
 * 1000/30 ms so the band travels 30 cells/second — omp's exact speed.
 *
 * On hosts that expose Pi's embedded working-status API, frames are delegated
 * to the host so the row is rendered in the editor's top border. Older hosts
 * without that API use the zero-padding widget fallback above the editor.
 *
 * Frame layout: `<dim spinner> <shimmer text>`, one full sweep per phrase —
 * `texts` rotates through phrases chapter by chapter with a continuous spinner
 * phase. The extension adds no interrupt hint or token-count suffix.
 */

import { keyText } from "@earendil-works/pi-coding-agent";
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
	/** @deprecated Retained for config compatibility; no interrupt hint is rendered. */
	hint: boolean;
	/** Tint mid/high tiers (and dim the spinner) with a per-session accent color. */
	sessionAccent: boolean;
	/** Frame advance interval in ms. Default: WORKING_INTERVAL_MS (33). Higher = fewer
	 * full-tree renders per second while the agent works. */
	intervalMs?: number;
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
	const envInterval = Number.parseInt(env.PRETTY_WORKING_INTERVAL_MS ?? "", 10);
	if (Number.isFinite(envInterval) && envInterval >= 33) settings.intervalMs = envInterval;
	else if (typeof config?.intervalMs === "number" && config.intervalMs >= 33) settings.intervalMs = config.intervalMs;
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
	/** @deprecated Retained for call-site compatibility; suffixes are not rendered. */
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
				)}`,
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
					)}`,
				);
				continue;
			}
			const cycleCells = 2 * range;
			for (let sweep = 0; sweep < cycleCells; sweep++) {
				const goingRight = sweep < range;
				const head = goingRight ? sweep : cycleCells - sweep;
				const tiers = Array.from({ length: total }, (_, i) => tierFor(kittIntensity(i, head, goingRight)));
				frames.push(`${spinnerPrefix(spinnerIndex++)}${paintFrame(text, ranges, tiers)}`);
			}
		} else {
			const period = total + CLASSIC_PADDING * 2;
			for (let pos = 0; pos < period; pos++) {
				const tiers = Array.from({ length: total }, (_, i) => tierFor(classicIntensity(i, pos)));
				frames.push(`${spinnerPrefix(spinnerIndex++)}${paintFrame(text, ranges, tiers)}`);
			}
		}
	}
	return { frames, intervalMs };
}

/** @deprecated The working row no longer displays token stats. */
export function workingTokens(message: unknown): number {
	const usage = (message as { usage?: { output?: unknown } } | undefined)?.usage;
	const output = Number(usage?.output);
	if (Number.isFinite(output) && output > 0) return Math.round(output);
	const content = (message as { content?: Array<{ type?: string; text?: unknown; thinking?: unknown }> } | undefined)
		?.content;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") chars += block.text.length;
		else if (block?.type === "thinking" && typeof block.thinking === "string") chars += block.thinking.length;
	}
	return Math.round(chars / 4);
}

// ─── Widget ──────────────────────────────────────────────────────────────────

/** Slice of the pi-tui TUI instance the widget needs. */
export interface WidgetTuiLike {
	requestRender(): void;
}

/**
 * Zero-padding working-row component. The host renders whatever `render()`
 * returns with no margins, so the legacy widget row sits flush-left without
 * relying on the host loader's padding.
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

	/** Ask the host for a render — lets non-widget consumers (the thinking label
	 * ticker) reuse this widget's TUI handle instead of relying on natural
	 * streaming renders. */
	requestRender(): void {
		this.#tui?.requestRender();
	}

	/** @deprecated Token stats are owned by Pi and are no longer rendered here. */
	setStats(_text: string | undefined): void {}

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
	/** Label refresh interval in ms. Default: WORKING_INTERVAL_MS (33). Higher = fewer
	 * full-tree renders per second while thinking — the main FPS lever on long sessions. */
	intervalMs?: number;
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
	const envInterval = Number.parseInt(env.PRETTY_THINKING_INTERVAL_MS ?? "", 10);
	if (Number.isFinite(envInterval) && envInterval >= 33) settings.intervalMs = envInterval;
	else if (typeof config?.intervalMs === "number" && config.intervalMs >= 33) settings.intervalMs = config.intervalMs;
	return settings;
}

export interface ThinkingUiLike {
	theme?: WorkingThemeLike;
	setHiddenThinkingLabel(label?: string): void;
}

// ─── Per-row hidden-thinking labels ──────────────────────────────────────────

/** Controller for the host-component label interception. */
export interface PerRowThinkingLabels {
	/** Mark the message currently streaming a thinking block (its row animates). */
	setActive(timestamp: number): void;
	/** Freeze a message's completed thinking duration in ms (its row shows
	 * `Thought for X` derived from this). */
	complete(timestamp: number, durationMs: number): void;
	/** Drop the active mark (run ended); completed rows keep their durations. */
	clearActive(): void;
	/** Restore the original prototype setter. */
	uninstall(): void;
}

const PER_ROW_PATCH = Symbol.for("pi-pretty.per-row-thinking-labels");

interface RowInternals {
	lastMessage?: { timestamp?: unknown };
}

/**
 * Intercept the host's per-row label fan-out method
 * (`AssistantMessageComponent.prototype.setHiddenThinkingLabel`): each row
 * substitutes the incoming global label with its own — the streaming row
 * animates, completed rows stay frozen at their own `Thought for X`, unknown
 * rows fall back to pi's default. Any per-call failure passes the incoming
 * label through unchanged, so a host internals change degrades to pi-pretty's
 * global-label behavior instead of breaking. Durations live per session.
 */
export function installPerRowThinkingLabels(componentClass: unknown): PerRowThinkingLabels | undefined {
	const proto = (componentClass as { prototype?: { setHiddenThinkingLabel?: unknown } } | undefined)?.prototype;
	const original = proto?.setHiddenThinkingLabel;
	if (typeof componentClass !== "function" || !proto || typeof original !== "function") return undefined;
	const existing = (original as { [PER_ROW_PATCH]?: PerRowThinkingLabels })[PER_ROW_PATCH];
	// Reuse the installed patch but start from clean state: a session_start
	// without an intervening shutdown (defensive) must not resurrect stale rows.
	if (existing) {
		existing.clearActive();
		return existing;
	}

	const state: { activeTs?: number; completed: Map<number, number> } = { completed: new Map() };
	const patched = function (this: unknown, label: string | undefined): void {
		const own = ownLabel(this, label);
		(original as (this: unknown, label: string | undefined) => void).call(this, own);
	};
	const ownLabel = (component: unknown, incoming: string | undefined): string | undefined => {
		try {
			const ts = (component as RowInternals | undefined)?.lastMessage?.timestamp;
			if (typeof ts !== "number") return incoming;
			if (ts === state.activeTs) return incoming;
			const ms = state.completed.get(ts);
			return ms === undefined ? thinkingLabel() : thoughtLabel(ms);
		} catch {
			return incoming;
		}
	};
	const controller: PerRowThinkingLabels = {
		setActive(timestamp: number): void {
			state.activeTs = timestamp;
		},
		complete(timestamp: number, durationMs: number): void {
			state.completed.set(timestamp, durationMs);
		},
		clearActive(): void {
			state.activeTs = undefined;
		},
		uninstall(): void {
			if (proto.setHiddenThinkingLabel === patched) {
				proto.setHiddenThinkingLabel = original as { setHiddenThinkingLabel?: unknown }["setHiddenThinkingLabel"];
			}
			state.completed.clear();
			state.activeTs = undefined;
		},
	};
	(patched as { [PER_ROW_PATCH]?: PerRowThinkingLabels })[PER_ROW_PATCH] = controller;
	proto.setHiddenThinkingLabel = patched as NonNullable<{ setHiddenThinkingLabel?: unknown }["setHiddenThinkingLabel"]>;
	return controller;
}

export interface ThinkingLabelAnimator {
	/** Apply the next shimmer frame, rebuilding frames when the label changes. */
	tick(label?: string): void;
	/** Apply a non-animated label (the host supplies its normal thinking style). */
	show(label: string): void;
	/** Restore pi's default static label. */
	restore(): void;
	/** Current pre-rendered label frames (exposed for diagnostics). */
	readonly frames: readonly string[];
}

export interface ThinkingTimer {
	/** Render the active label with the current elapsed duration. */
	tick(): void;
	/** Freeze the elapsed duration; returns the total in milliseconds, or
	 * undefined when the timer was already terminal. */
	complete(): number | undefined;
	/** Restore pi's default label and make the timer terminal. */
	restore(): void;
}

let claudeThinkingLabels = false;
/** claudecode tool style: flush-left `thinking` / `thought 3s` instead of ` Thinking...` / ` Thought for 3s`. */
export function setClaudeThinkingLabels(enabled: boolean): void {
	claudeThinkingLabels = enabled;
}
const thinkingLabel = (): string => (claudeThinkingLabels ? "thinking" : " Thinking...");
const padThinkingLabel = (label: string): string =>
	claudeThinkingLabels || label.startsWith(" ") ? label : ` ${label}`;
/** Settled label for a finished thinking run; claudecode style appends the toggle hint when bound. */
const thoughtLabel = (ms: number): string => {
	if (!claudeThinkingLabels) return ` Thought for ${formatThinkingDuration(ms)}`;
	const key = keyText("app.thinking.toggle");
	return `thought ${formatThinkingDuration(ms)}${key ? ` (${key} to expand)` : ""}`;
};

/** Format sub-second elapsed time as milliseconds, then use compact whole seconds. */
export function formatThinkingDuration(elapsedMs: number): string {
	const wholeMs = Math.max(0, Math.floor(elapsedMs));
	if (wholeMs < 1000) return `${wholeMs}ms`;
	const totalSeconds = Math.floor(wholeMs / 1000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
	if (totalMinutes > 0) return `${totalMinutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

/**
 * Couple elapsed-time wording to the label animator through an injected clock.
 * The timer starts on the first thinking delta, freezes once, and is terminal
 * after completion or restore. `startElapsedMs` resumes a later run in the
 * same message from its accumulated thinking time (per-message semantics:
 * the host renders one label line per thinking run, all sharing the message
 * label, so a fresh-zero restart would visibly rewind earlier lines).
 */
export function createThinkingTimer(
	animator: ThinkingLabelAnimator,
	now: () => number = Date.now,
	startElapsedMs = 0,
): ThinkingTimer {
	const startedAt = now() - startElapsedMs;
	let terminal = false;
	const elapsed = (): number => now() - startedAt;
	const duration = (): string => formatThinkingDuration(elapsed());
	return {
		tick(): void {
			if (terminal) return;
			animator.tick(`${thinkingLabel()} ${duration()}`);
		},
		complete(): number | undefined {
			if (terminal) return undefined;
			terminal = true;
			const ms = elapsed();
			animator.show(thoughtLabel(ms));
			return ms;
		},
		restore(): void {
			terminal = true;
			animator.restore();
		},
	};
}

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
 * chat children, so index.ts drives it at 30fps only while the streaming
 * message's last block is thinking. The elapsed label is rebuilt when its
 * displayed duration changes; the shimmer frame still advances every tick.
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
		show() {},
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
	const buildLabelFrames = (label: string): string[] => {
		const padded = padThinkingLabel(label);
		const text = padded.trimStart();
		const leftPadding = padded.slice(0, padded.length - text.length);
		return buildWorkingFrames([text], {
			mode: workSettings.mode,
			ansi,
			bold: workSettings.bold,
			spinner: false,
			italic: true,
		}).frames.map((frame) => `${leftPadding}${frame}`);
	};

	let currentLabel = thinkingLabel();
	let frames = buildLabelFrames(currentLabel);

	let index = 0;
	let appliedLabel: string | undefined;
	return {
		get frames(): readonly string[] {
			return frames;
		},
		tick(label = thinkingLabel()): void {
			const paddedLabel = padThinkingLabel(label);
			if (paddedLabel !== currentLabel) {
				frames = buildLabelFrames(paddedLabel);
				currentLabel = paddedLabel;
			}
			// A static frame changes only when its elapsed-time label changes.
			if (appliedLabel === currentLabel && frames.length === 1) return;
			ui.setHiddenThinkingLabel(frames[index % frames.length]);
			index++;
			appliedLabel = currentLabel;
		},
		show(label: string): void {
			ui.setHiddenThinkingLabel(padThinkingLabel(label));
		},
		restore(): void {
			// undefined → pi falls back to its default static label.
			ui.setHiddenThinkingLabel(undefined);
		},
	};
}

// ─── Installation ────────────────────────────────────────────────────────────

/** Structural slice of pi's Theme needed for the palette and thinking label. */
export interface WorkingThemeLike {
	/** Retained for compatibility with older theme adapters. */
	fg?: (name: "dim", text: string) => string;
	getFgAnsi?: (name: "dim" | "muted" | "accent" | "thinkingText") => string;
}

export interface WorkingStatusOptionsLike {
	frames?: string[];
	intervalMs?: number;
}

export interface WorkingUiLike {
	theme?: WorkingThemeLike;
	/** Hosts with Pi's embedded working-status API render this in the editor border. */
	setWorkingIndicator?: (options?: WorkingStatusOptionsLike) => void;
	/** Clear the host message appended after a custom native frame. */
	setWorkingMessage?: (message?: string) => void;
	setWorkingVisible(visible: boolean): void;
	setWidget(
		key: string,
		factory: ((tui: WidgetTuiLike, theme: unknown) => WorkingWidget) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

/** @deprecated Retained for compatibility with the former hint-resolution seam. */
export interface KeybindingsLike {
	getKeys(name: string): string[];
}

export interface WorkingIndicatorController {
	/** Streaming began — show and animate the row. */
	start(): void;
	/** Streaming ended — hide the row and pause the animation. */
	stop(): void;
	/** Remove the indicator and stop the animation. */
	dispose(): void;
	/** @deprecated Token stats are owned by Pi and are no longer rendered here. */
	setStats(text: string | undefined): void;
	/** Request a host render for consumers that drive another animated label. */
	requestRender(): void;
	/** Pre-rendered frames (exposed for diagnostics). */
	readonly frames: readonly string[];
}

const WIDGET_KEY = "pi-pretty-working";

/**
 * Install the custom working shimmer and return its lifecycle controller.
 *
 * Current Pi hosts receive the pre-rendered frames through the embedded
 * working-status API, which places them in the editor's top border. Older
 * hosts use a zero-padding widget above the editor. The host lifecycle drives
 * the controller (`start` on agent_start, `stop` on agent_end); disabled or
 * empty phrase settings leave host defaults untouched.
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
		setStats() {},
		requestRender() {},
		frames: [],
	};
	if (!settings.enabled) return noopController;
	const texts = settings.texts.map((t) => t.trim()).filter((t) => t.length > 0);
	if (texts.length === 0) return noopController;
	void deps; // Retained for compatibility; interrupt hints are no longer resolved here.

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
	const { frames, intervalMs } = buildWorkingFrames(texts, {
		mode: settings.mode,
		ansi,
		bold: settings.bold,
		spinnerColor,
		intervalMs: settings.intervalMs,
	});
	if (frames.length === 0) return noopController;

	const setWorkingIndicator = ui.setWorkingIndicator;
	const setWorkingMessage = ui.setWorkingMessage;
	if (typeof setWorkingIndicator === "function" && typeof setWorkingMessage === "function") {
		let started = false;
		let disposed = false;
		const updateNativeMessage = (): void => {
			// Keep Pi's built-in message hidden because the custom frame already
			// supplies the working label; no hint or token suffix is added here.
			setWorkingMessage.call(ui, "");
		};

		try {
			setWorkingIndicator.call(ui, { frames, intervalMs });
			// Keep the native status row hidden until the extension lifecycle starts it.
			// An empty message is intentional: all visible content lives in our frames.
			updateNativeMessage();
			ui.setWorkingVisible(false);
		} catch (error: unknown) {
			try {
				setWorkingIndicator.call(ui);
				setWorkingMessage.call(ui);
			} catch {
				// Best-effort rollback; the caller still restores host visibility.
			}
			throw error;
		}
		return {
			start: () => {
				if (disposed || started) return;
				started = true;
				updateNativeMessage();
				ui.setWorkingVisible(true);
			},
			stop: () => {
				if (!started) return;
				started = false;
				ui.setWorkingVisible(false);
			},
			dispose: () => {
				if (disposed) return;
				if (started) {
					started = false;
					ui.setWorkingVisible(false);
				}
				disposed = true;
				setWorkingIndicator.call(ui);
				setWorkingMessage.call(ui);
			},
			setStats: (_text: string | undefined) => {},
			requestRender: () => updateNativeMessage(),
			frames,
		};
	}

	const widget = new WorkingWidget();
	widget.setFrames(frames, intervalMs);
	// Widget first, visibility second: if setWidget throws (older host without
	// the native working-status API) the host loader was never hidden and pi's
	// default remains.
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
		setStats: (_text: string | undefined) => {},
		requestRender: () => widget.requestRender(),
		frames,
	};
}
