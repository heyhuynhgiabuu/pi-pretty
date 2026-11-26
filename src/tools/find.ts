/* pi-pretty: find tool -- FFF-backed file search with SDK (fd) fallback. */

import { isAbsolute, relative } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BG_ERROR, FG_DIM, RST, resolveBaseBackground } from "../config.js";
import { isLikelyGlobPattern, normalizeFindGlobPattern } from "../find-glob.js";
import { shortPath } from "../helpers.js";
import { NOTICE_PARTIAL_FILE_INDEX } from "../notices.js";
import {
	fillToolBackground,
	fillToolBody,
	rememberToolTitle,
	renderFindResults,
	renderToolDuration,
	renderToolError,
	setCollapsedToolTitle,
	toolIndent,
} from "../render.js";
import { resolveTextCtor } from "../tui-text.js";
import type { FffServiceWithCursor, FindDetails, RenderCtxLike, SdkToolDef, TextContent, ThemeLike } from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

type Result = AgentToolResult<Record<string, unknown>>;

function getText(result: Result): string {
	return (result.content ?? [])
		.filter((c) => c.type === "text")
		.map((c) => (c as TextContent).text ?? "")
		.join("\n");
}

function buildGlobPattern(pattern: string, path: string | undefined, basePath: string | null): string {
	const raw = pattern.trim().replace(/^(?:\.\/|\/)+/, "");
	const normalized = normalizeFindGlobPattern(raw);
	let cleanPath = path ?? "";
	if (cleanPath && isAbsolute(cleanPath) && basePath) {
		cleanPath = relative(basePath, cleanPath) || "";
	}
	cleanPath = cleanPath.replace(/\/$/, "");
	if (cleanPath) {
		if (normalized.startsWith("**/")) {
			return `${cleanPath}/${normalized}`;
		}
		if (normalized.includes("/")) {
			return `${cleanPath}/${normalized}`;
		}
		return `${cleanPath}/**/${normalized}`;
	}
	return normalized.startsWith("**/") || normalized.includes("/") ? normalized : `**/${normalized}`;
}

function normalizeSdkFindOutput(text: string): { text: string; matchCount: number; notices: string[] } {
	const trimmed = text.trim();
	if (!trimmed || trimmed === "No files found matching pattern") {
		return { text: "", matchCount: 0, notices: [] };
	}

	const noticeMatch = /\n\n\[([^\r\n]*)\]\s*$/.exec(text);
	const body = noticeMatch ? text.slice(0, noticeMatch.index) : text;
	const notices = noticeMatch ? noticeMatch[1].split(". ").filter(Boolean) : [];
	const matchCount = body.trim() ? body.trim().split("\n").filter(Boolean).length : 0;
	return { text: body, matchCount, notices };
}

async function sdkFindAsFindResult(
	sdkTool: SdkToolDef,
	tid: string,
	params: Record<string, unknown>,
	sig: AbortSignal | undefined,
	ctx: ExtensionContext,
	pattern: string,
	extraNotices: string[],
): Promise<Result> {
	const result = (await sdkTool.execute(tid, params, sig, undefined, ctx)) as Result;
	const parsed = normalizeSdkFindOutput(getText(result));
	const prev = (result.details as FindDetails | undefined)?.notices ?? [];
	const notices = [...parsed.notices, ...(Array.isArray(prev) ? prev : []), ...extraNotices];
	result.details = {
		...(result.details ?? {}),
		_type: "findResult",
		text: parsed.text,
		pattern,
		matchCount: parsed.matchCount,
		notices,
	};
	return result;
}

export function registerFindTool(
	pi: ExtensionAPI,
	cwd: string,
	fffService: FffServiceWithCursor | null | undefined,
	sdkTool: SdkToolDef,
	TextComp?: new (t?: string, x?: number, y?: number) => { setText(v: string): void },
): void {
	const TC = resolveTextCtor(TextComp);
	const home = process.env.HOME ?? "";

	pi.registerTool({
		name: "find",
		label: "Find",
		description: sdkTool.description ?? "Find files matching a glob pattern",
		parameters: sdkTool.parameters,
		constrainedSampling: sdkTool.constrainedSampling,
		outputSchema: sdkTool.outputSchema,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(async (tid, params, sig, _upd, ctx: ExtensionContext) => {
			const pattern = String(params.pattern ?? "");
			const path = params.path ? String(params.path) : undefined;
			const limit = params.limit;
			const fff = !sdkTool.outputSchema && fffService?.isAvailable ? fffService.getFinder() : null;

			if (fff) {
				try {
					const effectiveLimit = Math.max(1, typeof limit === "number" ? limit : 100);
					const basePathResult = fff.getBasePath();
					const basePath = basePathResult.ok ? basePathResult.value : null;
					const globPattern = buildGlobPattern(pattern, path, basePath);
					const searchResult = fff.glob(globPattern, {
						pageSize: effectiveLimit,
					});

					if (searchResult.ok) {
						const items = searchResult.value.items.slice(0, effectiveLimit);
						const notices: string[] = [];
						if (fffService?.partialIndex) notices.push(NOTICE_PARTIAL_FILE_INDEX);
						if (items.length >= effectiveLimit) notices.push(`${effectiveLimit} limit reached`);
						if (searchResult.value.totalMatched > items.length) {
							notices.push(`${searchResult.value.totalMatched} total matches`);
						}

						if (items.length === 0 && isLikelyGlobPattern(pattern)) {
							return sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, [
								"FFF glob returned no matches; results from SDK find (fd).",
								...notices,
							]);
						}

						if (items.length > 0) notices.push("Search engine: FFF glob.");
						else if (notices.length === 0) notices.push("Search engine: FFF glob (no matches).");

						const paths = items.map((i) => i.relativePath).join("\n");
						return {
							content: [{ type: "text" as const, text: paths }],
							details: {
								_type: "findResult",
								text: paths,
								pattern,
								matchCount: items.length,
								notices,
							},
						};
					}
				} catch {
					/* fall through to SDK */
				}
			}

			return sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, [
				fff ? "FFF find unavailable; results from SDK find (fd)." : "Search engine: SDK find (fd).",
			]);
		}),

		renderCall(args: any, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const a = args as { pattern?: unknown; path?: unknown; limit?: unknown };
			const text = (ctx as RenderCtxLike).lastComponent ?? new TC("", 0, 0);
			const pattern = a.pattern == null ? "" : String(a.pattern);
			const pathArg = a.path == null ? "<missing>" : shortPath(cwd, home, String(a.path));
			const limit = a.limit;
			const findLabel = theme.fg(ctx.isError ? "error" : "toolTitle", theme.bold("✱ find"));
			const patternPart = pattern ? theme.fg("toolTitle", pattern) : "";
			const inPart = theme.fg("dim", " in ");
			const pathPart = theme.fg("toolOutput", pathArg);
			const limitPart = limit !== undefined && limit !== null ? theme.fg("dim", ` limit ${limit}`) : "";
			const out = `${findLabel} ${patternPart}${inPart}${pathPart}${limitPart}`;
			const ind = toolIndent(ctx);
			const renderTitle = (suffix = ""): string =>
				fillToolBackground(`\n${ind}${out}${suffix}\n`, ctx.isError ? BG_ERROR : undefined, undefined, ind);
			rememberToolTitle(ctx, text, renderTitle);
			text.setText(renderTitle());
			return text;
		},

		renderResult(result: Result, _opt: unknown, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const r = result;
			const text = (ctx as RenderCtxLike).lastComponent ?? new TC("", 0, 0);
			const ind = toolIndent(ctx);
			if (ctx.isError) {
				text.setText(renderToolError(getText(r) || "Error", theme, ind));
				return text;
			}
			const d = r.details as FindDetails | undefined;
			if (d?._type === "findResult") {
				if (!d.text.trim()) {
					const notice = d.notices?.length ? ` ${theme.fg("warning", `[${d.notices.join(". ")}]`)}` : "";
					if (setCollapsedToolTitle(ctx, text, ` ${FG_DIM}0 files${RST}${notice}`)) return text;
					const noticeStr = d.notices?.length ? `\n${ind}${theme.fg("warning", `[${d.notices.join(". ")}]`)}` : "";
					text.setText(fillToolBody(`${ind}${theme.fg("dim", "0 files")}${noticeStr}`, undefined, undefined, ind));
					return text;
				}
				if (!ctx.expanded) {
					const duration = renderToolDuration(r, ctx);
					const summary = `${FG_DIM}${d.matchCount} files — ctrl+o to expand${RST}${duration ? `${FG_DIM}· ${duration}${RST}` : ""}`;
					if (setCollapsedToolTitle(ctx, text, ` ${summary}`)) return text;
					text.setText(fillToolBody(`${ind}${summary}`, undefined, undefined, ind));
					return text;
				}
				const rendered = renderFindResults(d.text, theme)
					.split("\n")
					.map((l) => `${ind}${l}`)
					.join("\n");
				const noticeStr = d.notices?.length ? `\n${ind}${theme.fg("warning", `[${d.notices.join(". ")}]`)}` : "";
				const duration = renderToolDuration(r, ctx);
				text.setText(
					fillToolBody(
						`${ind}${theme.fg("dim", `${d.matchCount} files`)}${duration ? `${FG_DIM}· ${duration}${RST}` : ""}\n${rendered}${noticeStr}`,
						undefined,
						undefined,
						ind,
					),
				);
				return text;
			}
			const fc = r.content?.[0] as TextContent | undefined;
			text.setText(
				fillToolBody(`${ind}${theme.fg("dim", fc?.text?.slice(0, 120) ?? "0 files")}`, undefined, undefined, ind),
			);
			return text;
		},
	} as unknown as ToolDefinition);
}
