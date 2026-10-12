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

	it("keeps SDK truncation notices out of the tree rows", async () => {
		vi.stubEnv("PRETTY_ICONS", "nerd");
		const { renderTree } = await freshModules();

		const out = strip(renderTree("a.ts\n[500 entries limit reached. Use limit=1000 for more]", "/p"));
		const noticeRow = out.split("\n").find((r) => r.includes("entries limit reached"));
		expect(noticeRow).toBeDefined();
		expect(noticeRow?.startsWith("├──")).toBe(false);
		expect(noticeRow?.startsWith("└──")).toBe(false);
	});
});
