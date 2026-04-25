/**
 * pi-pretty — Pretty terminal output for pi built-in tools.
 *
 * @module pi-pretty
 * @see https://github.com/buddingnewinsights/pi-pretty
 *
 * Enhances:
 *   • read  — syntax-highlighted file content with line numbers
 *   • bash  — colored exit status, stderr highlighting
 *   • ls    — tree-view directory listing with file-type icons
 *   • find  — grouped results with file-type icons
 *   • grep  — syntax-highlighted match context with line numbers
 *
 * Architecture:
 *   1. Wrap SDK factory tools (createReadTool, createBashTool, etc.)
 *   2. Delegate to original execute() — no behavior changes
 *   3. Attach metadata in result.details for custom renderCall/renderResult
 *   4. Async Shiki highlighting with ctx.invalidate() for non-blocking renders
 *
 * Performance:
 *   • Shared Shiki singleton (managed by @shikijs/cli)
 *   • LRU cache for highlighted blocks
 *   • Large-file fallback (skip highlighting, still show line numbers)
 */

import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import type { FileFinder, FileItem, GrepResult, SearchResult } from "@ff-labs/fff-node";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolInput,
	ExtensionCommandContext,
	ExtensionContext,
	FindToolInput,
	GrepToolInput,
	LsToolInput,
	ReadToolInput,
	ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { codeToANSI } from "@shikijs/cli";
import type { BundledLanguage, BundledTheme } from "shiki";

import { CursorStore, fffFormatGrepText } from "./fff-helpers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_THEME: BundledTheme = "github-dark";

function getDefaultAgentDir(): string | undefined {
	const home = process.env.HOME ?? "";
	return home ? join(home, ".pi/agent") : undefined;
}

function readThemeFromSettings(agentDir?: string): BundledTheme | undefined {
	const resolvedAgentDir = agentDir ?? getDefaultAgentDir();
	if (!resolvedAgentDir) return undefined;

	try {
		const settings = JSON.parse(readFileSync(join(resolvedAgentDir, "settings.json"), "utf8")) as {
			theme?: unknown;
		};
		return typeof settings.theme === "string" ? (settings.theme as BundledTheme) : undefined;
	} catch {
		return undefined;
	}
}

function resolvePrettyTheme(agentDir?: string): BundledTheme {
	return (process.env.PRETTY_THEME as BundledTheme | undefined) ?? readThemeFromSettings(agentDir) ?? DEFAULT_THEME;
}

let THEME: BundledTheme = resolvePrettyTheme();

function setPrettyTheme(agentDir?: string): void {
	const resolvedTheme = resolvePrettyTheme(agentDir);
	if (resolvedTheme === THEME) return;
	THEME = resolvedTheme;
	_cache.clear();
	codeToANSI("", "typescript", THEME).catch(() => {});
}

function envInt(name: string, fallback: number): number {
	const v = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

const MAX_HL_CHARS = envInt("PRETTY_MAX_HL_CHARS", 80_000);
const MAX_PREVIEW_LINES = envInt("PRETTY_MAX_PREVIEW_LINES", 80);
const CACHE_LIMIT = envInt("PRETTY_CACHE_LIMIT", 128);

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

let RST = "\x1b[0m";
const BOLD = "\x1b[1m";

const FG_LNUM = "\x1b[38;2;100;100;100m";
const FG_DIM = "\x1b[38;2;80;80;80m";
const FG_RULE = "\x1b[38;2;50;50;50m";
const FG_GREEN = "\x1b[38;2;100;180;120m";
const FG_RED = "\x1b[38;2;200;100;100m";
const FG_YELLOW = "\x1b[38;2;220;180;80m";
const FG_BLUE = "\x1b[38;2;100;140;220m";
const FG_MUTED = "\x1b[38;2;139;148;158m";

const BG_DEFAULT = "\x1b[49m";
let BG_BASE = BG_DEFAULT; // tool box success/base bg — updated from theme's toolSuccessBg
let BG_ERROR = BG_DEFAULT; // tool box error bg — updated from theme's toolErrorBg

type BgTheme = { getBgAnsi?: (key: string) => string };
type FgTheme = { fg: (key: string, text: string) => string };

/** Parse an ANSI 24-bit color escape into { r, g, b }. Handles both fg (38;2) and bg (48;2). */
function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	const m = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

function getThemeBgAnsi(theme: BgTheme, key: string): string | null {
	try {
		const bgAnsi = theme.getBgAnsi?.(key);
		return bgAnsi && parseAnsiRgb(bgAnsi) ? bgAnsi : null;
	} catch {
		return null;
	}
}

/** Read themed tool backgrounds and update BG_BASE / BG_ERROR + RST.
 *  Call once when theme is first available. Idempotent. */
let _bgBaseResolved = false;
function resolveBaseBackground(theme: BgTheme | null | undefined): void {
	if (_bgBaseResolved || !theme?.getBgAnsi) return;
	_bgBaseResolved = true;

	BG_BASE = getThemeBgAnsi(theme, "toolSuccessBg") ?? BG_DEFAULT;
	BG_ERROR = getThemeBgAnsi(theme, "toolErrorBg") ?? BG_BASE;
	RST = `\x1b[0m${BG_BASE}`;
}

function renderToolError(error: string, theme: FgTheme): string {
	return fillToolBackground(`\n${theme.fg("error", error)}`, BG_ERROR);
}

const ESC_RE = "\u001b";
const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");

// ---------------------------------------------------------------------------
// Low-contrast fix (same as pi-diff)
// ---------------------------------------------------------------------------

function isLowContrastShikiFg(params: string): boolean {
	if (params === "30" || params === "90") return true;
	if (params === "38;5;0" || params === "38;5;8") return true;
	if (!params.startsWith("38;2;")) return false;
	const parts = params.split(";").map(Number);
	if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return false;
	const [, , r, g, b] = parts;
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance < 72;
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) => (isLowContrastShikiFg(params) ? FG_MUTED : seq));
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function strip(s: string): string {
	return s.replace(ANSI_RE, "");
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function preserveToolBackground(ansi: string, bg: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (seq, params: string) => {
		const codes = params.split(";");
		return params === "0" || codes.includes("49") ? `${seq}${bg}` : seq;
	});
}

function fillToolBackground(text: string, bg = BG_BASE): string {
	const width = termW();
	return text
		.split("\n")
		.map((line) => {
			const normalized = preserveToolBackground(line, bg);
			const padding = Math.max(0, width - strip(normalized).length);
			return `${bg}${normalized}${" ".repeat(padding)}${RST}`;
		})
		.join("\n");
}

function termW(): number {
	const stderrWithColumns = process.stderr as NodeJS.WriteStream & { columns?: number };
	const raw =
		process.stdout.columns || stderrWithColumns.columns || Number.parseInt(process.env.COLUMNS ?? "", 10) || 200;
	return Math.max(80, Math.min(raw - 4, 210));
}

function shortPath(cwd: string, home: string, p: string): string {
	if (!p) return "";
	const r = relative(cwd, p);
	if (!r.startsWith("..") && !r.startsWith("/")) return r;
	return p.replace(home, "~");
}

function rule(w: number): string {
	return `${FG_RULE}${"─".repeat(w)}${RST}`;
}

function lnum(n: number, w: number): string {
	const v = String(n);
	return `${FG_LNUM}${" ".repeat(Math.max(0, w - v.length))}${v}${RST}`;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

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
	ex: "elixir",
	erb: "erb",
	hbs: "handlebars",
};

function lang(fp: string): BundledLanguage | undefined {
	const base = basename(fp).toLowerCase();
	if (base === "dockerfile") return "dockerfile";
	if (base === "makefile" || base === "gnumakefile") return "make";
	if (base === ".envrc" || base === ".env") return "bash";
	return EXT_LANG[extname(fp).slice(1).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Terminal image rendering (iTerm2 / Kitty / Ghostty inline image protocols)
// Handles tmux passthrough for image protocols.
// ---------------------------------------------------------------------------

type ImageProtocol = "iterm2" | "kitty" | "none";

let _tmuxClientTermCache: string | null | undefined;
let _tmuxAllowPassthroughCache: boolean | null | undefined;
let _tmuxClientTermOverrideForTests: string | null | undefined;
let _tmuxAllowPassthroughOverrideForTests: boolean | null | undefined;

function isTmuxSession(): boolean {
	return !!process.env.TMUX || /^(tmux|screen)/.test(process.env.TERM ?? "");
}

function normalizeTerminalName(term: string): string {
	const t = term.toLowerCase();
	if (t.includes("kitty")) return "kitty";
	if (t.includes("ghostty")) return "ghostty";
	if (t.includes("wezterm")) return "WezTerm";
	if (t.includes("iterm")) return "iTerm.app";
	if (t.includes("mintty")) return "mintty";
	return term;
}

function readTmuxClientTerm(): string | null {
	if (_tmuxClientTermOverrideForTests !== undefined) {
		return _tmuxClientTermOverrideForTests ? normalizeTerminalName(_tmuxClientTermOverrideForTests) : null;
	}
	if (!isTmuxSession()) return null;
	if (_tmuxClientTermCache !== undefined) return _tmuxClientTermCache;
	try {
		const term = childProcess
			.execFileSync("tmux", ["display-message", "-p", "#{client_termname}"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 200,
			})
			.trim();
		_tmuxClientTermCache = term ? normalizeTerminalName(term) : null;
	} catch {
		_tmuxClientTermCache = null;
	}
	return _tmuxClientTermCache;
}

/**
 * Detect the outer terminal when running inside tmux.
 * tmux sets TERM_PROGRAM=tmux, but the real terminal is often in
 * the environment of the tmux server or can be inferred.
 */
function getOuterTerminal(): string {
	// Environment hints that often survive inside tmux
	if (process.env.LC_TERMINAL === "iTerm2") return "iTerm.app";
	if (process.env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (process.env.KITTY_WINDOW_ID || process.env.KITTY_PID) return "kitty";
	if (process.env.WEZTERM_EXECUTABLE || process.env.WEZTERM_CONFIG_DIR || process.env.WEZTERM_CONFIG_FILE) {
		return "WezTerm";
	}

	const termProgram = process.env.TERM_PROGRAM ?? "";
	if (termProgram && termProgram !== "tmux" && termProgram !== "screen") {
		return normalizeTerminalName(termProgram);
	}

	const tmuxClientTerm = readTmuxClientTerm();
	if (tmuxClientTerm) return tmuxClientTerm;

	const term = process.env.TERM ?? "";
	if (term) return normalizeTerminalName(term);
	if (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit") return "unknown-modern";
	return termProgram;
}

function detectImageProtocol(): ImageProtocol {
	const forced = (process.env.PRETTY_IMAGE_PROTOCOL ?? "").toLowerCase();
	if (forced === "kitty" || forced === "iterm2" || forced === "none") {
		return forced;
	}

	const term = getOuterTerminal();
	// Ghostty and Kitty use the Kitty graphics protocol
	if (term === "ghostty" || term === "kitty") return "kitty";
	// iTerm2, WezTerm, Mintty support the iTerm2 protocol
	if (["iTerm.app", "WezTerm", "mintty"].includes(term)) return "iterm2";
	if (process.env.LC_TERMINAL === "iTerm2") return "iterm2";
	return "none";
}

function tmuxAllowsPassthrough(): boolean | null {
	if (_tmuxAllowPassthroughOverrideForTests !== undefined) return _tmuxAllowPassthroughOverrideForTests;
	if (!isTmuxSession()) return null;
	if (_tmuxAllowPassthroughCache !== undefined) return _tmuxAllowPassthroughCache;
	try {
		const value = childProcess
			.execFileSync("tmux", ["show-options", "-gv", "allow-passthrough"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 200,
			})
			.trim()
			.toLowerCase();
		_tmuxAllowPassthroughCache = value === "on" || value === "all";
	} catch {
		_tmuxAllowPassthroughCache = null;
	}
	return _tmuxAllowPassthroughCache;
}

function getTmuxPassthroughWarning(protocol: ImageProtocol): string | null {
	if (!isTmuxSession() || protocol === "none") return null;
	if (tmuxAllowsPassthrough() === false) {
		return "tmux allow-passthrough is off. Run: tmux set -g allow-passthrough on";
	}
	return null;
}

/**
 * Wrap escape sequence for tmux passthrough.
 * tmux requires: ESC Ptmux; <escaped-sequence> ESC \
 * Inner ESC chars must be doubled.
 */
function tmuxWrap(seq: string): string {
	if (!isTmuxSession()) return seq;
	// Double all ESC chars inside the sequence
	const escaped = seq.split("\x1b").join("\x1b\x1b");
	return `\x1bPtmux;${escaped}\x1b\\`;
}

export const __imageInternals = {
	isTmuxSession,
	getOuterTerminal,
	detectImageProtocol,
	tmuxWrap,
	tmuxAllowsPassthrough,
	getTmuxPassthroughWarning,
	setTmuxClientTermOverrideForTests: (value: string | null | undefined) => {
		_tmuxClientTermOverrideForTests = value;
	},
	setTmuxAllowPassthroughOverrideForTests: (value: boolean | null | undefined) => {
		_tmuxAllowPassthroughOverrideForTests = value;
	},
	resetCachesForTests: () => {
		_tmuxClientTermCache = undefined;
		_tmuxAllowPassthroughCache = undefined;
		_tmuxClientTermOverrideForTests = undefined;
		_tmuxAllowPassthroughOverrideForTests = undefined;
	},
};

/**
 * Render base64 image inline using iTerm2 inline image protocol.
 * Protocol: ESC ] 1337 ; File=[args] : base64data BEL
 */
function renderIterm2Image(base64Data: string, opts: { width?: string; name?: string } = {}): string {
	const args: string[] = ["inline=1", "preserveAspectRatio=1"];
	if (opts.width) args.push(`width=${opts.width}`);
	if (opts.name) args.push(`name=${Buffer.from(opts.name).toString("base64")}`);
	const byteSize = Math.ceil((base64Data.length * 3) / 4);
	args.push(`size=${byteSize}`);
	const seq = `\x1b]1337;File=${args.join(";")}:${base64Data}\x07`;
	return tmuxWrap(seq);
}

/**
 * Render base64 image inline using Kitty graphics protocol.
 * Protocol: ESC _G <key>=<value>,...; <base64data> ESC \
 * Chunked in 4096-byte pieces as required by protocol.
 * Supported by: Kitty, Ghostty
 */
function renderKittyImage(base64Data: string, opts: { cols?: number } = {}): string {
	const chunks: string[] = [];
	const CHUNK_SIZE = 4096;

	for (let i = 0; i < base64Data.length; i += CHUNK_SIZE) {
		const chunk = base64Data.slice(i, i + CHUNK_SIZE);
		const isFirst = i === 0;
		const isLast = i + CHUNK_SIZE >= base64Data.length;
		const more = isLast ? 0 : 1;

		if (isFirst) {
			const colPart = opts.cols ? `,c=${opts.cols}` : "";
			chunks.push(tmuxWrap(`\x1b_Ga=T,f=100,t=d,m=${more}${colPart};${chunk}\x1b\\`));
		} else {
			chunks.push(tmuxWrap(`\x1b_Gm=${more};${chunk}\x1b\\`));
		}
	}

	return chunks.join("");
}

/**
 * Get human-readable file size
 */
function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ---------------------------------------------------------------------------
// File-type icons — Nerd Font glyphs (Seti-UI + Devicons, stable in NF v3+)
//
// Requires a Nerd Font installed (e.g., JetBrainsMono Nerd Font, FiraCode NF).
// Fallback: set PRETTY_ICONS=none to disable icons.
// ---------------------------------------------------------------------------

const ICONS_MODE = (process.env.PRETTY_ICONS ?? "nerd").toLowerCase();
const USE_ICONS = ICONS_MODE !== "none" && ICONS_MODE !== "off";

// Nerd Font codepoints + ANSI color per file type
const NF_DIR = `${FG_BLUE}\ue5ff${RST}`; // folder
const NF_DEFAULT = `${FG_DIM}\uf15b${RST}`; // generic file

const EXT_ICON: Record<string, string> = {
	// TypeScript / JavaScript
	ts: `\x1b[38;2;49;120;198m\ue628${RST}`, // blue
	tsx: `\x1b[38;2;49;120;198m\ue7ba${RST}`, // react blue
	js: `\x1b[38;2;241;224;90m\ue74e${RST}`, // yellow
	jsx: `\x1b[38;2;97;218;251m\ue7ba${RST}`, // react cyan
	mjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,
	cjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,

	// Systems / Backend
	py: `\x1b[38;2;55;118;171m\ue73c${RST}`, // python blue
	rs: `\x1b[38;2;222;165;132m\ue7a8${RST}`, // rust orange
	go: `\x1b[38;2;0;173;216m\ue724${RST}`, // go cyan
	java: `\x1b[38;2;204;62;68m\ue738${RST}`, // java red
	swift: `\x1b[38;2;255;172;77m\ue755${RST}`, // swift orange
	rb: `\x1b[38;2;204;52;45m\ue739${RST}`, // ruby red
	kt: `\x1b[38;2;126;103;200m\ue634${RST}`, // kotlin purple
	c: `\x1b[38;2;85;154;211m\ue61e${RST}`, // c blue
	cpp: `\x1b[38;2;85;154;211m\ue61d${RST}`, // cpp blue
	h: `\x1b[38;2;140;160;185m\ue61e${RST}`, // header muted
	hpp: `\x1b[38;2;140;160;185m\ue61d${RST}`,
	cs: `\x1b[38;2;104;33;122m\ue648${RST}`, // c# purple

	// Web
	html: `\x1b[38;2;228;77;38m\ue736${RST}`, // html orange
	css: `\x1b[38;2;66;165;245m\ue749${RST}`, // css blue
	scss: `\x1b[38;2;207;100;154m\ue749${RST}`, // scss pink
	less: `\x1b[38;2;66;165;245m\ue749${RST}`,
	vue: `\x1b[38;2;65;184;131m\ue6a0${RST}`, // vue green
	svelte: `\x1b[38;2;255;62;0m\ue697${RST}`, // svelte red-orange

	// Config / Data
	json: `\x1b[38;2;241;224;90m\ue60b${RST}`, // json yellow
	jsonc: `\x1b[38;2;241;224;90m\ue60b${RST}`,
	yaml: `\x1b[38;2;160;116;196m\ue6a8${RST}`, // yaml purple
	yml: `\x1b[38;2;160;116;196m\ue6a8${RST}`,
	toml: `\x1b[38;2;160;116;196m\ue6b2${RST}`, // toml purple
	xml: `\x1b[38;2;228;77;38m\ue619${RST}`, // xml orange
	sql: `\x1b[38;2;218;218;218m\ue706${RST}`, // sql gray

	// Markdown / Docs
	md: `\x1b[38;2;66;165;245m\ue73e${RST}`, // markdown blue
	mdx: `\x1b[38;2;66;165;245m\ue73e${RST}`,

	// Shell / Scripts
	sh: `\x1b[38;2;137;180;130m\ue795${RST}`, // shell green
	bash: `\x1b[38;2;137;180;130m\ue795${RST}`,
	zsh: `\x1b[38;2;137;180;130m\ue795${RST}`,
	fish: `\x1b[38;2;137;180;130m\ue795${RST}`,
	lua: `\x1b[38;2;81;160;207m\ue620${RST}`, // lua blue
	php: `\x1b[38;2;137;147;186m\ue73d${RST}`, // php purple
	dart: `\x1b[38;2;87;182;240m\ue798${RST}`, // dart blue

	// Images
	png: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpeg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	gif: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	svg: `\x1b[38;2;255;180;50m\uf1c5${RST}`,
	webp: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	ico: `\x1b[38;2;160;116;196m\uf1c5${RST}`,

	// Misc
	lock: `\x1b[38;2;130;130;130m\uf023${RST}`, // lock gray
	env: `\x1b[38;2;241;224;90m\ue615${RST}`, // env yellow
	graphql: `\x1b[38;2;224;51;144m\ue662${RST}`, // graphql pink
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`,
};

const NAME_ICON: Record<string, string> = {
	"package.json": `\x1b[38;2;137;180;130m\ue71e${RST}`, // npm green
	"package-lock.json": `\x1b[38;2;130;130;130m\ue71e${RST}`, // npm gray
	"tsconfig.json": `\x1b[38;2;49;120;198m\ue628${RST}`, // ts blue
	"biome.json": `\x1b[38;2;96;165;250m\ue615${RST}`, // config blue
	".gitignore": `\x1b[38;2;222;165;132m\ue702${RST}`, // git orange
	".git": `\x1b[38;2;222;165;132m\ue702${RST}`,
	".env": `\x1b[38;2;241;224;90m\ue615${RST}`, // env yellow
	".envrc": `\x1b[38;2;241;224;90m\ue615${RST}`,
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`, // docker blue
	makefile: `\x1b[38;2;130;130;130m\ue615${RST}`, // make gray
	gnumakefile: `\x1b[38;2;130;130;130m\ue615${RST}`,
	"readme.md": `\x1b[38;2;66;165;245m\ue73e${RST}`, // readme blue
	license: `\x1b[38;2;218;218;218m\ue60a${RST}`, // license white
	"cargo.toml": `\x1b[38;2;222;165;132m\ue7a8${RST}`, // rust
	"go.mod": `\x1b[38;2;0;173;216m\ue724${RST}`, // go
	"pyproject.toml": `\x1b[38;2;55;118;171m\ue73c${RST}`, // python
};

function fileIcon(fp: string): string {
	if (!USE_ICONS) return "";
	const base = basename(fp).toLowerCase();
	if (NAME_ICON[base]) return `${NAME_ICON[base]} `;
	const ext = extname(fp).slice(1).toLowerCase();
	return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${NF_DEFAULT} `;
}

function dirIcon(): string {
	return USE_ICONS ? `${NF_DIR} ` : "";
}

// ---------------------------------------------------------------------------
// Shiki ANSI cache
// ---------------------------------------------------------------------------

// Pre-warm
codeToANSI("", "typescript", THEME).catch(() => {});

const _cache = new Map<string, string[]>();

function _touch(k: string, v: string[]): string[] {
	_cache.delete(k);
	_cache.set(k, v);
	while (_cache.size > CACHE_LIMIT) {
		const first = _cache.keys().next().value;
		if (first === undefined) break;
		_cache.delete(first);
	}
	return v;
}

async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	if (!code) return [""];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");

	const k = `${THEME}\0${language}\0${code}`;
	const hit = _cache.get(k);
	if (hit) return _touch(k, hit);

	try {
		const ansi = normalizeShikiContrast(await codeToANSI(code, language, THEME));
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return _touch(k, out);
	} catch {
		return code.split("\n");
	}
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Render syntax-highlighted file content with line numbers. */
async function renderFileContent(
	content: string,
	filePath: string,
	offset = 1,
	maxLines = MAX_PREVIEW_LINES,
): Promise<string> {
	const normalizedContent = normalizeLineEndings(content);
	const lines = normalizedContent.split("\n");
	const total = lines.length;
	const show = lines.slice(0, maxLines);
	const lg = lang(filePath);
	const hl = await hlBlock(show.join("\n"), lg);

	const tw = termW();
	const startLine = offset;
	const endLine = startLine + show.length - 1;
	const nw = Math.max(3, String(endLine).length);
	const gw = nw + 3; // num + " │ "
	const cw = Math.max(20, tw - gw);

	const out: string[] = [];
	out.push(rule(tw));

	for (let i = 0; i < hl.length; i++) {
		const ln = startLine + i;
		const code = hl[i] ?? show[i] ?? "";
		const plain = strip(code);
		// Truncate if wider than available
		let display = code;
		if (plain.length > cw) {
			let vis = 0;
			let j = 0;
			while (j < code.length && vis < cw - 1) {
				if (code[j] === "\x1b") {
					const e = code.indexOf("m", j);
					if (e !== -1) {
						j = e + 1;
						continue;
					}
				}
				vis++;
				j++;
			}
			display = `${code.slice(0, j)}${RST}${FG_DIM}›${RST}`;
		}
		out.push(`${lnum(ln, nw)} ${FG_RULE}│${RST} ${display}${RST}`);
	}

	out.push(rule(tw));
	if (total > maxLines) {
		out.push(`${FG_DIM}  … ${total - maxLines} more lines (${total} total)${RST}`);
	}
	return out.join("\n");
}

/** Render bash output with colored exit code and stderr highlighting. */
function renderBashOutput(text: string, exitCode: number | null): { summary: string; body: string } {
	const isOk = exitCode === 0;
	const statusFg = isOk ? FG_GREEN : FG_RED;
	const statusIcon = isOk ? "✓" : "✗";
	const codeStr = exitCode !== null ? `${statusFg}${statusIcon} exit ${exitCode}${RST}` : `${FG_YELLOW}⚡ killed${RST}`;

	const lines = text.split("\n");
	const maxShow = MAX_PREVIEW_LINES;
	const show = lines.slice(0, maxShow);
	const remaining = lines.length - maxShow;

	let body = show.join("\n");
	if (remaining > 0) {
		body += `\n${FG_DIM}  … ${remaining} more lines${RST}`;
	}

	return { summary: codeStr, body };
}

/** Render ls output as a tree view with icons. */
function renderTree(text: string, _basePath: string): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return `${FG_DIM}(empty directory)${RST}`;

	const out: string[] = [];
	const total = lines.length;
	const show = lines.slice(0, MAX_PREVIEW_LINES);

	for (let i = 0; i < show.length; i++) {
		const entry = show[i].trim();
		const isLast = i === show.length - 1 && total <= MAX_PREVIEW_LINES;
		const prefix = isLast ? "└── " : "├── ";
		const connector = `${FG_RULE}${prefix}${RST}`;

		// Detect directories (entries ending with /)
		const isDir = entry.endsWith("/");
		const name = isDir ? entry.slice(0, -1) : entry;
		const icon = isDir ? dirIcon() : fileIcon(name);
		const fg = isDir ? FG_BLUE + BOLD : "";
		const reset = isDir ? RST : "";

		out.push(`${connector}${icon}${fg}${name}${reset}`);
	}

	if (total > MAX_PREVIEW_LINES) {
		out.push(`${FG_RULE}└── ${RST}${FG_DIM}… ${total - MAX_PREVIEW_LINES} more entries${RST}`);
	}

	return out.join("\n");
}

/** Render find results grouped by directory with icons. */
function renderFindResults(text: string): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return `${FG_DIM}(no matches)${RST}`;

	// Group by directory
	const groups = new Map<string, string[]>();
	for (const line of lines) {
		const trimmed = line.trim();
		const dir = dirname(trimmed) || ".";
		const file = basename(trimmed);
		if (!groups.has(dir)) groups.set(dir, []);
		const bucket = groups.get(dir);
		if (bucket) bucket.push(file);
	}

	const out: string[] = [];
	let count = 0;

	for (const [dir, files] of groups) {
		if (count > 0) out.push(""); // blank line between groups
		out.push(`${dirIcon()}${FG_BLUE}${BOLD}${dir}/${RST}`);
		for (let i = 0; i < files.length; i++) {
			if (count >= MAX_PREVIEW_LINES) {
				out.push(`  ${FG_DIM}… ${lines.length - count} more files${RST}`);
				return out.join("\n");
			}
			const isLast = i === files.length - 1;
			const prefix = isLast ? "└── " : "├── ";
			const icon = fileIcon(files[i]);
			out.push(`  ${FG_RULE}${prefix}${RST}${icon}${files[i]}`);
			count++;
		}
	}

	return out.join("\n");
}

/** Render grep results with highlighted matches and line numbers. */
async function renderGrepResults(text: string, pattern: string): Promise<string> {
	const lines = normalizeLineEndings(text).split("\n");
	if (!lines.length || (lines.length === 1 && !lines[0].trim())) return `${FG_DIM}(no matches)${RST}`;

	const out: string[] = [];
	let currentFile = "";
	let count = 0;

	// Try to build a regex for highlighting
	let re: RegExp | null = null;
	try {
		re = new RegExp(`(${pattern})`, "gi");
	} catch {
		// invalid regex — skip highlighting
	}

	for (const line of lines) {
		if (count >= MAX_PREVIEW_LINES) {
			out.push(`${FG_DIM}  … more matches${RST}`);
			break;
		}

		// ripgrep-style: "file:line:content" or "file-line-content" or just "file"
		const fileMatch = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
		if (fileMatch) {
			const [, file, lineNo, content] = fileMatch;
			if (file !== currentFile) {
				if (currentFile) out.push(""); // blank line between files
				const icon = fileIcon(file);
				out.push(`${icon}${FG_BLUE}${BOLD}${file}${RST}`);
				currentFile = file;
			}

			const nw = Math.max(3, lineNo.length);
			let display = content;
			if (re) {
				display = content.replace(re, `${RST}${FG_YELLOW}${BOLD}$1${RST}`);
			}
			out.push(`  ${lnum(Number(lineNo), nw)} ${FG_RULE}│${RST} ${display}${RST}`);
			count++;
		} else if (line.trim() === "--") {
			// ripgrep separator
			out.push(`  ${FG_DIM}  ···${RST}`);
		} else if (line.trim()) {
			out.push(line);
			count++;
		}
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// FFF integration (optional) — Fast File Finder with frecency & SIMD search
//
// If @ff-labs/fff-node is installed, find/grep use FFF for speed + frecency.
// If not, falls back to wrapping SDK tools (current behavior).
// ---------------------------------------------------------------------------

type ToolTextContent = TextContent;
type ToolImageContent = ImageContent;
type ToolContent = TextContent | ImageContent;
type ToolResultLike<TDetails = unknown> = AgentToolResult<TDetails | undefined>;
type TextComponentLike = { setText(value: string): void; getText?: () => string };
type TextComponentCtor = new (text?: string, x?: number, y?: number) => TextComponentLike;
type ThemeLike = BgTheme & FgTheme & { bold: (text: string) => string };
type RenderContextLike<TState extends Record<string, string | undefined> = Record<string, string | undefined>> = {
	lastComponent?: TextComponentLike;
	state: TState;
	expanded: boolean;
	isError: boolean;
	invalidate: () => void;
};
type SessionContextLike = ExtensionContext;
type CommandContextLike = ExtensionCommandContext;
type ToolExecutor<TParams, TDetails = unknown> = (
	toolCallId: string,
	params: TParams,
	signal?: AbortSignal,
	onUpdate?: AgentToolUpdateCallback<TDetails | undefined>,
	ctx?: ExtensionContext,
) => Promise<ToolResultLike<TDetails>>;
type ToolFactory<TParams, TDetails = unknown> = (cwd: string) => {
	name?: string;
	description?: string;
	label?: string;
	parameters?: unknown;
	execute: ToolExecutor<TParams, TDetails>;
};
type PiPrettySdk = {
	createReadToolDefinition?: ToolFactory<ReadToolInput>;
	createReadTool?: ToolFactory<ReadToolInput>;
	createBashToolDefinition?: ToolFactory<BashToolInput>;
	createBashTool?: ToolFactory<BashToolInput>;
	createLsToolDefinition?: ToolFactory<LsToolInput>;
	createLsTool?: ToolFactory<LsToolInput>;
	createFindToolDefinition?: ToolFactory<FindToolInput>;
	createFindTool?: ToolFactory<FindToolInput>;
	createGrepToolDefinition?: ToolFactory<GrepToolInput>;
	createGrepTool?: ToolFactory<GrepToolInput>;
	getAgentDir?: () => string;
};
type PiPrettyApi = {
	registerTool: (tool: unknown) => void;
	registerCommand: (
		name: string,
		command: {
			description?: string;
			handler: (args: string, ctx: CommandContextLike) => Promise<void> | void;
		},
	) => void;
	on: (event: string, handler: (event: unknown, ctx: SessionContextLike) => Promise<void> | void) => void;
};
type OptionalFffModule = { FileFinder: typeof FileFinder };
type FffBackedFinder = FileFinder;
type ReadParams = ReadToolInput;
type BashParams = BashToolInput;
type LsParams = LsToolInput;
type FindParams = FindToolInput;
type GrepParams = GrepToolInput;
type MultiGrepParams = {
	patterns: string[];
	path?: string;
	constraints?: string;
	context?: number;
	limit?: number;
};
type GrepRenderState = { _gk?: string; _gt?: string };
type MultiGrepRenderState = { _mgk?: string; _mgt?: string };
type FindResultDetails = { _type: "findResult"; text: string; pattern: string; matchCount: number };
type GrepResultDetails = { _type: "grepResult"; text: string; pattern: string; matchCount: number };
type RenderDetails =
	| { _type: "readImage"; filePath: string; data: string; mimeType: string }
	| { _type: "readFile"; filePath: string; content: string; offset: number; lineCount: number }
	| { _type: "bashResult"; text: string; exitCode: number | null; command: string }
	| { _type: "lsResult"; text: string; path: string; entryCount: number }
	| FindResultDetails
	| GrepResultDetails;

function isTextContent(content: ToolContent): content is ToolTextContent {
	return content.type === "text";
}

function isImageContent(content: ToolContent): content is ToolImageContent {
	return content.type === "image";
}

function getTextContent(result: ToolResultLike): string {
	return (
		result.content
			?.filter(isTextContent)
			.map((content) => content.text || "")
			.join("\n") ?? ""
	);
}

function setResultDetails<T>(result: ToolResultLike, details: T): void {
	result.details = details;
}

function makeTextResult<TDetails>(text: string, details: TDetails): ToolResultLike<TDetails> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function appendNotices(text: string, notices: string[]): string {
	return notices.length ? `${text}\n\n[${notices.join(". ")}]` : text;
}

function countRipgrepMatches(text: string): number {
	return text
		.trim()
		.split("\n")
		.filter((line) => /^.+?[:-]\d+[:-]/.test(line)).length;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function resolveScopedPath(cwd: string, pathValue: string): string {
	return pathValue.startsWith("/") ? pathValue : join(cwd, pathValue);
}

function isExistingPath(cwd: string, pathValue: string | undefined): boolean {
	if (!pathValue) return false;

	try {
		const resolvedPath = resolveScopedPath(cwd, pathValue);
		return existsSync(resolvedPath);
	} catch {
		return false;
	}
}

function trimToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

function escapeRegexLiteral(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLiteralAlternationPattern(patterns: string[]): string {
	return patterns
		.map(escapeRegexLiteral)
		.sort((a, b) => b.length - a.length)
		.join("|");
}

function shouldIgnoreCaseForPatterns(patterns: string[]): boolean {
	return patterns.every((pattern) => pattern.toLowerCase() === pattern);
}

function getConstraintBackedPath(constraints: string | undefined): string | undefined {
	const trimmed = trimToUndefined(constraints);
	if (!trimmed || /\s/.test(trimmed) || trimmed.includes("!") || /[*?[{]/.test(trimmed)) return undefined;
	return trimmed;
}

function getSimpleConstraintGlob(cwd: string, constraints: string | undefined): string | undefined {
	const trimmed = trimToUndefined(constraints);
	if (!trimmed || /\s/.test(trimmed) || trimmed.includes("!")) return undefined;
	if (isExistingPath(cwd, trimmed)) return undefined;
	return /[*?[{]/.test(trimmed) ? trimmed : undefined;
}

const _cursorStore = new CursorStore();
let _fffModule: OptionalFffModule | null = null;
let _fffFinder: FffBackedFinder | null = null;
let _fffPartialIndex = false;
let _fffDbDir: string | null = null;
const FFF_SCAN_TIMEOUT = 15_000;

function getPiPrettyFffDir(agentDir: string): string {
	return join(agentDir, "pi-pretty", "fff");
}

async function fffEnsureFinder(cwd: string): Promise<FffBackedFinder | null> {
	if (_fffFinder && !_fffFinder.isDestroyed) return _fffFinder;
	if (!_fffModule || !_fffDbDir) return null;

	const result = _fffModule.FileFinder.create({
		basePath: cwd,
		frecencyDbPath: join(_fffDbDir, "frecency.mdb"),
		historyDbPath: join(_fffDbDir, "history.mdb"),
		aiMode: true,
	});

	if (!result.ok) throw new Error(`FFF init failed: ${result.error}`);

	_fffFinder = result.value;
	const scan = await _fffFinder.waitForScan(FFF_SCAN_TIMEOUT);
	_fffPartialIndex = scan.ok && !scan.value;

	return _fffFinder;
}

function fffDestroy(): void {
	if (_fffFinder && !_fffFinder.isDestroyed) {
		_fffFinder.destroy();
		_fffFinder = null;
	}
	_fffPartialIndex = false;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Dependencies that can be injected for testing.
 * In production, omit `deps` — the extension uses require() to load them.
 */
export interface PiPrettyDeps {
	sdk: PiPrettySdk;
	TextComponent: TextComponentCtor;
	fffModule?: OptionalFffModule;
}

export default function piPrettyExtension(pi: PiPrettyApi, deps?: PiPrettyDeps): void {
	let createReadTool: ToolFactory<ReadToolInput> | undefined;
	let createBashTool: ToolFactory<BashToolInput> | undefined;
	let createLsTool: ToolFactory<LsToolInput> | undefined;
	let createFindTool: ToolFactory<FindToolInput> | undefined;
	let createGrepTool: ToolFactory<GrepToolInput> | undefined;
	let TextComponent: TextComponentCtor;

	let sdk: PiPrettySdk;

	if (deps) {
		// Test path: use injected dependencies, reset module state
		sdk = deps.sdk;
		createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
		createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
		createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
		createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
		createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;
		TextComponent = deps.TextComponent;
		_fffModule = deps.fffModule ?? null;
		_fffFinder = null;
		_fffPartialIndex = false;
		_fffDbDir = null;
	} else {
		try {
			sdk = require("@mariozechner/pi-coding-agent");
			createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
			createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
			createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
			createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
			createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;
			TextComponent = require("@mariozechner/pi-tui").Text;
		} catch {
			return;
		}
	}
	if (!createReadTool || !TextComponent) return;

	const cwd = process.cwd();
	const home = process.env.HOME ?? "";
	const sp = (p: string) => shortPath(cwd, home, p);

	// ===================================================================
	// FFF initialization (optional — graceful fallback to SDK)
	// ===================================================================

	const getAgentDir = sdk.getAgentDir;
	setPrettyTheme(
		(() => {
			try {
				return getAgentDir?.() ?? getDefaultAgentDir();
			} catch {
				return getDefaultAgentDir();
			}
		})(),
	);
	if (!deps) {
		// Only try require() in production — tests inject fffModule via deps
		try {
			_fffModule = require("@ff-labs/fff-node");
			if (getAgentDir) {
				_fffDbDir = getPiPrettyFffDir(getAgentDir());
				try {
					mkdirSync(_fffDbDir, { recursive: true });
				} catch {}
			}
		} catch {
			/* FFF not installed — SDK tools will be used */
		}
	} else if (_fffModule && getAgentDir) {
		_fffDbDir = getPiPrettyFffDir(getAgentDir());
		try {
			mkdirSync(_fffDbDir, { recursive: true });
		} catch {}
	}

	pi.on("session_start", async (_event, ctx) => {
		// Try dynamic import if sync require failed (ESM-only package)
		if (!_fffModule) {
			try {
				const imported = await import("@ff-labs/fff-node");
				_fffModule = { FileFinder: imported.FileFinder };
			} catch {}
		}
		if (!_fffModule) return;

		if (!_fffDbDir) {
			const agentDir = getAgentDir?.() ?? join(home, ".pi/agent");
			_fffDbDir = getPiPrettyFffDir(agentDir);
			try {
				mkdirSync(_fffDbDir, { recursive: true });
			} catch {}
		}

		try {
			await fffEnsureFinder(ctx.cwd);
			if (_fffPartialIndex) {
				ctx.ui?.notify?.("FFF: scan timed out — using partial index. Run /fff-rescan when ready.", "warning");
			} else {
				ctx.ui?.setStatus?.("fff", "FFF indexed");
				setTimeout(() => ctx.ui?.setStatus?.("fff", undefined), 3000);
			}
		} catch (error: unknown) {
			ctx.ui?.notify?.(`FFF init failed: ${getErrorMessage(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		fffDestroy();
	});

	// ===================================================================
	// read — syntax-highlighted file content
	// ===================================================================

	const origRead = createReadTool(cwd);

	pi.registerTool({
		...origRead,
		name: "read",

		async execute(
			tid: string,
			params: ReadParams,
			sig: AbortSignal | undefined,
			upd: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionContext,
		) {
			const result = (await origRead.execute(tid, params, sig, upd, ctx)) as ToolResultLike;

			const fp = params.path ?? "";
			const offset = params.offset ?? 1;

			const imageBlock = result.content?.find(isImageContent);
			if (imageBlock) {
				setResultDetails(result, {
					_type: "readImage",
					filePath: fp,
					data: imageBlock.data,
					mimeType: imageBlock.mimeType ?? "image/png",
				});
				return result;
			}

			const textContent = getTextContent(result);
			if (textContent && fp) {
				const normalizedContent = normalizeLineEndings(textContent);
				const lineCount = normalizedContent.split("\n").length;
				setResultDetails(result, {
					_type: "readFile",
					filePath: fp,
					content: normalizedContent,
					offset,
					lineCount,
				});
			}

			return result;
		},

		renderCall(args: ReadParams, theme: ThemeLike, ctx: RenderContextLike) {
			resolveBaseBackground(theme);
			const fp = args.path ?? "";
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			const offset = args.offset ? ` ${theme.fg("muted", `from line ${args.offset}`)}` : "";
			const limit = args.limit ? ` ${theme.fg("muted", `(${args.limit} lines)`)}` : "";
			text.setText(
				fillToolBackground(
					`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", sp(fp))}${offset}${limit}`,
				),
			);
			return text;
		},

		renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

			if (ctx.isError) {
				text.setText(renderToolError(getTextContent(result) || "Error", theme));
				return text;
			}

			const d = result.details as RenderDetails | undefined;

			// Image rendering
			if (d?._type === "readImage") {
				const tw = termW();
				const out: string[] = [];
				const fname = basename(d.filePath);
				const byteSize = Math.ceil(((d.data as string).length * 3) / 4);
				const sizeStr = humanSize(byteSize);
				const mimeStr = d.mimeType ?? "image";

				out.push(`  ${fileIcon(d.filePath)}${FG_DIM}${mimeStr} · ${sizeStr}${RST}`);
				out.push(rule(tw));

				const protocol = detectImageProtocol();
				const passthroughWarning = getTmuxPassthroughWarning(protocol);
				if (passthroughWarning) {
					out.push(`  ${FG_YELLOW}${passthroughWarning}${RST}`);
				} else if (protocol === "kitty") {
					if (d.mimeType && d.mimeType !== "image/png") {
						out.push(
							`  ${FG_YELLOW}Kitty/Ghostty inline preview currently supports PNG payloads (got ${d.mimeType})${RST}`,
						);
					} else {
						const imgCols = Math.min(tw - 4, 80);
						out.push(renderKittyImage(d.data, { cols: imgCols }));
					}
				} else if (protocol === "iterm2") {
					const imgWidth = Math.min(tw - 4, 80);
					out.push(
						renderIterm2Image(d.data, {
							width: `${imgWidth}`,
							name: fname,
						}),
					);
				} else {
					out.push(`  ${FG_DIM}(Inline image preview requires Ghostty, iTerm2, WezTerm, or Kitty)${RST}`);
				}

				out.push(rule(tw));
				text.setText(fillToolBackground(out.join("\n")));
				return text;
			}

			if (d?._type === "readFile" && d.content) {
				const key = `read:${d.filePath}:${d.offset}:${d.lineCount}:${termW()}`;
				if (ctx.state._rk !== key) {
					ctx.state._rk = key;
					const info = `${FG_DIM}${d.lineCount} lines${RST}`;
					ctx.state._rt = fillToolBackground(`  ${info}`);

					const maxShow = ctx.expanded ? d.lineCount : MAX_PREVIEW_LINES;
					renderFileContent(d.content, d.filePath, d.offset, maxShow)
						.then((rendered: string) => {
							if (ctx.state._rk !== key) return;
							ctx.state._rt = fillToolBackground(`  ${info}\n${rendered}`);
							ctx.invalidate();
						})
						.catch(() => {});
				}
				text.setText(ctx.state._rt ?? fillToolBackground(`  ${FG_DIM}${d.lineCount} lines${RST}`));
				return text;
			}

			// Fallback
			const fallback = result.content?.[0];
			const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "read";
			text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
			return text;
		},
	});

	// ===================================================================
	// bash — colored exit status
	// ===================================================================

	if (createBashTool) {
		const origBash = createBashTool(cwd);

		pi.registerTool({
			...origBash,
			name: "bash",

			async execute(
				tid: string,
				params: BashParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const result = (await origBash.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
				const textContent = getTextContent(result);

				let exitCode: number | null = 0;
				if (textContent) {
					const exitMatch = textContent.match(/(?:exit code|exited with|exit status)[:\s]*(\d+)/i);
					if (exitMatch) exitCode = Number(exitMatch[1]);
					if (textContent.includes("command not found") || textContent.includes("No such file")) {
						exitCode = 1;
					}
				}

				setResultDetails(result, {
					_type: "bashResult",
					text: textContent ?? "",
					exitCode,
					command: params.command ?? "",
				});

				return result;
			},

			renderCall(args: BashParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const cmd = args.command ?? "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const timeout = args.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";
				const displayCmd = ctx.expanded || cmd.length <= 80 ? cmd : `${cmd.slice(0, 77)}…`;
				text.setText(
					fillToolBackground(
						`${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", displayCmd)}${timeout}`,
					),
				);
				return text;
			},

			renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
					return text;
				}

				const d = result.details as RenderDetails | undefined;
				if (d?._type === "bashResult") {
					const { summary } = renderBashOutput(d.text, d.exitCode);
					const lines = d.text.split("\n");
					const lineCount = lines.length;
					const lineInfo = lineCount > 1 ? `  ${FG_DIM}(${lineCount} lines)${RST}` : "";
					const header = `  ${summary}${lineInfo}`;

					if (d.text.trim()) {
						const maxShow = ctx.expanded ? lineCount : MAX_PREVIEW_LINES;
						const show = lines.slice(0, maxShow);
						const tw = termW();
						const out: string[] = [header, rule(tw)];
						for (const line of show) {
							out.push(`  ${line}`);
						}
						out.push(rule(tw));
						if (lineCount > maxShow) {
							out.push(`${FG_DIM}  … ${lineCount - maxShow} more lines${RST}`);
						}
						text.setText(fillToolBackground(out.join("\n")));
					} else {
						text.setText(fillToolBackground(header));
					}
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "done";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
				return text;
			},
		});
	}

	// ===================================================================
	// ls — tree view with icons
	// ===================================================================

	if (createLsTool) {
		const origLs = createLsTool(cwd);

		pi.registerTool({
			...origLs,
			name: "ls",

			async execute(
				tid: string,
				params: LsParams,
				sig: AbortSignal | undefined,
				upd: AgentToolUpdateCallback<unknown> | undefined,
				ctx: ExtensionContext,
			) {
				const result = (await origLs.execute(tid, params, sig, upd, ctx)) as ToolResultLike;
				const textContent = getTextContent(result);
				const fp = params.path ?? cwd;
				const entryCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				setResultDetails(result, {
					_type: "lsResult",
					text: textContent ?? "",
					path: fp,
					entryCount,
				});

				return result;
			},

			renderCall(args: LsParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const fp = args.path ?? ".";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(fillToolBackground(`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", sp(fp))}`));
				return text;
			},

			renderResult(result: ToolResultLike, _opt: unknown, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
					return text;
				}

				const d = result.details as RenderDetails | undefined;
				if (d?._type === "lsResult" && d.text) {
					const tree = renderTree(d.text, d.path);
					const info = `${FG_DIM}${d.entryCount} entries${RST}`;
					text.setText(fillToolBackground(`  ${info}\n${tree}`));
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "listed";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
				return text;
			},
		});
	}

	// ===================================================================
	// find — grouped file list with icons
	// ===================================================================

	if (createFindTool) {
		const origFind = createFindTool(cwd);

		pi.registerTool({
			...origFind,
			name: "find",

			async execute(
				tid: string,
				params: FindParams,
				sig: AbortSignal | undefined,
				upd: unknown,
				ctx: ExtensionContext,
			) {
				// Try FFF first (frecency-ranked, SIMD-accelerated)
				if (_fffFinder && !_fffFinder.isDestroyed) {
					try {
						const effectiveLimit = Math.max(1, params.limit ?? 200);
						let query = params.pattern;
						if (params.path) query = `${params.path} ${query}`;

						const searchResult = _fffFinder.fileSearch(query, { pageSize: effectiveLimit });
						if (searchResult.ok) {
							const search: SearchResult = searchResult.value;
							const items: FileItem[] = search.items.slice(0, effectiveLimit);
							const notices: string[] = [];
							if (_fffPartialIndex) notices.push("Warning: partial file index");
							if (items.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
							if (search.totalMatched > items.length) notices.push(`${search.totalMatched} total matches`);

							const textContent = appendNotices(items.map((item) => item.relativePath).join("\n"), notices);
							return makeTextResult<FindResultDetails>(textContent, {
								_type: "findResult",
								text: textContent,
								pattern: params.pattern,
								matchCount: items.length,
							});
						}
					} catch {
						/* fall through to SDK */
					}
				}

				// SDK fallback
				const result = await origFind.execute(tid, params, sig, upd as never, ctx);
				const textContent = getTextContent(result);
				const matchCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				setResultDetails<FindResultDetails>(result, {
					_type: "findResult",
					text: textContent,
					pattern: params.pattern,
					matchCount,
				});

				return result;
			},

			renderCall(args: FindParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const pattern = args.pattern ?? "";
				const path = args.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(
					fillToolBackground(`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${path}`),
				);
				return text;
			},

			renderResult(
				result: ToolResultLike<FindResultDetails>,
				_opt: ToolRenderResultOptions,
				theme: ThemeLike,
				ctx: RenderContextLike,
			) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
					return text;
				}

				const d = result.details;
				if (d?._type === "findResult" && d.text) {
					const rendered = renderFindResults(d.text);
					const info = `${FG_DIM}${d.matchCount} files${RST}`;
					text.setText(fillToolBackground(`  ${info}\n${rendered}`));
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "found";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
				return text;
			},
		});
	}

	// ===================================================================
	// grep — highlighted matches with line numbers
	// ===================================================================

	if (createGrepTool) {
		const origGrep = createGrepTool(cwd);

		pi.registerTool({
			...origGrep,
			name: "grep",

			async execute(
				tid: string,
				params: GrepParams,
				sig: AbortSignal | undefined,
				upd: unknown,
				ctx: ExtensionContext,
			) {
				// Try FFF first (SIMD-accelerated, frecency-ranked).
				// FFF 0.5.2 can abort the process when path/glob constraints meet
				// Unicode filenames, so constrained searches use the SDK fallback.
				if (_fffFinder && !_fffFinder.isDestroyed && !params.path && !params.glob) {
					try {
						const effectiveLimit = Math.max(1, params.limit ?? 100);
						const query = params.pattern;

						const grepResult = _fffFinder.grep(query, {
							mode: params.literal ? "plain" : "regex",
							smartCase: !params.ignoreCase,
							maxMatchesPerFile: Math.min(effectiveLimit, 50),
							cursor: null,
							beforeContext: params.context ?? 0,
							afterContext: params.context ?? 0,
						});

						if (grepResult.ok) {
							const grep: GrepResult = grepResult.value;
							const notices: string[] = [];
							if (_fffPartialIndex) notices.push("Warning: partial file index");
							if (grep.items.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
							if (grep.regexFallbackError) notices.push(`Regex failed: ${grep.regexFallbackError}, used literal match`);
							if (grep.nextCursor) {
								const cursorId = _cursorStore.store(grep.nextCursor);
								notices.push(`More results available. Use cursor="${cursorId}" to continue`);
							}

							const textContent = appendNotices(fffFormatGrepText(grep.items, effectiveLimit), notices);
							return makeTextResult<GrepResultDetails>(textContent, {
								_type: "grepResult",
								text: textContent,
								pattern: params.pattern,
								matchCount: Math.min(grep.items.length, effectiveLimit),
							});
						}
					} catch {
						/* fall through to SDK */
					}
				}

				// SDK fallback
				const result = await origGrep.execute(tid, params, sig, upd as never, ctx);
				const textContent = normalizeLineEndings(getTextContent(result));
				if (result.content) {
					for (const content of result.content) {
						if (isTextContent(content)) content.text = normalizeLineEndings(content.text || "");
					}
				}
				const matchCount = textContent ? countRipgrepMatches(textContent) : 0;

				setResultDetails<GrepResultDetails>(result, {
					_type: "grepResult",
					text: textContent,
					pattern: params.pattern,
					matchCount,
				});

				return result;
			},

			renderCall(args: GrepParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const pattern = args.pattern ?? "";
				const path = args.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const glob = args.glob ? ` ${theme.fg("muted", `(${args.glob})`)}` : "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(
					fillToolBackground(
						`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", pattern)}${path}${glob}`,
					),
				);
				return text;
			},

			renderResult(
				result: ToolResultLike<GrepResultDetails>,
				_opt: ToolRenderResultOptions,
				theme: ThemeLike,
				ctx: RenderContextLike<GrepRenderState>,
			) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					text.setText(renderToolError(getTextContent(result) || "Error", theme));
					return text;
				}

				const d = result.details;
				if (d?._type === "grepResult" && d.text) {
					const key = `grep:${d.pattern}:${d.matchCount}:${termW()}`;
					if (ctx.state._gk !== key) {
						ctx.state._gk = key;
						const info = `${FG_DIM}${d.matchCount} matches${RST}`;
						ctx.state._gt = fillToolBackground(`  ${info}`);

						renderGrepResults(d.text, d.pattern)
							.then((rendered: string) => {
								if (ctx.state._gk !== key) return;
								ctx.state._gt = fillToolBackground(`  ${info}\n${rendered}`);
								ctx.invalidate();
							})
							.catch(() => {});
					}
					text.setText(ctx.state._gt ?? fillToolBackground(`  ${FG_DIM}${d.matchCount} matches${RST}`));
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "searched";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`));
				return text;
			},
		});
	}

	// ===================================================================
	// multi_grep — OR-logic multi-pattern search (FFF when available,
	// SDK grep fallback otherwise)
	// ===================================================================

	if (_fffModule || createGrepTool) {
		const multiGrepFallback = createGrepTool ? createGrepTool(cwd) : null;

		pi.registerTool({
			name: "multi_grep",
			label: "multi_grep",
			description: [
				"Search file contents for lines matching ANY of multiple patterns (OR logic).",
				"Uses SIMD-accelerated Aho-Corasick multi-pattern matching when FFF is available.",
				"Falls back to grep-compatible regex alternation when needed (for example fresh on-disk paths).",
				"Patterns are literal text — never escape special characters.",
				"Use path to scope a directory/file and constraints for file filtering ('*.rs', 'src/', '!test/').",
			].join(" "),
			promptSnippet: "Multi-pattern OR search across file contents (FFF-accelerated with grep fallback)",
			promptGuidelines: [
				"Use multi_grep when you need to find multiple identifiers at once (OR logic).",
				"Include all naming conventions: snake_case, PascalCase, camelCase variants.",
				"Patterns are literal text. Never escape special characters.",
				"Use path to scope a directory or file when you need fresh on-disk results.",
				"Use the constraints parameter for additional file filtering, not inside patterns.",
			],

			parameters: {
				type: "object",
				properties: {
					patterns: {
						type: "array",
						items: { type: "string" },
						description: "Patterns to search for (OR logic — matches lines containing ANY pattern).",
					},
					path: {
						type: "string",
						description: "Directory or file path to search (default: current directory)",
					},
					constraints: {
						type: "string",
						description: "File constraints, e.g. '*.{ts,tsx} !test/' to filter files.",
					},
					context: {
						type: "number",
						description: "Number of context lines before and after each match (default: 0)",
					},
					limit: {
						type: "number",
						description: "Maximum number of matches to return (default: 100)",
					},
				},
				required: ["patterns"],
			},

			async execute(
				tid: string,
				params: MultiGrepParams,
				sig: AbortSignal | undefined,
				upd: unknown,
				ctx: ExtensionContext,
			) {
				if (sig?.aborted) return makeTextResult("Aborted", {});

				if (!params.patterns || params.patterns.length === 0) {
					return makeTextResult("Error: patterns array must have at least 1 element", { error: "empty patterns" });
				}

				const effectiveLimit = Math.max(1, params.limit ?? 100);
				const pattern = buildLiteralAlternationPattern(params.patterns);
				const requestedPath = trimToUndefined(params.path);
				const requestedConstraints = trimToUndefined(params.constraints);
				const effectivePath = requestedPath ?? getConstraintBackedPath(requestedConstraints);
				const hasNativeConstraints = Boolean(requestedPath || requestedConstraints);

				if (_fffFinder && !_fffFinder.isDestroyed && !hasNativeConstraints) {
					try {
						const grepResult = _fffFinder.multiGrep({
							patterns: params.patterns,
							maxMatchesPerFile: Math.min(effectiveLimit, 50),
							smartCase: true,
							cursor: null,
							beforeContext: params.context ?? 0,
							afterContext: params.context ?? 0,
						});

						if (!grepResult.ok) {
							return makeTextResult(`multi_grep error: ${grepResult.error}`, { error: grepResult.error });
						}

						const grep: GrepResult = grepResult.value;
						const notices: string[] = [];
						if (_fffPartialIndex) notices.push("Warning: partial file index");
						if (grep.items.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
						if (grep.nextCursor) {
							const cursorId = _cursorStore.store(grep.nextCursor);
							notices.push(`More results: cursor="${cursorId}"`);
						}

						const textContent = appendNotices(fffFormatGrepText(grep.items, effectiveLimit), notices);
						return makeTextResult<GrepResultDetails>(textContent, {
							_type: "grepResult",
							text: textContent,
							pattern,
							matchCount: Math.min(grep.items.length, effectiveLimit),
						});
					} catch {
						/* fall through to SDK */
					}
				}

				if (!multiGrepFallback) {
					if (!_fffFinder || _fffFinder.isDestroyed) {
						return makeTextResult("FFF not initialized. Wait for session start or run /fff-rescan.", {});
					}
					return makeTextResult("multi_grep error: FFF search failed and no grep fallback is available", {
						error: "missing grep fallback",
					});
				}

				try {
					const simpleGlob = getSimpleConstraintGlob(cwd, params.constraints);
					const notices: string[] = [];
					const trimmedConstraints = trimToUndefined(params.constraints);

					if (!_fffFinder || _fffFinder.isDestroyed) notices.push("FFF unavailable, used SDK grep fallback");
					else if (hasNativeConstraints) notices.push("Used SDK grep fallback for constrained search");
					if (trimmedConstraints && !simpleGlob && trimmedConstraints !== effectivePath) {
						notices.push(`SDK fallback ignored unsupported constraints: ${trimmedConstraints}`);
					}

					const result = await multiGrepFallback.execute(
						tid,
						{
							pattern,
							path: effectivePath,
							glob: simpleGlob,
							ignoreCase: shouldIgnoreCaseForPatterns(params.patterns),
							context: params.context,
							limit: params.limit,
						},
						sig,
						upd as never,
						ctx,
					);
					const textContent = normalizeLineEndings(getTextContent(result)) || "No matches found";
					const finalText = appendNotices(textContent, notices);

					return makeTextResult<GrepResultDetails>(finalText, {
						_type: "grepResult",
						text: finalText,
						pattern,
						matchCount: textContent ? countRipgrepMatches(textContent) : 0,
					});
				} catch (error: unknown) {
					const message = getErrorMessage(error);
					return makeTextResult(`multi_grep error: ${message}`, { error: message });
				}
			},

			renderCall(args: MultiGrepParams, theme: ThemeLike, ctx: RenderContextLike) {
				resolveBaseBackground(theme);
				const patterns = args.patterns ?? [];
				const path = args.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const constraints = args.constraints;
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				let content =
					theme.fg("toolTitle", theme.bold("multi_grep")) +
					" " +
					theme.fg("accent", patterns.map((p) => `"${p}"`).join(", "));
				content += path;
				if (constraints) content += theme.fg("muted", ` (${constraints})`);
				text.setText(fillToolBackground(content));
				return text;
			},

			renderResult(
				result: ToolResultLike<GrepResultDetails | { error?: string }>,
				_opt: ToolRenderResultOptions,
				theme: ThemeLike,
				ctx: RenderContextLike<MultiGrepRenderState>,
			) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					text.setText(`\n${theme.fg("error", getTextContent(result) || "Error")}`);
					return text;
				}

				const d = result.details;
				if (d && "_type" in d && d._type === "grepResult" && d.text) {
					const key = `mgrep:${d.pattern}:${d.matchCount}:${termW()}`;
					if (ctx.state._mgk !== key) {
						ctx.state._mgk = key;
						const info = `${FG_DIM}${d.matchCount} matches${RST}`;
						ctx.state._mgt = `  ${info}`;

						renderGrepResults(d.text, d.pattern)
							.then((rendered: string) => {
								if (ctx.state._mgk !== key) return;
								ctx.state._mgt = `  ${info}\n${rendered}`;
								ctx.invalidate();
							})
							.catch(() => {});
					}
					text.setText(ctx.state._mgt ?? `  ${FG_DIM}${d.matchCount} matches${RST}`);
					return text;
				}

				const fallback = result.content?.[0];
				const fallbackText = fallback && isTextContent(fallback) ? fallback.text : "searched";
				text.setText(`  ${theme.fg("dim", String(fallbackText).slice(0, 120))}`);
				return text;
			},
		});
	}

	// ===================================================================
	// FFF commands
	// ===================================================================

	if (_fffModule) {
		pi.registerCommand("fff-health", {
			description: "Show FFF file finder health and indexer status",
			handler: async (_args: string, ctx: CommandContextLike) => {
				if (!_fffFinder || _fffFinder.isDestroyed) {
					ctx.ui?.notify?.("FFF not initialized", "warning");
					return;
				}

				const health = _fffFinder.healthCheck();
				if (!health.ok) {
					ctx.ui?.notify?.(`Health check failed: ${health.error}`, "error");
					return;
				}

				const h = health.value;
				const lines = [
					`FFF v${h.version}`,
					`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
					`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
					`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
					`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
					`Partial index: ${_fffPartialIndex ? "yes (scan timed out)" : "no"}`,
				];

				const progress = _fffFinder.getScanProgress();
				if (progress.ok) {
					lines.push(
						`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
					);
				}

				ctx.ui?.notify?.(lines.join("\n"), "info");
			},
		});

		pi.registerCommand("fff-rescan", {
			description: "Trigger FFF to rescan files",
			handler: async (_args: string, ctx: CommandContextLike) => {
				if (!_fffFinder || _fffFinder.isDestroyed) {
					ctx.ui?.notify?.("FFF not initialized", "warning");
					return;
				}

				const result = _fffFinder.scanFiles();
				if (!result.ok) {
					ctx.ui?.notify?.(`Rescan failed: ${result.error}`, "error");
					return;
				}

				_fffPartialIndex = false;
				ctx.ui?.notify?.("FFF rescan triggered", "info");
			},
		});
	}
}
