import { FG_DIM, RST, TOOL_RESULT_INDENT } from "./config.js";

/** Shown in collapsed tool results; Pi keybinding is still `app.tools.expand` (Ctrl+O). */
export const COLLAPSED_EXPAND_LABEL = "ctrl+o to expand";

/** Collapsed hint line (no extra blank lines above/below). */
export function collapsedExpandBlock(countLabel: string): string {
	return `${TOOL_RESULT_INDENT}${FG_DIM}${countLabel} — ${COLLAPSED_EXPAND_LABEL}${RST}\n`;
}

/** When line count / metrics already appear on the header line (bash). */
export function collapsedExpandFooter(): string {
	return `${TOOL_RESULT_INDENT}${FG_DIM}${COLLAPSED_EXPAND_LABEL}${RST}\n`;
}
