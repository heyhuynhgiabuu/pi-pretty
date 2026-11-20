import type { CustomEditor } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

/** Constructor shape used to preserve compatibility with older Pi hosts. */
export type CustomEditorConstructor = new (...args: ConstructorParameters<typeof CustomEditor>) => CustomEditor;

type PromptColor = (text: string) => string;

const PROMPT_ICON = "❯";
const BOXED_PROMPT_WIDTH = 3; // one space on either side of the icon
const UNBOXED_PROMPT_WIDTH = 2; // icon flush left, one space after

/**
 * Build a CustomEditor subclass that reserves room for, and renders, the
 * user-message prompt. The host still owns all editing and app keybindings.
 * With `boxed: false` the host's plain horizontal rules are kept as-is (no rounded
 * corners, no side bars) and the prompt sits flush left: `❯ text`, ignoring the
 * host's horizontal padding.
 */
export function createPromptEditorClass(
	Base: CustomEditorConstructor,
	colorPrompt: PromptColor,
	boxed = true,
): CustomEditorConstructor {
	const basePrototype = Base.prototype as unknown as {
		renderTopBorder?: unknown;
		renderBottomBorder?: unknown;
	};
	const supportsBorderHooks =
		typeof basePrototype.renderTopBorder === "function" && typeof basePrototype.renderBottomBorder === "function";

	class PromptEditor extends Base {
		private userPaddingX = 0;
		private isScrolled = false;
		private bottomBorderLine = "";

		constructor(...args: ConstructorParameters<CustomEditorConstructor>) {
			const [tui, theme, keybindings, options] = args;
			super(tui, theme, keybindings, { ...(options ?? {}), embedWorkingStatus: true });
			this.userPaddingX = super.getPaddingX();
			super.setPaddingX(this.reservedPadding());
		}

		private promptWidth(): number {
			if (!boxed) return UNBOXED_PROMPT_WIDTH;
			// At zero user padding, reserve one extra column so the border leaves
			// the same visible gap before the icon as padded editors.
			return BOXED_PROMPT_WIDTH + (supportsBorderHooks && this.userPaddingX === 0 ? 1 : 0);
		}

		/** Columns the host must reserve left of the input: user padding plus the prompt slot. */
		private reservedPadding(): number {
			return (boxed ? this.userPaddingX : 0) + this.promptWidth();
		}

		override getPaddingX(): number {
			return this.userPaddingX;
		}

		override setPaddingX(padding: number): void {
			this.userPaddingX = Math.max(0, padding);
			super.setPaddingX(this.reservedPadding());
		}

		protected override renderTopBorder(width: number, hiddenLineCount: number): string {
			this.isScrolled = hiddenLineCount > 0;
			const border = super.renderTopBorder(width, hiddenLineCount);
			return boxed ? this.roundBorder(border, width, "╭", "╮") : border;
		}

		protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
			const border = super.renderBottomBorder(width, hiddenLineCount);
			if (!boxed) return border;
			this.bottomBorderLine = this.roundBorder(border, width, "╰", "╯");
			return this.bottomBorderLine;
		}

		private roundBorder(line: string, width: number, left: string, right: string): string {
			if (width < 2 || visibleWidth(line) !== width) return line;
			return `${this.borderColor(left)}${sliceByColumn(line, 1, width - 2, true)}${this.borderColor(right)}`;
		}

		override render(width: number): string[] {
			this.bottomBorderLine = "";
			// Copy: pi-tui 1.6 lets components return a cached render array, so patching it in place could repeat the patch next frame.
			const lines = [...super.render(width)];
			if (lines.length < 2) return lines;

			if (!this.isScrolled) {
				const firstContentLine = lines[1];
				if (firstContentLine) {
					const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
					const promptPadding = Math.min(this.reservedPadding(), maxPadding);
					const slot = boxed ? BOXED_PROMPT_WIDTH : UNBOXED_PROMPT_WIDTH;
					if (promptPadding >= slot && firstContentLine.startsWith(" ".repeat(promptPadding))) {
						const promptStart = promptPadding - slot;
						const prompt = boxed ? ` ${colorPrompt(PROMPT_ICON)} ` : `${colorPrompt(PROMPT_ICON)} `;
						lines[1] = `${firstContentLine.slice(0, promptStart)}${prompt}${firstContentLine.slice(promptPadding)}`;
					}
				}
			}

			if (!boxed || !supportsBorderHooks || !this.bottomBorderLine) return lines;

			const bottomBorderIndex = lines.lastIndexOf(this.bottomBorderLine);
			const contentEnd = bottomBorderIndex > 0 ? bottomBorderIndex : lines.length - 1;
			for (let i = 1; i < contentEnd; i++) {
				const line = lines[i];
				if (!line || visibleWidth(line) !== width || !line.startsWith(" ") || !line.endsWith(" ")) continue;
				lines[i] = `${this.borderColor("│")}${line.slice(1, -1)}${this.borderColor("│")}`;
			}

			return lines;
		}
	}

	return PromptEditor;
}
