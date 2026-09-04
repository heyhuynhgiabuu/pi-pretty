import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiPrettyDeps } from "../src/types.js";

/**
 * Lifecycle wiring for the hidden-thinking elapsed timer: index.ts drives the
 * animator from agent/message events. Seam: the extension factory against a
 * mock pi + fake ExtensionUIContext; `HOME` is redirected to a temp dir so
 * `hideThinkingBlock` is read from a settings.json we control.
 */

const SGR_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (s: string): string => s.replace(SGR_RE, "");

async function freshExtension() {
	vi.resetModules();
	return (await import("../src/index.js")).default;
}

let homeDir: string;
let agentDir: string;
let labels: Array<string | undefined>;
let notifications: Array<{ message: string; type: string }>;
let events: Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>;
let mockPi: { registerTool: ReturnType<typeof vi.fn>; registerCommand: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };

const writeSettings = (hideThinkingBlock: boolean): void => {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hideThinkingBlock }));
};

function makeCtx() {
	return {
		mode: "tui" as const,
		cwd: "/tmp/test",
		sessionManager: { getSessionName: () => undefined },
		ui: {
			theme: { fg: (_n: "dim", t: string) => t, getFgAnsi: (n: string) => `\x1b[38;5;${n.length}m` },
			setToolsExpanded: vi.fn(),
			setWorkingVisible: vi.fn(),
			setWidget: vi.fn(),
			setHiddenThinkingLabel: vi.fn((label?: string) => {
				labels.push(label);
			}),
			notify: vi.fn((message: string, type: string) => {
				notifications.push({ message, type });
			}),
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	homeDir = mkdtempSync(join(tmpdir(), "pi-pretty-timer-"));
	agentDir = join(homeDir, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeSettings(true);
	process.env.HOME = homeDir;
	for (const name of [
		"PRETTY_ICONS",
		"PRETTY_THEME",
		"PRETTY_MAX_HL_CHARS",
		"PRETTY_MAX_PREVIEW_LINES",
		"PRETTY_CACHE_LIMIT",
		"PRETTY_WORKING_INDICATOR",
		"PRETTY_WORKING_INDICATOR_MODE",
		"PRETTY_WORKING_INDICATOR_TEXT",
		"PRETTY_THINKING_INDICATOR",
		"PRETTY_DISABLE_TOOLS",
		"PRETTY_ENABLE_TOOLS",
	]) {
		vi.stubEnv(name, "");
	}
	labels = [];
	notifications = [];
	events = new Map();
	mockPi = {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			events.set(event, handler);
		}),
	};
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	delete process.env.HOME;
	rmSync(homeDir, { recursive: true, force: true });
});

async function loadExtension() {
	const extension = await freshExtension();
	const deps = { sdk: {} } as unknown as PiPrettyDeps;
	await extension(mockPi, deps);
	const ctx = makeCtx();
	await events.get("session_start")!({}, ctx);
	await events.get("agent_start")!({}, ctx);
	return ctx;
}

const thinkingMessage = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] };
const textAfterThinking = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "hmm" },
		{ type: "text", text: "answer" },
	],
};

describe("thinking timer lifecycle wiring", () => {
	it("ticks elapsed wording, freezes on the first text delta, and restores at run end", async () => {
		const ctx = await loadExtension();
		const start = Date.now();

		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		expect(stripAnsi(labels.at(-1) ?? "")).toBe("Thinking... 0s");

		vi.setSystemTime(start + 12_500);
		vi.advanceTimersByTime(33);
		expect(stripAnsi(labels.at(-1) ?? "")).toBe("Thinking... 12s");

		await events.get("message_update")!({ message: textAfterThinking }, ctx);
		expect(labels.at(-1)).toBe("Thought for 12s");

		const count = labels.length;
		vi.setSystemTime(start + 60_000);
		vi.advanceTimersByTime(330);
		await events.get("message_update")!({ message: textAfterThinking }, ctx);
		expect(labels.length).toBe(count); // frozen — no further label writes

		await events.get("agent_end")!({}, ctx);
		expect(labels.at(-1)).toBeUndefined();
	});

	it("restarts a fresh timer for a second thinking phase after tool calls", async () => {
		const ctx = await loadExtension();
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		await events.get("message_update")!({ message: textAfterThinking }, ctx);
		expect(labels.at(-1)).toBe("Thought for 0s");

		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		expect(stripAnsi(labels.at(-1) ?? "")).toBe("Thinking... 0s");
		vi.advanceTimersByTime(33);
		const afterTick = stripAnsi(labels.at(-1) ?? "");
		expect(afterTick).toMatch(/^Thinking\.\.\. 0s$/); // fresh timer, not the old phase
	});

	it("restores the default label when thinking is revealed mid-phase while ticking", async () => {
		const ctx = await loadExtension();
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		vi.advanceTimersByTime(330);
		expect(labels.length).toBeGreaterThan(1);

		writeSettings(false);
		vi.setSystemTime(Date.now() + 600);
		vi.advanceTimersByTime(33 * 20); // interval visibility recheck fires
		expect(labels.at(-1)).toBeUndefined();
		const count = labels.length;
		vi.advanceTimersByTime(330);
		expect(labels.length).toBe(count); // interval torn down — no further writes
	});

	it("restores the default label at message end so completed wording does not stack", async () => {
		const ctx = await loadExtension();
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		await events.get("message_update")!({ message: textAfterThinking }, ctx);
		expect(labels.at(-1)).toBe("Thought for 0s");

		// Non-assistant messages must not touch the frozen label
		await events.get("message_end")!({ message: { role: "toolResult", content: [] } }, ctx);
		expect(labels.at(-1)).toBe("Thought for 0s");

		// The assistant message ending restores pi's default immediately — the
		// global label must not stamp this duration onto every older thinking row
		await events.get("message_end")!({ message: textAfterThinking }, ctx);
		expect(labels.at(-1)).toBeUndefined();

		// A later phase in the same run starts a fresh timer
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		expect(stripAnsi(labels.at(-1) ?? "")).toBe("Thinking... 0s");
	});

	it("restores the default label when thinking is revealed mid-run after completion", async () => {
		const ctx = await loadExtension();
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		await events.get("message_update")!({ message: textAfterThinking }, ctx);
		expect(labels.at(-1)).toBe("Thought for 0s");

		writeSettings(false);
		vi.setSystemTime(Date.now() + 600);
		await events.get("message_update")!({ message: textAfterThinking }, ctx);
		expect(labels.at(-1)).toBeUndefined();
	});

	it("never writes a label when thinking blocks are visible", async () => {
		writeSettings(false);
		const ctx = await loadExtension();
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		vi.advanceTimersByTime(330);
		await events.get("message_update")!({ message: textAfterThinking }, ctx);
		await events.get("agent_end")!({}, ctx);
		expect(labels).toEqual([]);
	});

	it("tears the label down with one warning when the host throws inside the ticker", async () => {
		const ctx = await loadExtension();
		ctx.ui.setHiddenThinkingLabel = vi.fn((label?: string) => {
			labels.push(label);
			if (labels.length > 3) throw new Error("host exploded");
		});
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		expect(() => vi.advanceTimersByTime(330)).not.toThrow();
		expect(labels.at(-1)).toBeUndefined(); // restored, not left mid-shimmer
		expect(notifications.some((n) => n.type === "warning" && n.message.includes("thinking indicator failed"))).toBe(
			true,
		);
	});

	it("restores on session shutdown mid-phase", async () => {
		const ctx = await loadExtension();
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		vi.advanceTimersByTime(330);
		await events.get("session_shutdown")!({}, ctx);
		expect(labels.at(-1)).toBeUndefined();
	});

	it("feeds the working-row token suffix: 1/s throttle, agent_start reset, ticker requestRender", async () => {
		const ctx = await loadExtension();
		// Materialize the real widget through the captured setWidget factory — the
		// factory closure returns the same instance the controller drives.
		const widgetCalls = (ctx.ui.setWidget as ReturnType<typeof vi.fn>).mock.calls as Array<{
			0: string;
			1: (tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[] };
		}>;
		const factory = widgetCalls.find((call) => call[0] === "pi-pretty-working")?.[1];
		expect(factory).toBeDefined();
		const tuiRenders: number[] = [];
		const widget = factory!({ requestRender: () => void tuiRenders.push(1) }, undefined) as unknown as {
			render(w: number): string[];
			setStats(text: string | undefined): void;
		};
		const statsWrites: Array<string | undefined> = [];
		const originalSetStats = widget.setStats.bind(widget);
		widget.setStats = (text: string | undefined) => {
			statsWrites.push(text);
			originalSetStats(text);
		};

		const textMessage = (chars: number) => ({
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(chars) }],
		});

		await events.get("message_update")!({ message: textMessage(400) }, ctx);
		expect(statsWrites).toEqual([" (↓ 100 tokens)"]);
		// Same-second deltas are throttled away
		await events.get("message_update")!({ message: textMessage(600) }, ctx);
		await events.get("message_update")!({ message: textMessage(800) }, ctx);
		expect(statsWrites).toHaveLength(1);

		vi.setSystemTime(Date.now() + 1100);
		await events.get("message_update")!({ message: textMessage(800) }, ctx);
		expect(statsWrites.at(-1)).toBe(" (↓ 200 tokens)");
		expect(stripAnsi(widget.render(120)[0] ?? "")).toContain("(↓ 200 tokens)");

		// The thinking ticker reuses the widget's TUI handle for its renders
		await events.get("message_update")!({ message: thinkingMessage }, ctx);
		const before = tuiRenders.length;
		vi.advanceTimersByTime(99);
		expect(tuiRenders.length).toBeGreaterThan(before);

		// A new run resets the suffix
		await events.get("agent_end")!({}, ctx);
		await events.get("agent_start")!({}, ctx);
		expect(statsWrites.at(-1)).toBeUndefined();
	});
});
