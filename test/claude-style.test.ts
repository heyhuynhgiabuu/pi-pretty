import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	installClaudeChatGrouping,
	installClaudeExternalToolRenderers,
	setClaudeStyleAgentActive,
	setClaudeStyleTheme,
	withClaudeToolStyle,
} from "../src/claude-style.js";

// Pi's keybindings are not initialised outside the TUI, so the binding text is stubbed per test.
const toolsExpandKey = vi.hoisted(() => ({ value: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	keyText: () => toolsExpandKey.value,
}));

const theme = { fg: (_k: string, t: string) => t, bold: (t: string) => t };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("claudecode tool style", () => {
	const def = withClaudeToolStyle({
		name: "read",
		label: "Read",
		renderResult: () => ({ render: () => ["FULL"] }),
	});

	it("renders ✓ Name (args) call rows and └ result rows", () => {
		const call = def.renderCall({ path: "src/a.ts" }, theme, { state: {}, isPartial: false, outputPad: 1 } as any);
		expect(strip(call.render(80)[0])).toBe(" ✓ Read (src/a.ts)");
		const result = def.renderResult(
			{ content: [{ type: "text", text: "a\nb" }], details: { _type: "readFile", lineCount: 2 } },
			{ expanded: false },
			theme,
			{ state: {}, durationMs: 20, outputPad: 1 } as any,
		);
		expect(strip(result.render(80)[0])).toBe("   └ 2 lines · ◷ 0.02s");
		const bash = withClaudeToolStyle({ name: "bash", label: "Bash" }).renderResult(
			{ content: [{ type: "text", text: "ok" }] },
			{ expanded: false },
			theme,
			{ state: {}, durationMs: 290, args: { timeout: 300 }, outputPad: 1 } as any,
		);
		expect(strip(bash.render(80)[0])).toBe("   └ 1 line · ◷ 0.29s · timeout 300s");
	});

	it("keeps the original result body when expanded", () => {
		const result = def.renderResult({ content: [] }, { expanded: true }, theme, { state: {}, expanded: true } as any);
		expect(result.render(80)).toEqual(["FULL"]);
	});

	it("expands a locally registered tool after a collapse without handing its renderer a style row", () => {
		// Like pi-pretty's read/bash/find/ls renderers: reuse lastComponent as a mutable Text.
		const textTool = withClaudeToolStyle({
			name: "read",
			label: "Read",
			renderResult: (_r: unknown, _o: unknown, _t: unknown, ctx: any) => {
				const text = ctx.lastComponent ?? {
					lines: [] as string[],
					setText(v: string) {
						this.lines = [v];
					},
					render() {
						return this.lines;
					},
				};
				text.setText("FULL");
				return text;
			},
		});
		const state: Record<string, unknown> = {};
		const run = (expanded: boolean, lastComponent?: unknown) =>
			textTool.renderResult({ content: [] }, { expanded }, theme, { state, expanded, lastComponent } as any);

		const first = run(true);
		const collapsed = run(false, first);
		const again = run(true, collapsed);
		expect(again).toBe(first);
		expect(again.render(80)).toEqual(["FULL"]);
	});

	it("folds consecutive tool calls into a Done group", () => {
		setClaudeStyleTheme(theme);
		const tool = (id: string) => ({
			toolCallId: id,
			toolName: "read",
			result: {},
			isPartial: false,
			render: () => ["", ` ✓ Read (${id})`, "   └ 1 line"],
		});
		const children = [tool("a"), tool("b")];
		const chat = new Container();
		for (const child of children) chat.addChild(child as any);
		installClaudeChatGrouping(true);
		const lines = chat.render(80).map(strip);
		installClaudeChatGrouping(false);
		expect(lines[1]).toBe("✓ Done (2 tool calls)");
		expect(lines[2]).toContain("├─ • Read (a)");
		expect(lines.some((l: string) => l.includes("└─ • Read (b)"))).toBe(true);
	});

	it("expands the clicked tool through the folded group's mouse handler", () => {
		setClaudeStyleTheme(theme);
		let expanded = 0;
		const tool = (id: string) => ({
			toolCallId: id,
			toolName: "read",
			result: {},
			isPartial: false,
			expanded: false,
			setExpanded() {
				expanded++;
			},
			render: () => ["", ` ✓ Read (${id})`, "   └ 1 line"],
		});
		const chat = new Container();
		chat.addChild(tool("a") as never);
		chat.addChild(tool("b") as never);
		installClaudeChatGrouping(true);
		chat.render(80);
		installClaudeChatGrouping(false);
		// Lines: 0 blank, 1 summary, 2-3 tool a rows, 4-5 tool b rows.
		const click = (y: number) =>
			chat.handleMouse({
				type: "click",
				button: "left",
				x: 3,
				y,
				width: 80,
				height: 7,
				screenX: 3,
				screenY: y,
			} as never);
		expect(click(1)).toBeUndefined();
		expect(click(4)?.handled).toBe(true);
		expect(expanded).toBe(1);
	});

	it("does not fold tools it does not style (e.g. pi-diff edit) into a group", () => {
		setClaudeStyleTheme(theme);
		const tool = (id: string, toolName: string, lines: string[]) => ({
			toolCallId: id,
			toolName,
			result: {},
			isPartial: false,
			render: () => lines,
		});
		const chat = new Container();
		chat.addChild(tool("a", "read", [" ✓ Read (a)"]) as never);
		chat.addChild(tool("b", "read", [" ✓ Read (b)"]) as never);
		chat.addChild(tool("c", "edit", ["EDIT HEADER", "+ diff line"]) as never);
		chat.addChild(tool("d", "read", [" ✓ Read (d)"]) as never);
		installClaudeChatGrouping(true);
		const lines = chat.render(80).map(strip);
		installClaudeChatGrouping(false);
		expect(lines.some((l) => l.includes("Done (2 tool calls)"))).toBe(true);
		// The edit keeps its own rows, unindented and outside the tree.
		expect(lines).toContain("EDIT HEADER");
		expect(lines).toContain("+ diff line");
		expect(lines.some((l) => l.includes("Read (d)"))).toBe(true);
		expect(lines.filter((l) => l.includes("Done")).length).toBe(1);
	});

	describe("write/edit from another extension", () => {
		const plain = (text: string) => text.replace(/<\/?[a-z]*>/g, "");
		const tagged = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (t: string) => t };
		const original = (result: any, _options: any, _theme: any, ctx: any) => ({
			render: () => ["DIFF"],
			seen: ctx.lastComponent,
		});

		class FakeToolComponent {
			toolName = "edit";
			getCallRenderer() {
				return () => "provider call";
			}
			expanded = false;
			getResultRenderer() {
				// recall ships no result renderer of its own
				return this.toolName === "recall" ? undefined : original;
			}
			getRenderShell() {
				return "default";
			}
		}

		it("renders +N in success and -N in error color, and restores on disable", () => {
			installClaudeExternalToolRenderers(FakeToolComponent, true);
			const component = new FakeToolComponent();
			expect(component.getRenderShell()).toBe("self");

			const call = (component.getCallRenderer() as any)({ path: "src/a.ts" }, tagged, { state: {}, outputPad: 1 });
			expect(plain(call.render(80)[0])).toContain("Edit (src/a.ts)");

			const result = (component.getResultRenderer() as any)(
				{ content: [], details: { _type: "editInfo", linesAdded: 3, linesRemoved: 1 } },
				{ expanded: false },
				tagged,
				{ state: {}, outputPad: 1 },
			);
			const row = result.render(80)[0] as string;
			expect(row).toContain("<success>+3</> <error>-1</>");

			installClaudeExternalToolRenderers(FakeToolComponent, false);
			expect(component.getRenderShell()).toBe("default");
			expect((component.getCallRenderer() as any)()).toBe("provider call");
		});

		it("hands the provider only its own previous component when expanding after a collapse", () => {
			installClaudeExternalToolRenderers(FakeToolComponent, true);
			const renderResult = (new FakeToolComponent().getResultRenderer() as any).bind(null);
			const state: Record<string, unknown> = {};
			const args = [{ content: [], details: {} }];

			const first = renderResult(...args, { expanded: true }, tagged, { state, expanded: true });
			renderResult(...args, { expanded: false }, tagged, { state, lastComponent: first });
			const again = renderResult(...args, { expanded: true }, tagged, { state, expanded: true, lastComponent: {} });
			expect(again.seen).toBe(first);
			installClaudeExternalToolRenderers(FakeToolComponent, false);
		});

		it("summarizes new files, no-ops and builtin patches", () => {
			installClaudeExternalToolRenderers(FakeToolComponent, true);
			const render = (details: unknown, name = "edit") => {
				const component = new FakeToolComponent();
				component.toolName = name;
				const result = (component.getResultRenderer() as any)({ content: [], details }, { expanded: false }, tagged, {
					state: {},
					outputPad: 1,
				});
				return plain(result.render(80)[0]);
			};
			expect(render({ _type: "new", lines: 24 }, "write")).toContain("new file · +24 -0");
			expect(render({ _type: "noChange" }, "write")).toContain("no changes");
			expect(render({ patch: "--- a\n+++ b\n@@\n-old\n+new\n+more\n" })).toContain("+2 -1");
			const applied = [
				{ path: "a.ts", action: "update", diff: "@@ -1,1 +1,2 @@\n-old\n+new\n+more\n" },
				{ path: "b.ts", action: "add", newContent: "x\ny\nz" },
				{ path: "c.ts", action: "delete", oldContent: "gone" },
			];
			expect(render({ result: { applied } }, "apply_patch")).toContain("+5 -2 · 3 files");
			const patchComponent = new FakeToolComponent();
			patchComponent.toolName = "apply_patch";
			const patchCall = (patchComponent.getCallRenderer() as any)(
				{ changes: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] },
				tagged,
				{ state: {}, outputPad: 1 },
			);
			expect(plain(patchCall.render(80)[0])).toContain("Apply patch (a.ts, +2 more)");
			installClaudeExternalToolRenderers(FakeToolComponent, false);
		});

		it("summarizes recall searches and expansions, leaving expanded output to the host", () => {
			installClaudeExternalToolRenderers(FakeToolComponent, true);
			const component = new FakeToolComponent();
			component.toolName = "recall";
			const call = (component.getCallRenderer() as any)({ query: "codemode", scope: "all", page: 2 }, tagged, {
				state: {},
				outputPad: 1,
			});
			expect(plain(call.render(400)[0])).toContain('Recall ("codemode", all sessions, page 2)');
			const expandCall = (component.getCallRenderer() as any)({ expand: [1, 3] }, tagged, { state: {}, outputPad: 1 });
			expect(plain(expandCall.render(400)[0])).toContain("Recall (expand #1 #3)");

			const row = (result: unknown, args: object) =>
				plain(
					(component.getResultRenderer() as any)(result, { expanded: false }, tagged, {
						state: {},
						outputPad: 1,
						args,
					}).render(400)[0],
				);
			const found = { content: [], details: { total: 12, entries: [{}, {}, {}, {}, {}] } };
			expect(row(found, { query: "x" })).toContain("12 results");
			expect(row({ content: [], details: { total: 0, entries: [] } }, { query: "x" })).toContain("no results");
			expect(row({ content: [], details: { total: 2, entries: [{}, {}] } }, { expand: [1, 2] })).toContain(
				"2 entries expanded",
			);

			component.expanded = true;
			expect(component.getResultRenderer()).toBeUndefined();
			installClaudeExternalToolRenderers(FakeToolComponent, false);
		});

		it("summarizes codemode scripts and shows the source only when expanded", () => {
			installClaudeExternalToolRenderers(FakeToolComponent, true);
			const component = new FakeToolComponent();
			component.toolName = "codemode";
			const code = '// @options: {"timeout_ms": 1000}\nconst r = await tools.read({ path: "a" });\nreturn r;';

			const call = component.getCallRenderer() as any;
			const collapsed = call({ code }, tagged, { state: {}, outputPad: 1 }).render(400);
			expect(collapsed).toHaveLength(1);
			expect(plain(collapsed[0])).toContain('Codemode (const r = await tools.read({ path: "a" });)');
			const expanded = call({ code }, tagged, { state: {}, outputPad: 1, expanded: true }).render(400);
			expect(expanded.length).toBeGreaterThan(1);

			const render = (result: unknown, ctx: object = {}) =>
				plain(
					(component.getResultRenderer() as any)(result, { expanded: false }, tagged, {
						state: {},
						outputPad: 1,
						...ctx,
					}).render(400)[0],
				);
			const ok = {
				content: [
					{ type: "text", text: "Script completed\nWall time 0.4 seconds\nOutput:\n" },
					{ type: "text", text: "one\ntwo" },
				],
				details: { calls: [{ status: "ok", cost: 0.0042 }, { status: "error" }, { status: "ok" }] },
			};
			expect(render(ok)).toContain("3 tool calls · 1 failed · 2 lines · $0.0042");
			const failed = {
				content: [
					{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
					{ type: "text", text: "Script error:\nboom: nope" },
				],
			};
			expect(render(failed, { isError: true })).toContain("boom: nope");
			installClaudeExternalToolRenderers(FakeToolComponent, false);
		});
	});

	it("hints at the expand binding on a folded group and the collapse binding on an expanded call", () => {
		toolsExpandKey.value = "ctrl+o";
		setClaudeStyleTheme(theme);
		const tool = (id: string) => ({
			toolCallId: id,
			toolName: "read",
			result: {},
			isPartial: false,
			render: () => [` ✓ Read (${id})`],
		});
		const chat = new Container();
		chat.addChild(tool("a") as never);
		chat.addChild(tool("b") as never);
		installClaudeChatGrouping(true);
		const summary = chat.render(80).map(strip)[1];
		installClaudeChatGrouping(false);
		expect(summary).toBe("✓ Done (2 tool calls) (ctrl+o to expand)");

		const expandedCall = def.renderCall({ path: "a.ts" }, theme, { state: {}, expanded: true, outputPad: 1 } as any);
		expect(strip(expandedCall.render(80)[0])).toBe(" ✓ Read (a.ts) (ctrl+o to collapse)");
		toolsExpandKey.value = "";
	});
});

describe("settled group cache", () => {
	withClaudeToolStyle({ name: "read", label: "Read" });
	const counted = (id: string, counter: { renders: number }, onExpand?: () => void) => ({
		toolCallId: id,
		toolName: "read",
		result: {},
		isPartial: false,
		expanded: false,
		setExpanded() {
			onExpand?.();
		},
		render: () => {
			counter.renders++;
			return ["", ` ✓ Read (${id})`, "   └ 1 line"];
		},
	});
	const chat = (tools: any[]): Container => {
		const container = new Container();
		for (const tool of tools) container.addChild(tool);
		return container;
	};

	it("does not re-render settled groups on the next frame but keeps live ones live", () => {
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(true);
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		// A message between them keeps the live call out of the settled group, so the two cases
		// are observable side by side: the group is cached, the running row re-renders.
		const live = { ...counted("c", counter), result: undefined, isPartial: true };
		const container = chat([counted("a", counter), counted("b", counter), { render: () => ["msg"] }, live]);
		container.render(80);
		const first = counter.renders;
		counter.renders = 0;
		container.render(80);
		installClaudeChatGrouping(false);
		expect(first).toBe(3);
		// The settled group is served from the cache; only the running row renders again.
		expect(counter.renders).toBe(1);
	});

	it("refreshes rows and mouse owners when the host rebuilds the transcript with the same ids", () => {
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(true);
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		const container = chat([counted("a", counter), counted("b", counter)]);
		expect(container.render(80).map(strip)[2]).toContain("Read (a)");

		// fork / /tree navigation: chatContainer.clear() then renderInitialMessages()
		let clicks = 0;
		container.clear();
		container.addChild(counted("a", counter, () => clicks++) as never);
		container.addChild(counted("b", counter, () => clicks++) as never);
		const lines = container.render(80).map(strip);
		container.handleMouse({ type: "click", button: "left", x: 3, y: 4, width: 80, height: 7 } as never);
		installClaudeChatGrouping(false);
		expect(lines[2]).toContain("Read (a)");
		expect(counter.renders).toBe(4);
		expect(clicks).toBe(1);
	});

	it("keeps caching past the entry cap instead of clearing every entry", () => {
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(false);
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		const container = new Container();
		for (let group = 0; group < 520; group++) {
			container.addChild({ render: () => [`msg ${group}`] } as never);
			container.addChild(counted(`g${group}a`, counter) as never);
			container.addChild(counted(`g${group}b`, counter) as never);
		}
		container.render(80);
		counter.renders = 0;
		container.render(80);
		installClaudeChatGrouping(false);
		// Only the groups past the cap re-render; the cached subset stays warm.
		expect(counter.renders).toBeLessThan(520);
	});

	it("refreshes a group when one of its members is replaced in place", () => {
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(true);
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		const container = chat([counted("a", counter), counted("b", counter), counted("c", counter)]);
		container.render(80);
		// The host swaps a middle component (updateDisplay rebuilds the children array in place).
		(container as unknown as { children: unknown[] }).children[1] = {
			...counted("b", counter),
			render: () => ["", " ✓ Read (NEW-b)", "   └ 1 line"],
		};
		const lines = container.render(80).map(strip);
		installClaudeChatGrouping(false);
		expect(lines.join("\n")).toContain("NEW-b");
	});

	it("refreshes a group when a member result lands in place", () => {
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(true);
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		const late = counted("b", counter) as Record<string, unknown>;
		const container = chat([counted("a", counter), late]);
		expect(container.render(80).map(strip)[1]).toBe("✓ Done (2 tool calls)");
		// tool_execution_end mutates the component instead of replacing it
		late.result = { isError: true };
		late.render = () => ["", " ✗ Read (b)", "   └ boom"];
		const lines = container.render(80).map(strip);
		installClaudeChatGrouping(false);
		expect(lines[1]).toBe("✗ Done (2 tool calls · 1 failed)");
		expect(lines.join("\n")).toContain("boom");
	});

	it("rebuilds rows in the new palette after a theme change", () => {
		const tagged = (tag: string) => ({ fg: (_k: string, t: string) => `[${tag}:${t}]`, bold: (t: string) => t });
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		const container = chat([counted("a", counter), counted("b", counter)]);
		setClaudeStyleTheme(tagged("A"));
		const before = container.render(80)[1];
		setClaudeStyleTheme(tagged("B"));
		const after = container.render(80)[1];
		installClaudeChatGrouping(false);
		expect(before).toContain("[A:✓]");
		expect(after).toContain("[B:✓]");
	});
});

describe("restored dangling tool calls", () => {
	withClaudeToolStyle({ name: "read", label: "Read" });
	const restored = (id: string) => ({
		toolCallId: id,
		toolName: "read",
		result: undefined as unknown,
		isPartial: true,
		expanded: false,
		setExpanded() {},
		render: () => ["", ` · Read (${id})`, "   └ 1 line"],
	});
	const settled = (id: string, isPartial = false) => ({
		toolCallId: id,
		toolName: "read",
		result: {} as unknown,
		isPartial,
		expanded: false,
		setExpanded() {},
		render: () => ["", ` ✓ Read (${id})`, "   └ 1 line"],
	});
	const render = (tools: any[]): string[] => {
		const container = new Container();
		for (const tool of tools) container.addChild(tool);
		installClaudeChatGrouping(true);
		const lines = container.render(80).map(strip);
		installClaudeChatGrouping(false);
		return lines;
	};

	it("reports an interrupted group instead of a frozen Running spinner after a restart", () => {
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(false);
		const lines = render([restored("a"), settled("b")]);
		expect(lines[1]).toBe("✓ Done (2 tool calls · 1 call interrupted)");
		expect(lines[2]).toContain("⊘ Read (a)");
	});

	it("marks a lone restored call, which has no group summary", () => {
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(false);
		expect(render([restored("solo")]).join("\n")).toContain("⊘ Read (solo)");
	});

	it("replaces the state icon whatever the host indent and row colors are", () => {
		// The icon is separated from the row text by padding and its own SGR, which is what the
		// real host produces; a naive leading-match regex misses it.
		const sgrTheme = { fg: (_k: string, t: string) => `\x1b[38;5;245m${t}\x1b[39m`, bold: (t: string) => t };
		setClaudeStyleTheme(sgrTheme);
		setClaudeStyleAgentActive(false);
		installClaudeChatGrouping(true);
		const chatA = new Container();
		chatA.addChild({
			...restored("solo"),
			outputPad: 3,
			render: () => ["", "    · Read (solo)", "   └ 1 line"],
		} as never);
		const lines = chatA.render(80).map(strip);
		installClaudeChatGrouping(false);
		expect(lines[1]).toBe("    ⊘ Read (solo)");
	});

	it("reads Running only while the agent runs, and keeps the mark across a later run", () => {
		setClaudeStyleTheme(theme);
		const live = { ...restored("live"), render: () => ["", " ⠋ Read (live)", "   └ 1 line"] };
		setClaudeStyleAgentActive(true);
		expect(render([live, settled("b")])[1]).toContain("Running (2 tool calls");

		// A restored call marked while idle must not read "Running" in the next run.
		setClaudeStyleAgentActive(false);
		const dead = restored("dead");
		render([dead, settled("b")]);
		setClaudeStyleAgentActive(true);
		expect(render([dead, settled("c", true)])[1]).toContain("1 call interrupted");
	});
});
