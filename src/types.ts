/**
 * pi-pretty shared types.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Re-export FFF types needed by tools
// ---------------------------------------------------------------------------

export type { FileFinder, FileItem, GrepCursor, GrepMatch, GrepResult, SearchResult } from "@ff-labs/fff-node";

// ---------------------------------------------------------------------------
// Content / Result types
// ---------------------------------------------------------------------------

export type ToolContent = TextContent | ImageContent;
export type { ImageContent, TextContent };
// ---------------------------------------------------------------------------
// Theme / rendering context types
// ---------------------------------------------------------------------------

export interface ThemeLike {
	fg: (key: string, text: string) => string;
	bold: (text: string) => string;
	getBgAnsi?: (key: string) => string;
}

export interface RenderCtxLike {
	lastComponent?: ComponentLike;
	isError?: boolean;
	state: Record<string, string | undefined>;
	expanded?: boolean;
}

export interface TextLike {
	setText(v: string): void;
	getText?(): string;
}

/** Minimal Component interface matching pi-tui's Component. */
export interface ComponentLike {
	setText(v: string): void;
	render(width: number): string[];
	invalidate?(): void;
}

// ---------------------------------------------------------------------------
// Render detail types
// ---------------------------------------------------------------------------

export type ReadDetails =
	| { _type: "readImage"; filePath: string }
	| { _type: "readFile"; filePath: string; content: string; offset: number; lineCount: number };

export interface BashDetails extends Record<string, unknown> {
	_type: "bashResult";
	text: string;
	exitCode: number | null;
	command: string;
}

export interface LsDetails extends Record<string, unknown> {
	_type: "lsResult";
	text: string;
	path: string;
	entryCount: number;
}

export interface FindDetails extends Record<string, unknown> {
	_type: "findResult";
	text: string;
	pattern: string;
	matchCount: number;
	notices?: string[];
}

export interface GrepDetails extends Record<string, unknown> {
	_type: "grepResult";
	text: string;
	pattern: string;
	matchCount: number;
}

export type AnyDetails = ReadDetails | BashDetails | LsDetails | FindDetails | GrepDetails;

// ---------------------------------------------------------------------------
// Tool input types
// ---------------------------------------------------------------------------

export interface ReadInput {
	path: string;
	offset?: number;
	limit?: number;
}

export interface BashInput {
	command: string;
	timeout?: number;
}

export interface LsInput {
	path?: string;
}

export interface FindInput {
	pattern: string;
	path?: string;
	limit?: number;
}

export interface GrepInput {
	pattern: string;
	path?: string;
	glob?: string;
	context?: number;
	limit?: number;
	literal?: boolean;
	ignoreCase?: boolean;
}

// ---------------------------------------------------------------------------
// SDK tool definition shape (DI-friendly — accepts both mock and real SDK)
// ---------------------------------------------------------------------------

/**
 * Minimal structural type for an SDK-produced tool definition.
 * Accepts both the real SDK's ToolDefinition<> return type and test mocks.
 */
export interface SdkToolDef {
	name?: string;
	description?: string;
	label?: string;
	parameters?: unknown;
	execute: (...args: any[]) => Promise<AgentToolResult<any>>;
}

export interface SdkTools {
	createReadTool?: (cwd: string) => SdkToolDef;
	createReadToolDefinition?: (cwd: string) => SdkToolDef;
	createBashTool?: (cwd: string) => SdkToolDef;
	createBashToolDefinition?: (cwd: string) => SdkToolDef;
	createLsTool?: (cwd: string) => SdkToolDef;
	createLsToolDefinition?: (cwd: string) => SdkToolDef;
	createFindTool?: (cwd: string) => SdkToolDef;
	createFindToolDefinition?: (cwd: string) => SdkToolDef;
	createGrepTool?: (cwd: string) => SdkToolDef;
	createGrepToolDefinition?: (cwd: string) => SdkToolDef;
	getAgentDir?: () => string;
}

// ---------------------------------------------------------------------------
// FFF service interfaces
// ---------------------------------------------------------------------------

/** Minimal FFF service shape for tools that only need fileSearch. */
export interface FffServiceLike {
	readonly isAvailable: boolean;
	readonly partialIndex: boolean;
	getFinder(): import("@ff-labs/fff-node").FileFinder | null;
}

/** Full FFF service for grep tools that also need cursor store. */
export interface FffServiceWithCursor extends FffServiceLike {
	getCursorStore(): CursorStore;
}

/** FFF lifecycle interface (used by session lifecycle code). */
export interface FffService extends FffServiceWithCursor {
	ensureFinder(cwd: string): Promise<void>;
	destroy(): void;
	isModuleLoaded(): boolean;
	tryLoadModule(): Promise<boolean>;
}

export interface CursorStore {
	store(cursor: unknown): string;
	get(id: string): unknown | undefined;
}

// ---------------------------------------------------------------------------
// DI
// ---------------------------------------------------------------------------

export interface PiPrettyDeps {
	sdk?: SdkTools;
	TextComponent?: new (text?: string, x?: number, y?: number) => ComponentLike;
	fffModule?: typeof import("@ff-labs/fff-node");
	/** Host AssistantMessageComponent class for the per-row label patch; defaults
	 * to the package export. Injectable so tests can verify against the exact
	 * class instance they construct rows from. */
	assistantMessageComponent?: unknown;
}
