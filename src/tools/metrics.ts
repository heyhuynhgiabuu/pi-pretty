/**
 * pi-pretty: tool metrics wrapper — elapsed time + output size.
 *
 * Wraps execute functions to record performance metadata in result.details.
 */

import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHARS_KEY, ELAPSED_KEY } from "../helpers.js";

type ExecuteFn = (
	tid: string,
	params: any,
	sig: AbortSignal | undefined,
	_upd: unknown,
	ctx: ExtensionContext,
) => Promise<AgentToolResult<Record<string, unknown>>>;

export function wrapExecuteWithMetrics(execute: ExecuteFn): ExecuteFn {
	return async (tid, params, sig, upd, ctx) => {
		const start = performance.now();
		const result = await execute(tid, params, sig, upd, ctx);
		const elapsedMs = performance.now() - start;
		const details = (result.details ?? {}) as Record<string, unknown>;
		details[ELAPSED_KEY] = elapsedMs;
		details[CHARS_KEY] = getOutputCharCount(result);
		(result as { details: Record<string, unknown> }).details = details;
		return result;
	};
}

function getOutputCharCount(result: AgentToolResult<unknown>): number {
	const content = result.content;
	if (!Array.isArray(content)) return 0;
	let length = 0;
	for (const block of content) {
		if (block.type !== "text") continue;
		length += String(block.text ?? "").replace(/\r/g, "").length;
	}
	return length;
}
