/* pi-pretty: bash tool -- command execution with styled output. */

import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { BG_BASE, FG_DIM, MAX_PREVIEW_LINES, resolveBaseBackground, TOOL_RESULT_INDENT, termWidth } from "../config.js";
import { compactErrorLines, inferBashExitCode, stripBashExitStatusLine } from "../helpers.js";
import { fillToolBackground, renderToolDuration, renderToolError } from "../render.js";
import { resolveTextCtor } from "../tui-text.js";
import type { BashDetails, ComponentLike, RenderCtxLike, SdkToolDef, TextContent, ThemeLike } from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

type Result = AgentToolResult<Record<string, unknown>>;

export function registerBashTool(
	pi: ExtensionAPI,
	_cwd: string,
	_fffService: unknown,
	sdkTool: SdkToolDef,
	TextComp?: new (t?: string, x?: number, y?: number) => { setText(v: string): void },
): void {
	const TC = resolveTextCtor(TextComp);

	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: sdkTool.description
			? `${sdkTool.description} For text search: \`rg -n\`.`
			: "Execute shell commands. For text search: `rg -n`.",
		promptSnippet: "Execute commands via bash. For text search: `rg -n`.",
		promptGuidelines: [
			"For text search: `rg -n`. If no results, try `rg -u` (respects .gitignore by default).",
			"In rg: | means alternation, \\| means literal pipe. Opposite of GNU grep. Never use \\| for alternation.",
		],
		parameters: sdkTool.parameters,
		renderShell: "self",

		execute: wrapExecuteWithMetrics(async (tid, params, sig, _upd, ctx: ExtensionContext) => {
			try {
				return (await sdkTool.execute(tid, params, sig, undefined, ctx)) as Result;
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text" as const, text: msg }],
					isError: true,
					details: {
						_type: "bashResult",
						text: msg,
						exitCode: 1,
						command: String((params as any).command ?? ""),
					} as BashDetails,
				};
			}
		}),

		renderCall(args: any, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);
			const text = ctx.lastComponent ?? new TC("", 0, 0);
			const t = typeof args.timeout === "number" ? ` ${theme.fg("muted", `(timeout ${args.timeout}s)`)}` : "";
			const tw = termWidth() || 80;
			const rawCmd = String(args.command ?? "");
			const headerBudget = ctx.expanded ? tw : Math.max(8, tw - 20);
			const cmd =
				rawCmd.length === 0
					? theme.fg("toolOutput", "...")
					: !ctx.expanded && rawCmd.length > headerBudget
						? `${rawCmd.slice(0, Math.max(1, headerBudget))}…`
						: rawCmd;
			const commandLabel = theme.fg(ctx.isError ? "error" : "toolTitle", theme.bold(`$ ${cmd}`));
			text.setText(
				fillToolBackground(`\n${TOOL_RESULT_INDENT}${commandLabel}${t}`, undefined, ctx.expanded ? undefined : tw),
			);
			return text;
		},

		renderResult(result: Result, _opt: unknown, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);

			const text = ctx.lastComponent ?? new TC("", 0, 0);

			const details = result.details;
			const tc = getText(result);
			const d: BashDetails | undefined =
				(details as BashDetails)?._type === "bashResult"
					? (details as BashDetails)
					: tc || ctx.isError
						? {
								_type: "bashResult",
								text: tc || "Error",
								exitCode: inferBashExitCode(tc, ctx.isError ? 1 : 0),
								command: "",
							}
						: undefined;

			if (d?._type === "bashResult") {
				const isErr = ctx.isError || (d.exitCode !== null && d.exitCode !== 0);
				const cleaned = stripBashExitStatusLine(d.text);
				const output = isErr ? compactErrorLines(cleaned).join("\n") : cleaned;
				const lineCount = output.split("\n").length;
				const info = [`${lineCount} lines`, renderToolDuration(result), !ctx.expanded ? "ctrl+o to expand" : ""]
					.filter(Boolean)
					.map((part) => theme.fg("dim", part))
					.join(theme.fg("dim", " · "));
				const header = `${TOOL_RESULT_INDENT}${info}`;
				const rw = termWidth();

				const renderFn = (w: number) => {
					if (!ctx.expanded) return fillToolBackground(`${header}\n`, undefined, w);
					if (!output.trim()) return fillToolBackground(`${header}\n`, undefined, w);
					const show = output.split("\n");
					const out = [header, "", ...show.map((line: string) => `${TOOL_RESULT_INDENT}${line}`)];
					return fillToolBackground(`${out.join("\n")}\n`, undefined, w);
				};

				text.setText(renderFn(rw));
				const baseRender =
					typeof (text as ComponentLike).render === "function" ? (text as ComponentLike).render.bind(text) : null;
				if (baseRender) {
					let key: string | undefined;
					(text as unknown as Record<string, unknown>).render = (w: number) => {
						const width = Math.max(1, Math.floor(w || termWidth()));
						const k = `bash:${ctx.expanded ? "1" : "0"}:${width}:${d.exitCode ?? "killed"}:${output.length}:${renderToolDuration(result)}`;
						if (key !== k) {
							text.setText(renderFn(width));
							key = k;
						}
						return baseRender(width);
					};
				}
				return text;
			}

			if (ctx.isError) {
				text.setText(renderToolError(tc || "Error", theme));
				return text;
			}
			const fc = result.content?.[0];
			text.setText(
				fillToolBackground(
					`${TOOL_RESULT_INDENT}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`,
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
