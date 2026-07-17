/* pi-pretty: read tool -- file reading with syntax highlighting and inline image support. */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	BG_BASE,
	BG_ERROR,
	FG_DIM,
	FG_LNUM,
	FG_RULE,
	MAX_PREVIEW_LINES,
	RST,
	resolveBaseBackground,
	TOOL_RESULT_INDENT,
	termWidth,
} from "../config.js";
import { normalizeLineEndings, shortPath } from "../helpers.js";
import { fillToolBackground, renderFileContent, renderToolError, renderToolMetrics } from "../render.js";
import { resolveTextCtor } from "../tui-text.js";
import type { ReadDetails, RenderCtxLike, SdkToolDef, TextContent, ThemeLike } from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

type Result = AgentToolResult<Record<string, unknown>>;

export function registerReadTool(
	pi: ExtensionAPI,
	cwd: string,
	_fffService: unknown,
	sdkTool: SdkToolDef,
	TextComp?: new (t?: string, x?: number, y?: number) => { setText(v: string): void },
): void {
	const TC = resolveTextCtor(TextComp);
	const home = process.env.HOME ?? "";

	pi.registerTool({
		name: "read",
		label: "Read",
		description: sdkTool.description ?? "Read file contents",
		parameters: sdkTool.parameters,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(async (tid, params, sig, _upd, ctx: ExtensionContext) => {
			const p = params as any;
			const result = (await sdkTool.execute(tid, p, sig, undefined, ctx)) as Result;

			const imageBlock = (result.content as any[])?.find((c: any) => c.type === "image");
			if (imageBlock) {
				result.details = {
					_type: "readImage",
					filePath: String(p.path ?? ""),
				} as ReadDetails;
				return result;
			}

			const tc = normalizeLineEndings(getText(result));
			result.details = {
				_type: "readFile",
				filePath: String(p.path ?? ""),
				content: tc,
				offset: typeof p.offset === "number" ? p.offset : 0,
				lineCount: tc ? tc.split("\n").length : 0,
			} as ReadDetails;
			return result;
		}),

		renderCall(args: any, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);

			const text = ctx.lastComponent ?? new TC("", 0, 0);
			if (!ctx.isError) {
				text.setText("");
				return text;
			}

			const path = String(args.path ?? "");
			const label = theme.fg("error", theme.bold("→ read"));
			text.setText(fillToolBackground(`\n${TOOL_RESULT_INDENT}${label} ${theme.fg("toolTitle", path)}`, BG_ERROR));
			return text;
		},

		renderResult(result: Result, _opt: unknown, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);

			const text = ctx.lastComponent ?? new TC("", 0, 0);

			if (ctx.isError) {
				text.setText(fillToolBackground(renderToolError(getText(result) || "Error", theme), BG_ERROR));
				return text;
			}

			const d = result.details as ReadDetails | undefined;

			// Image content is preserved for ToolExecution's host-generic image pass.
			if (d?._type === "readImage") {
				text.setText("");
				return text;
			}

			// File content — line-numbered display
			if (d?._type === "readFile" && d.content) {
				const tw = termWidth();
				const lines = d.content.split("\n");
				const total = lines.length;
				const p2 = shortPath(cwd, home, String(d.filePath ?? ""));
				const off2 = typeof d.offset === "number" ? `:${d.offset}` : "";
				if (!ctx.expanded) {
					text.setText(
						fillToolBackground(
							`\n${TOOL_RESULT_INDENT}${theme.fg("toolTitle", theme.bold("→ read"))} ${theme.fg("toolTitle", p2)}${theme.fg("dim", off2)}\n${TOOL_RESULT_INDENT}${FG_DIM}${total} lines — ctrl+o to expand${RST}\n`,
							BG_BASE,
						),
					);
					return text;
				}
				const maxShow = lines.length;
				const show = lines.slice(0, maxShow);
				const nw = Math.max(3, String(total).length);
				const gw = nw + 3;
				const cw = Math.max(1, tw - gw);

				const header = `${theme.fg("toolTitle", theme.bold("→ read"))} ${theme.fg("toolTitle", p2)}${theme.fg("dim", off2)}`;
				const out: string[] = ["", `${TOOL_RESULT_INDENT}${header}`];
				out.push(`${TOOL_RESULT_INDENT}${FG_RULE}${"─".repeat(tw - 1)}${RST}`);
				for (let i = 0; i < show.length; i++) {
					const ln = (d.offset || 0) + i + 1;
					const code = show[i] ?? "";
					const display = code.length > cw ? code.slice(0, cw) + `${FG_DIM}›${RST}` : code;
					const lineNo = String(ln);
					out.push(
						`${TOOL_RESULT_INDENT}${FG_LNUM}${" ".repeat(Math.max(0, nw - lineNo.length))}${lineNo}${RST} ${FG_RULE}│${RST} ${display}${RST}`,
					);
				}
				if (total > maxShow) {
					out.push(`${TOOL_RESULT_INDENT}${FG_DIM}… ${total - maxShow} more lines (${total} total)${RST}`);
				}
				out.push("");
				const rendered = out.join("\n");
				text.setText(fillToolBackground(rendered, BG_BASE));
				(ctx as any).state._rt = rendered;

				// Async syntax highlighting via Shiki
				renderFileContent(d.content, d.filePath, d.offset || 0, maxShow, tw)
					.then((hl) => {
						const padded = hl
							.split("\n")
							.map((l) => `${TOOL_RESULT_INDENT}${l}`)
							.join("\n");
						const rendered = `\n${TOOL_RESULT_INDENT}${header}\n${padded}\n`;
						text.setText(fillToolBackground(rendered, BG_BASE));
						(ctx as any).state._rt = rendered;
					})
					.catch(() => {});

				return text;
			}

			const fc = result.content?.[0];
			text.setText(
				fillToolBackground(
					`${TOOL_RESULT_INDENT}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`,
					BG_BASE,
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
