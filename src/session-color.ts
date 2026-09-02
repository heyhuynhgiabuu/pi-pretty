/**
 * Per-session accent color — port of oh-my-pi's `utils/session-color.ts`
 * (OKLCH essence, no native dependencies).
 *
 * omp derives a stable per-session accent: the session name hash picks only
 * the *hue* (djb2, walked along a dark-theme-safe arc that excludes hues
 * which darken badly); lightness and chroma live in OKLCH so every hue
 * renders with equal perceived weight (the reason omp carries the theme
 * accent through per-hue gamut cusps — constant OKLCH L/C achieves the same
 * uniformity without theme introspection, which pi's extension API does not
 * expose). The spinner variant dims the accent exactly like omp's
 * `adjustHsv(hex, { s: 0.55, v: 0.65 })`.
 *
 * Skipped from the omp original (requires host theme internals pi does not
 * expose to extensions): per-hue gamut cusps, WCAG contrast bisection against
 * the surface, hue-collision avoidance against theme colors.
 */

// ─── omp session-color.ts constants ──────────────────────────────────────────

/** omp MIN_CHROMA / MAX_CHROMA: readable floor, "not a highlighter set" ceiling. */
const MIN_CHROMA = 0.05;
const MAX_CHROMA = 0.21;

/** omp dark-theme lightness band (visible on dark surfaces). */
const LIGHTNESS = 0.75;

/**
 * Dark-theme hue arc. omp computes these intervals from per-hue gamut cusps;
 * its doc comment pins the always-excluded bands — the yellow/chartreuse core
 * (≈94–138°, darkens to mustard) and the over-light cyan peak (≈158–200°) —
 * for every theme, so the arc below hardcodes the full wheel minus those two.
 */
const DARK_HUE_INTERVALS: ReadonlyArray<readonly [number, number]> = [
	[0, 93],
	[139, 157],
	[201, 359],
];
const ARC_LENGTH = DARK_HUE_INTERVALS.reduce((n, [a, b]) => n + (b - a + 1), 0);

/** omp nameToHash: stable 32-bit djb2. */
function nameToHash(name: string): number {
	let hash = 5381;
	for (let i = 0; i < name.length; i++) {
		hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
		hash = hash >>> 0;
	}
	return hash;
}

/** Map a name to its OKLCH hue on the dark-safe arc. */
export function sessionAccentHue(name: string): number {
	let pos = nameToHash(name) % ARC_LENGTH;
	for (const [a, b] of DARK_HUE_INTERVALS) {
		const n = b - a + 1;
		if (pos < n) return a + pos;
		pos -= n;
	}
	return DARK_HUE_INTERVALS[DARK_HUE_INTERVALS.length - 1]?.[1] ?? 0;
}

// ─── OKLCH ↔ sRGB (Björn Ottosson's published matrices) ─────────────────────

function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
	const h = (hDeg * Math.PI) / 180;
	const a = c * Math.cos(h);
	const b = c * Math.sin(h);
	const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = l - 0.0894841775 * a - 1.291485548 * b;
	const ll = l_ * l_ * l_;
	const mm = m_ * m_ * m_;
	const ss = s_ * s_ * s_;
	return [
		4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
		-1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
		-0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss,
	];
}

const transfer = (x: number): number => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Largest chroma ≤ `c` whose color is inside the sRGB gamut (chroma bisection). */
function clampChroma(l: number, c: number, hDeg: number, iterations = 12): number {
	let lo = 0;
	let hi = c;
	const inGamut = (chroma: number): boolean => oklchToSrgb(l, chroma, hDeg).every((x) => x >= -1e-4 && x <= 1 + 1e-4);
	if (inGamut(hi)) return hi;
	for (let i = 0; i < iterations; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(mid)) lo = mid;
		else hi = mid;
	}
	return lo;
}

function oklchToHex(l: number, c: number, hDeg: number): string {
	const chroma = clampChroma(l, c, hDeg);
	const [r, g, b] = oklchToSrgb(l, chroma, hDeg);
	const hex = (x: number): string =>
		Math.round(clamp01(transfer(clamp01(x))) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// ─── Public surface ──────────────────────────────────────────────────────────

/** Stable per-session accent hex at a fixed OKLCH lightness/chroma band. */
export function sessionAccentHex(name: string): string {
	return oklchToHex(LIGHTNESS, Math.max(MIN_CHROMA, Math.min(MAX_CHROMA, 0.14)), sessionAccentHue(name));
}

function hexToRgb(hex: string): [number, number, number] | undefined {
	const m = hex.trim().match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (!m) return undefined;
	return [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)];
}

/** RGB(0-1) → HSV; exactly the inverse legs omp's adjustHsv needs. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	let h: number;
	if (d === 0) h = 0;
	else if (max === r) h = ((g - b) / d) % 6;
	else if (max === g) h = (b - r) / d + 2;
	else h = (r - g) / d + 4;
	h = (h * 60 + 360) % 360;
	return [h, max === 0 ? 0 : d / max, max];
}

function hsvToHex(h: number, s: number, v: number): string {
	const c = v * s;
	const hp = h / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const m = v - c;
	let rgb: [number, number, number];
	if (hp < 1) rgb = [c, x, 0];
	else if (hp < 2) rgb = [x, c, 0];
	else if (hp < 3) rgb = [0, c, x];
	else if (hp < 4) rgb = [0, x, c];
	else if (hp < 5) rgb = [x, 0, c];
	else rgb = [c, 0, x];
	const hex = (x: number): string =>
		Math.round((x + m) * 255)
			.toString(16)
			.padStart(2, "0");
	return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

/**
 * Dim variant for the spinner — identical transform to omp's
 * `adjustHsv(hex, { s: 0.55, v: 0.65 })`. Unparseable input returns
 * the input unchanged.
 */
export function dimAccentHex(hex: string): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return hex;
	const [r, g, b] = rgb.map((x) => x / 255) as [number, number, number];
	const [h, s, v] = rgbToHsv(r, g, b);
	return hsvToHex(h, s * 0.55, v * 0.65);
}

/** Truecolor ANSI foreground open sequence for a `#rrggbb` hex. */
export function hexToAnsiFg(hex: string): string {
	const rgb = hexToRgb(hex);
	if (!rgb) return "";
	return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}
