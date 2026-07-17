import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { getTextCtor, resolveTextCtor } from "../src/tui-text.js";

describe("pi-tui Text resolution", () => {
	it("returns pi-tui's Text constructor by default", () => {
		expect(getTextCtor()).toBe(Text);
		expect(resolveTextCtor()).toBe(Text);
	});

	it("preserves an explicitly provided constructor", () => {
		class TestText {
			value = "";

			setText(value: string): void {
				this.value = value;
			}
		}

		expect(resolveTextCtor(TestText)).toBe(TestText);
	});
});
