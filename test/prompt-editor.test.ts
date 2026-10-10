import { afterEach, describe, expect, it, vi } from "vitest";

import piPrettyExtension from "../src/index.js";
import { type CustomEditorConstructor, createPromptEditorClass } from "../src/prompt-editor.js";

class FakeEditor {
	private padding = 1;
	protected borderColor = (text: string): string => text;

	constructor(..._args: unknown[]) {}

	protected renderTopBorder(width: number, _hiddenLineCount: number): string {
		return "─".repeat(width);
	}

	protected renderBottomBorder(width: number, _hiddenLineCount: number): string {
		return "─".repeat(width);
	}

	getPaddingX(): number {
		return this.padding;
	}

	setPaddingX(padding: number): void {
		this.padding = padding;
	}

	render(width: number): string[] {
		return [this.renderTopBorder(width, 0), `${" ".repeat(this.padding)}draft`, this.renderBottomBorder(width, 0)];
	}
}

const fakeEditorClass = FakeEditor as unknown as CustomEditorConstructor;

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("prompt editor", () => {
	it("renders the prompt icon while preserving editor padding", () => {
		const PromptEditor = createPromptEditorClass(
			fakeEditorClass,
			(text) => `\x1b[38;5;7m${text}\x1b[39m`,
		);
		const editor = new PromptEditor(...([] as unknown as ConstructorParameters<CustomEditorConstructor>));

		expect(editor.getPaddingX()).toBe(1);
		expect(editor.render(40)[1]).toBe("  \x1b[38;5;7m❯\x1b[39m draft");
	});

	it("keeps leading spaces in the input after the reserved prompt slot", () => {
		class LeadingSpaceEditor extends FakeEditor {
			override render(_width: number): string[] {
				return ["top", `${" ".repeat(4)}   draft`, "bottom"];
			}
		}
		const PromptEditor = createPromptEditorClass(
			LeadingSpaceEditor as unknown as CustomEditorConstructor,
			(text) => `<${text}>`,
		);
		const editor = new PromptEditor(...([] as unknown as ConstructorParameters<CustomEditorConstructor>));

		expect(editor.render(40)[1]).toBe("  <❯>    draft");
	});

	it("adds vertical borders around full-width live input rows", () => {
		class FullWidthEditor extends FakeEditor {
			override render(width: number): string[] {
				const padding = " ".repeat(4);
				const contentWidth = width - padding.length * 2;
				const row = (content: string) => `${padding}${content}${" ".repeat(contentWidth - content.length)}${padding}`;
				return [this.renderTopBorder(width, 0), row("draft"), row("second"), this.renderBottomBorder(width, 0), "completion"];
			}
		}
		const PromptEditor = createPromptEditorClass(
			FullWidthEditor as unknown as CustomEditorConstructor,
			(text) => text,
		);
		const editor = new PromptEditor(...([] as unknown as ConstructorParameters<CustomEditorConstructor>));

		const lines = editor.render(40);
		expect(lines[0]).toBe(`╭${"─".repeat(38)}╮`);
		expect(lines[1]).toMatch(/^│ ❯ draft/);
		expect(lines[1]?.endsWith("│")).toBe(true);
		expect(lines[1]).toHaveLength(40);
		expect(lines[2]?.startsWith(`│${" ".repeat(3)}second`)).toBe(true);
		expect(lines[2]?.endsWith("│")).toBe(true);
		expect(lines[2]).toHaveLength(40);
		expect(lines[3]).toBe(`╰${"─".repeat(38)}╯`);
		expect(lines[4]).toBe("completion");
	});

	it("keeps the old prompt-only fallback when border hooks are unavailable", () => {
		class LegacyEditor {
			private padding = 0;

			constructor(..._args: unknown[]) {}

			getPaddingX(): number {
				return this.padding;
			}

			setPaddingX(padding: number): void {
				this.padding = padding;
			}

			render(_width: number): string[] {
				return ["top", `${" ".repeat(this.padding)}draft`, "bottom", "completion"];
			}
		}
		const PromptEditor = createPromptEditorClass(
			LegacyEditor as unknown as CustomEditorConstructor,
			(text) => text,
		);
		const editor = new PromptEditor(...([] as unknown as ConstructorParameters<CustomEditorConstructor>));

		expect(editor.render(40)).toEqual(["top", " ❯ draft", "bottom", "completion"]);
	});

	it("installs the prompt editor only through the host's public editor API", async () => {
		vi.stubEnv("PRETTY_WORKING_INDICATOR", "off");
		let editorFactory: unknown;
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const pi = {
			registerMarkdownTransformer: () => {},
			registerFlag: () => {},
			registerTool: () => {},
			registerToolRenderer: () => {},
			registerCommand: () => {},
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		};
		const ui = {
			theme: {
				fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
				getThinkingBorderColor: (level: string) => (text: string) => `<${level}>${text}</${level}>`,
			},
			setEditorComponent: (factory: unknown) => {
				editorFactory = factory;
			},
			getEditorComponent: () => undefined,
			setToolsExpanded: () => {},
			setWorkingVisible: () => {},
		};
		let thinkingLevel = "max";
		const ctx = {
			mode: "tui",
			cwd: process.cwd(),
			ui,
			get thinkingLevel() {
				return thinkingLevel;
			},
			sessionManager: { getSessionName: () => undefined },
		};

		await piPrettyExtension(pi as never, { sdk: {}, fffModule: undefined, customEditorClass: fakeEditorClass });
		await handlers.get("session_start")?.({}, ctx);

		expect(typeof editorFactory).toBe("function");
		const factory = editorFactory as (tui: unknown, theme: unknown, keybindings: unknown) => {
			render(width: number): string[];
		};
		const editor = factory(undefined, undefined, undefined);
		expect(editor.render(40)[1]).toContain("<max>❯</max>");
		thinkingLevel = "high";
		expect(editor.render(40)[1]).toContain("<high>❯</high>");

		await handlers.get("session_shutdown")?.({}, ctx);
		expect(editorFactory).toBeUndefined();
	});
});
