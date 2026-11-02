import { describe, expect, it } from "vitest";

import { preserveBoxBackground } from "../src/render.js";

const ESC = String.fromCharCode(27);
const sgr = (params: string) => `${ESC}[${params}m`;
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const visible = (text: string) => text.split(sgr("0")).join("").replace(ANSI, "");

/**
 * `preserveBoxBackground` rewrites SGR sequences so a background survives a reset. It must keep
 * every parameter that belongs to a `38` introducer, because a palette index or a colour channel
 * can legitimately fall in the 40-49/100-107 range and be dropped as a background.
 *
 * `58` (underline colour) is not handled by either branch and is broken on main too; that is a
 * separate bug, not covered here.
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
		// 18 indices sit in the background ranges (40-49 and 100-107); read on their own they were
		// dropped, leaving a colour-less `38;5` that the terminal renders with the default colour.
		// 48 and 49 are background codes too, not only the 40-47 block.
		for (const index of ["42", "48", "49", "103", "0", "255"]) {
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
		// 48;5 takes one. An index outside 40-47 (196 here) would survive as a stray code if the
		// skip were two instead of three.
		expect(preserveBoxBackground(sgr("48;5;196;31"))).toBe(sgr("31"));
	});

	it("keeps a 38 introducer with no recognised sub-code", () => {
		// The loop advances by one here; without that it would not terminate.
		expect(preserveBoxBackground(sgr("38"))).toBe(sgr("38"));
		expect(preserveBoxBackground(sgr("1;38;9"))).toBe(sgr("1;38;9"));
	});

	it("keeps the foreground when a palette colour precedes a background", () => {
		expect(preserveBoxBackground(sgr("38;5;101;48;5;42;1"))).toBe(sgr("38;5;101;1"));
	});

	it("leaves the visible text untouched", () => {
		expect(visible(preserveBoxBackground(`${sgr("38;5;42")}hello${sgr("0")}`))).toBe("hello");
	});
});
