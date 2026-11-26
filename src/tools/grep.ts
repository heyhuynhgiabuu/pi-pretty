/* pi-pretty: grep tool -- FFF-backed text search with SDK fallback. */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BG_ERROR, FG_DIM, RST, resolveBaseBackground } from "../config.js";
import { fffFormatGrepText } from "../fff-helpers.js";
import { normalizeLineEndings, shortPath } from "../helpers.js";
import { NOTICE_PARTIAL_FILE_INDEX } from "../notices.js";
import {
	fillToolBackground,
	fillToolBody,
	rememberToolTitle,
	renderToolError,
	setCollapsedToolTitle,
	toolIndent,
} from "../render.js";
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
		constrainedSampling: sdkTool.constrainedSampling,
		outputSchema: sdkTool.outputSchema,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(async (tid, params, sig, _upd, ctx: ExtensionContext) => {
			const p = params as any;
			const pattern = String(p.pattern ?? "");
			const path = p.path ? String(p.path) : undefined;
			const glob = p.glob ? String(p.glob) : undefined;
			const context = typeof p.context === "number" ? p.context : 0;
			const limit = typeof p.limit === "number" ? p.limit : 200;
			const literal = p.literal === true;

			// FFF exposes smart-case, not the SDK's explicit ignoreCase mode, and
			// does not synthesize host `structuredContent` when `outputSchema` is set.
			if (fffService?.isAvailable && !sdkTool.outputSchema && !path && !glob && p.ignoreCase !== true) {
				try {
					const fff = fffService.getFinder();
					if (!fff) throw new Error("FFF finder not available");
					const effectiveLimit = Math.max(1, limit);
					const grepResult = fff.grep(pattern, {
						pageSize: effectiveLimit,
						mode: literal ? "plain" : "regex",
						smartCase: false,
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
								text: items.length > 0 ? text : "",
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
			const normalizedText = tc.trim() === "No matches found" ? "" : tc;
			result.details = {
				...(result.details ?? {}),
				_type: "grepResult",
				text: normalizedText,
				pattern,
				matchCount: normalizedText ? normalizedText.trim().split("\n").filter(Boolean).length : 0,
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
			const ind = toolIndent(ctx);
			const renderTitle = (suffix = ""): string =>
				fillToolBackground(`\n${ind}${out}${suffix}\n`, ctx.isError ? BG_ERROR : undefined, undefined, ind);
			rememberToolTitle(ctx, text, renderTitle);
			text.setText(renderTitle());
			return text;
		},

		renderResult(result: Result, _opt: unknown, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new T("", 0, 0);
			const ind = toolIndent(ctx);
			if (ctx.isError) {
				text.setText(
					renderToolError(
						((result.content ?? []) as TextContent[])
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("\n") || "Error",
						theme,
						ind,
					),
				);
				return text;
			}
			const d = result.details as GrepDetails | undefined;
			if (d?._type === "grepResult" && d.text) {
				const lines = d.text.split("\n");
				if (!ctx.expanded) {
					const summary = `${FG_DIM}${lines.length} lines — ctrl+o to expand${RST}`;
					if (setCollapsedToolTitle(ctx, text, ` ${summary}`)) return text;
					text.setText(fillToolBody(`${ind}${summary}`, ctx.isError ? BG_ERROR : undefined, undefined, ind));
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
				const body = out.map((l) => `${ind}${l}`).join("\n");
				text.setText(fillToolBody(body, ctx.isError ? BG_ERROR : undefined, undefined, ind));
				return text;
			}
			const fc = result.content?.[0];
			const fallback = fc && "text" in fc ? String(fc.text).slice(0, 120) : "no matches";
			text.setText(
				fillToolBody(`${ind}${theme.fg("dim", fallback)}`, ctx.isError ? BG_ERROR : undefined, undefined, ind),
			);
			return text;
		},
	} as unknown as ToolDefinition<any, any, any>);
}

function appendNotices(text: string, notices: string[]): string {
	return notices.length ? `${text}\n\n[${notices.join(". ")}]` : text;
}
