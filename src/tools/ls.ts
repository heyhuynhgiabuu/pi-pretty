/* pi-pretty: ls tool -- directory listing with styled output. */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BG_ERROR, FG_DIM, RST, resolveBaseBackground } from "../config.js";
import { shortPath } from "../helpers.js";
import {
	fillToolBackground,
	fillToolBody,
	isLsNotice,
	rememberToolTitle,
	renderToolError,
	renderToolMetrics,
	renderTree,
	setCollapsedToolTitle,
	toolIndent,
} from "../render.js";
import { resolveTextCtor } from "../tui-text.js";
import type { LsDetails, RenderCtxLike, SdkToolDef, TextContent, ThemeLike } from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

type Result = AgentToolResult<Record<string, unknown>>;

export function registerLsTool(
	pi: ExtensionAPI,
	cwd: string,
	_fffService: unknown,
	sdkTool: SdkToolDef,
	TextComp?: new (t?: string, x?: number, y?: number) => { setText(v: string): void },
): void {
	const home = process.env.HOME ?? "";
	const TC = resolveTextCtor(TextComp);

	pi.registerTool({
		name: "ls",
		label: "List",
		description: sdkTool.description ?? "List directory contents",
		parameters: sdkTool.parameters,
		promptSnippet: sdkTool.promptSnippet,
		promptGuidelines: sdkTool.promptGuidelines,
		constrainedSampling: sdkTool.constrainedSampling,
		outputSchema: sdkTool.outputSchema,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(async (tid, params, sig, _upd, ctx: ExtensionContext) => {
			const result = (await sdkTool.execute(tid, params, sig, undefined, ctx)) as Result;
			const tc = getText(result);
			result.details = {
				...(result.details ?? {}),
				_type: "lsResult",
				text: tc,
				path: String((params as any).path ?? ""),
				entryCount: tc
					? tc
							.trim()
							.split("\n")
							.filter((line) => line && !isLsNotice(line.trim())).length
					: 0,
			} as LsDetails;
			return result;
		}),

		renderCall(args: any, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new TC("", 0, 0);
			const rawPath = args.path;
			const path =
				rawPath === null || rawPath === undefined || String(rawPath).length === 0
					? ""
					: shortPath(cwd, home, String(rawPath));
			const limit = args.limit;
			let out = theme.fg("toolTitle", theme.bold("ls"));
			if (path) out += ` ${theme.fg("accent", path)}`;
			if (limit !== undefined && limit !== null) out += theme.fg("toolOutput", ` (limit ${limit})`);
			const ind = toolIndent(ctx);
			const renderTitle = (suffix = ""): string =>
				fillToolBackground(`\n${ind}${out}${suffix}\n`, ctx.isError ? BG_ERROR : undefined, undefined, ind);
			rememberToolTitle(ctx, text, renderTitle);
			text.setText(renderTitle());
			return text;
		},

		renderResult(result: Result, _opt: unknown, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);

			const text = ctx.lastComponent ?? new TC("", 0, 0);
			const ind = toolIndent(ctx);
			if (ctx.isError) {
				text.setText(renderToolError(getText(result) || "Error", theme, ind));
				return text;
			}
			const d = result.details as LsDetails | undefined;
			if (d?._type === "lsResult" && d.text) {
				if (!ctx.expanded) {
					const summary = `${FG_DIM}${d.entryCount} entries — ctrl+o to expand${RST}${renderToolMetrics(result, ctx)}`;
					if (setCollapsedToolTitle(ctx, text, ` ${summary}`)) return text;
					text.setText(fillToolBody(`${ind}${summary}`, undefined, undefined, ind));
					return text;
				}
				const rendered = renderTree(d.text, d.path)
					.split("\n")
					.map((l) => `${ind}${l}`)
					.join("\n");
				text.setText(
					fillToolBody(
						`${ind}${FG_DIM}${d.entryCount} entries${RST}${renderToolMetrics(result, ctx)}\n${rendered}`,
						undefined,
						undefined,
						ind,
					),
				);
				return text;
			}
			const fc = result.content?.[0];
			text.setText(
				fillToolBody(
					`${ind}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`,
					undefined,
					undefined,
					ind,
				),
			);
			return text;
		},
	} as unknown as ToolDefinition<any, any, any>);
}

function getText(result: Result): string {
	return (
		((result.content ?? []) as TextContent[])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") ?? ""
	);
}
