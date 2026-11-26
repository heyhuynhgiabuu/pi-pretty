/* pi-pretty: read tool -- file reading with syntax highlighting and inline image support. */

import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getReadmePath } from "@earendil-works/pi-coding-agent";
import { BG_BASE, BG_ERROR, FG_DIM, FG_LNUM, FG_RULE, RST, resolveBaseBackground, termWidth } from "../config.js";
import { normalizeLineEndings, shortPath } from "../helpers.js";
import { fillToolBackground, fillToolBody, renderFileContent, renderToolError, toolIndent } from "../render.js";
import { resolveTextCtor } from "../tui-text.js";
import type { ReadDetails, RenderCtxLike, SdkToolDef, TextContent, ThemeLike } from "../types.js";
import { wrapExecuteWithMetrics } from "./metrics.js";

type Result = AgentToolResult<Record<string, unknown>>;

function getPiDocsLabel(filePath: string, cwd: string): string | undefined {
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolve(packageRoot), resolve(cwd, filePath));
	if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return undefined;
	}

	const label = relativePath.split(sep).join("/");
	return label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/") ? label : undefined;
}

function getSkillName(filePath: string, content: string): string | undefined {
	if (basename(filePath) !== "SKILL.md") return undefined;

	const lines = content.split("\n");
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		for (const line of lines.slice(1, end < 0 ? 1 : end)) {
			const match = /^name\s*:\s*(.+?)\s*$/.exec(line);
			if (!match) continue;
			const value = match[1].trim();
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				return value.slice(1, -1).trim() || basename(dirname(filePath));
			}
			return value || basename(dirname(filePath));
		}
	}

	return basename(dirname(filePath));
}

function renderSkillHeader(skillName: string, expanded: boolean, theme: ThemeLike): string {
	const label = theme.fg("accent", "[skill]");
	const name = theme.fg("toolTitle", skillName);
	const hint = theme.fg("dim", `ctrl+o to ${expanded ? "collapse" : "expand"}`);
	return `${label} ${name} ${hint}`;
}

export function registerReadTool(
	pi: ExtensionAPI,
	cwd: string,
	_fffService: unknown,
	sdkTool: SdkToolDef,
	TextComp?: new (t?: string, x?: number, y?: number) => { setText(v: string): void },
	renderContent: typeof renderFileContent = renderFileContent,
): void {
	const TC = resolveTextCtor(TextComp);
	const home = process.env.HOME ?? "";

	pi.registerTool({
		name: "read",
		label: "Read",
		description: sdkTool.description ?? "Read file contents",
		parameters: sdkTool.parameters,
		promptSnippet: sdkTool.promptSnippet,
		promptGuidelines: sdkTool.promptGuidelines,
		constrainedSampling: sdkTool.constrainedSampling,
		outputSchema: sdkTool.outputSchema as ToolDefinition["outputSchema"],
		renderShell: "self",

		execute: wrapExecuteWithMetrics(async (tid, params, sig, _upd, ctx: ExtensionContext) => {
			const p = params as any;
			const result = (await sdkTool.execute(tid, p, sig, undefined, ctx)) as Result;

			const imageBlock = (result.content as any[])?.find((c: any) => c.type === "image");
			if (imageBlock) {
				result.details = {
					...(result.details ?? {}),
					_type: "readImage",
					filePath: String(p.path ?? ""),
				} as ReadDetails;
				return result;
			}

			const tc = normalizeLineEndings(getText(result));
			result.details = {
				...(result.details ?? {}),
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

			const ind = toolIndent(ctx);
			const path = String(args.path ?? "");
			const label = theme.fg("error", theme.bold("→ read"));
			text.setText(fillToolBackground(`\n${ind}${label} ${theme.fg("toolTitle", path)}\n`, BG_ERROR, undefined, ind));
			return text;
		},

		renderResult(result: Result, _opt: unknown, theme: ThemeLike, ctx: RenderCtxLike) {
			resolveBaseBackground(theme);

			const renderToken = nextReadRenderToken(ctx);
			const text = ctx.lastComponent ?? new TC("", 0, 0);
			const ind = toolIndent(ctx);

			if (ctx.isError) {
				text.setText(renderToolError(getText(result) || "Error", theme, ind));
				return text;
			}

			const d = result.details as ReadDetails | undefined;

			// Image content is preserved for ToolExecution's host-generic image pass.
			// Keep the SDK's text note visible as a fallback when host images are hidden
			// or unsupported by the terminal.
			if (d?._type === "readImage") {
				const note = getText(result);
				// Keep fallback text visually separated from the preceding tool row.
				text.setText(note ? fillToolBody(`\n${note}`, BG_BASE) : "");
				return text;
			}

			// File content — line-numbered display
			if (d?._type === "readFile" && d.content) {
				const tw = termWidth();
				const lines = d.content.split("\n");
				const total = lines.length;
				const filePath = String(d.filePath ?? "");
				const skillName = getSkillName(filePath, d.content);
				const p2 = shortPath(cwd, home, filePath);
				const off2 = typeof d.offset === "number" ? `:${d.offset}` : "";
				if (!ctx.expanded) {
					if (skillName) {
						const header = renderSkillHeader(skillName, false, theme);
						text.setText(fillToolBody(`\n${ind}${header}\n`, BG_BASE, undefined, ind));
						return text;
					}
					const docsLabel = getPiDocsLabel(filePath, cwd);
					const title = docsLabel
						? `${theme.fg("toolTitle", theme.bold("→ read docs"))} ${theme.fg("toolTitle", docsLabel)}`
						: `${theme.fg("toolTitle", theme.bold("→ read"))} ${theme.fg("toolTitle", p2)}`;
					text.setText(
						fillToolBody(
							`\n${ind}${title}${theme.fg("dim", off2)} ${FG_DIM}${total} lines — ctrl+o to expand${RST}`,
							BG_BASE,
							undefined,
							ind,
						),
					);
					return text;
				}
				const maxShow = lines.length;
				const show = lines.slice(0, maxShow);
				const offset = d.offset || 0;
				const nw = Math.max(3, String(offset + total).length);
				const gw = nw + 3;
				// Default pad 1 keeps its historical budget; extra padding is subtracted so rows do not grow.
				const cw = Math.max(1, tw - gw - Math.max(0, ind.length - 1));

				const header = skillName
					? renderSkillHeader(skillName, true, theme)
					: `${theme.fg("toolTitle", theme.bold("→ read"))} ${theme.fg("toolTitle", p2)}${theme.fg("dim", off2)}`;
				const highlightRequest: ReadHighlightRequest = {
					content: d.content,
					filePath: d.filePath,
					offset,
					maxLines: maxShow,
					width: cw,
				};
				const cachedHighlight = getCachedReadHighlight(ctx, highlightRequest);
				if (cachedHighlight !== undefined) {
					const highlighted = buildHighlightedRead(cachedHighlight, header, skillName, offset, nw, tw, ind);
					text.setText(fillToolBody(highlighted, BG_BASE, undefined, ind));
					return text;
				}

				const out: string[] = ["", `${ind}${header}`, ""];
				out.push(`${ind}${FG_RULE}${"─".repeat(Math.max(1, tw - ind.length))}${RST}`);
				for (let i = 0; i < show.length; i++) {
					const ln = offset + i + 1;
					const code = show[i] ?? "";
					const display = code.length > cw ? `${code.slice(0, Math.max(0, cw - 1))}${FG_DIM}›${RST}` : code;
					const lineNo = String(ln);
					out.push(
						`${ind}${FG_LNUM}${" ".repeat(Math.max(0, nw - lineNo.length))}${lineNo}${RST} ${FG_RULE}│${RST} ${display}${RST}`,
					);
				}
				if (total > maxShow) {
					out.push(`${ind}${FG_DIM}… ${total - maxShow} more lines (${total} total)${RST}`);
				}
				const rendered = out.join("\n");
				text.setText(fillToolBody(rendered, BG_BASE, undefined, ind));

				// Async syntax highlighting via Shiki. The component is reused across
				// expansion changes, so stale work must not restore an older view.
				renderContent(d.content, d.filePath, offset, maxShow, cw)
					.then((hl) => {
						if (!isCurrentReadRender(ctx, renderToken)) return;
						setCachedReadHighlight(ctx, highlightRequest, hl);
						const highlighted = buildHighlightedRead(hl, header, skillName, offset, nw, tw, ind);
						text.setText(fillToolBody(highlighted, BG_BASE, undefined, ind));
						ctx.invalidate?.();
					})
					.catch(() => {});

				return text;
			}

			const fc = result.content?.[0];
			text.setText(
				fillToolBody(
					`${ind}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`,
					BG_BASE,
					undefined,
					ind,
				),
			);
			return text;
		},
	} as unknown as ToolDefinition<any, any, any>);
}

const READ_RENDER_TOKEN = "__piPrettyReadRenderToken";
const READ_HIGHLIGHT_CACHE = "__piPrettyReadHighlightCache";

type ReadHighlightRequest = {
	content: string;
	filePath: string;
	offset: number;
	maxLines: number;
	width: number;
};

type ReadHighlightCache = ReadHighlightRequest & {
	highlighted: string;
};

function nextReadRenderToken(ctx: RenderCtxLike): number {
	const state = ctx.state;
	const token = typeof state[READ_RENDER_TOKEN] === "number" ? state[READ_RENDER_TOKEN] + 1 : 1;
	state[READ_RENDER_TOKEN] = token;
	return token;
}

function isCurrentReadRender(ctx: RenderCtxLike, token: number): boolean {
	return ctx.state[READ_RENDER_TOKEN] === token;
}

function getCachedReadHighlight(ctx: RenderCtxLike, request: ReadHighlightRequest): string | undefined {
	const cache = ctx.state[READ_HIGHLIGHT_CACHE] as ReadHighlightCache | undefined;
	if (!cache) return undefined;
	if (
		cache.content !== request.content ||
		cache.filePath !== request.filePath ||
		cache.offset !== request.offset ||
		cache.maxLines !== request.maxLines ||
		cache.width !== request.width
	) {
		return undefined;
	}
	return cache.highlighted;
}

function setCachedReadHighlight(ctx: RenderCtxLike, request: ReadHighlightRequest, highlighted: string): void {
	ctx.state[READ_HIGHLIGHT_CACHE] = {
		...request,
		highlighted,
	} satisfies ReadHighlightCache;
}

function buildHighlightedRead(
	highlighted: string,
	header: string,
	skillName: string | undefined,
	offset: number,
	nw: number,
	tw: number,
	ind: string,
): string {
	const padded = highlighted
		.split("\n")
		.map((line, index) => {
			const lineNo = String(offset + index + 1);
			return `${ind}${FG_LNUM}${" ".repeat(Math.max(0, nw - lineNo.length))}${lineNo}${RST} ${FG_RULE}│${RST} ${line}${RST}`;
		})
		.join("\n");
	const divider = skillName ? `${ind}${FG_RULE}${"─".repeat(Math.max(1, tw - ind.length))}${RST}\n` : "";
	return `\n${ind}${header}\n\n${divider}${padded}`;
}

function getText(result: Result): string {
	return (
		((result.content ?? []) as TextContent[])
			.filter((c) => c.type === "text")
			.map((c) => c.text)
			.join("\n") ?? ""
	);
}
