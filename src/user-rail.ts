/* pi-pretty: left rail for user messages — a thin tinted bar instead of a full-width
 * background, so acrylic/translucent terminals keep showing through. ANSI cell
 * backgrounds are always opaque in Windows Terminal, so a full-width bg kills the
 * blur; a one-cell rail reads as "highlighted, still transparent". */

/** Host component shape pi-pretty needs (UserMessageComponent). */
interface RailPatchable {
	prototype: { render?: (width: number) => string[] };
}

const RAIL_PATCH = Symbol.for("pi-pretty.user-rail");

interface RailState {
	ansiOpen: string;
	railChar: string;
	width: number;
}

let state: RailState | undefined;

export interface UserRailOptions {
	/** `#rrggbb` rail bar background. Empty/undefined disables the rail. */
	color?: string;
}

/** Configure the rail from config resolution. Call once at session start. */
export function setUserRail(color: string | undefined): void {
	if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) {
		state = undefined;
		return;
	}
	const r = parseInt(color.slice(1, 3), 16);
	const g = parseInt(color.slice(3, 5), 16);
	const b = parseInt(color.slice(5, 7), 16);
	state = { ansiOpen: `\x1b[48;2;${r};${g};${b}m`, railChar: " ", width: 1 };
}

/** Width the rail adds to every rendered row (0 when disabled). */
export function userRailWidth(): number {
	return state ? state.width : 0;
}

/**
 * Patch the host's UserMessageComponent so every rendered line carries a one-cell
 * tinted bar. The host render is wrapped, not replaced — expand/collapse and the
 * OSC133 markers are untouched. Pass undefined to remove the rail.
 */
export function installUserRail(componentClass: unknown): boolean {
	const proto = (componentClass as RailPatchable | undefined)?.prototype;
	const base = proto?.render;
	if (typeof base !== "function") return false;

	const existing = (base as { [RAIL_PATCH]?: boolean })[RAIL_PATCH];
	if (existing) return true; // wrapper already installed; setUserRail changes only colors

	const wrapped = function (this: unknown, width: number): string[] {
		const lines = base.call(this, width) as string[];
		const s = state;
		if (!s || lines.length === 0) return lines;
		const out: string[] = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// OSC133 screen-zone markers stay at position 0 of first/last lines.
			if ((i === 0 || i === lines.length - 1) && line.startsWith("\u001b]133;")) {
				const m = line.match(/^(\u001b\]133;[A-Z][^\u0007]*\u0007)([\s\S]*)$/);
				if (m) {
					out.push(`${m[1]}${s.ansiOpen}${s.railChar}\x1b[49m${m[2]}`);
					continue;
				}
			}
			out.push(`${s.ansiOpen}${s.railChar}\x1b[49m${line}`);
		}
		return out;
	};
	(wrapped as { [RAIL_PATCH]?: boolean })[RAIL_PATCH] = true;
	proto.render = wrapped as NonNullable<RailPatchable["prototype"]["render"]>;
	return true;
}
