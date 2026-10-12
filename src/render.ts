/**
 * pi-pretty: rendering functions for all tools.
 *
 * These produce ANSI-colored terminal output strings.
 * They are async only when Shiki syntax highlighting is involved.
 */

import { basename, dirname } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
// Top-level value import so jiti's pi-tui alias applies (it only rewrites
// static top-level import/require, not function-body require — see tui-text.ts).
import { Text as TuiText, truncateToWidth } from "@earendil-works/pi-tui";
import { codeToANSI } from "@shikijs/cli";
import { type BundledLanguage, type BundledTheme, bundledThemes } from "shiki";
import {
	BG_BASE,
	BG_ERROR,
	CACHE_LIMIT,
	detectLang,
	dirIcon,
	FG_BLUE,
	FG_DIM,
	FG_LNUM,
	FG_RULE,
	FG_YELLOW,
	fileIcon,
	loadConfig,
	MAX_HL_CHARS,
	MAX_PREVIEW_LINES,
	RST,
	resolveBaseBackground,
	TOOL_RESULT_INDENT,
	termWidth,
} from "./config.js";
import {
	CHARS_KEY,
	compactErrorLines,
	ELAPSED_KEY,
	formatCharCount,
	formatElapsedMs,
	normalizeLineEndings,
} from "./helpers.js";
import type { RenderCtxLike as RenderContext, TextLike, ThemeLike } from "./types.js";

// ---------------------------------------------------------------------------
// Shiki ANSI cache
// ---------------------------------------------------------------------------

const DEFAULT_THEME: BundledTheme = "github-dark";

function isBundledTheme(name: string): name is BundledTheme {
	return Object.hasOwn(bundledThemes, name);
}

function pickValidTheme(candidate: string, source: string): BundledTheme {
	if (isBundledTheme(candidate)) return candidate;
	console.warn(
		`pi-pretty: theme "${candidate}" from ${source} is not a bundled Shiki theme; falling back to "${DEFAULT_THEME}"`,
	);
	return DEFAULT_THEME;
}

/**
 * Resolve the Shiki theme used for syntax highlighting.
 *
 * `~/.pi/agent/settings.json`'s `theme` field is pi's TUI appearance setting
 * (e.g. `dark`, `light`, or a custom pi theme name), which is not a valid
 * Shiki theme for native users. Validate the candidate against Shiki's
 * bundled themes; warn once and fall back to {@link DEFAULT_THEME} when it is
 * not a bundled theme, instead of silently degrading every highlighted block
 * to plain text.
 */
export function resolveTheme(env = process.env.PRETTY_THEME, home = process.env.HOME): BundledTheme {
	if (env) return pickValidTheme(env, "PRETTY_THEME");
	try {
		if (!home) return DEFAULT_THEME;
		const settings = JSON.parse(
			require("node:fs").readFileSync(require("node:path").join(home, ".pi/agent/settings.json"), "utf8"),
		);
		const candidate = settings.theme;
		if (typeof candidate === "string") return pickValidTheme(candidate, "~/.pi/agent/settings.json");
		return DEFAULT_THEME;
	} catch {
		return DEFAULT_THEME;
	}
}

let _theme: BundledTheme | undefined;

/**
 * Resolve the effective theme once per session: `PRETTY_THEME` env →
 * `pi-pretty.json` → `~/.pi/agent/settings.json` → {@link DEFAULT_THEME}.
 * Resolution is lazy so config-file values applied at extension activation
 * take effect, and the result is cached (at most one warning per source).
 */
export function getTheme(): BundledTheme {
	if (_theme) return _theme;
	const env = process.env.PRETTY_THEME;
	let theme: BundledTheme;
	if (env) {
		theme = resolveTheme(env, "");
	} else {
		const configTheme = loadConfig().theme;
		theme =
			typeof configTheme === "string"
				? pickValidTheme(configTheme, "pi-pretty.json")
				: resolveTheme(undefined, process.env.HOME);
	}
	_theme = theme;
	return theme;
}

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

	const k = `${getTheme()}\0${language}\0${code}`;
	const hit = _cache.get(k);
	if (hit) return _touch(k, hit);

	try {
		const ansi = normalizeShikiContrast(await codeToANSI(code, language, getTheme()));
		const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return _touch(k, out);
	} catch {
		return code.split("\n");
	}
}

const ESC_RE = "\u001b";
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");
const FG_MUTED = "\x1b[38;2;139;148;158m";

export function isLowContrastShikiFg(params: string): boolean {
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
// Box background helpers
// ---------------------------------------------------------------------------

export const RESET_WITHOUT_BG = "\x1b[22;23;24;25;27;28;29;39m";

export function preserveBoxBackground(ansi: string): string {
	return ansi.replace(ANSI_CAPTURE_RE, (_seq, params: string) => {
		if (!params || params === "0") return RESET_WITHOUT_BG;
		const parts = params.split(";").filter(Boolean);
		const kept: string[] = [];
		let i = 0;
		while (i < parts.length) {
			const code = Number(parts[i]);
			if (code === 38) {
				// Foreground extended — keep entire sequence
				kept.push(parts[i]);
				if (parts[i + 1] === "5") {
					kept.push(parts[i + 1]);
					i += 2;
				} else if (parts[i + 1] === "2") {
					kept.push(parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
					i += 5;
				} else {
					i++;
				}
			} else if (code === 48) {
				// Background extended — skip entirely
				if (parts[i + 1] === "5") i += 3;
				else if (parts[i + 1] === "2") i += 6;
				else i++;
			} else if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				i++;
			} else {
				kept.push(parts[i]);
				i++;
			}
		}
		return kept.length ? `\x1b[${kept.join(";")}m` : "";
	});
}

/** Left indent for self-rendered rows: host `ctx.outputPad` spaces, falling back to 1 on older/invalid hosts. */
export function toolIndent(ctx?: Pick<RenderContext, "outputPad">): string {
	const pad = ctx?.outputPad;
	// Reject unusable values, including pads wider than the terminal (avoids giant allocations).
	return typeof pad === "number" && Number.isInteger(pad) && pad >= 0 && pad <= termWidth()
		? " ".repeat(pad)
		: TOOL_RESULT_INDENT;
}

export function fillToolBackground(text: string, bg = BG_BASE, width?: number, indent = TOOL_RESULT_INDENT): string {
	return text
		.split("\n")
		.map((line) => {
			if (!width) {
				const stripped = preserveBoxBackground(line);
				return bg ? bg + stripped : stripped;
			}
			const plainLead = line.replace(ANSI_CAPTURE_RE, "");
			// Indented rows keep their natural width; with no indent every row is padded.
			const skipPad = indent !== "" && (line.startsWith(indent) || plainLead.startsWith(indent));
			const fitted = truncateToWidth(line, width, "", !skipPad);
			const stripped = preserveBoxBackground(fitted);
			return bg ? bg + stripped : stripped;
		})
		.join("\n");
}

/** Add exactly the missing terminal row after a rendered tool body. */
export function fillToolBody(text: string, bg = BG_BASE, width?: number, indent = TOOL_RESULT_INDENT): string {
	return fillToolBackground(text.endsWith("\n") ? text : `${text}\n`, bg, width, indent);
}

const TOOL_TITLE_STATE_KEY = "__piPrettyToolTitle";
type ToolTitleRenderer = (suffix?: string) => string;
type ToolTitleState = { component: TextLike; render: ToolTitleRenderer };

/** Keep a self-rendered tool's call title mutable while its result arrives. */
export function rememberToolTitle(ctx: RenderContext, component: TextLike, render: ToolTitleRenderer): void {
	ctx.state[TOOL_TITLE_STATE_KEY] = { component, render } satisfies ToolTitleState;
}

/** Move collapsed result metadata into the call title and hide the result slot. */
export function setCollapsedToolTitle(ctx: RenderContext, result: TextLike, suffix: string): boolean {
	if (ctx.expanded) return false;
	const title = ctx.state[TOOL_TITLE_STATE_KEY] as ToolTitleState | undefined;
	if (!title || typeof title.render !== "function") return false;
	title.component.setText(title.render(suffix));
	result.setText("");
	return true;
}

function lnum(n: number, w: number): string {
	const v = String(n);
	return `${FG_LNUM}${" ".repeat(Math.max(0, w - v.length))}${v}${RST}`;
}

// ---------------------------------------------------------------------------
// Tool metrics line
// ---------------------------------------------------------------------------

/** Prefer the host's final duration (0 is valid); fall back to wrapper-recorded metadata. */
function resolveDurationMs(
	result: AgentToolResult<Record<string, unknown>>,
	ctx?: Pick<RenderContext, "durationMs">,
): number | undefined {
	const host = ctx?.durationMs;
	if (typeof host === "number" && Number.isFinite(host) && host >= 0) return host;
	const details = result.details as Record<string, unknown> | undefined;
	return details?.[ELAPSED_KEY] as number | undefined;
}

export function renderToolMetrics(
	result: AgentToolResult<Record<string, unknown>>,
	ctx?: Pick<RenderContext, "durationMs">,
): string {
	const details = result.details as Record<string, unknown> | undefined;
	const elapsed = formatElapsedMs(resolveDurationMs(result, ctx));
	const chars = formatCharCount(details?.[CHARS_KEY] as number | undefined);
	if (!elapsed && !chars) return "";
	return `${FG_DIM}· ${[elapsed, chars].filter(Boolean).join(" · ")}${RST}`;
}

export function renderToolDuration(
	result: AgentToolResult<Record<string, unknown>>,
	ctx?: Pick<RenderContext, "durationMs">,
): string {
	return formatElapsedMs(resolveDurationMs(result, ctx));
}

// ---------------------------------------------------------------------------
// Error renderer
// ---------------------------------------------------------------------------

export function renderToolError(error: string, theme: ThemeLike, indent = TOOL_RESULT_INDENT): string {
	const body = compactErrorLines(error)
		.map((line) => `${indent}${line ? theme.fg("error", line) : ""}`)
		.join("\n");
	return fillToolBody(body, BG_ERROR, undefined, indent);
}

// ---------------------------------------------------------------------------
// Read — syntax-highlighted file content
// ---------------------------------------------------------------------------

export async function renderFileContent(
	content: string,
	filePath: string,
	offset = 0,
	maxLines = MAX_PREVIEW_LINES,
	width?: number,
): Promise<string> {
	const normalizedContent = normalizeLineEndings(content);
	const lines = normalizedContent.split("\n");
	const show = lines.slice(0, maxLines);
	const lg = detectLang(filePath);
	const hl = await hlBlock(show.join("\n"), lg);

	const tw = width ?? termWidth();

	const out: string[] = [];
	for (const line of hl) {
		out.push(truncateToWidth(line ?? "", Math.max(1, tw), `${FG_DIM}›`));
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Bash — colored exit status
// ---------------------------------------------------------------------------

export function renderBashOutput(text: string, indent = TOOL_RESULT_INDENT): string {
	const lines = text.split("\n");
	const maxShow = MAX_PREVIEW_LINES;
	const show = lines.slice(0, maxShow);
	const remaining = lines.length - maxShow;

	let body = show.join("\n");
	if (remaining > 0) body += `\n${indent}${FG_DIM}… ${remaining} more lines${RST}`;

	return body;
}

// ---------------------------------------------------------------------------
// Ls — tree view with icons
// ---------------------------------------------------------------------------

export function renderTree(text: string, _basePath: string): string {
	const lines = text.trim().split("\n").filter(Boolean).map((line) => line.trim());
	if (!lines.length) return `${FG_DIM}(empty directory)${RST}`;

	// Match the SDK's notice formats precisely; bracketed filenames remain entries.
	const noticePattern = /^\[(?:\d+ entries limit reached\. Use limit=\d+ for more|\d+(?:\.\d+)?(?:B|KB|MB|GB) limit reached)(?:\. (?:\d+ entries limit reached\. Use limit=\d+ for more|\d+(?:\.\d+)?(?:B|KB|MB|GB) limit reached))*\]$/;
	const entries = lines.filter((line) => !noticePattern.test(line));
	const notices = lines.filter((line) => noticePattern.test(line));
	if (!entries.length) return notices.map((notice) => `${FG_DIM}${notice}${RST}`).join("\n");

	const out: string[] = [];
	const total = entries.length;
	const show = entries.slice(0, MAX_PREVIEW_LINES);

	for (let i = 0; i < show.length; i++) {
		const entry = show[i];
		const isLast = i === show.length - 1 && total <= MAX_PREVIEW_LINES;
		const prefix = isLast ? "└── " : "├── ";
		const connector = `${FG_RULE}${prefix}${RST}`;
		const isDir = entry.endsWith("/");
		const name = isDir ? entry.slice(0, -1) : entry;
		const icon = isDir ? dirIcon() : fileIcon(name);
		out.push(`${connector}${icon}${isDir ? `${FG_BLUE}\x1b[1m${name}${RST}` : name}`);
	}

	if (total > MAX_PREVIEW_LINES) {
		out.push(`${FG_RULE}└── ${RST}${FG_DIM}… ${total - MAX_PREVIEW_LINES} more entries${RST}`);
	}
	for (const notice of notices) out.push(`${FG_DIM}${notice}${RST}`);

	return out.join("\n");
}
// ---------------------------------------------------------------------------
// Find — grouped file list (plain, no tree characters or icons)
// ---------------------------------------------------------------------------

/** File rows keep the structural one-space indent; the tool applies host outer padding. */
export function renderFindResults(text: string, theme?: ThemeLike): string {
	const lines = text.trim().split("\n").filter(Boolean);
	if (!lines.length) return theme ? theme.fg("dim", "(no matches)") : `${FG_DIM}(no matches)${RST}`;

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
		if (count > 0) out.push("");
		const dirColored = theme ? theme.fg("accent", theme.bold(`${dir}/`)) : `${FG_BLUE}\x1b[1m${dir}/${RST}`;
		out.push(dirColored);
		for (let i = 0; i < files.length; i++) {
			if (count >= MAX_PREVIEW_LINES) {
				const more = theme
					? theme.fg("dim", `… ${lines.length - count} more files`)
					: `${FG_DIM}… ${lines.length - count} more files${RST}`;
				out.push(`${TOOL_RESULT_INDENT}${more}`);
				return out.join("\n");
			}
			out.push(`${TOOL_RESULT_INDENT}${files[i]}`);
			count++;
		}
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Grep — highlighted matches with line numbers
// ---------------------------------------------------------------------------

export async function renderGrepResults(text: string, pattern: string, indent = TOOL_RESULT_INDENT): Promise<string> {
	const lines = normalizeLineEndings(text).split("\n");
	if (!lines.length || (lines.length === 1 && !lines[0].trim())) return `${FG_DIM}(no matches)${RST}`;

	const out: string[] = [];
	let currentFile = "";
	let count = 0;

	let re: RegExp | null = null;
	try {
		re = new RegExp(`(${pattern})`, "gi");
	} catch {
		/* skip highlighting */
	}

	for (const line of lines) {
		if (count >= MAX_PREVIEW_LINES) {
			out.push(`${FG_DIM}  … more matches${RST}`);
			break;
		}
		const fileMatch = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
		if (fileMatch) {
			const [, file, lineNo, content] = fileMatch;
			if (file !== currentFile) {
				if (currentFile) out.push("");
				out.push(`${FG_BLUE}\x1b[1m${file}${RST}`);
				currentFile = file;
			}
			const nw = Math.max(3, lineNo.length);
			let display = content;
			if (re) display = content.replace(re, `${RST}${FG_YELLOW}\x1b[1m$1${RST}`);
			out.push(`${indent}${lnum(Number(lineNo), nw)} ${FG_RULE}│${RST} ${display}${RST}`);
			count++;
		} else if (line.trim() === "--") {
			out.push(`${indent}${FG_DIM}  ···${RST}`);
		} else if (line.trim()) {
			out.push(line);
			count++;
		}
	}

	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Generic renderCall / renderResult for custom tools
// ---------------------------------------------------------------------------

export function makeRenderCall(toolName: string) {
	return (args: Record<string, unknown>, theme: ThemeLike, ctx: RenderContext) => {
		resolveBaseBackground(theme);
		const text = ctx.lastComponent ?? new TuiText("", 0, 0);
		const bg = ctx.isError ? BG_ERROR : undefined;
		text.setText(fillToolBackground(`${theme.fg("toolTitle", theme.bold(toolName))}`, bg, undefined, toolIndent(ctx)));
		return text;
	};
}

export function makeRenderResult() {
	return (result: AgentToolResult<Record<string, unknown>>, _opt: unknown, theme: ThemeLike, ctx: RenderContext) => {
		resolveBaseBackground(theme);
		const text = ctx.lastComponent ?? new TuiText("", 0, 0);
		if (ctx.isError) {
			text.setText(renderToolError(getTextContent(result) || "Error", theme, toolIndent(ctx)));
			return text;
		}
		const content = getTextContent(result);
		if (content) {
			const renderWidth = termWidth();
			const indent = toolIndent(ctx);
			const lines = content.split("\n");
			const maxShow = ctx.expanded ? lines.length : Math.min(lines.length, MAX_PREVIEW_LINES);
			const preview = lines.slice(0, maxShow).join("\n");
			const more = lines.length > maxShow ? `\n${FG_DIM}... ${lines.length - maxShow} more lines${RST}` : "";
			const metrics = renderToolMetrics(result, ctx);
			text.setText(
				fillToolBody(
					`${indent}${preview}${more}${metrics ? `\n${indent}${metrics}` : ""}`,
					undefined,
					renderWidth,
					indent,
				),
			);
		} else {
			text.setText(
				fillToolBody(`${toolIndent(ctx)}${theme.fg("dim", "(no text output)")}`, undefined, undefined, toolIndent(ctx)),
			);
		}
		return text;
	};
}

function getTextContent(result: AgentToolResult<Record<string, unknown>>): string {
	return (result.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text ?? "")
		.join("\n");
}
