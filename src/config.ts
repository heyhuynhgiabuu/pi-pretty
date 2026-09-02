/**
 * pi-pretty: ANSI codes, icons, theme, and environment config.
 */

import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

/** Left indent for rendered tool result lines (was two spaces; one matches tighter TUI layout). */
export const TOOL_RESULT_INDENT = " ";

export let RST = "\x1b[0m";

export const FG_LNUM = "\x1b[38;2;100;100;100m";
export const FG_DIM = "\x1b[38;2;80;80;80m";
export const FG_RULE = "\x1b[38;2;50;50;50m";
export const FG_GREEN = "\x1b[38;2;100;180;120m";
export const FG_RED = "\x1b[38;2;200;100;100m";
export const FG_YELLOW = "\x1b[38;2;220;180;80m";
export const FG_BLUE = "\x1b[38;2;100;140;220m";
export const FG_MUTED = "\x1b[38;2;139;148;158m";

const BG_DEFAULT = "\x1b[49m";
export let BG_BASE = BG_DEFAULT;
export let BG_ERROR = BG_DEFAULT;

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

type BgThemeLike = {
	getBgAnsi?: (key: string) => string;
	bg?: (key: string, text: string) => string;
};

const ESC_RE = "\u001b";

function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	const m = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

function getThemeBgAnsi(theme: BgThemeLike, key: string): string | null {
	try {
		const direct = theme.getBgAnsi?.(key);
		if (direct && parseAnsiRgb(direct)) return direct;

		const marker = "\0";
		const styled = theme.bg?.(key, marker);
		const markerIndex = styled?.indexOf(marker) ?? -1;
		const ansi = markerIndex > 0 ? styled?.slice(0, markerIndex) : null;
		return ansi && parseAnsiRgb(ansi) ? ansi : null;
	} catch {
		return null;
	}
}

function hexToAnsiBg(hex: string): string | null {
	const m = hex.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (!m) return null;
	const r = Number.parseInt(m[1], 16);
	const g = Number.parseInt(m[2], 16);
	const b = Number.parseInt(m[3], 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

export interface WorkingIndicatorConfig {
	enabled?: boolean;
	/** One phrase or a list of phrases rotated across sweeps. */
	text?: string | string[];
	mode?: "shimmer" | "kitt" | "static";
	/** Tier colors: a pi theme color name or a `#rrggbb` hex. */
	low?: string;
	mid?: string;
	high?: string;
	bold?: boolean;
	hint?: boolean;
	/** Tint the indicator with a stable per-session accent color. */
	sessionAccent?: boolean;
}

export interface ThinkingIndicatorConfig {
	enabled?: boolean;
}

export interface PrettyConfig {
	background?: {
		tool?: string;
		error?: string;
	};
	theme?: string;
	icons?: string;
	enableTools?: string[];
	disableTools?: string[];
	maxHlChars?: number;
	maxPreviewLines?: number;
	cacheLimit?: number;
	workingIndicator?: WorkingIndicatorConfig;
	thinkingIndicator?: ThinkingIndicatorConfig;
}

/** Normalize a comma-separated env value or JSON array into tool names. */
export function normalizeToolList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim().toLowerCase())
		.filter(Boolean);
}

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Read and validate `pi-pretty.json` from the config directory. Invalid
 * fields are silently skipped, matching the historical `background`
 * behavior. The file is re-read on each call; callers that need a stable
 * value (extension activation, theme resolution) cache the result.
 */
export function loadConfig(agentDir = getConfigDir()): PrettyConfig {
	if (!agentDir) return {};
	try {
		const parsed = JSON.parse(readFileSync(join(agentDir, "pi-pretty.json"), "utf8")) as PrettyConfig;
		const config: PrettyConfig = {};
		if (parsed.background) {
			const background: NonNullable<PrettyConfig["background"]> = {};
			if (parsed.background.tool && hexToAnsiBg(parsed.background.tool)) {
				background.tool = parsed.background.tool;
			}
			if (parsed.background.error && hexToAnsiBg(parsed.background.error)) {
				background.error = parsed.background.error;
			}
			if (background.tool || background.error) config.background = background;
		}
		if (typeof parsed.theme === "string" && parsed.theme.trim() !== "") config.theme = parsed.theme;
		if (typeof parsed.icons === "string") config.icons = parsed.icons;
		const enableTools = normalizeToolList(parsed.enableTools);
		const disableTools = normalizeToolList(parsed.disableTools);
		if (enableTools.length) config.enableTools = enableTools;
		if (disableTools.length) config.disableTools = disableTools;
		const maxHlChars = positiveInt(parsed.maxHlChars);
		const maxPreviewLines = positiveInt(parsed.maxPreviewLines);
		const cacheLimit = positiveInt(parsed.cacheLimit);
		if (maxHlChars) config.maxHlChars = maxHlChars;
		if (maxPreviewLines) config.maxPreviewLines = maxPreviewLines;
		if (cacheLimit) config.cacheLimit = cacheLimit;
		const workingIndicator = parsed.workingIndicator;
		if (workingIndicator && typeof workingIndicator === "object") {
			const wi: WorkingIndicatorConfig = {};
			const src = workingIndicator as Record<string, unknown>;
			if (typeof src.enabled === "boolean") wi.enabled = src.enabled;
			if (typeof src.text === "string" && src.text.trim() !== "") wi.text = src.text;
			else if (Array.isArray(src.text)) {
				const list = src.text.filter((item) => typeof item === "string" && item.trim() !== "");
				if (list.length > 0) wi.text = list;
			}
			if (src.mode === "shimmer" || src.mode === "kitt" || src.mode === "static") wi.mode = src.mode;
			for (const tier of ["low", "mid", "high"] as const) {
				const value = src[tier];
				if (typeof value === "string" && value.trim() !== "") wi[tier] = value;
			}
			if (typeof src.bold === "boolean") wi.bold = src.bold;
			if (typeof src.hint === "boolean") wi.hint = src.hint;
			if (typeof src.sessionAccent === "boolean") wi.sessionAccent = src.sessionAccent;
			if (Object.keys(wi).length > 0) config.workingIndicator = wi;
		}
		const thinkingIndicator = parsed.thinkingIndicator;
		if (thinkingIndicator && typeof thinkingIndicator === "object") {
			const ti: ThinkingIndicatorConfig = {};
			const src = thinkingIndicator as Record<string, unknown>;
			if (typeof src.enabled === "boolean") ti.enabled = src.enabled;
			if (Object.keys(ti).length > 0) config.thinkingIndicator = ti;
		}
		return config;
	} catch {
		return {};
	}
}

export function getConfigDir(): string | undefined {
	return process.env.PRETTY_CONFIG_DIR ?? getDefaultAgentDir();
}

/**
 * Merge env tool sets with config-file tool lists: a non-empty env set wins
 * over the config file (12-factor precedence); otherwise config applies.
 */
export function resolveToolSets(
	envDisabled: Set<string>,
	envEnabled: Set<string>,
	config: Pick<PrettyConfig, "disableTools" | "enableTools">,
): { disabledTools: Set<string>; enabledTools: Set<string> } {
	return {
		disabledTools: envDisabled.size > 0 ? envDisabled : new Set(config.disableTools ?? []),
		enabledTools: envEnabled.size > 0 ? envEnabled : new Set(config.enableTools ?? []),
	};
}

function applyPrettyConfigBg(agentDir?: string): boolean {
	const config = loadConfig(agentDir);
	if (!config.background?.tool) return false;
	const toolBg = hexToAnsiBg(config.background.tool);
	if (!toolBg) return false;
	BG_BASE = toolBg;
	BG_ERROR = config.background.error ? (hexToAnsiBg(config.background.error) ?? toolBg) : toolBg;
	RST = "\x1b[0m";
	return true;
}

export function resolveBaseBackground(theme: BgThemeLike | null | undefined): void {
	const configDir = getConfigDir();
	if (applyPrettyConfigBg(configDir)) return;
	if (!theme?.getBgAnsi && !theme?.bg) return;
	BG_BASE =
		getThemeBgAnsi(theme, "toolSuccessBg") ??
		getThemeBgAnsi(theme, "toolBg") ??
		getThemeBgAnsi(theme, "background") ??
		BG_DEFAULT;
	BG_ERROR = getThemeBgAnsi(theme, "toolErrorBg") ?? BG_BASE;
	RST = "\x1b[0m";
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export function termWidth(): number {
	if (process.stdout.columns) return Math.max(1, Math.min(process.stdout.columns, 210));
	const raw =
		(process.stderr as NodeJS.WriteStream & { columns?: number }).columns ||
		Number.parseInt(process.env.COLUMNS ?? "", 10) ||
		200;
	return Math.max(1, Math.min(raw - 4, 210));
}

// ---------------------------------------------------------------------------
// File-type icons — Nerd Font glyphs
// ---------------------------------------------------------------------------

const ICONS_MODE = (process.env.PRETTY_ICONS ?? "nerd").toLowerCase();
export let USE_ICONS = ICONS_MODE !== "none" && ICONS_MODE !== "off";

export const NF_DIR = `${FG_BLUE}\ue5ff${RST}`;
export const NF_DEFAULT = `${FG_DIM}\uf15b${RST}`;

const EXT_ICON: Record<string, string> = {
	ts: `\x1b[38;2;49;120;198m\ue628${RST}`,
	tsx: `\x1b[38;2;49;120;198m\ue7ba${RST}`,
	js: `\x1b[38;2;241;224;90m\ue74e${RST}`,
	jsx: `\x1b[38;2;97;218;251m\ue7ba${RST}`,
	mjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,
	cjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,
	py: `\x1b[38;2;55;118;171m\ue73c${RST}`,
	rs: `\x1b[38;2;222;165;132m\ue7a8${RST}`,
	go: `\x1b[38;2;0;173;216m\ue724${RST}`,
	java: `\x1b[38;2;204;62;68m\ue738${RST}`,
	swift: `\x1b[38;2;255;172;77m\ue755${RST}`,
	rb: `\x1b[38;2;204;52;45m\ue739${RST}`,
	kt: `\x1b[38;2;126;103;200m\ue634${RST}`,
	c: `\x1b[38;2;85;154;211m\ue61e${RST}`,
	cpp: `\x1b[38;2;85;154;211m\ue61d${RST}`,
	cs: `\x1b[38;2;104;33;122m\ue648${RST}`,
	html: `\x1b[38;2;228;77;38m\ue736${RST}`,
	css: `\x1b[38;2;66;165;245m\ue749${RST}`,
	scss: `\x1b[38;2;207;100;154m\ue749${RST}`,
	vue: `\x1b[38;2;65;184;131m\ue6a0${RST}`,
	svelte: `\x1b[38;2;255;62;0m\ue697${RST}`,
	json: `\x1b[38;2;241;224;90m\ue60b${RST}`,
	yaml: `\x1b[38;2;160;116;196m\ue6a8${RST}`,
	yml: `\x1b[38;2;160;116;196m\ue6a8${RST}`,
	toml: `\x1b[38;2;160;116;196m\ue6b2${RST}`,
	xml: `\x1b[38;2;228;77;38m\ue619${RST}`,
	md: `\x1b[38;2;66;165;245m\ue73e${RST}`,
	mdx: `\x1b[38;2;66;165;245m\ue73e${RST}`,
	sql: `\x1b[38;2;218;218;218m\ue706${RST}`,
	sh: `\x1b[38;2;137;180;130m\ue795${RST}`,
	bash: `\x1b[38;2;137;180;130m\ue795${RST}`,
	zsh: `\x1b[38;2;137;180;130m\ue795${RST}`,
	lua: `\x1b[38;2;81;160;207m\ue620${RST}`,
	php: `\x1b[38;2;137;147;186m\ue73d${RST}`,
	dart: `\x1b[38;2;87;182;240m\ue798${RST}`,
	png: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	svg: `\x1b[38;2;255;180;50m\uf1c5${RST}`,
	webp: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	lock: `\x1b[38;2;130;130;130m\uf023${RST}`,
	env: `\x1b[38;2;241;224;90m\ue615${RST}`,
	graphql: `\x1b[38;2;224;51;144m\ue662${RST}`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`,
};

const NAME_ICON: Record<string, string> = {
	"package.json": `\x1b[38;2;137;180;130m\ue71e${RST}`,
	"package-lock.json": `\x1b[38;2;130;130;130m\ue71e${RST}`,
	"tsconfig.json": `\x1b[38;2;49;120;198m\ue628${RST}`,
	".gitignore": `\x1b[38;2;222;165;132m\ue702${RST}`,
	".env": `\x1b[38;2;241;224;90m\ue615${RST}`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`,
	makefile: `\x1b[38;2;130;130;130m\ue615${RST}`,
	"readme.md": `\x1b[38;2;66;165;245m\ue73e${RST}`,
	license: `\x1b[38;2;218;218;218m\ue60a${RST}`,
};

export function fileIcon(fp: string): string {
	if (!USE_ICONS) return "";
	const base = basename(fp).toLowerCase();
	if (NAME_ICON[base]) return `${NAME_ICON[base]} `;
	const ext = extname(fp).slice(1).toLowerCase();
	return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `;
}

export function dirIcon(): string {
	return USE_ICONS ? `${NF_DIR} ` : "";
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

import type { BundledLanguage } from "shiki";

const EXT_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	less: "css",
	json: "json",
	jsonc: "jsonc",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	mdx: "mdx",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	php: "php",
	dart: "dart",
	xml: "xml",
	graphql: "graphql",
	svelte: "svelte",
	vue: "vue",
	dockerfile: "dockerfile",
	makefile: "make",
	zig: "zig",
	nim: "nim",
	elixir: "elixir",
};

export function detectLang(fp: string): BundledLanguage | undefined {
	const base = basename(fp).toLowerCase();
	if (base === "dockerfile") return "dockerfile";
	if (base === "makefile" || base === "gnumakefile") return "make";
	return EXT_LANG[extname(fp).slice(1).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

export function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

export let MAX_HL_CHARS = envInt("PRETTY_MAX_HL_CHARS", 80_000);
export let MAX_PREVIEW_LINES = envInt("PRETTY_MAX_PREVIEW_LINES", 80);
export let CACHE_LIMIT = envInt("PRETTY_CACHE_LIMIT", 128);

/**
 * Apply `pi-pretty.json` values to the env-backed module bindings. An env
 * var wins over the config file whenever it is set to a non-empty value;
 * empty strings are treated as unset. Call once at extension activation,
 * before any render reads the bindings.
 */
export function applyConfig(config: PrettyConfig): void {
	if (!process.env.PRETTY_MAX_HL_CHARS && config.maxHlChars) MAX_HL_CHARS = config.maxHlChars;
	if (!process.env.PRETTY_MAX_PREVIEW_LINES && config.maxPreviewLines) MAX_PREVIEW_LINES = config.maxPreviewLines;
	if (!process.env.PRETTY_CACHE_LIMIT && config.cacheLimit) CACHE_LIMIT = config.cacheLimit;
	if (!process.env.PRETTY_ICONS && config.icons) {
		const mode = config.icons.toLowerCase();
		USE_ICONS = mode !== "none" && mode !== "off";
	}
}

// ---------------------------------------------------------------------------
// Agent directory helpers
// ---------------------------------------------------------------------------

export function getDefaultAgentDir(): string | undefined {
	const home = process.env.HOME ?? "";
	return home ? join(home, ".pi/agent") : undefined;
}
