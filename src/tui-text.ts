/**
 * Resolver for pi-tui's Text constructor.
 *
 * Returns the real Text class from @earendil-works/pi-tui, or a stub when
 * pi-tui is genuinely unavailable.
 *
 * IMPORTANT: the require() below is TOP-LEVEL on purpose. pi loads extensions
 * through jiti, which only rewrites its `@earendil-works/pi-tui` alias for
 * STATIC top-level require()/import — NOT for a require() inside a function
 * body. When this resolve used a lazy in-function require, jiti left the
 * specifier unmapped, so it always threw MODULE_NOT_FOUND under pi and fell
 * back to StubText. Every self-rendered tool then drew nothing, and a resize
 * crashed the TUI with `child.render is not a function`. Resolving once at
 * module top level (matching the working `import { Image }` in tools/read.ts)
 * lets the alias apply. The try/catch keeps the graceful stub fallback for
 * environments where pi-tui really is absent (tests, plain Node).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TextCtor = new (t?: string, x?: number, y?: number) => { setText(v: string): void; [k: string]: any };

/**
 * Stub that satisfies the Component interface so rendering never crashes when
 * pi-tui is absent. render()/invalidate() are required by the TUI: without
 * them a resize threw `child.render is not a function`.
 */
class StubText {
	private _text = "";
	constructor(t = "", _x = 0, _y = 0) {
		this._text = t;
	}
	setText(v: string): void {
		this._text = v;
	}
	render(_width?: number): string[] {
		return this._text.split("\n");
	}
	invalidate(): void {
		// no-op — nothing to lay out
	}
}

let _ctor: TextCtor;
try {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	_ctor = (require("@earendil-works/pi-tui") as { Text?: TextCtor }).Text ?? StubText;
} catch {
	_ctor = StubText;
}

function resolve(): TextCtor {
	return _ctor;
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
