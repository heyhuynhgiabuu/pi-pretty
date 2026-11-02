import { describe, expect, it } from "vitest";

import { preserveBoxBackground } from "../src/render.js";

const ESC = String.fromCharCode(27);
const sgr = (params: string) => `${ESC}[${params}m`;
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const visible = (text: string) => text.split(sgr("0")).join("").replace(ANSI, "");

/**
 * `preserveBoxBackground` rewrites SGR sequences so a background survives a reset. It must keep
 * every foreground parameter that belongs to a `38`/`58` introducer, because a palette index or a
 * colour channel can legitimately fall in the 40-47/100-107 background range.
 */
describe("preserveBoxBackground", () => {
	it("keeps a bare reset from clearing the background", () => {
		expect(preserveBoxBackground(sgr("0"))).not.toContain(`${ESC}[0m`);
	});

	it("drops background codes", () => {
		for (const params of ["49", "41", "47", "100", "107", "48;5;42", "48;2;1;2;3"]) {
			expect(preserveBoxBackground(sgr(params))).toBe("");
		}
	});

	it("keeps a 256-colour palette index with its introducer", () => {
		// 42 and 103 sit in the background ranges; read on their own they were dropped, leaving
		// a colour-less `38;5` that the terminal renders with the default colour.
		for (const index of ["42", "103", "0", "255"]) {
			expect(preserveBoxBackground(sgr(`38;5;${index}`))).toBe(sgr(`38;5;${index}`));
		}
	});

	it("keeps extended foreground channels that look like background codes", () => {
		for (const rgb of ["104;183;141", "40;41;42", "100;107;49"]) {
			expect(preserveBoxBackground(sgr(`38;2;${rgb}`))).toBe(sgr(`38;2;${rgb}`));
		}
	});

	it("drops an extended background without eating the code after it", () => {
		// 48;2 takes four arguments; skipping five swallowed whatever followed.
		expect(preserveBoxBackground(sgr("1;48;2;1;2;3;31"))).toBe(sgr("1;31"));
	});

	it("keeps the foreground when a palette colour precedes a background", () => {
		expect(preserveBoxBackground(sgr("38;5;101;48;5;42;1"))).toBe(sgr("38;5;101;1"));
	});

	it("leaves the visible text untouched", () => {
		expect(visible(preserveBoxBackground(`${sgr("38;5;42")}hello${sgr("0")}`))).toBe("hello");
	});
});
