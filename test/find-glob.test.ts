import { describe, expect, it } from "vitest";
import { isLikelyGlobPattern, normalizeFindGlobPattern } from "../src/find-glob.js";

describe("normalizeFindGlobPattern", () => {
	it("keeps **/* unchanged", () => {
		expect(normalizeFindGlobPattern("**/*")).toBe("**/*");
	});

	it("prefixes bare globs with **/", () => {
		expect(normalizeFindGlobPattern("*.ts")).toBe("**/*.ts");
		expect(normalizeFindGlobPattern("**/*")).toBe("**/*");
	});

	it("leaves path-qualified globs", () => {
		expect(normalizeFindGlobPattern("src/**/*.ts")).toBe("src/**/*.ts");
	});

	it("strips leading ./ prefixes to match Pi 1.6 find semantics", () => {
		expect(normalizeFindGlobPattern("./src/*.ts")).toBe("src/*.ts");
		expect(normalizeFindGlobPattern("./*.ts")).toBe("**/*.ts");
	});
});

describe("isLikelyGlobPattern", () => {
	it("detects glob metacharacters", () => {
		expect(isLikelyGlobPattern("*.ts")).toBe(true);
		expect(isLikelyGlobPattern("foo")).toBe(false);
	});
});