import { MAX_PREVIEW_LINES } from "./config.js";

/** Render context from pi tool UI (Ctrl+O toggles `expanded` per tool block). */
export type ToolRenderCtx = { expanded?: boolean };

/** Lines to show in tool result body when collapsed vs expanded. */
export function previewLineCount(ctx: ToolRenderCtx, totalLines: number): number {
	if (ctx.expanded) return totalLines;
	return Math.min(totalLines, MAX_PREVIEW_LINES);
}
