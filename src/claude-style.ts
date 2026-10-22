/**
 * pi-pretty: opt-in "claudecode" tool style (config `toolStyle: "claudecode"`).
 *
 *   ✓ Read (src/a.ts)           collapsed call row: status icon (spinner while running), bold name
 *     └ 42 lines · ◷ 0.02s      collapsed result row hanging from a connector
 *   ✓ Done (3 tool calls)       consecutive tool calls fold into one group row
 *     ├─ • Bash(ls)
 *     └─ • Read(a.ts)
 *
 * Collapsed rows replace the pretty output; Ctrl+O (expanded) keeps pi-pretty's
 * full rendering. Grouping is a pure render-time projection of the chat children.
 * Modeled on the look of sting8k/pi-droid-styling's `claudecode` preset.
 */

import { highlightCode, keyText } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ELAPSED_KEY, shortPath } from "./helpers.js";
import type { RenderCtxLike, ThemeLike } from "./types.js";

type AnyFn = (...args: any[]) => any;
type AnyComponent = { render(width: number): string[]; invalidate?(): void; [key: string]: any };

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
// Kitty (`ESC _G`) and iTerm2 (`ESC ]1337;File=`) inline-image payload lines.
const IMAGE_LINE_RE = new RegExp(`${String.fromCharCode(27)}(?:_G|\\]1337;File=)`);
const isImageLine = (line: string): boolean => IMAGE_LINE_RE.test(line);
// Leading padding after any SGR prefix (thought rows start with `ESC[3m ` etc.).
const LEADING_SPACE_RE = new RegExp(`^((?:${String.fromCharCode(27)}\\[[0-9;]*m)*) +`);
const stripAnsi = (text: string): string => text.replace(ANSI_RE, "");

const PLAIN_THEME: ThemeLike = { fg: (_color, text) => text, bold: (text) => text };

// Theme for group rows, which are built outside any tool's render context.
let groupTheme: ThemeLike = PLAIN_THEME;
/** Bumped on every theme swap so cached group rows (baked ANSI) are discarded. */
let themeGeneration = 0;

export function setClaudeStyleTheme(theme: unknown): void {
	groupTheme = theme as ThemeLike;
	themeGeneration++;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
/** Time-based so every host redraw (the working indicator already ticks while streaming) advances it. */
const spinnerFrame = (): string => SPINNER_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];

const ICON_SUCCESS = "✓";
const ICON_ERROR = "✗";
const ICON_PENDING = "·";
/** A call whose result will never arrive, so it is neither running, pending nor done. */
const ICON_INTERRUPTED = "⊘";

type ToolState = "pending" | "running" | "success" | "error";

function stateIcon(theme: ThemeLike, state: ToolState): string {
	switch (state) {
		case "pending":
			return theme.fg("dim", ICON_PENDING);
		case "running":
			return theme.fg("accent", spinnerFrame());
		case "error":
			return theme.fg("error", ICON_ERROR);
		default:
			return theme.fg("success", ICON_SUCCESS);
	}
}

/** Dim ` (ctrl+o to expand)` / ` (ctrl+o to collapse)` using the user's binding; empty when unbound. */
function toggleHint(theme: ThemeLike, verb: "expand" | "collapse"): string {
	const key = keyText("app.tools.expand");
	return key ? ` ${theme.fg("dim", `(${key} to ${verb})`)}` : "";
}

const ESC = String.fromCharCode(27);
/** Indent and SGR prefix a collapsed row starts with, followed by its state icon (the icon carries
 * its own color, so spaces and escapes interleave in any order). */
const ROW_PREFIX = `(?:[ \\t]|${ESC}\\[[0-9;]*m)*`;
const STEP_ICONS = [ICON_SUCCESS, ICON_ERROR, ICON_PENDING, ICON_INTERRUPTED, ...SPINNER_FRAMES].join("");
const ROW_ICON_RE = new RegExp(`^(${ROW_PREFIX})(?:[${STEP_ICONS}])`);

/** Swap a row's state icon for the interrupted glyph — the row itself cannot know it was restored. */
function markInterruptedRow(line: string): string {
	return line.replace(ROW_ICON_RE, `$1${fg("error", ICON_INTERRUPTED)}`);
}

function indentOf(ctx: RenderCtxLike): string {
	const pad = ctx.outputPad;
	return " ".repeat(typeof pad === "number" && pad >= 0 ? Math.floor(pad) : 1);
}

function oneLine(text: string): string {
	return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

function callDetail(toolName: string, args: Record<string, unknown>): string {
	const home = process.env.HOME ?? "";
	const cwd = process.cwd();
	const path = (value: string): string => shortPath(cwd, home, value);
	switch (toolName) {
		case "read": {
			const offset = typeof args.offset === "number" ? `:${args.offset}` : "";
			return `${path(firstString(args, ["path", "file_path"]))}${offset}`;
		}
		case "bash":
			return oneLine(firstString(args, ["command"]));
		case "grep": {
			const where = firstString(args, ["path", "glob"]);
			return [firstString(args, ["pattern"]), where ? path(where) : ""].filter(Boolean).join(", ");
		}
		case "find": {
			const where = firstString(args, ["path"]);
			return [firstString(args, ["pattern"]), where ? path(where) : ""].filter(Boolean).join(", ");
		}
		case "ls":
			return path(firstString(args, ["path"]) || ".");
		case "write":
		case "edit":
			return path(firstString(args, ["path", "file_path"]));
		case "codemode":
			return oneLine(firstScriptLine(firstString(args, ["code"])));
		case "recall": {
			const query = firstString(args, ["query"]);
			const expand = Array.isArray(args.expand) ? args.expand.map((index) => `#${index}`).join(" ") : "";
			const page = typeof args.page === "number" && args.page > 1 ? `page ${args.page}` : "";
			return [
				expand ? `expand ${expand}` : query ? `"${oneLine(query)}"` : "browse",
				args.scope === "all" ? "all sessions" : "",
				page,
			]
				.filter(Boolean)
				.join(", ");
		}
		case "apply_patch": {
			const paths = (Array.isArray(args.changes) ? args.changes : [])
				.map((change: { path?: unknown }) => (typeof change?.path === "string" ? path(change.path) : ""))
				.filter(Boolean);
			return paths.length > 1 ? `${paths[0]}, +${paths.length - 1} more` : (paths[0] ?? "");
		}
		default: {
			const first = Object.values(args).find((value) => typeof value === "string" && value) as string | undefined;
			return first ? oneLine(first) : "";
		}
	}
}

/** First line of a codemode script that is not its `// @options:` line. */
function firstScriptLine(code: string): string {
	return code.split("\n").find((line) => line.trim() !== "" && !/^\s*\/\/\s*@options:/.test(line)) ?? "";
}

/** The header lines codemode prepends to its output, which say nothing about what happened. */
const CODEMODE_HEADER_LINE = /^(Script (completed|failed)|Wall time [\d.]+ seconds|Output:|Script error:)$/;

function resultText(result: any): string {
	return ((result?.content ?? []) as Array<{ type?: string; text?: string }>)
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function countLines(text: string, skip?: RegExp): number {
	return text.split("\n").filter((line) => line.trim() !== "" && !(skip && skip.test(line.trim()))).length;
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** `2 files`, or `empty` when there is nothing to count. */
function countOrEmpty(count: number, empty: string, noun: string, pluralNoun?: string): string {
	return count === 0 ? empty : plural(count, noun, pluralNoun);
}

/** `+3 -1` with additions in the success color and removals in the error color. */
function diffCounts(added: number, removed: number, theme: ThemeLike): string {
	return [theme.fg("success", `+${added}`), theme.fg("error", `-${removed}`)].join(" ");
}

function countPatchLines(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

/** pi-diff's apply_patch: per-file `diff` hunks (updates), full content (adds) or old content (deletes). */
function summarizeApplyPatch(result: any, theme: ThemeLike): string {
	const applied: Array<Record<string, any>> = Array.isArray(result?.details?.result?.applied)
		? result.details.result.applied
		: [];
	if (applied.length === 0) return theme.fg("muted", "applied");
	let added = 0;
	let removed = 0;
	for (const change of applied) {
		if (typeof change.diff === "string") {
			const counts = countPatchLines(change.diff);
			added += counts.added;
			removed += counts.removed;
		} else if (change.action === "add" && typeof change.newContent === "string") {
			added += countLines(change.newContent);
		} else if (change.action === "delete" && typeof change.oldContent === "string") {
			removed += countLines(change.oldContent);
		}
	}
	return [diffCounts(added, removed, theme), theme.fg("muted", plural(applied.length, "file"))].join(
		theme.fg("dim", " · "),
	);
}

/** Written by pi-diff (`diff`/`new`/`noChange`, `editInfo`) or Pi's builtin edit (`patch`). */
function summarizeFileChange(toolName: string, result: any, theme: ThemeLike): string {
	const details = (result?.details ?? {}) as Record<string, any>;
	const note = (text: string): string => theme.fg("muted", text);
	if (details._type === "noChange") return note("no changes");
	if (details._type === "new")
		return [note("new file"), diffCounts(Number(details.lines) || 0, 0, theme)].join(theme.fg("dim", " · "));
	let counts: { added: number; removed: number } | undefined;
	if (typeof details.linesAdded === "number" && typeof details.linesRemoved === "number") {
		counts = { added: details.linesAdded, removed: details.linesRemoved };
	} else if (typeof details.diff?.added === "number" && typeof details.diff?.removed === "number") {
		counts = { added: details.diff.added, removed: details.diff.removed };
	} else if (typeof details.patch === "string") {
		counts = countPatchLines(details.patch);
	}
	if (!counts) return note(toolName === "write" ? "written" : "edited");
	const parts = [diffCounts(counts.added, counts.removed, theme)];
	if (typeof details.editCount === "number" && details.editCount > 1)
		parts.push(note(plural(details.editCount, "edit")));
	return parts.join(theme.fg("dim", " · "));
}

/** `3 tool calls · 1 failed · 12 lines · $0.0042` for a codemode script. */
function summarizeCodemode(result: any, theme: ThemeLike): string {
	const calls: Array<{ status?: string; cost?: number }> = Array.isArray(result?.details?.calls)
		? result.details.calls
		: [];
	const failed = calls.filter((call) => call.status === "error").length;
	const cost = calls.reduce((sum, call) => sum + (call.cost ?? 0), 0);
	const outputLines = countLines(
		resultText(result)
			.split("\n")
			.filter((line) => !CODEMODE_HEADER_LINE.test(line))
			.join("\n"),
	);
	const parts = [theme.fg("muted", calls.length === 0 ? "no tool calls" : plural(calls.length, "tool call"))];
	if (failed > 0) parts.push(theme.fg("error", `${failed} failed`));
	if (outputLines > 0) parts.push(theme.fg("muted", plural(outputLines, "line")));
	if (cost > 0) parts.push(theme.fg("dim", `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`));
	return parts.join(theme.fg("dim", " · "));
}

/** pikit's recall: `{ total, entries }` in details; `args.expand` fetches full entries instead of searching. */
function summarizeRecall(result: any, args: Record<string, unknown> | undefined, theme: ThemeLike): string {
	const entries: unknown[] = Array.isArray(result?.details?.entries) ? result.details.entries : [];
	if (Array.isArray(args?.expand)) return theme.fg("muted", `${plural(entries.length, "entry", "entries")} expanded`);
	const total = typeof result?.details?.total === "number" ? result.details.total : entries.length;
	return theme.fg("muted", total === 0 ? "no results" : plural(total, "result"));
}

function summarize(toolName: string, result: any, theme: ThemeLike, args?: Record<string, unknown>): string {
	if (toolName === "recall") return summarizeRecall(result, args, theme);
	if (toolName === "codemode") return summarizeCodemode(result, theme);
	if (toolName === "apply_patch") return summarizeApplyPatch(result, theme);
	if (toolName === "write" || toolName === "edit") return summarizeFileChange(toolName, result, theme);
	return theme.fg("muted", summarizeOutput(toolName, result));
}

function summarizeOutput(toolName: string, result: any): string {
	const details = result?.details as Record<string, unknown> | undefined;
	const text = resultText(result);
	switch (toolName) {
		case "read":
			if (details?._type === "readImage") return "image";
			return plural(typeof details?.lineCount === "number" ? details.lineCount : countLines(text), "line");
		case "bash":
			return countOrEmpty(countLines(typeof details?.text === "string" ? details.text : text), "no output", "line");
		case "grep":
			return countOrEmpty(countLines(text, /^--$/), "no matches", "line");
		case "find":
			return countOrEmpty(countLines(text), "no files", "file");
		case "ls":
			return countOrEmpty(countLines(text), "empty", "entry", "entries");
		default:
			return countOrEmpty(countLines(text), "done", "line");
	}
}

function formatSeconds(ms: number): string {
	return ms < 995 ? `${(ms / 1000).toFixed(2)}s` : `${(ms / 1000).toFixed(ms < 9950 ? 1 : 0)}s`;
}

function elapsedMs(result: any, ctx: RenderCtxLike): number | undefined {
	if (typeof ctx.durationMs === "number") return ctx.durationMs;
	const value = (result?.details as Record<string, unknown> | undefined)?.[ELAPSED_KEY];
	return typeof value === "number" ? value : undefined;
}

function rowComponent(build: (width: number) => string[]): AnyComponent {
	return { render: (width: number) => build(Math.max(1, width)), invalidate() {} };
}

function fitLine(line: string, width: number, theme: ThemeLike): string {
	return visibleWidth(line) > width ? truncateToWidth(line, width, theme.fg("dim", "…")) : line;
}

function buildCallRow(
	theme: ThemeLike,
	ctx: RenderCtxLike,
	label: string,
	detail: string,
	state: ToolState,
	hint = "",
	bodyLines: string[] = [],
): AnyComponent {
	return rowComponent((width) => {
		const head = `${indentOf(ctx)}${stateIcon(theme, state)} ${theme.bold(theme.fg("text", label))}`;
		const body = detail ? ` ${theme.fg("dim", "(")}${theme.fg("muted", detail)}${theme.fg("dim", ")")}` : "";
		const indent = `${indentOf(ctx)}  `;
		return [
			fitLine(`${head}${body}${hint}`, width, theme),
			...bodyLines.map((line) => fitLine(`${indent}${line}`, width, theme)),
		];
	});
}

function buildResultRow(theme: ThemeLike, ctx: RenderCtxLike, text: string, failed: boolean): AnyComponent {
	return rowComponent((width) => {
		const connector = theme.fg("dim", "└ ");
		const body = failed ? theme.fg("error", text) : text;
		return [fitLine(`${indentOf(ctx)}  ${connector}${body}`, width, theme)];
	});
}

/**
 * Tools wearing the claudecode rows. Only these render as compact rows, so only these may be
 * folded into a group: other tools (apply_patch, MCP tools, …) render their own multi-line
 * bodies, which a group's tree would flatten, so they break a run instead.
 */
const styledToolNames = new Set<string>();

/** Extra lines shown under the call row when expanded (e.g. a script's source). */
type CallBody = (args: Record<string, unknown>) => string[];

/** A codemode script, highlighted, shown under its call row when expanded. */
const codemodeSource: CallBody = (args) =>
	highlightCode(firstString(args, ["code"]).replace(/\r/g, "").replace(/\t/g, "  ").trimEnd(), "javascript");

/** Renderer pair for one tool; `original` is the result renderer shown when expanded. */
function claudeRenderers(name: string, label: string, original?: AnyFn, expandedCallBody?: CallBody) {
	return {
		renderCall(args: Record<string, unknown>, theme: ThemeLike, ctx: RenderCtxLike) {
			const state: ToolState = ctx.isError
				? "error"
				: ctx.isPartial
					? ctx.executionStarted === false
						? "pending"
						: "running"
					: "success";
			return buildCallRow(
				theme,
				ctx,
				label,
				callDetail(name, args ?? {}),
				state,
				ctx.expanded ? toggleHint(theme, "collapse") : "",
				ctx.expanded && expandedCallBody ? expandedCallBody(args ?? {}) : [],
			);
		},
		renderResult(
			result: any,
			options: { expanded?: boolean; isPartial?: boolean },
			theme: ThemeLike,
			ctx: RenderCtxLike,
		) {
			if (options?.isPartial) return rowComponent(() => []);
			if (ctx.expanded && original) return original(result, options, theme, ctx);
			if (ctx.isError) {
				const message = oneLine(
					resultText(result)
						.split("\n")
						.find((line) => line.trim() !== "" && !CODEMODE_HEADER_LINE.test(line)) ?? "Error",
				);
				return buildResultRow(theme, ctx, message, true);
			}
			const ms = elapsedMs(result, ctx);
			const parts = [summarize(name, result, theme, ctx.args)];
			if (ms !== undefined) parts.push(theme.fg("dim", `◷ ${formatSeconds(ms)}`));
			// Labeled so a bash timeout limit is never mistaken for the measured duration.
			if (typeof ctx.args?.timeout === "number") parts.push(theme.fg("dim", `timeout ${ctx.args.timeout}s`));
			return buildResultRow(theme, ctx, parts.join(theme.fg("dim", " · ")), false);
		},
	};
}

/** Where the delegated (expanded) renderer's own component is kept between renders. */
const DELEGATE_COMPONENT = "__claudeDelegateComponent";

/**
 * A provider's result renderer reuses and mutates `ctx.lastComponent` (e.g. `setText`), so it must only
 * ever be handed its own previous component, never one of this style's rows (a collapse/expand round trip).
 */
function isolateDelegate(original: AnyFn | undefined): AnyFn | undefined {
	if (!original) return undefined;
	return (result, options, theme, ctx) => {
		const lastComponent = ctx.state[DELEGATE_COMPONENT];
		const component = original(result, options, theme, { ...ctx, lastComponent });
		ctx.state[DELEGATE_COMPONENT] = component;
		return component;
	};
}

/**
 * Wrap a tool definition so collapsed rows use the Claude Code look. Expanded
 * calls keep the call row but defer the result body to the original renderer.
 */
export function withClaudeToolStyle<
	T extends { name: string; label?: string; renderCall?: AnyFn; renderResult?: AnyFn },
>(def: T): T {
	styledToolNames.add(def.name);
	return { ...def, ...claudeRenderers(def.name, def.label || def.name, isolateDelegate(def.renderResult)) } as T;
}

// ---------------------------------------------------------------------------
// write / edit / apply_patch (pi-diff), codemode (Pi built-in), recall (pikit): tools registered elsewhere
// ---------------------------------------------------------------------------

const EXTERNAL_TOOLS = ["write", "edit", "apply_patch", "codemode", "recall"];
const EXTERNAL_TOOL_ORIGINALS = Symbol.for("pi-pretty.claude-style.file-tool-originals");

type RendererLookup = "getCallRenderer" | "getResultRenderer" | "getRenderShell";
type ComponentProto = Record<RendererLookup, AnyFn> & { [EXTERNAL_TOOL_ORIGINALS]?: Record<RendererLookup, AnyFn> };

/**
 * Give write/edit/apply_patch the Claude Code rows without owning their registration (pi-diff or Pi's
 * builtins keep their schema, execute and diff renderer). Rendering is decided per component,
 * so the host's lookups are patched by tool name, as pi-droid-styling does. Collapsed: call
 * and `+N -N` rows; expanded: the provider's own result renderer. Pass `false` to restore.
 */
export function installClaudeExternalToolRenderers(toolExecutionComponent: unknown, enabled = true): void {
	const proto = (toolExecutionComponent as { prototype?: ComponentProto } | undefined)?.prototype;
	if (!proto) return;
	proto[EXTERNAL_TOOL_ORIGINALS] ??= {
		getCallRenderer: proto.getCallRenderer,
		getResultRenderer: proto.getResultRenderer,
		getRenderShell: proto.getRenderShell,
	};
	const originals = proto[EXTERNAL_TOOL_ORIGINALS];
	if (!enabled) {
		Object.assign(proto, originals);
		for (const name of EXTERNAL_TOOLS) styledToolNames.delete(name);
		return;
	}
	for (const name of EXTERNAL_TOOLS) styledToolNames.add(name);
	const isExternalTool = (component: { toolName?: string }): boolean =>
		EXTERNAL_TOOLS.includes(component.toolName ?? "");
	const labelOf = (component: { toolName: string }): string => {
		const words = component.toolName.replace(/_/g, " ");
		return words.charAt(0).toUpperCase() + words.slice(1);
	};

	proto.getCallRenderer = function (this: any) {
		return isExternalTool(this)
			? claudeRenderers(
					this.toolName,
					labelOf(this),
					undefined,
					this.toolName === "codemode" ? codemodeSource : undefined,
				).renderCall
			: originals.getCallRenderer.call(this);
	};
	proto.getResultRenderer = function (this: any) {
		const original = originals.getResultRenderer.call(this);
		if (!isExternalTool(this)) return original;
		// A tool with no result renderer of its own (recall) gets the host's plain text fallback when expanded.
		if (!original && this.expanded) return undefined;
		return claudeRenderers(this.toolName, labelOf(this), isolateDelegate(original)).renderResult;
	};
	// The shell is fixed when the component is built, and the style draws its own rows without a box.
	proto.getRenderShell = function (this: any) {
		return isExternalTool(this) ? "self" : originals.getRenderShell.call(this);
	};
}

/** Proxy `pi` so tools registered through it get the Claude Code rows. */
export function withClaudeToolStyleApi<P extends { registerTool: AnyFn }>(pi: P): P {
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") return (def: any) => target.registerTool(withClaudeToolStyle(def));
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

// ---------------------------------------------------------------------------
// Tool-run grouping
// ---------------------------------------------------------------------------

const MIN_GROUPED_TOOLS = 2;

const fg = (color: string, text: string): string => groupTheme.fg(color, text);
const bold = (text: string): string => groupTheme.bold(text);

function isToolComponent(component: any): boolean {
	return typeof component?.toolCallId === "string" && styledToolNames.has(component.toolName);
}

/** Assistant turns with no answer text whose tool calls are all styled belong to the tool run. */
function toolOnlyAssistantContent(component: any): any[] | null {
	const message = component?.lastMessage;
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
	if (message.stopReason === "error" || message.stopReason === "aborted") return null;
	const content = message.content as any[];
	if (content.some((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim()))
		return null;
	const calls = content.filter((block) => block?.type === "toolCall");
	return calls.length > 0 && calls.every((block) => styledToolNames.has(block.name)) ? content : null;
}

const isGroupMember = (component: any): boolean =>
	isToolComponent(component) || toolOnlyAssistantContent(component) !== null;

const hasThought = (component: any): boolean =>
	Boolean(
		toolOnlyAssistantContent(component)?.some(
			(block) => block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim(),
		),
	);

/** Whether the host agent is between agent_start and agent_end. A restored session can
 * contain tool calls whose result never arrived (pi killed mid-run): without this flag
 * their group summary froze on a single spinner frame — "Running" that only shifted
 * when a scroll forced a redraw. */
let agentActive = false;

/** Tool components observed result-less while the agent was idle: restored dangling calls from a
 * killed run. Recorded once, they stay "interrupted" even when a later agent run flips
 * agentActive back on (their result will never arrive). Keyed by component, so a rebuilt
 * transcript (same toolCallIds, fresh components) starts without stale marks. */
let interruptedTools = new WeakSet<object>();

export function setClaudeStyleAgentActive(active: boolean): void {
	agentActive = active;
}

/** Drop per-session state on teardown: a reload/resume can leave a stale `agentActive` (and the
 * matching interrupted marks) behind, which would suppress every later "Running" summary. */
export function resetClaudeStyleSessionState(): void {
	agentActive = false;
	interruptedTools = new WeakSet<object>();
}

/** A call whose result will never arrive: marked while idle, or never resolved at all. */
const isInterrupted = (tool: any): boolean => interruptedTools.has(tool) || (!tool.result && !agentActive);

/** Live only while the host is actually running the agent; restored result-less calls
 * are reported as interrupted instead of reading as perpetually "Running". */
const isRunning = (tool: any): boolean =>
	agentActive && !isInterrupted(tool) && (!tool.result || Boolean(tool.isPartial));

function toolLabel(tool: any): string {
	const label = tool.toolDefinition?.label;
	return typeof label === "string" && label ? label : String(tool.toolName);
}

function summaryRow(members: any[], width: number): string[] {
	const tools = members.filter(isToolComponent);
	const running = tools.filter(isRunning);
	const failed = tools.filter((tool) => Boolean(tool.result?.isError)).length;
	const interrupted = tools.filter((tool) => !tool.result && isInterrupted(tool)).length;
	const thoughts = members.filter(hasThought).length;
	const parts = [fg("muted", plural(tools.length, "tool call"))];
	if (thoughts > 0) parts.push(fg("muted", plural(thoughts, "thought")));
	if (failed > 0) parts.push(fg("error", `${failed} failed`));
	if (interrupted > 0) parts.push(fg("error", `${plural(interrupted, "call")} interrupted`));
	if (running.length > 0) parts.push(fg("muted", toolLabel(running[running.length - 1])));
	const icon = stateIcon(groupTheme, running.length > 0 ? "running" : failed > 0 ? "error" : "success");
	const state = bold(fg("text", running.length > 0 ? "Running" : "Done"));
	const row = `${icon} ${state} ${fg("dim", "(")}${parts.join(fg("dim", " · "))}${fg("dim", ")")}${toggleHint(groupTheme, "expand")}`;
	return ["", visibleWidth(row) > width ? truncateToWidth(row, width, fg("dim", " …")) : row];
}

function treeRows(members: any[], width: number): { lines: string[]; owners: any[] } {
	// Text-less assistant turns only contribute to the summary's thought count; their
	// own rows (a hidden-thinking label) would read as noise between the tool rows.
	const blocks = members
		.filter(isToolComponent)
		.map((member) => ({
			member,
			rows: (member.render(width) as string[]).filter((line) => stripAnsi(line).trim() !== "" && !isImageLine(line)),
		}))
		.filter((block) => block.rows.length > 0);
	const lines: string[] = [];
	// owners[i] is the tool component that line i belongs to (for click-to-expand).
	const owners: any[] = [];
	blocks.forEach(({ member, rows }, blockIndex) => {
		const last = blockIndex === blocks.length - 1;
		rows.forEach((line, lineIndex) => {
			const guide = lineIndex === 0 ? (last ? "└─ " : "├─ ") : last ? "   " : "│  ";
			let content = line;
			// A settled success shrinks to a small dot; errors, spinners and pending markers stay as they are.
			if (lineIndex === 0 && stripAnsi(line).trimStart().startsWith(ICON_SUCCESS))
				content = line.replace(ICON_SUCCESS, "•");
			if (lineIndex === 0 && isInterrupted(member)) content = markInterruptedRow(content);
			const row = `  ${fg("dim", guide)}${content.replace(LEADING_SPACE_RE, "$1")}`;
			lines.push(visibleWidth(row) > width ? truncateToWidth(row, width, "") : row);
			owners.push(member);
		});
	});
	if (lines.length > 0) {
		lines.push("");
		owners.push(undefined);
	}
	return { lines, owners };
}

/** Mouse target for a folded group: a left click on a tool's rows toggles that tool, which unfolds the group. */
function groupComponent(owners: any[]): AnyComponent {
	return {
		render: () => [],
		handleMouse(event: { type: string; button?: string; y: number }) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const tool = owners[event.y];
			if (!tool?.result || typeof tool.setExpanded !== "function") return undefined;
			tool.setExpanded(!tool.expanded);
			return { handled: true };
		},
	};
}

// Settled groups rebuild identical strings on every host render — once a
// session is long, that is O(history) work per frame (pi-tui re-renders the
// whole tree on every doRender, and requestRender ticks ~30x/s while
// streaming). Cache each settled group's rows keyed by its member span;
// groups with running tools re-render every frame (spinner/summary are live).
interface CachedGroupRender {
	component: AnyComponent;
	/** The exact members these rows were built from. */
	members: AnyComponent[];
	/** `tool.result` identity and partial flag per tool member: a result that lands in place must
	 * invalidate the row even though the component object is unchanged. */
	results: unknown[];
	partials: boolean[];
	rendered: string[];
}

interface GroupCacheState {
	store: Map<string, CachedGroupRender>;
	/** First child of the previous render. The host tears a container down with `clear()` and refills
	 * it with fresh components on fork, `/tree` navigation and reload; a different first child
	 * object therefore means the transcript was rebuilt and no cached rows are reusable. */
	firstChild: unknown;
}

/** Per-container: two containers can hold different components with identical toolCallIds
 * (rebuilds, forked sessions) — sharing rows between them would point mouse owners at dead
 * components. */
const GROUP_RENDER_CACHE = new WeakMap<object, GroupCacheState>();
/** Memory bound only: a rendered copy of every settled group is roughly one transcript. A group
 * past the cap stays uncached (the pre-cache behavior) rather than evicting a warm entry. */
const GROUP_RENDER_CACHE_MAX = 4096;

function groupCacheState(container: object): GroupCacheState {
	let state = GROUP_RENDER_CACHE.get(container);
	if (!state) {
		state = { store: new Map(), firstChild: undefined };
		GROUP_RENDER_CACHE.set(container, state);
	}
	return state;
}

/** Buckets entries; `isSameGroup` is what actually proves a hit. */
const groupCacheKey = (members: AnyComponent[], width: number): string =>
	`${themeGeneration}|${width}|${members.length}|${members[0]?.toolCallId ?? ""}|${members[members.length - 1]?.toolCallId ?? ""}`;

/**
 * A hit needs the same member components *and* the same result state per tool. Ids are not enough —
 * a rebuilt transcript reuses toolCallIds (stale rows would keep dead mouse owners) — and neither is
 * member identity, because a result that lands in place mutates the member instead of replacing it.
 */
function isSameGroup(entry: CachedGroupRender, members: AnyComponent[], tools: AnyComponent[]): boolean {
	if (entry.members.length !== members.length || entry.results.length !== tools.length) return false;
	for (let i = 0; i < members.length; i++) if (entry.members[i] !== members[i]) return false;
	for (let i = 0; i < tools.length; i++) {
		if (entry.results[i] !== tools[i].result || entry.partials[i] !== Boolean(tools[i].isPartial)) return false;
	}
	return true;
}

function renderGrouped(container: any, width: number): string[] {
	const children: any[] = container.children;
	const state = groupCacheState(container);
	// Appending keeps the first child; a rebuild replaces it with a fresh component.
	if (state.firstChild !== undefined && children[0] !== state.firstChild) state.store.clear();
	state.firstChild = children[0];
	const lines: string[] = [];
	const layout: Array<{ component: AnyComponent; height: number }> = [];
	const push = (component: AnyComponent, rendered: string[]): void => {
		layout.push({ component, height: rendered.length });
		for (const line of rendered) lines.push(line);
	};
	let index = 0;
	while (index < children.length) {
		let end = index;
		while (end < children.length && isGroupMember(children[end])) end++;
		if (end === index) {
			push(children[index], children[index].render(width));
			index++;
			continue;
		}
		const members = children.slice(index, end);
		const tools = members.filter(isToolComponent);
		// While idle, any result-less styled tool is a restored dangling call — mark it once.
		if (!agentActive) {
			for (const tool of tools) if (!tool.result) interruptedTools.add(tool);
		}
		if (tools.length < MIN_GROUPED_TOOLS || tools.some((tool) => tool.expanded)) {
			for (const member of members) {
				const rendered = member.render(width);
				// A group has no summary to say "interrupted", so the lone row says it itself.
				const first = rendered.findIndex((line: string) => stripAnsi(line).trim() !== "");
				push(
					member,
					isToolComponent(member) && first >= 0 && isInterrupted(member)
						? rendered.map((line: string, i: number) => (i === first ? markInterruptedRow(line) : line))
						: rendered,
				);
			}
		} else {
			const running = tools.some((tool) => isRunning(tool));
			const key = groupCacheKey(members, width);
			const cached = running ? undefined : state.store.get(key);
			if (cached && isSameGroup(cached, members, tools)) {
				push(cached.component, cached.rendered);
			} else {
				const summary = summaryRow(members, width);
				const tree = treeRows(members, width);
				const owners = [...summary.map(() => undefined), ...tree.owners];
				const component = groupComponent(owners);
				const rendered = [...summary, ...tree.lines];
				push(component, rendered);
				if (!running && state.store.size < GROUP_RENDER_CACHE_MAX) {
					state.store.set(key, {
						component,
						members: [...members],
						results: tools.map((tool) => tool.result),
						partials: tools.map((tool) => Boolean(tool.isPartial)),
						rendered,
					});
				}
			}
		}
		index = end;
	}
	container.mouseLayout = { width, children: layout };
	return lines;
}

const CONTAINER_ORIGINAL_RENDER = Symbol.for("pi-pretty.claude-style.container-render");

/**
 * Fold consecutive tool calls into `✓ Done (...)` groups by wrapping pi-tui's base
 * `Container.render`. Pi nests its chat container (no stable index to look it up by),
 * but only that container holds tool components as direct children, so the wrapper
 * stays inert for every other container. Pass `false` to restore the original render.
 */
export function installClaudeChatGrouping(enabled = true): void {
	const proto = Container.prototype as unknown as Record<symbol, unknown> & { render: (width: number) => string[] };
	const base = (proto[CONTAINER_ORIGINAL_RENDER] as ((width: number) => string[]) | undefined) ?? proto.render;
	proto[CONTAINER_ORIGINAL_RENDER] = base;
	if (!enabled) {
		proto.render = base;
		return;
	}
	proto.render = function renderChatWithToolGroups(this: { children: unknown[] }, width: number): string[] {
		try {
			if (this.children.some(isToolComponent)) return renderGrouped(this, width);
		} catch {
			// fall through to the original render
		}
		return base.call(this, width);
	};
}
