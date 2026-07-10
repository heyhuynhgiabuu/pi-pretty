/**
 * Glob normalization for FFF glob() (repo-relative paths).
 * Aligns with Pi SDK find: bare *.ts searches under cwd recursively.
 */

/** Do not collapse double-star-slash-star to single star. */
export function normalizeFindGlobPattern(pattern: string): string {
	const p = pattern.trim();
	if (!p) return p;
	if (p === "**/*") return "**/*";
	if (p.includes("/") || p.startsWith("**/")) return p;
	if (/[*?[\]]/.test(p)) return `**/${p}`;
	return p;
}

/** Patterns where an empty FFF result is suspicious — try SDK find (fd). */
export function isLikelyGlobPattern(pattern: string): boolean {
	const p = pattern.trim();
	if (!p) return false;
	return /[*?[\]]/.test(p) || p === "**/*" || p.startsWith("**/");
}
