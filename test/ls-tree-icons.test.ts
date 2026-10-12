import { afterEach, describe, expect, it, vi } from "vitest";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping SGR sequences
const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, "");

afterEach(() => vi.unstubAllEnvs());

/** Fresh module registry so PRETTY_ICONS stubs are re-read by config's module-level bindings. */
async function freshModules() {
	vi.resetModules();
	const render = await import("../src/render.js");
	const config = await import("../src/config.js");
	return { renderTree: render.renderTree, fileIcon: config.fileIcon, dirIcon: config.dirIcon };
}

describe("renderTree file icons", () => {
	it("renders a Nerd Font icon for files and the folder glyph for directories", async () => {
		vi.stubEnv("PRETTY_ICONS", "nerd");
		const { renderTree, fileIcon, dirIcon } = await freshModules();

		const out = strip(renderTree("a.ts\nb/", "/p"));
		expect(out).toContain(strip(fileIcon("a.ts")));
		expect(out).toContain(strip(dirIcon()));
		expect(out).toContain("a.ts");
		expect(out).toContain("b");
	});

	it("gives files a type-specific glyph rather than the folder glyph", async () => {
		vi.stubEnv("PRETTY_ICONS", "nerd");
		const { renderTree, fileIcon, dirIcon } = await freshModules();

		const ts = strip(fileIcon("a.ts")).trim();
		const folder = strip(dirIcon()).trim();
		const out = strip(renderTree("a.ts\nb/", "/p"));
		expect(ts).not.toBe(folder);
		expect(out).toContain(`├── ${ts} a.ts`);
		expect(out).toContain(`└── ${folder} b`);
	});

	it("drops icons entirely when icons are disabled", async () => {
		vi.stubEnv("PRETTY_ICONS", "none");
		const { renderTree } = await freshModules();

		const out = strip(renderTree("a.ts\nb/", "/p"));
		expect(out).toBe("├── a.ts\n└── b");
	});

	it("keeps SDK truncation notices outside the tree and closes the final entry", async () => {
		vi.stubEnv("PRETTY_ICONS", "nerd");
		const { renderTree } = await freshModules();

		const out = strip(renderTree("a.ts\n[500 entries limit reached. Use limit=1000 for more]", "/p"));
		const rows = out.split("\n");
		expect(rows[0]).toMatch(/^└── .*a\.ts$/);
		expect(rows[1]).toBe("[500 entries limit reached. Use limit=1000 for more]");
	});

	it("renders bracketed filenames as normal file entries", async () => {
		vi.stubEnv("PRETTY_ICONS", "nerd");
		const { renderTree, fileIcon } = await freshModules();

		const icon = strip(fileIcon("[notes]")).trim();
		const out = strip(renderTree("[notes]", "/p"));
		expect(out).toBe(`└── ${icon} [notes]`);
	});
});
