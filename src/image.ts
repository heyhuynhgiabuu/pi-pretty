/**
 * pi-pretty: Terminal image rendering (iTerm2 / Kitty / Ghostty inline image protocols).
 * Handles tmux passthrough for image protocols.
 */

import { execFileSync } from "node:child_process";

type ImageProtocol = "iterm2" | "kitty" | "none";

let _tmuxClientTermCache: string | null | undefined;
let _tmuxAllowPassthroughCache: boolean | null | undefined;
let _tmuxClientTermOverrideForTests: string | null | undefined;
let _tmuxAllowPassthroughOverrideForTests: boolean | null | undefined;

function isTmuxSession(): boolean {
	return !!process.env.TMUX || /^(tmux|screen)/.test(process.env.TERM ?? "");
}

function normalizeTerminalName(term: string): string {
	const t = term.toLowerCase();
	if (t.includes("kitty")) return "kitty";
	if (t.includes("ghostty")) return "ghostty";
	if (t.includes("wezterm")) return "WezTerm";
	if (t.includes("iterm")) return "iTerm.app";
	if (t.includes("mintty")) return "mintty";
	return term;
}

function readTmuxClientTerm(): string | null {
	if (_tmuxClientTermOverrideForTests !== undefined) {
		return _tmuxClientTermOverrideForTests ? normalizeTerminalName(_tmuxClientTermOverrideForTests) : null;
	}
	if (!isTmuxSession()) return null;
	if (_tmuxClientTermCache !== undefined) return _tmuxClientTermCache;
	try {
		const term = execFileSync("tmux", ["display-message", "-p", "#{client_termname}"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 200,
		}).trim();
		_tmuxClientTermCache = term ? normalizeTerminalName(term) : null;
	} catch {
		_tmuxClientTermCache = null;
	}
	return _tmuxClientTermCache;
}

function getOuterTerminal(): string {
	if (process.env.LC_TERMINAL === "iTerm2") return "iTerm.app";
	if (process.env.GHOSTTY_RESOURCES_DIR) return "ghostty";
	if (process.env.KITTY_WINDOW_ID || process.env.KITTY_PID) return "kitty";
	if (process.env.WEZTERM_EXECUTABLE || process.env.WEZTERM_CONFIG_DIR || process.env.WEZTERM_CONFIG_FILE) {
		return "WezTerm";
	}
	const termProgram = process.env.TERM_PROGRAM ?? "";
	if (termProgram && termProgram !== "tmux" && termProgram !== "screen") {
		return normalizeTerminalName(termProgram);
	}
	const tmuxClientTerm = readTmuxClientTerm();
	if (tmuxClientTerm) return tmuxClientTerm;
	const term = process.env.TERM ?? "";
	if (term) return normalizeTerminalName(term);
	if (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit") return "unknown-modern";
	return termProgram;
}

function detectImageProtocol(): ImageProtocol {
	const forced = (process.env.PRETTY_IMAGE_PROTOCOL ?? "").toLowerCase();
	if (forced === "kitty" || forced === "iterm2" || forced === "none") return forced;
	const term = getOuterTerminal();
	if (term === "ghostty" || term === "kitty") return "kitty";
	if (["iTerm.app", "WezTerm", "mintty"].includes(term)) return "iterm2";
	if (process.env.LC_TERMINAL === "iTerm2") return "iterm2";
	return "none";
}

function tmuxAllowsPassthrough(): boolean | null {
	if (_tmuxAllowPassthroughOverrideForTests !== undefined) return _tmuxAllowPassthroughOverrideForTests;
	if (!isTmuxSession()) return null;
	if (_tmuxAllowPassthroughCache !== undefined) return _tmuxAllowPassthroughCache;
	try {
		const value = execFileSync("tmux", ["show-options", "-gv", "allow-passthrough"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 200,
		})
			.trim()
			.toLowerCase();
		_tmuxAllowPassthroughCache = value === "on" || value === "all";
	} catch {
		_tmuxAllowPassthroughCache = null;
	}
	return _tmuxAllowPassthroughCache;
}

function getTmuxPassthroughWarning(protocol: ImageProtocol): string | null {
	if (!isTmuxSession() || protocol === "none") return null;
	if (tmuxAllowsPassthrough() === false) {
		return "tmux allow-passthrough is off. Run: tmux set -g allow-passthrough on";
	}
	return null;
}

function tmuxWrap(seq: string): string {
	if (!isTmuxSession()) return seq;
	const escaped = seq.split("\x1b").join("\x1b\x1b");
	return `\x1bPtmux;${escaped}\x1b\\`;
}

export const __imageInternals = {
	isTmuxSession,
	getOuterTerminal,
	detectImageProtocol,
	tmuxWrap,
	tmuxAllowsPassthrough,
	getTmuxPassthroughWarning,
	setTmuxClientTermOverrideForTests: (value: string | null | undefined) => {
		_tmuxClientTermOverrideForTests = value;
	},
	setTmuxAllowPassthroughOverrideForTests: (value: boolean | null | undefined) => {
		_tmuxAllowPassthroughOverrideForTests = value;
	},
	resetCachesForTests: () => {
		_tmuxClientTermCache = undefined;
		_tmuxAllowPassthroughCache = undefined;
		_tmuxClientTermOverrideForTests = undefined;
		_tmuxAllowPassthroughOverrideForTests = undefined;
	},
};
