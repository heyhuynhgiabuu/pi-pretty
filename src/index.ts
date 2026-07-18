/**
 * pi-pretty — Pretty terminal output for pi built-in tools.
 *
 * Enhances read, bash, ls, find, and grep with:
 *   • Syntax-highlighted file content (Shiki)
 *   • Colored bash exit status + output
 *   • Tree-view directory listings with file-type icons
 *   • FFF-accelerated find/grep with SDK fallback
 *   • Custom ANSI rendering for all tools
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createFffAutocompleteProvider } from "./autocomplete.js";
import { getDefaultAgentDir } from "./config.js";
import { type FffService, getSharedFffService } from "./fff.js";
import { registerBashTool } from "./tools/bash.js";
import { registerFindTool } from "./tools/find.js";
import { registerGrepTool } from "./tools/grep.js";
import { registerLsTool } from "./tools/ls.js";
import { registerReadTool } from "./tools/read.js";
import type { PiPrettyDeps } from "./types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_DISABLED_TOOLS = new Set(["ls"]);

function envTools(name: "PRETTY_DISABLE_TOOLS" | "PRETTY_ENABLE_TOOLS"): Set<string> {
	return new Set(
		(process.env[name] ?? "")
			.split(",")
			.map((tool) => tool.trim().toLowerCase())
			.filter(Boolean),
	);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export type { PiPrettyDeps };

export default async function piPrettyExtension(pi: ExtensionAPI, deps?: PiPrettyDeps): Promise<void> {
	const disabledTools = envTools("PRETTY_DISABLE_TOOLS");
	const enabledTools = envTools("PRETTY_ENABLE_TOOLS");
	const isToolEnabled = (name: string) => {
		const normalizedName = name.toLowerCase();
		return (
			!disabledTools.has(normalizedName) &&
			(!DEFAULT_DISABLED_TOOLS.has(normalizedName) || enabledTools.has(normalizedName))
		);
	};
	const cwd = process.cwd();

	// ------------------------------------------------------------------
	// FFF service init
	// ------------------------------------------------------------------
	// Keep FFF independent from the Pi SDK import. Published extension installs
	// run in Pi's isolated npm root; importing a nested Pi SDK at activation time
	// has proven crash-prone across host Pi versions. FFF commands and indexing
	// should still work even when SDK tool factories are unavailable.

	const maybeGetAgentDir = deps?.sdk?.getAgentDir;
	const agentDir = typeof maybeGetAgentDir === "function" ? maybeGetAgentDir() : getDefaultAgentDir();
	const fffService: FffService | null = getSharedFffService(deps?.fffModule, agentDir);

	// Text component for custom rendering (DI-friendly)
	const TextComp = deps?.TextComponent;

	// ------------------------------------------------------------------
	// FFF commands
	// ------------------------------------------------------------------

	if (fffService) {
		pi.registerCommand("fff-health", {
			description: "Show FFF file finder health and indexer status",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const fff = fffService;
				if (!fff || !fff.isAvailable) {
					ctx.ui.notify("FFF not initialized", "warning");
					return;
				}
				const finder = fff.getFinder();
				if (!finder) {
					ctx.ui.notify("FFF not initialized", "warning");
					return;
				}
				const health = finder.healthCheck();
				if (!health.ok) {
					ctx.ui.notify(`Health check failed: ${health.error}`, "error");
					return;
				}
				const h = health.value;
				const lines = [
					`FFF v${h.version}`,
					`Git: ${h.git.repositoryFound ? `yes (${h.git.workdir ?? "unknown"})` : "no"}`,
					`Picker: ${h.filePicker.initialized ? `${h.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
					`Frecency: ${h.frecency.initialized ? "active" : "disabled"}`,
					`Query tracker: ${h.queryTracker.initialized ? "active" : "disabled"}`,
					`Partial index: ${fff.partialIndex ? "yes (scan timed out)" : "no"}`,
				];
				const progress = finder.getScanProgress();
				if (progress.ok) {
					lines.push(
						`Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
					);
				}
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		pi.registerCommand("fff-rescan", {
			description: "Trigger FFF to rescan files",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const fff = fffService!;
				if (!fff.isAvailable) {
					ctx.ui.notify("FFF not initialized", "warning");
					return;
				}
				const finder = fff.getFinder();
				if (!finder) {
					ctx.ui.notify("FFF not initialized", "warning");
					return;
				}
				const result = finder.scanFiles();
				if (!result.ok) {
					ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
					return;
				}
				fff.partialIndex = false;
				ctx.ui.notify("FFF rescan triggered", "info");
			},
		});
	}

	// ------------------------------------------------------------------
	// Session lifecycle
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (!fffService) return;

		try {
			// Try dynamic import if sync require failed
			if (!fffService.isModuleLoaded()) {
				const loaded = await fffService.tryLoadModule();
				if (!loaded) return;
			}

			await fffService.ensureFinder(ctx.cwd);
			if (fffService.partialIndex) {
				ctx.ui?.notify?.("FFF: scan timed out — using partial index. Run /fff-rescan when ready.", "warning");
			} else {
				const ui = ctx.ui;
				ui?.setStatus?.("fff", "FFF indexed");
				setTimeout(() => ui?.setStatus?.("fff", undefined), 3000);
			}

			// Register FFF-backed @-mention autocomplete only after a finder exists.
			ctx.ui?.addAutocompleteProvider?.((current) =>
				createFffAutocompleteProvider(current, () => fffService?.getFinder() ?? null),
			);
		} catch (error: unknown) {
			ctx.ui?.notify?.(`FFF init failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		// Intentionally keep the native FFF finder on session shutdown.
		// Pi can emit shutdown/start during resume or session switching while the
		// process keeps running. Native teardown, or dropping the JS handle while the
		// native LMDB frecency env stays open, can make the next init fail with
		// "environment already open in this program". Let process exit reclaim it.
	});

	// ------------------------------------------------------------------
	// Resolve SDK tools, if available
	// ------------------------------------------------------------------
	// The SDK import is optional. Do not return from the extension if it fails;
	// FFF commands/indexing above must remain available in published npm installs.

	let sdk: any = deps?.sdk ?? {};
	let createReadTool: any = sdk.createReadTool ?? sdk.createReadToolDefinition;
	let createBashTool: any = sdk.createBashTool ?? sdk.createBashToolDefinition;
	let createLsTool: any = sdk.createLsTool ?? sdk.createLsToolDefinition;
	let createFindTool: any = sdk.createFindTool ?? sdk.createFindToolDefinition;
	let createGrepTool: any = sdk.createGrepTool ?? sdk.createGrepToolDefinition;

	if (!deps) {
		try {
			// Dynamic import() uses ESM resolution (not CJS interop), so it
			// correctly resolves subpath exports like @earendil-works/pi-ai/base
			// which only have "import" conditions in their exports map.
			const mod = await import("@earendil-works/pi-coding-agent");
			sdk = mod;
			createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
			createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
			createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
			createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
			createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;
		} catch {
			createReadTool = undefined;
			createBashTool = undefined;
			createLsTool = undefined;
			createFindTool = undefined;
			createGrepTool = undefined;
		}
	}

	// ------------------------------------------------------------------
	// Tool registration
	// ------------------------------------------------------------------

	if (isToolEnabled("read") && createReadTool) {
		registerReadTool(pi, cwd, null, createReadTool(cwd), TextComp);
	}
	if (isToolEnabled("bash") && createBashTool) {
		registerBashTool(pi, cwd, null, createBashTool(cwd), TextComp);
	}
	if (isToolEnabled("ls") && createLsTool) {
		registerLsTool(pi, cwd, null, createLsTool(cwd), TextComp);
	}
	if (isToolEnabled("find") && createFindTool) {
		registerFindTool(pi, cwd, fffService, createFindTool(cwd), TextComp);
	}
	if (isToolEnabled("grep") && createGrepTool) {
		registerGrepTool(pi, cwd, fffService, createGrepTool(cwd), TextComp);
	}

	// Fallback padding for SDK-rendered tool bodies. The SDK reads
	// result.content[0].text and slices collapsed output to roughly the first
	// 10 lines, so insert bottom padding inside that visible slice.
	const PADDED_TOOLS = new Set(["read", "grep", "bash"]);
	const RESULT_LEFT_PAD = "    ";
	const BOTTOM_PADDING_BY_TOOL: Record<string, number> = { read: 2, grep: 2, bash: 0 };
	pi.on("tool_result", (event, _ctx) => {
		if (!PADDED_TOOLS.has(event.toolName)) return undefined;
		const first = event.content[0];
		if (!first || first.type !== "text") return undefined;
		const lines = first.text.split("\n").map((line) => `${RESULT_LEFT_PAD}${line}`);
		if (lines.length === 0) return undefined;

		const padCount = BOTTOM_PADDING_BY_TOOL[event.toolName] ?? 0;
		lines.push(...Array.from({ length: padCount }, () => RESULT_LEFT_PAD));

		return {
			content: [{ type: "text" as const, text: lines.join("\n") }, ...event.content.slice(1)],
		};
	});
}
