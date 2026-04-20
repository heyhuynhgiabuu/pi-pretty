/**
 * FFF helper functions — extracted for testability.
 *
 * Pure functions and classes used by the FFF integration in index.ts.
 */

import type { GrepCursor, GrepMatch } from "@ff-labs/fff-node";

function sanitizeGrepRecordContent(text: string): string {
	let content = text;
	if (content.endsWith("\r\n")) content = content.slice(0, -2);
	else if (content.endsWith("\r") || content.endsWith("\n")) content = content.slice(0, -1);

	return content.replace(/\r\n/g, "\\n").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function truncateGrepRecordContent(text: string): string {
	const content = sanitizeGrepRecordContent(text);
	return content.length > 500 ? `${content.slice(0, 500)}...` : content;
}

/**
 * Store for FFF grep pagination cursors.
 * Evicts oldest entry when exceeding maxSize.
 */
export class CursorStore {
	private cursors = new Map<string, GrepCursor>();
	private counter = 0;
	private maxSize: number;

	constructor(maxSize = 200) {
		this.maxSize = maxSize;
	}

	store(cursor: GrepCursor): string {
		const id = `fff_c${++this.counter}`;
		this.cursors.set(id, cursor);
		if (this.cursors.size > this.maxSize) {
			const first = this.cursors.keys().next().value;
			if (first) this.cursors.delete(first);
		}
		return id;
	}

	get(id: string): GrepCursor | undefined {
		return this.cursors.get(id);
	}

	get size(): number {
		return this.cursors.size;
	}
}

/**
 * Convert FFF GrepResult items to ripgrep-style "file:line:content" text.
 * This ensures pi-pretty's renderGrepResults works unchanged.
 */
export function fffFormatGrepText(items: GrepMatch[], limit: number): string {
	const capped = items.slice(0, limit);
	if (!capped.length) return "No matches found";

	const lines: string[] = [];
	let currentFile = "";

	for (const match of capped) {
		if (match.relativePath !== currentFile) {
			if (currentFile) lines.push("");
			currentFile = match.relativePath;
		}
		if (match.contextBefore?.length) {
			const startLine = match.lineNumber - match.contextBefore.length;
			for (let i = 0; i < match.contextBefore.length; i++) {
				lines.push(`${match.relativePath}-${startLine + i}-${truncateGrepRecordContent(match.contextBefore[i] ?? "")}`);
			}
		}
		lines.push(`${match.relativePath}:${match.lineNumber}:${truncateGrepRecordContent(match.lineContent)}`);
		if (match.contextAfter?.length) {
			const startLine = match.lineNumber + 1;
			for (let i = 0; i < match.contextAfter.length; i++) {
				lines.push(`${match.relativePath}-${startLine + i}-${truncateGrepRecordContent(match.contextAfter[i] ?? "")}`);
			}
		}
	}

	return lines.join("\n");
}
