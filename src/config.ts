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

interface PrettyConfig {
	background?: {
		tool?: string;
		error?: string;
	};
}

function readPrettyConfig(agentDir?: string): PrettyConfig {
	if (!agentDir) return {};
	try {
		const raw = readFileSync(join(agentDir, "pi-pretty.json"), "utf8");
		const parsed = JSON.parse(raw) as PrettyConfig;
		if (parsed.background) {
			if (parsed.background.tool && !hexToAnsiBg(parsed.background.tool)) {
				parsed.background.tool = undefined;
			}
			if (parsed.background.error && !hexToAnsiBg(parsed.background.error)) {
				parsed.background.error = undefined;
			}
			if (!parsed.background.tool && !parsed.background.error) {
				parsed.background = undefined;
			}
		}
		return parsed;
	} catch {
		return {};
	}
}

function applyPrettyConfigBg(agentDir?: string): boolean {
	const config = readPrettyConfig(agentDir);
	if (!config.background?.tool) return false;
	const toolBg = hexToAnsiBg(config.background.tool);
	if (!toolBg) return false;
	BG_BASE = toolBg;
	BG_ERROR = config.background.error ? (hexToAnsiBg(config.background.error) ?? toolBg) : toolBg;
	RST = "\x1b[0m";
	return true;
}

export function resolveBaseBackground(theme: BgThemeLike | null | undefined): void {
	const home = process.env.HOME;
	const configDir = process.env.PRETTY_CONFIG_DIR ?? (home ? join(home, ".pi/agent") : undefined);
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
export const USE_ICONS = ICONS_MODE !== "none" && ICONS_MODE !== "off";

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

export const MAX_HL_CHARS = envInt("PRETTY_MAX_HL_CHARS", 80_000);
export const MAX_PREVIEW_LINES = envInt("PRETTY_MAX_PREVIEW_LINES", 80);
export const CACHE_LIMIT = envInt("PRETTY_CACHE_LIMIT", 128);

// ---------------------------------------------------------------------------
// Agent directory helpers
// ---------------------------------------------------------------------------

export function getDefaultAgentDir(): string | undefined {
	const home = process.env.HOME ?? "";
	return home ? join(home, ".pi/agent") : undefined;
}
