import { initTheme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	installClaudeChatGrouping,
	installClaudeExternalToolRenderers,
	setClaudeStyleAgentActive,
	setClaudeStyleExpandFileTools,
	setClaudeStyleGroupInlineTools,
	setClaudeStyleTheme,
	withClaudeToolStyle,
} from "../src/claude-style.js";

// `highlightCode` resolves colours through the global theme, so a codemode script rendered outside
// the TUI throws "Theme not initialized" before this file ever mocks the module away.
initTheme("dark", false);
// Pi's keybindings are not initialised outside the TUI, so the binding text is stubbed per test.
const toolsExpandKey = vi.hoisted(() => ({ value: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	keyText: () => toolsExpandKey.value,
}));

const theme = { fg: (_k: string, t: string) => t, bold: (t: string) => t };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
/** A painted header is padded to the render width, so compare its text without trailing space. */
const rowText = (s: string) => strip(s).trimEnd();

describe("claudecode tool style", () => {
	const def = withClaudeToolStyle({
		name: "read",
		label: "Read",
		renderResult: () => ({ render: () => ["FULL"] }),
	});

	it("renders ✓ Name (args) call rows and └ result rows", () => {
		const call = def.renderCall({ path: "src/a.ts" }, theme, { state: {}, isPartial: false, outputPad: 1 } as any);
		expect(rowText(call.render(80)[0])).toBe(" ✓ Read (src/a.ts)");
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

	it("keeps an expanded file tool inside the group and shows its diff there", () => {
		// The reason you expand an edit is to read the diff next to the call it belongs to, so a
		// file tool stays inside the group instead of breaking it apart.
		setClaudeStyleTheme(theme);
		for (const name of ["edit", "write", "apply_patch"]) withClaudeToolStyle({ name, label: name });
		const tool = (id: string, name: string, expanded: boolean) => ({
			toolCallId: id,
			toolName: name,
			result: {},
			isPartial: false,
			expanded,
			render: () =>
				expanded
					? ["", ` ✓ ${name} (src/a.ts)`, "   └ +2 -1", "     +added line", "     -removed line"]
					: ["", ` ✓ ${name} (src/a.ts)`, "   └ +2 -1"],
		});
		const chat = new Container();
		chat.addChild(tool("a", "edit", false) as never);
		chat.addChild(tool("b", "edit", true) as never);
		installClaudeChatGrouping(true);
		const lines = (chat.render(60) as string[]).map(strip);
		installClaudeChatGrouping(false);

		expect(lines.some((l: string) => l.includes("Done (2 tool calls)"))).toBe(true);
		expect(lines.some((l: string) => l.includes("+added line"))).toBe(true);
		expect(lines.some((l: string) => l.includes("-removed line"))).toBe(true);
	});

	it("keeps a diff row's own background and blank spacing, but not the tool row's", () => {
		// pi-diff paints added lines green and removed lines red. That background is the diff's
		// content, so an inlined body row keeps it; the tool's own row background would stripe the
		// group and is still dropped.
		setClaudeStyleTheme(theme);
		withClaudeToolStyle({ name: "edit", label: "Edit" });
		const toolBg = "\x1b[48;2;30;30;46m";
		const addBg = "\x1b[48;2;30;52;40m";
		const delBg = "\x1b[48;2;60;30;30m";
		const member = (id: string, expanded: boolean) => ({
			toolCallId: id,
			toolName: "edit",
			result: {},
			isPartial: false,
			expanded,
			render: () =>
				expanded
					? ["", `${toolBg} ✓ Edit (src/a.ts)`, `   ${addBg}+added`, "", `   ${delBg}-removed`]
					: ["", `${toolBg} ✓ Edit (src/a.ts)`, "   └ +1 -1"],
		});
		const chat = new Container();
		chat.addChild(member("a", false) as never);
		chat.addChild(member("b", true) as never);
		installClaudeChatGrouping(true);
		const lines = chat.render(60) as string[];
		installClaudeChatGrouping(false);
		const joined = lines.join("\n");

		// The diff keeps its own colours and the blank row that separates its hunks. Targeted at the
		// row between `+added` and `-removed`: a stray blank elsewhere (the group's own trailing
		// spacer) would otherwise satisfy a looser check.
		expect(joined).toContain(addBg);
		expect(joined).toContain(delBg);
		const addedAt = lines.findIndex((l: string) => l.includes("+added"));
		const removedAt = lines.findIndex((l: string) => l.includes("-removed"));
		expect(removedAt - addedAt).toBe(2);
		expect(strip(lines[addedAt + 1]).trim()).toBe("");
		// The tool row's background is still dropped, so the group is not a stack of bars.
		expect(joined).not.toContain(toolBg);
	});

	it("strips the background from an expanded file tool's error message", () => {
		// pi-diff paints a failed write/edit with the tool error background. That row is a message,
		// not a diff line, so it must not keep the background inside the tree.
		setClaudeStyleTheme(theme);
		withClaudeToolStyle({ name: "edit", label: "Edit" });
		const errBg = "\x1b[48;2;60;30;30m";
		const toolBg = "\x1b[48;2;30;30;46m";
		const member = (id: string, expanded: boolean) => ({
			toolCallId: id,
			toolName: "edit",
			// `isError` lives on the result, which is what the host reads too.
			result: { isError: true },
			isPartial: false,
			expanded,
			render: () =>
				expanded
					? ["", `${toolBg} ✗ Edit (src/a.ts)`, `   ${errBg}failed: permission denied`]
					: ["", `${toolBg} ✗ Edit (src/a.ts)`, "   └ failed"],
		});
		const chat = new Container();
		chat.addChild(member("a", false) as never);
		chat.addChild(member("b", true) as never);
		installClaudeChatGrouping(true);
		const joined = (chat.render(60) as string[]).join("\n");
		installClaudeChatGrouping(false);

		expect(joined).toContain("permission denied");
		expect(joined).not.toContain(errBg);
		expect(joined).not.toContain(toolBg);
	});

	it("opens a file tool by default when expandFileTools is on", () => {
		// `claudeStyle.expandFileTools`: the diff is there without a click. Only once a result
		// exists — there is nothing to show before that — and only once per tool, so a later
		// collapse (a click, or Ctrl+O) sticks instead of being undone on the next frame.
		setClaudeStyleTheme(theme);
		withClaudeToolStyle({ name: "edit", label: "Edit" });
		setClaudeStyleAgentActive(true);
		setClaudeStyleExpandFileTools(true);
		const calls: boolean[] = [];
		const member = (id: string, hasResult: boolean) => ({
			toolCallId: id,
			toolName: "edit",
			result: hasResult ? {} : undefined,
			isPartial: false,
			expanded: false,
			setExpanded(value: boolean) {
				calls.push(value);
				(this as any).expanded = value;
			},
			render: () => ["", ` ✓ Edit (${id})`, "   └ +1 -1"],
		});
		const container = new Container();
		container.addChild(member("a", true) as never);
		container.addChild(member("b", false) as never);
		installClaudeChatGrouping(true);
		container.render(80);
		container.render(80);
		installClaudeChatGrouping(false);
		setClaudeStyleExpandFileTools(false);

		// Opened once for the tool that has a result, never for the one still running, and not
		// re-opened on the second frame because it is already expanded.
		expect(calls).toEqual([true]);
	});

	it("lets a click or Ctrl+O collapse a file tool it opened by default", () => {
		// Re-opening on every frame would silently undo the user's collapse, and the host would
		// still report "Tool output: collapsed" while the diff stayed open.
		setClaudeStyleTheme(theme);
		withClaudeToolStyle({ name: "edit", label: "Edit" });
		setClaudeStyleAgentActive(true);
		setClaudeStyleExpandFileTools(true);
		let opened = 0;
		const member = (id: string) => ({
			toolCallId: id,
			toolName: "edit",
			result: {},
			isPartial: false,
			expanded: false,
			setExpanded(value: boolean) {
				opened++;
				(this as any).expanded = value;
			},
			render: () => ["", ` ✓ Edit (${id})`, "   └ +1 -1"],
		});
		const container = new Container();
		container.addChild(member("a") as never);
		container.addChild(member("b") as never);
		installClaudeChatGrouping(true);
		container.render(80);
		expect(opened).toBe(2);
		// The user collapses both, as Ctrl+O does, then the host renders again.
		for (const child of container.children as any[]) if (child.expanded) child.setExpanded(false);
		opened = 0;
		container.render(80);
		container.render(80);
		installClaudeChatGrouping(false);
		setClaudeStyleExpandFileTools(false);

		expect(opened).toBe(0);
		expect((container.children as any[]).every((c) => c.expanded === false)).toBe(true);
	});

	it("keeps a config-listed tool inside its group when expanded", () => {
		// `claudeStyle.groupInlineTools`: any tool with a short body can keep its group, not just the
		// file tools. Set and reset in try/finally because an assertion failure would otherwise leak
		// the module-level state into every later test.
		setClaudeStyleTheme(theme);
		withClaudeToolStyle({ name: "bash", label: "Bash" });
		setClaudeStyleAgentActive(true);
		const render = (grouped: boolean) => {
			setClaudeStyleGroupInlineTools(grouped ? ["bash"] : undefined);
			const member = (id: string) => ({
				toolCallId: id,
				toolName: "bash",
				result: {},
				isPartial: false,
				expanded: true,
				render: () => ["", ` ✓ Bash (${id})`, "   └ out"],
			});
			const container = new Container();
			container.addChild(member("a") as never);
			container.addChild(member("b") as never);
			installClaudeChatGrouping(true);
			const rows = container.render(80) as string[];
			installClaudeChatGrouping(false);
			return rows;
		};
		const text = (rows: string[]) => strip(rows.join("\n"));
		try {
			// Off: an expanded non-file tool breaks the group, so each member renders flat.
			const flat = text(render(false));
			expect(flat).not.toContain("Done (2 tool calls)");

			// On: the group survives and both expanded bodies sit on its tree rows.
			const grouped = text(render(true));
			expect(grouped).toContain("Done (2 tool calls)");
			expect(grouped).toContain("├─ • Bash (a)");
			expect(grouped).toContain("└─ • Bash (b)");
			// The point of the key is the body staying in the group, so assert the bodies too.
			expect(grouped).toContain("└ out");
		} finally {
			setClaudeStyleGroupInlineTools(undefined);
			setClaudeStyleAgentActive(false);
		}
	});

	it("keeps an image-bearing tool out of the group, collapsed or expanded", () => {
		// A tree row drops image payload lines, so grouping an image result hides the image behind its
		// fallback note. The host adds image components regardless of expansion, so this cannot depend
		// on it — and it must not be a `read`-only rule.
		setClaudeStyleTheme(theme);
		withClaudeToolStyle({ name: "read", label: "Read" });
		withClaudeToolStyle({ name: "bash", label: "Bash" });
		setClaudeStyleAgentActive(true);
		const render = (toolName: string, expanded: boolean) => {
			setClaudeStyleGroupInlineTools([toolName]);
			const member = (id: string) => ({
				toolCallId: id,
				toolName,
				result: { content: [{ type: "image", mimeType: "image/png", data: "AAA" }] },
				isPartial: false,
				expanded,
				render: () => ["", ` ✓ ${toolName} (${id})`, "   [image]"],
			});
			const container = new Container();
			container.addChild(member("a") as never);
			container.addChild(member("b") as never);
			installClaudeChatGrouping(true);
			const rows = (container.render(80) as string[]).map(strip);
			installClaudeChatGrouping(false);
			return rows.join("\n");
		};
		// Positive assertions too: a negative-only check would also pass if nothing rendered at all.
		const expectFlat = (toolName: string, expanded: boolean) => {
			const text = render(toolName, expanded);
			expect(text).not.toContain("Done (2 tool calls)");
			expect(text).toContain(`✓ ${toolName} (a)`);
			expect(text).toContain(`✓ ${toolName} (b)`);
			expect(text.match(/\[image\]/g) ?? []).toHaveLength(2);
		};
		try {
			// Collapsed and expanded, and for a tool other than `read`.
			expectFlat("read", true);
			expectFlat("read", false);
			expectFlat("bash", false);
		} finally {
			setClaudeStyleGroupInlineTools(undefined);
			setClaudeStyleAgentActive(false);
		}
	});

	it("leaves a file tool collapsed when expandFileTools is off", () => {
		setClaudeStyleTheme(theme);
		withClaudeToolStyle({ name: "edit", label: "Edit" });
		setClaudeStyleAgentActive(true);
		setClaudeStyleExpandFileTools(false);
		let opened = 0;
		const member = () => ({
			toolCallId: "a",
			toolName: "edit",
			result: {},
			isPartial: false,
			expanded: false,
			setExpanded() {
				opened++;
			},
			render: () => ["", " ✓ Edit (a)", "   └ +1 -1"],
		});
		const container = new Container();
		container.addChild(member() as never);
		container.addChild({ ...member(), toolCallId: "b" } as never);
		installClaudeChatGrouping(true);
		container.render(80);
		installClaudeChatGrouping(false);

		expect(opened).toBe(0);
	});

	it("still breaks the group apart for a tool whose body a tree row cannot carry", () => {
		// read highlights asynchronously and can hold an image payload; bash output runs to hundreds
		// of lines. Keeping either inside a cached group would freeze the pre-highlight text, drop
		// the image, or bury the rest of the transcript.
		setClaudeStyleTheme(theme);
		for (const name of ["read", "bash", "codemode", "recall"]) withClaudeToolStyle({ name, label: name });
		const tool = (id: string, name: string) => ({
			toolCallId: id,
			toolName: name,
			result: {},
			isPartial: false,
			expanded: true,
			render: () => ["", ` ✓ ${name} (${id})`, "   └ 300 lines"],
		});
		const chat = new Container();
		chat.addChild(tool("a", "read") as never);
		chat.addChild(tool("b", "bash") as never);
		installClaudeChatGrouping(true);
		const lines = (chat.render(60) as string[]).map(strip);
		installClaudeChatGrouping(false);

		expect(lines.some((l: string) => l.includes("Done (2 tool calls)"))).toBe(false);
		expect(lines.some((l: string) => l.includes("read (a)"))).toBe(true);
		expect(lines.some((l: string) => l.includes("bash (b)"))).toBe(true);
	});

	it("strips the painted background from a folded group's member rows", () => {
		// Group rows are a tree of tool rows. Keeping the background would put a painted bar
		// beside the guide column on every member, striping most of a claudecode transcript.
		setClaudeStyleTheme(theme);
		const bg = "\x1b[48;2;30;30;46m";
		// A palette foreground rides along, so a strip that threw away every colour instead of
		// only the background would be caught here.
		const fg = "\x1b[38;5;45m";
		const painted = (id: string) => ({
			toolCallId: id,
			toolName: "read",
			result: {},
			isPartial: false,
			expanded: false,
			render: () => ["", `${bg}${fg} ✓ Read (${id})`, `${bg}${fg}   └ 1 line`],
		});
		const chat = new Container();
		chat.addChild(painted("a") as never);
		chat.addChild(painted("b") as never);
		installClaudeChatGrouping(true);
		const lines = chat.render(60) as string[];
		installClaudeChatGrouping(false);

		expect(lines.join("\n")).not.toContain(bg);
		expect(lines.join("\n")).toContain(fg);
		expect(strip(lines.join("\n"))).toContain("Read (a)");
	});

	it("does not fold tools it does not style (e.g. pi-diff edit) into a group", () => {
		// `styledToolNames` is module-global and other tests register `read`/`edit`, so this uses
		// names nothing else claims. Relying on the shipped names made the test order-dependent.
		setClaudeStyleTheme(theme);
		const styled = withClaudeToolStyle({ name: "unstyledProbeStyled", label: "Styled" });
		expect(styled.name).toBe("unstyledProbeStyled");
		const tool = (id: string, toolName: string, lines: string[]) => ({
			toolCallId: id,
			toolName,
			result: {},
			isPartial: false,
			render: () => lines,
		});
		const chat = new Container();
		chat.addChild(tool("a", "unstyledProbeStyled", [" ✓ Styled (a)"]) as never);
		chat.addChild(tool("b", "unstyledProbeStyled", [" ✓ Styled (b)"]) as never);
		chat.addChild(tool("c", "unstyledProbeOther", ["OTHER HEADER", "+ diff line"]) as never);
		chat.addChild(tool("d", "unstyledProbeStyled", [" ✓ Styled (d)"]) as never);
		installClaudeChatGrouping(true);
		const lines = chat.render(80).map(strip);
		installClaudeChatGrouping(false);
		expect(lines.some((l) => l.includes("Done (2 tool calls)"))).toBe(true);
		// The unstyled tool keeps its own rows, unindented and outside the tree.
		expect(lines).toContain("OTHER HEADER");
		expect(lines).toContain("+ diff line");
		expect(lines.some((l) => l.includes("Styled (d)"))).toBe(true);
		expect(lines.filter((l) => l.includes("Done")).length).toBe(1);
	});

	describe("write/edit from another extension", () => {
		const plain = (text: string) => text.replace(/<\/?[A-Za-z]*>/g, "");
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
			// Rendered wider than 80: this test's fake theme tags are plain text, so `visibleWidth`
			// counts the colour name itself and the row would truncate before the closing paren.
			expect(plain(patchCall.render(100)[0])).toContain("Apply patch (a.ts, +2 more)");
			installClaudeExternalToolRenderers(FakeToolComponent, false);
		});

		it("summarizes recall searches and expansions, painting the expanded output", () => {
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

			// Expanded, recall has no renderer of its own, so the host fallback would draw plain
			// `toolOutput` text on a "self" shell with no box — an unpainted body. Paint it here.
			component.expanded = true;
			const bg = "\x1b[48;2;30;30;46m";
			const bgTheme = { fg: (_k: string, t: string) => t, bold: (t: string) => t, getBgAnsi: () => bg };
			const expanded = (component.getResultRenderer() as any)(
				{ content: [{ type: "text", text: "line one\nline two" }], details: {} },
				{ expanded: true },
				bgTheme,
				{ state: {}, outputPad: 1, expanded: true },
			);
			const bodyRows = expanded.render(60) as string[];
			expect(bodyRows).toHaveLength(2);
			for (const row of bodyRows) expect(row).toContain(bg);

			// The host fallback wrapped (it was a Text component); truncating would drop the tail of
			// a long entry with no way to reach it. Every character must survive a narrow width.
			const long = `head-${"x".repeat(120)}-tail`;
			const wrapped = (component.getResultRenderer() as any)(
				{ content: [{ type: "text", text: long }], details: {} },
				{ expanded: true },
				bgTheme,
				{ state: {}, outputPad: 1, expanded: true },
			).render(40) as string[];
			expect(wrapped.length).toBeGreaterThan(1);
			for (const row of wrapped) expect(row).toContain(bg);
			const joined = strip(wrapped.join(""));
			expect(joined).toContain("head-");
			expect(joined).toContain("-tail");

			// Parity with the host fallback this replaces: it stripped ANSI and binary controls,
			// replaced tabs with three spaces, and drew with `toolOutput`. A raw escape reaching the
			// terminal can reprogram it, so it must never survive.
			const draw = (text: string) =>
				(component.getResultRenderer() as any)(
					{ content: [{ type: "text", text }], details: {} },
					{ expanded: true },
					bgTheme,
					{ state: {}, outputPad: 1, expanded: true },
				).render(40) as string[];
			const escapeRow = draw("\x1b]0;pwned\x07visible\x1b[2J");
			expect(escapeRow.join("")).not.toContain("\x1b]");
			expect(escapeRow.join("")).not.toContain("\x1b[2J");
			expect(strip(escapeRow.join(""))).toContain("visible");
			// Sanitization parity with the host for the nastier sequences. pi-tui's
			// stripTerminalSequences is NOT usable here: it scans to the first m/G/K/H/J, so
			// "keep ESC[?25l me" loses the text between, and it misses C1 entirely.
			const clean = (input: string) => strip(draw(input).join("")).replace(/ +$/gm, "").trimEnd();
			expect(clean("a\u009b?25lb")).toBe("ab");
			expect(clean("a\x1b[?25lb")).toBe("ab");
			expect(clean("a\x1b[<35;59;1Mb")).toBe("ab");
			expect(clean("a\x1b]8;;http://x\x07b")).toBe("ab");
			expect(clean("a\x1b]52;c;Zm9v\x07b")).toBe("ab");
			expect(clean("a\x07b")).toBe("ab");
			expect(clean("a\rb")).toBe("ab");
			// Host order matters here: stripping ANSI before CR keeps "[31m" as visible text,
			// because the CR breaks the sequence. Removing CR first would make it a real SGR.
			expect(clean("a\x1b\r[31mb")).toBe("a[31mb");
			// The text between a private CSI and what follows survives; the host keeps it too.
			expect(clean("keep\x1b[?25lme")).toBe("keepme");

			// Sanitized per block. Joining first would let the unterminated OSC run past the block
			// boundary and swallow the next block's text up to its BEL.
			const multi = (component.getResultRenderer() as any)(
				{
					content: [
						{ type: "text", text: "keep\x1b]title" },
						{ type: "text", text: "visible\x07after" },
					],
					details: {},
				},
				{ expanded: true },
				bgTheme,
				{ state: {}, outputPad: 1, expanded: true },
			).render(60) as string[];
			const multiText = strip(multi.join("\n"));
			expect(multiText).toContain("visible");
			expect(multiText).toContain("after");

			// A whole SGR pair must vanish as a pair. Dropping only the ESC would leave `[31m` on
			// screen as literal text, so this pins the sequence strip, not just the control filter.
			const sgr = draw("a\x1b[31mb");
			expect(strip(sgr.join(""))).not.toContain("[31m");
			expect(strip(sgr.join("")).trimEnd()).toBe("ab");
			// A bare NUL is not part of any sequence: only the control-character filter catches it.
			expect(strip(draw("a\u0000b").join("")).trimEnd()).toBe("ab");
			// The host drew this body with `toolOutput`; an identity theme would hide that.
			const markTheme = { fg: (k: string, t: string) => `<${k}>${t}</>`, bold: (t: string) => t, getBgAnsi: () => bg };
			const tinted = (component.getResultRenderer() as any)(
				{ content: [{ type: "text", text: "hello" }], details: {} },
				{ expanded: true },
				markTheme,
				{ state: {}, outputPad: 1, expanded: true },
			).render(40) as string[];
			expect(tinted.join("")).toContain("<toolOutput>");

			const tabbed = draw("a\tb");
			expect(tabbed.join("")).not.toContain("\t");
			expect(strip(tabbed.join("")).trimEnd()).toBe("a   b");
			installClaudeExternalToolRenderers(FakeToolComponent, false);
		});

		it("paints a foreign tool's expanded result body but not pi-diff's", () => {
			// codemode's expanded body is `theme.fg`-only text, and its shell is "self" so the host
			// draws no box: unpainted it floats on the terminal background. pi-diff paints its own
			// green/red hunks, and filling over them would replace the information.
			const bg = "\x1b[48;2;30;30;46m";
			const bgTheme = { fg: (_k: string, t: string) => t, bold: (t: string) => t, getBgAnsi: () => bg };
			const bodyOf = (toolName: string) => {
				installClaudeExternalToolRenderers(FakeToolComponent, true);
				const component = new FakeToolComponent();
				component.toolName = toolName;
				const rows = (component.getResultRenderer() as any)({ content: [], details: {} }, { expanded: true }, bgTheme, {
					state: {},
					outputPad: 1,
					expanded: true,
					lastComponent: undefined,
				}).render(60) as string[];
				installClaudeExternalToolRenderers(FakeToolComponent, false);
				return rows;
			};

			const codeMode = bodyOf("codemode");
			expect(codeMode).toHaveLength(1);
			expect(codeMode[0]).toContain("DIFF");
			expect(codeMode[0]).toContain(bg);
			// write/edit/apply_patch keep pi-diff's own rows untouched.
			expect(bodyOf("write")).toEqual(["DIFF"]);
			expect(bodyOf("apply_patch")).toEqual(["DIFF"]);
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

		it("paints the expanded call body as well as the header row", () => {
			// Only codemode passes a call body to claudeRenderers, so it is the one path where this
			// assertion has rows to check. The claudecode shell is "self", so the host draws no box:
			// leaving the body unpainted shows the terminal's own background as a hole under the
			// header.
			const bg = "\x1b[48;2;30;30;46m";
			const bgTheme = { fg: (_k: string, t: string) => t, bold: (t: string) => t, getBgAnsi: () => bg };
			installClaudeExternalToolRenderers(FakeToolComponent, true);
			const component = new FakeToolComponent();
			component.toolName = "codemode";
			const call = component.getCallRenderer() as any;
			const rows = call({ code: "const a = 1;\nconst b = 2;" }, bgTheme, {
				state: {},
				outputPad: 1,
				expanded: true,
			}).render(60) as string[];
			installClaudeExternalToolRenderers(FakeToolComponent, false);

			// Without body rows this test would silently pass; prove there are some.
			expect(rows.length).toBeGreaterThan(1);
			for (const row of rows) expect(row).toContain(bg);
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
		expect(rowText(expandedCall.render(80)[0])).toBe(" ✓ Read (a.ts) (ctrl+o to collapse)");
		toolsExpandKey.value = "";
	});

	it("draws the tool name in the toolTitle colour, not the default text colour", () => {
		// The tool name is the one thing that tells two collapsed calls apart, so it uses the
		// dedicated colour rather than `text`. A tag theme pins which colour was asked for.
		const tagged = { fg: (color: string, text: string) => `<${color}>${text}</>`, bold: (t: string) => t };
		const call = def.renderCall({ path: "a.ts" }, tagged, { state: {}, outputPad: 1 } as any);
		const line = call.render(200)[0] as string;
		expect(line).toContain("<toolTitle>Read</>");
		expect(line).not.toContain("<text>Read</>");
	});

	it("paints the call row's background across the full width", () => {
		// The claudecode shell is "self", so the host draws no box and pi-pretty owns the row.
		// Without a fill the header has no background at all; without padding the colour stops
		// at the text instead of reaching the edge.
		const bgTheme = {
			fg: (_k: string, t: string) => t,
			bold: (t: string) => t,
			getBgAnsi: () => "\x1b[48;2;30;30;46m",
		};
		const call = def.renderCall({ path: "a.ts" }, bgTheme, { state: {}, outputPad: 1 } as any);
		const line = call.render(60)[0] as string;

		expect(line).toContain("\x1b[48;2;30;30;46m");
		expect(visibleWidth(line)).toBe(60);
		expect(rowText(line)).toBe(" ✓ Read (a.ts)");
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

	it("serves fresh rows after a member is expanded", () => {
		// The component object survives a toggle and only its children are rebuilt, and a delegated
		// renderer can repaint later still (pi-diff starts a placeholder and invalidates when the
		// async diff lands). Neither changes the cache's identity inputs, so a group holding an
		// expanded member is never cached at all. Uses `edit` because only the inline-body tools
		// keep a group when expanded.
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(true);
		withClaudeToolStyle({ name: "edit", label: "Edit" });
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		const asEdit = (tool: any) => ({ ...tool, toolName: "edit" });
		const a = asEdit(counted("a", counter));
		const b = asEdit(counted("b", counter));
		const container = chat([a, b]);
		container.render(80);
		const folded = container.render(80).map(strip);
		// Expand the second member in place, as a click on it would.
		(b as any).expanded = true;
		(b as any).render = () => {
			counter.renders++;
			return ["", " ✓ Read (b)", "   └ BODY LINE"];
		};
		const opened = container.render(80).map(strip);
		installClaudeChatGrouping(false);

		expect(folded.some((l: string) => l.includes("BODY LINE"))).toBe(false);
		expect(opened.some((l: string) => l.includes("BODY LINE"))).toBe(true);
	});

	it("never caches a group that holds an expanded member", () => {
		// A delegated renderer repaints asynchronously without touching result, partial or member
		// identity, so a cached string would freeze pi-diff's placeholder. Re-rendering every frame
		// is the cost of showing the diff inline.
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(true);
		withClaudeToolStyle({ name: "edit", label: "Edit" });
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		const tool = (id: string, expanded: boolean) => ({
			toolCallId: id,
			toolName: "edit",
			result: {},
			isPartial: false,
			expanded,
			render: () => {
				counter.renders++;
				return ["", " ✓ Edit (a)", "   └ +1 -1"];
			},
		});
		const container = chat([tool("a", false), tool("b", true)]);
		container.render(80);
		counter.renders = 0;
		container.render(80);
		container.render(80);
		installClaudeChatGrouping(false);

		// Two members, two frames, nothing served from the cache.
		expect(counter.renders).toBe(4);
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

	it("keeps caching after a resize instead of filling the cap with stale widths", () => {
		setClaudeStyleTheme(theme);
		setClaudeStyleAgentActive(false);
		installClaudeChatGrouping(true);
		const counter = { renders: 0 };
		const container = new Container();
		// Enough groups that width-keyed entries would fill the 4096-entry cap: 600 groups x 7 widths.
		for (let group = 0; group < 600; group++) {
			container.addChild({ render: () => [`msg ${group}`] } as never);
			container.addChild(counted(`g${group}a`, counter) as never);
			container.addChild(counted(`g${group}b`, counter) as never);
		}
		for (let width = 80; width < 86; width++) container.render(width);
		// A resize must not leave the cache full of old widths, or nothing can be cached at the new one.
		container.render(86);
		counter.renders = 0;
		container.render(86);
		installClaudeChatGrouping(false);
		expect(counter.renders).toBe(0);
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
