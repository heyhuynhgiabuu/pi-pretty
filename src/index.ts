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
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import { codeToANSI } from "@shikijs/cli";
import type { BundledLanguage, BundledTheme } from "shiki";

import { CursorStore, fffFormatGrepText } from "./fff-helpers.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const THEME: BundledTheme = (process.env.PRETTY_THEME as BundledTheme | undefined) ?? "github-dark";

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
const DIM = "\x1b[2m";
const ITALIC = "\x1b[3m";

const FG_LNUM = "\x1b[38;2;100;100;100m";
const FG_DIM = "\x1b[38;2;80;80;80m";
const FG_RULE = "\x1b[38;2;50;50;50m";
const FG_GREEN = "\x1b[38;2;100;180;120m";
const FG_RED = "\x1b[38;2;200;100;100m";
const FG_YELLOW = "\x1b[38;2;220;180;80m";
const FG_BLUE = "\x1b[38;2;100;140;220m";
const FG_CYAN = "\x1b[38;2;80;190;190m";
const FG_MUTED = "\x1b[38;2;139;148;158m";
const FG_ORANGE = "\x1b[38;2;220;140;60m";
const FG_PURPLE = "\x1b[38;2;170;120;200m";

const BG_STDERR = "\x1b[48;2;40;25;25m";

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
	const raw =
		process.stdout.columns || (process.stderr as any).columns || Number.parseInt(process.env.COLUMNS ?? "", 10) || 200;
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
const NF_DIR_OPEN = `${FG_BLUE}\ue5fe${RST}`; // folder open
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
	const lines = content.split("\n");
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
function renderTree(text: string, basePath: string): string {
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
		groups.get(dir)!.push(file);
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
	const lines = text.split("\n");
	if (!lines.length || (lines.length === 1 && !lines[0].trim())) return `${FG_DIM}(no matches)${RST}`;

	const tw = termW();
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

const _cursorStore = new CursorStore();
let _fffModule: any = null;
let _fffFinder: any = null;
let _fffPartialIndex = false;
let _fffDbDir: string | null = null;
const FFF_SCAN_TIMEOUT = 15_000;

async function fffEnsureFinder(cwd: string): Promise<any> {
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
	sdk: any;
	TextComponent: any;
	fffModule?: any;
}

export default function piPrettyExtension(pi: any, deps?: PiPrettyDeps): void {
	let createReadTool: any;
	let createBashTool: any;
	let createLsTool: any;
	let createFindTool: any;
	let createGrepTool: any;
	let TextComponent: any;

	let sdk: any;

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

	const getAgentDir = (sdk as any).getAgentDir;
	if (!deps) {
		// Only try require() in production — tests inject fffModule via deps
		try {
			_fffModule = require("@ff-labs/fff-node");
			if (getAgentDir) {
				_fffDbDir = join(getAgentDir(), "fff");
				try {
					mkdirSync(_fffDbDir, { recursive: true });
				} catch {}
			}
		} catch {
			/* FFF not installed — SDK tools will be used */
		}
	} else if (_fffModule && getAgentDir) {
		_fffDbDir = join(getAgentDir(), "fff");
		try {
			mkdirSync(_fffDbDir, { recursive: true });
		} catch {}
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		// Try dynamic import if sync require failed (ESM-only package)
		if (!_fffModule) {
			try {
				// @ts-ignore — optional dependency, may not be installed
				_fffModule = await import("@ff-labs/fff-node");
			} catch {}
		}
		if (!_fffModule) return;

		if (!_fffDbDir) {
			const agentDir = getAgentDir?.() ?? join(home, ".pi/agent");
			_fffDbDir = join(agentDir, "fff");
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
		} catch (e: any) {
			ctx.ui?.notify?.(`FFF init failed: ${e.message}`, "error");
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

		async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
			const result = await origRead.execute(tid, params, sig, upd, ctx);

			const fp = params.path ?? "";
			const offset = params.offset ?? 1;

			// Check for image content
			const imageBlock = result.content?.find((c: any) => c.type === "image");
			if (imageBlock) {
				(result as any).details = {
					_type: "readImage",
					filePath: fp,
					data: imageBlock.data,
					mimeType: imageBlock.mimeType ?? "image/png",
				};
				return result;
			}

			// Extract text content for rendering
			const textContent = result.content
				?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text || "")
				.join("\n");

			if (textContent && fp) {
				const lineCount = textContent.split("\n").length;
				(result as any).details = {
					_type: "readFile",
					filePath: fp,
					content: textContent,
					offset,
					lineCount,
				};
			}

			return result;
		},

		renderCall(args: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
			const fp = args?.path ?? "";
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			const offset = args?.offset ? ` ${theme.fg("muted", `from line ${args.offset}`)}` : "";
			const limit = args?.limit ? ` ${theme.fg("muted", `(${args.limit} lines)`)}` : "";
			text.setText(fillToolBackground(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", sp(fp))}${offset}${limit}`));
			return text;
		},

		renderResult(result: any, _opt: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

			if (ctx.isError) {
				const e =
					result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
				text.setText(renderToolError(e, theme));
				return text;
			}

			const d = result.details;

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
						out.push(`  ${FG_YELLOW}Kitty/Ghostty inline preview currently supports PNG payloads (got ${d.mimeType})${RST}`);
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
			const fallback = result.content?.[0]?.text ?? "read";
			text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallback).slice(0, 120))}`));
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

			async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
				const result = await origBash.execute(tid, params, sig, upd, ctx);

				const textContent = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join("\n");

				// Try to extract exit code from the output
				let exitCode: number | null = 0;
				if (textContent) {
					const exitMatch = textContent.match(/(?:exit code|exited with|exit status)[:\s]*(\d+)/i);
					if (exitMatch) exitCode = Number(exitMatch[1]);
					// Check for common error indicators
					if (textContent.includes("command not found") || textContent.includes("No such file")) {
						exitCode = 1;
					}
				}

				(result as any).details = {
					_type: "bashResult",
					text: textContent ?? "",
					exitCode,
					command: params.command ?? "",
				};

				return result;
			},

			renderCall(args: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
				const cmd = args?.command ?? "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const timeout = args?.timeout ? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}` : "";
				text.setText(
					fillToolBackground(`${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd)}${timeout}`),
				);
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e =
						result.content
							?.filter((c: any) => c.type === "text")
							.map((c: any) => c.text || "")
							.join("\n") ?? "Error";
					text.setText(renderToolError(e, theme));
					return text;
				}

				const d = result.details;
				if (d?._type === "bashResult") {
					const { summary, body } = renderBashOutput(d.text, d.exitCode);
					const lines = d.text.split("\n");
					const lineCount = lines.length;
					const lineInfo = lineCount > 1 ? `  ${FG_DIM}(${lineCount} lines)${RST}` : "";
					const header = `  ${summary}${lineInfo}`;

					// Show output content
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

				const fallback = result.content?.[0]?.text ?? "done";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallback).slice(0, 120))}`));
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

			async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
				const result = await origLs.execute(tid, params, sig, upd, ctx);

				const textContent = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join("\n");

				const fp = params.path ?? cwd;
				const entryCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				(result as any).details = {
					_type: "lsResult",
					text: textContent ?? "",
					path: fp,
					entryCount,
				};

				return result;
			},

			renderCall(args: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
				const fp = args?.path ?? ".";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(fillToolBackground(`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", sp(fp))}`));
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e =
						result.content
							?.filter((c: any) => c.type === "text")
							.map((c: any) => c.text || "")
							.join("\n") ?? "Error";
					text.setText(renderToolError(e, theme));
					return text;
				}

				const d = result.details;
				if (d?._type === "lsResult" && d.text) {
					const tree = renderTree(d.text, d.path);
					const info = `${FG_DIM}${d.entryCount} entries${RST}`;
					text.setText(fillToolBackground(`  ${info}\n${tree}`));
					return text;
				}

				const fallback = result.content?.[0]?.text ?? "listed";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallback).slice(0, 120))}`));
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

			async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
				// Try FFF first (frecency-ranked, SIMD-accelerated)
				if (_fffFinder && !_fffFinder.isDestroyed) {
					try {
						const effectiveLimit = Math.max(1, params.limit ?? 200);
						let query = params.pattern ?? "";
						if (params.path) query = `${params.path} ${query}`;

						const searchResult = _fffFinder.fileSearch(query, { pageSize: effectiveLimit });
						if (searchResult.ok) {
							const items = searchResult.value.items.slice(0, effectiveLimit);
							let textContent = items.map((i: any) => i.relativePath).join("\n");
							const matchCount = items.length;

							const notices: string[] = [];
							if (_fffPartialIndex) notices.push("Warning: partial file index");
							if (items.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
							if (searchResult.value.totalMatched > items.length) {
								notices.push(`${searchResult.value.totalMatched} total matches`);
							}
							if (notices.length) textContent += `\n\n[${notices.join(". ")}]`;

							return {
								content: [{ type: "text", text: textContent }],
								details: {
									_type: "findResult",
									text: textContent,
									pattern: params.pattern ?? "",
									matchCount,
								},
							};
						}
					} catch {
						/* fall through to SDK */
					}
				}

				// SDK fallback
				const result = await origFind.execute(tid, params, sig, upd, ctx);

				const textContent = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join("\n");

				const matchCount = textContent ? textContent.trim().split("\n").filter(Boolean).length : 0;

				(result as any).details = {
					_type: "findResult",
					text: textContent ?? "",
					pattern: params.pattern ?? "",
					matchCount,
				};

				return result;
			},

			renderCall(args: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
				const pattern = args?.pattern ?? "";
				const path = args?.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(fillToolBackground(`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${path}`));
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e =
						result.content
							?.filter((c: any) => c.type === "text")
							.map((c: any) => c.text || "")
							.join("\n") ?? "Error";
					text.setText(renderToolError(e, theme));
					return text;
				}

				const d = result.details;
				if (d?._type === "findResult" && d.text) {
					const rendered = renderFindResults(d.text);
					const info = `${FG_DIM}${d.matchCount} files${RST}`;
					text.setText(fillToolBackground(`  ${info}\n${rendered}`));
					return text;
				}

				const fallback = result.content?.[0]?.text ?? "found";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallback).slice(0, 120))}`));
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

			async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
				// Try FFF first (SIMD-accelerated, frecency-ranked)
				if (_fffFinder && !_fffFinder.isDestroyed) {
					try {
						const effectiveLimit = Math.max(1, params.limit ?? 100);
						let query = params.pattern ?? "";
						if (params.glob) query = `${params.glob} ${query}`;
						else if (params.path) query = `${params.path} ${query}`;

						const mode = params.literal ? "plain" : "regex";

						const grepResult = _fffFinder.grep(query, {
							mode,
							smartCase: !params.ignoreCase,
							maxMatchesPerFile: Math.min(effectiveLimit, 50),
							cursor: null,
							beforeContext: params.context ?? 0,
							afterContext: params.context ?? 0,
						});

						if (grepResult.ok) {
							const result = grepResult.value;
							let textContent = fffFormatGrepText(result.items, effectiveLimit);
							const matchCount = Math.min(result.items.length, effectiveLimit);

							const notices: string[] = [];
							if (_fffPartialIndex) notices.push("Warning: partial file index");
							if (result.items.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
							if ((result as any).regexFallbackError) {
								notices.push(`Regex failed: ${(result as any).regexFallbackError}, used literal match`);
							}
							if (result.nextCursor) {
								const cursorId = _cursorStore.store(result.nextCursor);
								notices.push(`More results available. Use cursor="${cursorId}" to continue`);
							}
							if (notices.length) textContent += `\n\n[${notices.join(". ")}]`;

							return {
								content: [{ type: "text", text: textContent }],
								details: {
									_type: "grepResult",
									text: textContent,
									pattern: params.pattern ?? "",
									matchCount,
								},
							};
						}
					} catch {
						/* fall through to SDK */
					}
				}

				// SDK fallback
				const result = await origGrep.execute(tid, params, sig, upd, ctx);

				const textContent = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join("\n");

				const matchCount = textContent
					? textContent
							.trim()
							.split("\n")
							.filter((l: string) => l.match(/^.+?[:\-]\d+[:\-]/)).length
					: 0;

				(result as any).details = {
					_type: "grepResult",
					text: textContent ?? "",
					pattern: params.pattern ?? "",
					matchCount,
				};

				return result;
			},

			renderCall(args: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
				const pattern = args?.pattern ?? "";
				const path = args?.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const glob = args?.glob ? ` ${theme.fg("muted", `(${args.glob})`)}` : "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(fillToolBackground(`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", pattern)}${path}${glob}`));
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
			resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e =
						result.content
							?.filter((c: any) => c.type === "text")
							.map((c: any) => c.text || "")
							.join("\n") ?? "Error";
					text.setText(renderToolError(e, theme));
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

				const fallback = result.content?.[0]?.text ?? "searched";
				text.setText(fillToolBackground(`  ${theme.fg("dim", String(fallback).slice(0, 120))}`));
				return text;
			},
		});
	}

	// ===================================================================
	// multi_grep — FFF-only OR-logic multi-pattern search
	// ===================================================================

	if (_fffModule) {
		pi.registerTool({
			name: "multi_grep",
			label: "multi_grep (fff)",
			description: [
				"Search file contents for lines matching ANY of multiple patterns (OR logic).",
				"Uses SIMD-accelerated Aho-Corasick multi-pattern matching. Faster than regex alternation.",
				"Patterns are literal text — never escape special characters.",
				"Use the constraints parameter for file filtering ('*.rs', 'src/', '!test/').",
			].join(" "),
			promptSnippet:
				"Multi-pattern OR search across file contents (FFF: SIMD-accelerated, frecency-ranked)",
			promptGuidelines: [
				"Use multi_grep when you need to find multiple identifiers at once (OR logic).",
				"Include all naming conventions: snake_case, PascalCase, camelCase variants.",
				"Patterns are literal text. Never escape special characters.",
				"Use the constraints parameter for file type/path filtering, not inside patterns.",
			],

			parameters: {
				type: "object",
				properties: {
					patterns: {
						type: "array",
						items: { type: "string" },
						description: "Patterns to search for (OR logic — matches lines containing ANY pattern).",
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

			async execute(_tid: string, params: any, sig: any, _upd: any, _ctx: any) {
				if (sig?.aborted) return { content: [{ type: "text", text: "Aborted" }], details: {} };

				if (!params.patterns || params.patterns.length === 0) {
					return {
						content: [{ type: "text", text: "Error: patterns array must have at least 1 element" }],
						details: { error: "empty patterns" },
					};
				}

				if (!_fffFinder || _fffFinder.isDestroyed) {
					return {
						content: [{ type: "text", text: "FFF not initialized. Wait for session start or run /fff-rescan." }],
						details: {},
					};
				}

				try {
					const effectiveLimit = Math.max(1, params.limit ?? 100);

					const grepResult = _fffFinder.multiGrep({
						patterns: params.patterns,
						constraints: params.constraints,
						maxMatchesPerFile: Math.min(effectiveLimit, 50),
						smartCase: true,
						cursor: null,
						beforeContext: params.context ?? 0,
						afterContext: params.context ?? 0,
					});

					if (!grepResult.ok) {
						return {
							content: [{ type: "text", text: `multi_grep error: ${grepResult.error}` }],
							details: { error: grepResult.error },
						};
					}

					const result = grepResult.value;
					let textContent = fffFormatGrepText(result.items, effectiveLimit);
					const matchCount = Math.min(result.items.length, effectiveLimit);

					const notices: string[] = [];
					if (_fffPartialIndex) notices.push("Warning: partial file index");
					if (result.items.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
					if (result.nextCursor) {
						const cursorId = _cursorStore.store(result.nextCursor);
						notices.push(`More results: cursor="${cursorId}"`);
					}
					if (notices.length) textContent += `\n\n[${notices.join(". ")}]`;

					return {
						content: [{ type: "text", text: textContent }],
						details: {
							_type: "grepResult",
							text: textContent,
							pattern: params.patterns.join(" | "),
							matchCount,
						},
					};
				} catch (e: any) {
					return {
						content: [{ type: "text", text: `multi_grep error: ${e.message}` }],
						details: { error: e.message },
					};
				}
			},

			renderCall(args: any, theme: any, ctx: any) {
				resolveBaseBackground(theme);
				const patterns = args?.patterns ?? [];
				const constraints = args?.constraints;
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				let content =
					theme.fg("toolTitle", theme.bold("multi_grep")) +
					" " +
					theme.fg("accent", patterns.map((p: string) => `"${p}"`).join(", "));
				if (constraints) content += theme.fg("muted", ` (${constraints})`);
				text.setText(content);
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
				resolveBaseBackground(theme);
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e = result.content?.[0]?.text ?? "Error";
					text.setText(`\n${theme.fg("error", e)}`);
					return text;
				}

				const d = result.details;
				if (d?._type === "grepResult" && d.text) {
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

				const fallback = result.content?.[0]?.text ?? "searched";
				text.setText(`  ${theme.fg("dim", String(fallback).slice(0, 120))}`);
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
			handler: async (_args: any, ctx: any) => {
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
					lines.push(`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`);
				}

				ctx.ui?.notify?.(lines.join("\n"), "info");
			},
		});

		pi.registerCommand("fff-rescan", {
			description: "Trigger FFF to rescan files",
			handler: async (_args: any, ctx: any) => {
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
