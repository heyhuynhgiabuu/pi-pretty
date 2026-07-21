/* pi-pretty: grep tool -- FFF-backed text search with SDK fallback. */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BG_ERROR, FG_DIM, RST, resolveBaseBackground, TOOL_RESULT_INDENT } from "../config.js";
import { fffFormatGrepText } from "../fff-helpers.js";
import { normalizeLineEndings, shortPath } from "../helpers.js";
import { NOTICE_PARTIAL_FILE_INDEX } from "../notices.js";
import { fillToolBackground, renderToolError } from "../render.js";
import { resolveTextCtor } from "../tui-text.js";
import type { FffServiceWithCursor, GrepDetails, RenderCtxLike, SdkToolDef, TextContent, ThemeLike } from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

const invalidArg = "<missing>";

type Result = AgentToolResult<Record<string, unknown>>;

export function registerGrepTool(
	pi: ExtensionAPI,
	cwd: string,
	fffService: FffServiceWithCursor | null | undefined,
	sdkTool: SdkToolDef,
	TextComp?: new (t?: string, x?: number, y?: number) => { setText(v: string): void },
): void {
	const T = resolveTextCtor(TextComp);
	const home = process.env.HOME ?? "";

	pi.registerTool({
		name: "grep",
		label: "Grep",
		description: sdkTool.description ?? "Search file contents by pattern",
		parameters: sdkTool.parameters,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(async (tid, params, sig, _upd, ctx: ExtensionContext) => {
			const p = params as any;
			const pattern = String(p.pattern ?? "");
			const path = p.path ? String(p.path) : undefined;
			const glob = p.glob ? String(p.glob) : undefined;
			const context = typeof p.context === "number" ? p.context : 0;
			const limit = typeof p.limit === "number" ? p.limit : 200;
			const literal = p.literal === true;

			if (fffService?.isAvailable && !path && !glob) {
				try {
					const fff = fffService.getFinder();
					if (!fff) throw new Error("FFF finder not available");
					const effectiveLimit = Math.max(1, limit);
					const grepResult = fff.grep(pattern, {
						pageSize: effectiveLimit,
						mode: literal ? "plain" : "regex",
						beforeContext: context,
						afterContext: context,
					});
					if (grepResult.ok) {
						const grep = grepResult.value;
						const items = grep.items.slice(0, effectiveLimit);
						const cursorStore = fffService.getCursorStore();
						const notices: string[] = [];
						if (fffService.partialIndex) notices.push(NOTICE_PARTIAL_FILE_INDEX);
						if (items.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
						if (grep.regexFallbackError) notices.push(`Regex failed: ${grep.regexFallbackError}, used literal match`);
						if (grep.nextCursor) {
							const cursorId = cursorStore.store(grep.nextCursor);
							notices.push(`More results available: cursor="${cursorId}"`);
						}
						const text = appendNotices(fffFormatGrepText(items, effectiveLimit), notices);
						return {
							content: [{ type: "text" as const, text }],
							details: {
								_type: "grepResult",
								text,
								pattern,
								matchCount: items.length,
							} as GrepDetails,
						};
					}
				} catch {
					/* fall through */
				}
			}

			const result = (await sdkTool.execute(tid, p, sig, undefined, ctx)) as Result;
			for (const c of (result.content ?? []) as any[]) {
				if (c.type === "text") c.text = normalizeLineEndings(c.text);
			}
			const tc =
				((result.content ?? []) as TextContent[])
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n") ?? "";
			result.details = {
				_type: "grepResult",
				text: tc,
				pattern,
				matchCount: tc ? tc.trim().split("\n").filter(Boolean).length : 0,
			} as GrepDetails;
			return result;
		}),

		renderCall(args: any, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new T("", 0, 0);
			const pattern = args.pattern === null || args.pattern === undefined ? invalidArg : String(args.pattern);
			const path = args.path === null || args.path === undefined ? invalidArg : shortPath(cwd, home, String(args.path));
			const glob = args.glob;
			const limit = args.limit;
			const literal = args.literal === true;
			const caseInsensitive = args.caseInsensitive === true || args.ignoreCase === true;
			let out = `${theme.fg(ctx.isError ? "error" : "toolTitle", theme.bold("✱ grep"))} ${theme.fg("toolTitle", `/${pattern || ""}/`)}${theme.fg("toolOutput", ` in ${path}`)}`;
			if (glob) out += theme.fg("dim", ` (${String(glob)})`);
			if (limit !== undefined && limit !== null) out += theme.fg("dim", ` limit ${limit}`);
			if (literal) out += theme.fg("dim", ` (literal)`);
			if (caseInsensitive) out += theme.fg("dim", ` (case-insensitive)`);
			text.setText(fillToolBackground(`\n${TOOL_RESULT_INDENT}${out}\n`, ctx.isError ? BG_ERROR : undefined));
			return text;
		},

		renderResult(result: Result, _opt: unknown, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new T("", 0, 0);
			if (ctx.isError) {
				text.setText(
					renderToolError(
						((result.content ?? []) as TextContent[])
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("\n") || "Error",
						theme,
					),
				);
				return text;
			}
			const d = result.details as GrepDetails | undefined;
			if (d?._type === "grepResult" && d.text) {
				const lines = d.text.split("\n");
				if (!ctx.expanded) {
					text.setText(
						fillToolBackground(
							`${TOOL_RESULT_INDENT}${FG_DIM}${lines.length} lines — ctrl+o to expand${RST}\n`,
							ctx.isError ? BG_ERROR : undefined,
						),
					);
					return text;
				}
				const maxShow = lines.length;
				const show = lines.slice(0, maxShow);
				const remaining = lines.length - maxShow;
				const out: string[] = [];
				for (const line of show) {
					if (!line) continue;
					out.push(theme.fg("toolOutput", line));
				}
				if (remaining > 0) {
					out.push(theme.fg("muted", `… (${remaining} more ${remaining === 1 ? "line" : "lines"}, to expand)`));
				}
				const body = `${out.map((l) => `${TOOL_RESULT_INDENT}${l}`).join("\n")}\n\n`;
				text.setText(fillToolBackground(body, ctx.isError ? BG_ERROR : undefined));
				return text;
			}
			const fc = result.content?.[0];
			const fallback = fc && "text" in fc ? String(fc.text).slice(0, 120) : "no matches";
			text.setText(
				fillToolBackground(`${TOOL_RESULT_INDENT}${theme.fg("dim", fallback)}`, ctx.isError ? BG_ERROR : undefined),
			);
			return text;
		},
	} as unknown as ToolDefinition<any, any, any>);
}

function appendNotices(text: string, notices: string[]): string {
	return notices.length ? `${text}\n\n[${notices.join(". ")}]` : text;
}
