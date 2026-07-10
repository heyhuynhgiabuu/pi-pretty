/**
 * Lazy resolver for pi-tui Text constructor.
 *
 * Returns the real Text class from @earendil-works/pi-tui, or a stub when
 * pi-tui is unavailable (e.g. not in jiti's alias map). This avoids crashing
 * during tool registration when pi-tui isn't aliased.
 *
 * The resolution is cached — the require() call happens at most once.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextCtor = new (t?: string, x?: number, y?: number) => { setText(v: string): void; [k: string]: any };

/** No-op stub that satisfies the Text interface so rendering doesn't crash. */
class StubText {
	setText(_v: string): void {
		// no-op — pi-tui not available
	}
}

let _ctor: TextCtor | null = null;
let _resolved = false;

function resolve(): TextCtor {
	if (_ctor) return _ctor;
	_resolved = true;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { Text } = require("@earendil-works/pi-tui") as { Text: TextCtor };
		_ctor = Text;
		return _ctor;
	} catch {
		_ctor = StubText;
		return _ctor;
	}
}

/**
 * Returns a Text constructor, always valid. Falls back to StubText if
 * @earendil-works/pi-tui is unavailable (caught and cached).
 */
export function getTextCtor(): TextCtor {
	return resolve();
}

/**
 * Returns TextComp if provided, otherwise the lazy-resolved Text constructor.
 * Always returns a valid constructor (never undefined/null).
 */
export function resolveTextCtor(TextComp?: TextCtor): TextCtor {
	return TextComp ?? resolve();
}
