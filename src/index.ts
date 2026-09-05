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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionInfoChangedEvent,
} from "@earendil-works/pi-coding-agent";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import { createFffAutocompleteProvider } from "./autocomplete.js";
import { applyConfig, getDefaultAgentDir, loadConfig, normalizeToolList, resolveToolSets } from "./config.js";
import { type FffService, getSharedFffService } from "./fff.js";
import { registerBashTool } from "./tools/bash.js";
import { registerFindTool } from "./tools/find.js";
import { registerGrepTool } from "./tools/grep.js";
import { registerLsTool } from "./tools/ls.js";
import { registerReadTool } from "./tools/read.js";
import type { PiPrettyDeps, SdkTools } from "./types.js";
import {
	createThinkingLabelAnimator,
	createThinkingTimer,
	installPerRowThinkingLabels,
	installWorkingIndicator,
	type PerRowThinkingLabels,
	resolveThinkingIndicatorSettings,
	resolveWorkingIndicatorSettings,
	type ThinkingTimer,
	thinkingBlockActive,
	WORKING_INTERVAL_MS,
	type WorkingIndicatorController,
	workingTokens,
} from "./working-indicator.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_DISABLED_TOOLS = new Set(["ls"]);

function envTools(name: "PRETTY_DISABLE_TOOLS" | "PRETTY_ENABLE_TOOLS"): Set<string> {
	return new Set(normalizeToolList((process.env[name] ?? "").split(",")));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export type { PiPrettyDeps };

export default async function piPrettyExtension(pi: ExtensionAPI, deps?: PiPrettyDeps): Promise<void> {
	const config = loadConfig();
	applyConfig(config);
	const { disabledTools, enabledTools } = resolveToolSets(
		envTools("PRETTY_DISABLE_TOOLS"),
		envTools("PRETTY_ENABLE_TOOLS"),
		config,
	);
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

	const workingSettings = resolveWorkingIndicatorSettings(config.workingIndicator);
	const thinkingSettings = resolveThinkingIndicatorSettings(config.thinkingIndicator);
	let workingController: WorkingIndicatorController | undefined;
	let thinkingTimer: ThinkingTimer | undefined;
	let thinkingInterval: ReturnType<typeof setInterval> | undefined;
	let thinkingLastMessage: unknown;
	let thinkingHiddenCheckedAt = 0;
	let workingSessionName: string | undefined;
	let workingStreaming = false;
	let workingStatsUpdatedAt = 0;
	let perRowLabels: PerRowThinkingLabels | undefined;
	/** Accumulated thinking time per message timestamp — later runs in the same
	 * message resume from this total instead of rewinding to zero. */
	const thinkingElapsedMs = new Map<number, number>();
	const TOKEN_COUNT_FORMAT = new Intl.NumberFormat("en-US");

	/** Message timestamps are the per-row identity the label patch keys on. */
	const messageTimestamp = (message: unknown): number | undefined => {
		const ts = (message as { timestamp?: unknown } | undefined)?.timestamp;
		return typeof ts === "number" ? ts : undefined;
	};

	/** pi persists the thinking-visibility toggle as a top-level settings key. */
	const thinkingHidden = (): boolean => {
		try {
			const dir = getDefaultAgentDir();
			if (!dir) return false;
			const parsed = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as {
				hideThinkingBlock?: unknown;
			};
			return parsed.hideThinkingBlock === true;
		} catch {
			return false;
		}
	};

	/**
	 * True when the 500ms-cached hidden check is stale and settings now show
	 * thinking revealed — the single re-check shared by the ticker and the
	 * completed-phase message_update path (timestamp guard runs before the read).
	 */
	const thinkingRevealed = (): boolean => {
		if (Date.now() - thinkingHiddenCheckedAt <= 500) return false;
		thinkingHiddenCheckedAt = Date.now();
		return !thinkingHidden();
	};

	const safeSessionName = (ctx: ExtensionContext): string | undefined => {
		try {
			return ctx.sessionManager?.getSessionName?.() ?? undefined;
		} catch {
			return undefined;
		}
	};

	// (Re-)install the widget: new session, reload, or session rename (the
	// accent tint tracks the name, omp-style). Preserves streaming state so a
	// mid-stream rename does not drop the row.
	const installIndicator = async (ctx: ExtensionContext): Promise<void> => {
		workingController?.dispose();
		workingController = undefined;
		try {
			const controller = await installWorkingIndicator(ctx.ui, workingSettings, undefined, workingSessionName);
			workingController = controller;
			if (workingStreaming) controller.start();
			// Noop install (disabled/blank) after a previous install → restore pi's loader.
			if (controller.frames.length === 0) ctx.ui.setWorkingVisible?.(true);
		} catch (error: unknown) {
			try {
				ctx.ui.setWorkingVisible?.(true);
			} catch {
				// Host without the API — nothing to restore.
			}
			ctx.ui?.notify?.(
				`pi-pretty working indicator failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
	};

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode === "tui") {
			ctx.ui.setToolsExpanded(false);
			// Per-row hidden-thinking labels: intercept the host's label fan-out so
			// each row keeps its own duration. Falls back to the global-label
			// behavior whenever the host class is missing or reshaped.
			perRowLabels = thinkingSettings.enabled
				? installPerRowThinkingLabels(
						deps?.assistantMessageComponent ??
							(hostSdk as { AssistantMessageComponent?: unknown }).AssistantMessageComponent,
					)
				: undefined;
			workingSessionName = safeSessionName(ctx);
			await installIndicator(ctx);
		}

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

	// Re-apply the indicator when the session is (re)named so the accent tint
	// tracks the name; omp derives the accent the same way.
	pi.on("session_info_changed", async (event: SessionInfoChangedEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (event.name === workingSessionName) return;
		workingSessionName = event.name;
		if (workingSettings.enabled) await installIndicator(ctx);
	});

	// Drive the widget with the streaming lifecycle (host loader is hidden).
	pi.on("agent_start", async (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		workingStreaming = true;
		workingStatsUpdatedAt = 0;
		workingController?.setStats(undefined);
		workingController?.start();
	});
	const stopStreaming = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		if (ctx.mode !== "tui") return;
		workingStreaming = false;
		workingController?.stop();
		stopThinkingShimmer();
	};
	pi.on("agent_end", stopStreaming);
	pi.on("agent_settled", stopStreaming);

	const clearThinkingInterval = (): void => {
		if (!thinkingInterval) return;
		clearInterval(thinkingInterval);
		thinkingInterval = undefined;
	};

	const stopThinkingShimmer = (): void => {
		clearThinkingInterval();
		perRowLabels?.clearActive();
		try {
			thinkingTimer?.restore();
		} catch {
			// Teardown must never throw — a host that explodes on restore is left
			// with whatever label it has; the interval is already gone.
		}
		thinkingTimer = undefined;
		thinkingLastMessage = undefined;
	};

	const completeThinkingShimmer = (): void => {
		clearThinkingInterval();
		const ts = messageTimestamp(thinkingLastMessage);
		const frozenMs = thinkingTimer?.complete();
		if (ts !== undefined && frozenMs !== undefined) {
			thinkingElapsedMs.set(ts, frozenMs);
			perRowLabels?.complete(ts, frozenMs);
		}
		// The completed row is no longer the animating one — drop the active mark
		// so subsequent global writes freeze it at its own duration.
		perRowLabels?.clearActive();
		thinkingLastMessage = undefined;
	};

	/** Surface one warning without letting a throwing host escape the crash guard. */
	const notifyThinkingFailure = (ctx: ExtensionContext, error: unknown): void => {
		try {
			ctx.ui?.notify?.(
				`pi-pretty thinking indicator failed: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		} catch {
			// A host that throws on notify too must not crash the timer path.
		}
	};

	// Same 30fps cadence as the working row — but the interval lives ONLY while
	// the streaming message is actively emitting a thinking block (each label
	// change rebuilds chat children, so the moment text or tool calls stream the
	// label freezes as `Thought for {duration}` until the run ends).
	const startThinkingShimmer = (ctx: ExtensionContext): void => {
		if (thinkingInterval || !thinkingSettings.enabled) return;
		try {
			thinkingHiddenCheckedAt = Date.now();
			if (!thinkingHidden()) return; // thinking visible: no label writes at all
			const animator = createThinkingLabelAnimator(ctx.ui, workingSettings, workingSessionName, thinkingSettings);
			const activeTs = messageTimestamp(thinkingLastMessage);
			// Same message thinking again (interleaved runs): resume its total.
			const resumeMs = activeTs !== undefined ? (thinkingElapsedMs.get(activeTs) ?? 0) : 0;
			thinkingTimer = createThinkingTimer(animator, Date.now, resumeMs);
			if (activeTs !== undefined) perRowLabels?.setActive(activeTs);
			thinkingTimer.tick();
			thinkingInterval = setInterval(() => {
				try {
					if (!workingStreaming) {
						stopThinkingShimmer();
						return;
					}
					if (thinkingRevealed()) {
						stopThinkingShimmer();
						return;
					}
					if (!thinkingBlockActive(thinkingLastMessage)) {
						// Thinking phase over: freeze its duration until the run ends.
						completeThinkingShimmer();
						return;
					}
					thinkingTimer?.tick();
					// The label has no widget of its own — reuse the working widget's
					// TUI handle so the frame lands even when deltas pause mid-thinking.
					workingController?.requestRender();
				} catch (error: unknown) {
					// A throwing host call inside our timer would crash pi (uncaught in
					// setInterval) — tear the label down and surface one warning instead.
					stopThinkingShimmer();
					notifyThinkingFailure(ctx, error);
				}
			}, WORKING_INTERVAL_MS);
		} catch (error: unknown) {
			stopThinkingShimmer();
			notifyThinkingFailure(ctx, error);
		}
	};

	// Remember the streaming message; lazily start the shimmer on the first
	// thinking delta (thinkingHidden() is re-checked at most every 500ms). After
	// the phase completes, deltas keep refreshing the visibility cache so a
	// mid-run `hideThinkingBlock` toggle-off restores the default label.
	pi.on("message_update", async (event: MessageUpdateEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || !workingStreaming) return;
		thinkingLastMessage = event.message;
		// Live token suffix on the working row (throttled to one update/second).
		const now = Date.now();
		if (now - workingStatsUpdatedAt >= 1000) {
			workingStatsUpdatedAt = now;
			const tokens = workingTokens(event.message);
			workingController?.setStats(tokens > 0 ? ` (↓ ${TOKEN_COUNT_FORMAT.format(tokens)} tokens)` : undefined);
		}
		if (thinkingInterval) {
			// Complete immediately on the first text/tool delta instead of waiting
			// for the next animation frame.
			if (!thinkingBlockActive(event.message)) completeThinkingShimmer();
			return;
		}
		if (thinkingBlockActive(event.message)) {
			// First thinking delta — or a later phase after tool calls — starts a
			// fresh timer (the completed one is replaced wholesale).
			startThinkingShimmer(ctx);
			return;
		}
		if (thinkingTimer && thinkingRevealed()) stopThinkingShimmer();
	});

	// The completed wording belongs to the message that produced it. The label
	// is global, so once that assistant message ends, restore pi's default —
	// otherwise every later phase stamps its frozen duration onto every hidden
	// thinking row in the transcript (the image-read "Thought for 5s" stack).
	pi.on("message_end", async (event: MessageEndEvent, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
		if (thinkingInterval || thinkingTimer) stopThinkingShimmer();
	});

	pi.on("session_shutdown", async () => {
		// Tear down the widget animation; pi re-runs session_start (and our
		// install) after resume or session switching.
		workingController?.dispose();
		workingController = undefined;
		stopThinkingShimmer();
		perRowLabels?.uninstall();
		perRowLabels = undefined;
		thinkingElapsedMs.clear();
		workingStreaming = false;
		// Intentionally keep the native FFF finder on session shutdown.
		// Pi can emit shutdown/start during resume or session switching while the
		// process keeps running. Native teardown, or dropping the JS handle while the
		// native LMDB frecency env stays open, can make the next init fail with
		// "environment already open in this program". Let process exit reclaim it.
	});

	// ------------------------------------------------------------------
	// Resolve SDK tools
	// ------------------------------------------------------------------
	// Pi aliases static SDK imports to its host package for managed extensions.
	// Native dynamic imports bypass that alias because the managed npm root omits
	// Pi peer dependencies.

	const sdk: SdkTools = deps?.sdk ?? {
		createReadToolDefinition: hostSdk.createReadToolDefinition,
		createBashToolDefinition: hostSdk.createBashToolDefinition,
		createLsToolDefinition: hostSdk.createLsToolDefinition,
		createFindToolDefinition: hostSdk.createFindToolDefinition,
		createGrepToolDefinition: hostSdk.createGrepToolDefinition,
	};
	const createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
	const createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
	const createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
	const createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
	const createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;

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
}
