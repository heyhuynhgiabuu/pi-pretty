/**
 * pi-pretty — Pretty terminal output for pi built-in tools.
 *
 * @module pi-pretty
 * @see https://github.com/heyhuynhgiabuu/pi-pretty
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

import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, relative } from "node:path";

import { codeToANSI } from "@shikijs/cli";
import type { BundledLanguage, BundledTheme } from "shiki";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const THEME: BundledTheme =
	(process.env.PRETTY_THEME as BundledTheme | undefined) ?? "github-dark";

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

const RST = "\x1b[0m";
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

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ---------------------------------------------------------------------------
// Low-contrast fix (same as pi-diff)
// ---------------------------------------------------------------------------

function isLowContrastShikiFg(params: string): boolean {
	if (params === "30" || params === "90") return true;
	if (params === "38;5;0" || params === "38;5;8") return true;
	if (!params.startsWith("38;2;")) return false;
	const parts = params.split(";").map(Number);
	if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n)))
		return false;
	const [, , r, g, b] = parts;
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance < 72;
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(
		/\x1b\[([0-9;]*)m/g,
		(seq, params: string) =>
			isLowContrastShikiFg(params) ? FG_MUTED : seq,
	);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function strip(s: string): string {
	return s.replace(ANSI_RE, "");
}

function termW(): number {
	const raw =
		process.stdout.columns ||
		(process.stderr as any).columns ||
		Number.parseInt(process.env.COLUMNS ?? "", 10) ||
		200;
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
	ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
	mjs: "javascript", cjs: "javascript",
	py: "python", rb: "ruby", rs: "rust", go: "go", java: "java",
	c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
	swift: "swift", kt: "kotlin",
	html: "html", css: "css", scss: "scss", less: "css",
	json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", toml: "toml",
	md: "markdown", mdx: "mdx", sql: "sql", sh: "bash", bash: "bash", zsh: "bash",
	lua: "lua", php: "php", dart: "dart", xml: "xml",
	graphql: "graphql", svelte: "svelte", vue: "vue",
	dockerfile: "dockerfile", makefile: "make",
	zig: "zig", nim: "nim", elixir: "elixir", ex: "elixir",
	erb: "erb", hbs: "handlebars",
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

const IS_TMUX = !!process.env.TMUX;

/**
 * Detect the outer terminal when running inside tmux.
 * tmux sets TERM_PROGRAM=tmux, but the real terminal is often in
 * the environment of the tmux server or can be inferred.
 */
function getOuterTerminal(): string {
	// Direct terminal (not in tmux)
	const term = process.env.TERM_PROGRAM ?? "";
	if (term !== "tmux" && term !== "screen") return term;

	// Inside tmux: check common env vars that leak through
	// Ghostty sets this; iTerm2 sets LC_TERMINAL
	if (process.env.LC_TERMINAL === "iTerm2") return "iTerm.app";

	// TERM_PROGRAM_VERSION sometimes survives into tmux
	// Try to detect via COLORTERM or other hints
	if (process.env.GHOSTTY_RESOURCES_DIR) return "ghostty";

	// Default: assume modern terminal if truecolor is supported
	if (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit") {
		// Can't determine exact terminal, but likely modern
		return "unknown-modern";
	}
	return term;
}

function detectImageProtocol(): ImageProtocol {
	const term = getOuterTerminal();
	// Ghostty and Kitty use the Kitty graphics protocol
	if (term === "ghostty" || term === "kitty") return "kitty";
	// iTerm2, WezTerm, Mintty support the iTerm2 protocol
	if (["iTerm.app", "WezTerm", "mintty"].includes(term)) return "iterm2";
	if (process.env.LC_TERMINAL === "iTerm2") return "iterm2";
	return "none";
}

/**
 * Wrap escape sequence for tmux passthrough.
 * tmux requires: ESC Ptmux; <escaped-sequence> ESC \
 * Inner ESC chars must be doubled.
 */
function tmuxWrap(seq: string): string {
	if (!IS_TMUX) return seq;
	// Double all ESC chars inside the sequence
	const escaped = seq.replace(/\x1b/g, "\x1b\x1b");
	return `\x1bPtmux;${escaped}\x1b\\`;
}

/**
 * Render base64 image inline using iTerm2 inline image protocol.
 * Protocol: ESC ] 1337 ; File=[args] : base64data BEL
 */
function renderIterm2Image(
	base64Data: string,
	opts: { width?: string; name?: string } = {},
): string {
	const args: string[] = ["inline=1", "preserveAspectRatio=1"];
	if (opts.width) args.push(`width=${opts.width}`);
	if (opts.name) args.push(`name=${Buffer.from(opts.name).toString("base64")}`);
	const byteSize = Math.ceil(base64Data.length * 3 / 4);
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
function renderKittyImage(
	base64Data: string,
	opts: { cols?: number } = {},
): string {
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
const NF_DIR      = `${FG_BLUE}\ue5ff${RST}`;      // folder
const NF_DIR_OPEN = `${FG_BLUE}\ue5fe${RST}`;      // folder open
const NF_DEFAULT  = `${FG_DIM}\uf15b${RST}`;       // generic file

const EXT_ICON: Record<string, string> = {
	// TypeScript / JavaScript
	ts:  `\x1b[38;2;49;120;198m\ue628${RST}`,   // blue
	tsx: `\x1b[38;2;49;120;198m\ue7ba${RST}`,   // react blue
	js:  `\x1b[38;2;241;224;90m\ue74e${RST}`,   // yellow
	jsx: `\x1b[38;2;97;218;251m\ue7ba${RST}`,   // react cyan
	mjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,
	cjs: `\x1b[38;2;241;224;90m\ue74e${RST}`,

	// Systems / Backend
	py:    `\x1b[38;2;55;118;171m\ue73c${RST}`,   // python blue
	rs:    `\x1b[38;2;222;165;132m\ue7a8${RST}`,   // rust orange
	go:    `\x1b[38;2;0;173;216m\ue724${RST}`,     // go cyan
	java:  `\x1b[38;2;204;62;68m\ue738${RST}`,     // java red
	swift: `\x1b[38;2;255;172;77m\ue755${RST}`,    // swift orange
	rb:    `\x1b[38;2;204;52;45m\ue739${RST}`,     // ruby red
	kt:    `\x1b[38;2;126;103;200m\ue634${RST}`,   // kotlin purple
	c:     `\x1b[38;2;85;154;211m\ue61e${RST}`,    // c blue
	cpp:   `\x1b[38;2;85;154;211m\ue61d${RST}`,    // cpp blue
	h:     `\x1b[38;2;140;160;185m\ue61e${RST}`,   // header muted
	hpp:   `\x1b[38;2;140;160;185m\ue61d${RST}`,
	cs:    `\x1b[38;2;104;33;122m\ue648${RST}`,    // c# purple

	// Web
	html:   `\x1b[38;2;228;77;38m\ue736${RST}`,    // html orange
	css:    `\x1b[38;2;66;165;245m\ue749${RST}`,    // css blue
	scss:   `\x1b[38;2;207;100;154m\ue749${RST}`,   // scss pink
	less:   `\x1b[38;2;66;165;245m\ue749${RST}`,
	vue:    `\x1b[38;2;65;184;131m\ue6a0${RST}`,    // vue green
	svelte: `\x1b[38;2;255;62;0m\ue697${RST}`,      // svelte red-orange

	// Config / Data
	json:  `\x1b[38;2;241;224;90m\ue60b${RST}`,    // json yellow
	jsonc: `\x1b[38;2;241;224;90m\ue60b${RST}`,
	yaml:  `\x1b[38;2;160;116;196m\ue6a8${RST}`,   // yaml purple
	yml:   `\x1b[38;2;160;116;196m\ue6a8${RST}`,
	toml:  `\x1b[38;2;160;116;196m\ue6b2${RST}`,   // toml purple
	xml:   `\x1b[38;2;228;77;38m\ue619${RST}`,      // xml orange
	sql:   `\x1b[38;2;218;218;218m\ue706${RST}`,    // sql gray

	// Markdown / Docs
	md:  `\x1b[38;2;66;165;245m\ue73e${RST}`,      // markdown blue
	mdx: `\x1b[38;2;66;165;245m\ue73e${RST}`,

	// Shell / Scripts
	sh:   `\x1b[38;2;137;180;130m\ue795${RST}`,    // shell green
	bash: `\x1b[38;2;137;180;130m\ue795${RST}`,
	zsh:  `\x1b[38;2;137;180;130m\ue795${RST}`,
	fish: `\x1b[38;2;137;180;130m\ue795${RST}`,
	lua:  `\x1b[38;2;81;160;207m\ue620${RST}`,     // lua blue
	php:  `\x1b[38;2;137;147;186m\ue73d${RST}`,    // php purple
	dart: `\x1b[38;2;87;182;240m\ue798${RST}`,     // dart blue

	// Images
	png:  `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpg:  `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	jpeg: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	gif:  `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	svg:  `\x1b[38;2;255;180;50m\uf1c5${RST}`,
	webp: `\x1b[38;2;160;116;196m\uf1c5${RST}`,
	ico:  `\x1b[38;2;160;116;196m\uf1c5${RST}`,

	// Misc
	lock: `\x1b[38;2;130;130;130m\uf023${RST}`,    // lock gray
	env:  `\x1b[38;2;241;224;90m\ue615${RST}`,     // env yellow
	graphql: `\x1b[38;2;224;51;144m\ue662${RST}`,  // graphql pink
	dockerfile: `\x1b[38;2;56;152;236m\ue7b0${RST}`,
};

const NAME_ICON: Record<string, string> = {
	"package.json":      `\x1b[38;2;137;180;130m\ue71e${RST}`,  // npm green
	"package-lock.json": `\x1b[38;2;130;130;130m\ue71e${RST}`,  // npm gray
	"tsconfig.json":     `\x1b[38;2;49;120;198m\ue628${RST}`,   // ts blue
	"biome.json":        `\x1b[38;2;96;165;250m\ue615${RST}`,   // config blue
	".gitignore":        `\x1b[38;2;222;165;132m\ue702${RST}`,  // git orange
	".git":              `\x1b[38;2;222;165;132m\ue702${RST}`,
	".env":              `\x1b[38;2;241;224;90m\ue615${RST}`,    // env yellow
	".envrc":            `\x1b[38;2;241;224;90m\ue615${RST}`,
	"dockerfile":        `\x1b[38;2;56;152;236m\ue7b0${RST}`,   // docker blue
	"makefile":          `\x1b[38;2;130;130;130m\ue615${RST}`,   // make gray
	"gnumakefile":       `\x1b[38;2;130;130;130m\ue615${RST}`,
	"readme.md":         `\x1b[38;2;66;165;245m\ue73e${RST}`,   // readme blue
	"license":           `\x1b[38;2;218;218;218m\ue60a${RST}`,  // license white
	"cargo.toml":        `\x1b[38;2;222;165;132m\ue7a8${RST}`,  // rust
	"go.mod":            `\x1b[38;2;0;173;216m\ue724${RST}`,    // go
	"pyproject.toml":    `\x1b[38;2;55;118;171m\ue73c${RST}`,   // python
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

async function hlBlock(
	code: string,
	language: BundledLanguage | undefined,
): Promise<string[]> {
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
			display = code.slice(0, j) + RST + FG_DIM + "›" + RST;
		}
		out.push(`${lnum(ln, nw)} ${FG_RULE}│${RST} ${display}${RST}`);
	}

	out.push(rule(tw));
	if (total > maxLines) {
		out.push(
			`${FG_DIM}  … ${total - maxLines} more lines (${total} total)${RST}`,
		);
	}
	return out.join("\n");
}

/** Render bash output with colored exit code and stderr highlighting. */
function renderBashOutput(
	text: string,
	exitCode: number | null,
): { summary: string; body: string } {
	const isOk = exitCode === 0;
	const statusFg = isOk ? FG_GREEN : FG_RED;
	const statusIcon = isOk ? "✓" : "✗";
	const codeStr =
		exitCode !== null
			? `${statusFg}${statusIcon} exit ${exitCode}${RST}`
			: `${FG_YELLOW}⚡ killed${RST}`;

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
		out.push(
			`${FG_RULE}└── ${RST}${FG_DIM}… ${total - MAX_PREVIEW_LINES} more entries${RST}`,
		);
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
				out.push(
					`  ${FG_DIM}… ${lines.length - count} more files${RST}`,
				);
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
async function renderGrepResults(
	text: string,
	pattern: string,
): Promise<string> {
	const lines = text.split("\n");
	if (!lines.length || (lines.length === 1 && !lines[0].trim()))
		return `${FG_DIM}(no matches)${RST}`;

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
		const fileMatch = line.match(/^(.+?)[:\-](\d+)[:\-](.*)$/);
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
				display = content.replace(
					re,
					`${RST}${FG_YELLOW}${BOLD}$1${RST}`,
				);
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
// Extension entry point
// ---------------------------------------------------------------------------

export default function piPrettyExtension(pi: any): void {
	let createReadTool: any;
	let createBashTool: any;
	let createLsTool: any;
	let createFindTool: any;
	let createGrepTool: any;
	let TextComponent: any;

	try {
		const sdk = require("@mariozechner/pi-coding-agent");
		createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
		createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
		createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
		createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
		createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;
		TextComponent = require("@mariozechner/pi-tui").Text;
	} catch {
		return;
	}
	if (!createReadTool || !TextComponent) return;

	const cwd = process.cwd();
	const home = process.env.HOME ?? "";
	const sp = (p: string) => shortPath(cwd, home, p);

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
			const fp = args?.path ?? "";
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
			const offset = args?.offset ? ` ${theme.fg("muted", `from line ${args.offset}`)}` : "";
			const limit = args?.limit ? ` ${theme.fg("muted", `(${args.limit} lines)`)}` : "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", sp(fp))}${offset}${limit}`,
			);
			return text;
		},

		renderResult(result: any, _opt: any, theme: any, ctx: any) {
			const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

			if (ctx.isError) {
				const e = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join("\n") ?? "Error";
				text.setText(`\n${theme.fg("error", e)}`);
				return text;
			}

			const d = result.details;

			// Image rendering
			if (d?._type === "readImage") {
				const tw = termW();
				const out: string[] = [];
				const fname = basename(d.filePath);
				const byteSize = Math.ceil((d.data as string).length * 3 / 4);
				const sizeStr = humanSize(byteSize);
				const mimeStr = d.mimeType ?? "image";

				out.push(`  ${fileIcon(d.filePath)}${FG_DIM}${mimeStr} · ${sizeStr}${RST}`);
				out.push(rule(tw));

				const protocol = detectImageProtocol();
				if (protocol === "kitty") {
					const imgCols = Math.min(tw - 4, 80);
					out.push(renderKittyImage(d.data, { cols: imgCols }));
				} else if (protocol === "iterm2") {
					const imgWidth = Math.min(tw - 4, 80);
					out.push(renderIterm2Image(d.data, {
						width: `${imgWidth}`,
						name: fname,
					}));
				} else {
					out.push(`  ${FG_DIM}(Inline image preview requires Ghostty, iTerm2, WezTerm, or Kitty)${RST}`);
				}

				out.push(rule(tw));
				text.setText(out.join("\n"));
				return text;
			}

			if (d?._type === "readFile" && d.content) {
				const key = `read:${d.filePath}:${d.offset}:${d.lineCount}:${termW()}`;
				if (ctx.state._rk !== key) {
					ctx.state._rk = key;
					const info = `${FG_DIM}${d.lineCount} lines${RST}`;
					ctx.state._rt = `  ${info}`;

					const maxShow = ctx.expanded ? d.lineCount : MAX_PREVIEW_LINES;
					renderFileContent(d.content, d.filePath, d.offset, maxShow)
						.then((rendered: string) => {
							if (ctx.state._rk !== key) return;
							ctx.state._rt = `  ${info}\n${rendered}`;
							ctx.invalidate();
						})
						.catch(() => {});
				}
				text.setText(ctx.state._rt ?? `  ${FG_DIM}${d.lineCount} lines${RST}`);
				return text;
			}

			// Fallback
			const fallback = result.content?.[0]?.text ?? "read";
			text.setText(`  ${theme.fg("dim", String(fallback).slice(0, 120))}`);
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
					const exitMatch = textContent.match(
						/(?:exit code|exited with|exit status)[:\s]*(\d+)/i,
					);
					if (exitMatch) exitCode = Number(exitMatch[1]);
					// Check for common error indicators
					if (
						textContent.includes("command not found") ||
						textContent.includes("No such file")
					) {
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
				const cmd = args?.command ?? "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				const timeout = args?.timeout
					? ` ${theme.fg("muted", `(${args.timeout}s timeout)`)}`
					: "";
				text.setText(
					`${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", cmd.length > 80 ? cmd.slice(0, 77) + "…" : cmd)}${timeout}`,
				);
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e = result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
					text.setText(`\n${theme.fg("error", e)}`);
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
						text.setText(out.join("\n"));
					} else {
						text.setText(header);
					}
					return text;
				}

				const fallback = result.content?.[0]?.text ?? "done";
				text.setText(
					`  ${theme.fg("dim", String(fallback).slice(0, 120))}`,
				);
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
				const entryCount = textContent
					? textContent.trim().split("\n").filter(Boolean).length
					: 0;

				(result as any).details = {
					_type: "lsResult",
					text: textContent ?? "",
					path: fp,
					entryCount,
				};

				return result;
			},

			renderCall(args: any, theme: any, ctx: any) {
				const fp = args?.path ?? ".";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(
					`${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", sp(fp))}`,
				);
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e = result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
					text.setText(`\n${theme.fg("error", e)}`);
					return text;
				}

				const d = result.details;
				if (d?._type === "lsResult" && d.text) {
					const tree = renderTree(d.text, d.path);
					const info = `${FG_DIM}${d.entryCount} entries${RST}`;
					text.setText(`  ${info}\n${tree}`);
					return text;
				}

				const fallback = result.content?.[0]?.text ?? "listed";
				text.setText(
					`  ${theme.fg("dim", String(fallback).slice(0, 120))}`,
				);
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
				const result = await origFind.execute(tid, params, sig, upd, ctx);

				const textContent = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join("\n");

				const matchCount = textContent
					? textContent.trim().split("\n").filter(Boolean).length
					: 0;

				(result as any).details = {
					_type: "findResult",
					text: textContent ?? "",
					pattern: params.pattern ?? "",
					matchCount,
				};

				return result;
			},

			renderCall(args: any, theme: any, ctx: any) {
				const pattern = args?.pattern ?? "";
				const path = args?.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(
					`${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", pattern)}${path}`,
				);
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e = result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
					text.setText(`\n${theme.fg("error", e)}`);
					return text;
				}

				const d = result.details;
				if (d?._type === "findResult" && d.text) {
					const rendered = renderFindResults(d.text);
					const info = `${FG_DIM}${d.matchCount} files${RST}`;
					text.setText(`  ${info}\n${rendered}`);
					return text;
				}

				const fallback = result.content?.[0]?.text ?? "found";
				text.setText(
					`  ${theme.fg("dim", String(fallback).slice(0, 120))}`,
				);
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
				const result = await origGrep.execute(tid, params, sig, upd, ctx);

				const textContent = result.content
					?.filter((c: any) => c.type === "text")
					.map((c: any) => c.text || "")
					.join("\n");

				const matchCount = textContent
					? textContent
							.trim()
							.split("\n")
							.filter((l: string) => l.match(/^.+?[:\-]\d+[:\-]/))
							.length
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
				const pattern = args?.pattern ?? "";
				const path = args?.path ? ` ${theme.fg("muted", `in ${sp(args.path)}`)}` : "";
				const glob = args?.glob ? ` ${theme.fg("muted", `(${args.glob})`)}` : "";
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
				text.setText(
					`${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", pattern)}${path}${glob}`,
				);
				return text;
			},

			renderResult(result: any, _opt: any, theme: any, ctx: any) {
				const text = ctx.lastComponent ?? new TextComponent("", 0, 0);

				if (ctx.isError) {
					const e = result.content
						?.filter((c: any) => c.type === "text")
						.map((c: any) => c.text || "")
						.join("\n") ?? "Error";
					text.setText(`\n${theme.fg("error", e)}`);
					return text;
				}

				const d = result.details;
				if (d?._type === "grepResult" && d.text) {
					const key = `grep:${d.pattern}:${d.matchCount}:${termW()}`;
					if (ctx.state._gk !== key) {
						ctx.state._gk = key;
						const info = `${FG_DIM}${d.matchCount} matches${RST}`;
						ctx.state._gt = `  ${info}`;

						renderGrepResults(d.text, d.pattern)
							.then((rendered: string) => {
								if (ctx.state._gk !== key) return;
								ctx.state._gt = `  ${info}\n${rendered}`;
								ctx.invalidate();
							})
							.catch(() => {});
					}
					text.setText(ctx.state._gt ?? `  ${FG_DIM}${d.matchCount} matches${RST}`);
					return text;
				}

				const fallback = result.content?.[0]?.text ?? "searched";
				text.setText(
					`  ${theme.fg("dim", String(fallback).slice(0, 120))}`,
				);
				return text;
			},
		});
	}
}
