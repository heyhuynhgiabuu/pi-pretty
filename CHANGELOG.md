# Changelog

## [0.6.26] - 2026-09-05

### Added

- Hidden-thinking elapsed timer: `Thinking... Xs` while thinking, then `Thought for Xs`. Completed messages keep their own durations for the session; multiple thinking runs within one message share its accumulated thinking time. Durations are not persisted across restarts.
- Live output-token count on the working indicator, using provider usage when available and a character-based estimate otherwise.

### Fixed

- Load the pi extension from `src/index.ts` so jiti honors host SDK aliases even when a local checkout has its own SDK dependency. This prevents the per-message label patch from targeting a different class and making completed rows mirror the active timer. The Node package entry remains `dist/index.js`.
- Remove blank bottom-padding rows under `bash`, `read`, `find`, `grep`, and `ls` titles, including skill-read headers and expanded result-leading gaps. Preserve top padding and result-body/footer spacing; host `edit`/`write` renderers are unchanged.

### Maintenance

- Update Pi development dependencies to `^0.85.0` and include `@earendil-works/pi-server` for the development SDK import graph.

## [0.6.25] - 2026-08-29

### Added

- omp-style shimmer working indicator: an accent band sweeps the streaming `Working…` row at 30 cells/second over a dim braille spinner, rendered **flush-left** through an extension-owned widget (pi's loader hardcodes a one-column indent the frames API cannot change). `workingIndicator.text` accepts a string or an array of phrases played one sweep per phrase, with a configurable palette (`low`/`mid`/`high` as theme color names or `#hex`), `bold`, `kitt` scanner and `static` modes, and the interrupt hint ([oh-my-pi](https://github.com/can1357/oh-my-pi) shimmer port).
- Session accent tint: the mid/high tiers and the spinner are tinted with a stable per-session color derived from the session name (an OKLCH port of oh-my-pi's session accent, hue arc plus chroma/lightness bands) — different windows get different hues at uniform perceived brightness; renaming the session re-tints live; explicit `workingIndicator.mid`/`high` colors disable the tint.
- Thinking-label shimmer: with thinking blocks hidden (pi's `hideThinkingBlock`), the static `Thinking...` label gets the same shimmer — italic `thinkingText` base, accent band, session accent tint — animated at 30fps only during the thinking phase and restored to pi's default label when the phase or the run ends.
- Config: `workingIndicator` (`enabled`, `text`, `mode` `shimmer`\\|`kitt`\\|`static`, `low`, `mid`, `high`, `bold`, `hint`, `sessionAccent`) and `thinkingIndicator` (`enabled`), each with environment-variable overrides (`PRETTY_WORKING_INDICATOR`, `PRETTY_WORKING_INDICATOR_MODE`, `PRETTY_WORKING_INDICATOR_TEXT`, `PRETTY_THINKING_INDICATOR`).

### Changed

- **Behavior change (both features on by default):** the streaming working row and the hidden-thinking label replace pi's static chrome. Restore pi's defaults with `workingIndicator.enabled: false` and `thinkingIndicator.enabled: false`.
- Bumped `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from `^0.84.3` to `^0.84.4`.

## [0.6.24] - 2026-08-24

### Fixed

- Extension no longer fails to load when installed as a pi package on pi 0.84.3: the SDK's new `session-share.js` imports `@earendil-works/pi-ai/providers/radius-config`, which jiti's alias table does not cover; under CommonJS extension output the alias pipeline concatenated that subpath onto `dist/compat.js`, producing a nonexistent module and failing startup with `Cannot find module .../dist/compat.js/providers/radius-config`. The package now ships true ESM (`"type": "module"`; tsconfig was already `nodenext`), so runtime SDK imports resolve natively through Node exports maps.

### Changed

- Bumped `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `@earendil-works/pi-tui` devDependencies from `^0.82.0` to `^0.84.3`.

## [0.6.23] - 2026-08-21

### Added

- All options are now configurable in `pi-pretty.json` with environment variables as override layer: `theme`, `icons`, `enableTools`, `disableTools`, `maxHlChars`, `maxPreviewLines`, `cacheLimit` (precedence: env var > config file > built-in default; the theme additionally falls back to `~/.pi/agent/settings.json` before the default) ([#12](https://github.com/heyhuynhgiabuu/pi-pretty/issues/12)).

### Fixed

- Syntax highlighting no longer silently degrades to plain text for native pi users: pi's `settings.json` `theme` is a TUI appearance setting (`dark`/`light`/custom names), not a Shiki theme. The resolved theme is now validated against Shiki's bundled themes with a one-time warning and a fallback to `github-dark` when invalid ([#11](https://github.com/heyhuynhgiabuu/pi-pretty/issues/11)).

## [0.6.22] - 2026-08-20

### Fixed

- Removed the `tool_result` hook that prepended 4 spaces to every line of `read`, `grep`, and `bash` results ([#10](https://github.com/heyhuynhgiabuu/pi-pretty/issues/10)). The hook mutated model-visible, persisted content instead of the TUI view; rendering padding remains solely in the view layer (`renderResult`/`renderCall`).
- Added a regression test asserting no `tool_result` handler is registered and `read`/`bash`/`grep` execute output is byte-exact.

## [0.6.21] - 2026-07-29

### Fixed

- Preserved offset-aware line-number gutters after asynchronous syntax highlighting so expanded read output remains numbered across TUI re-renders ([#8](https://github.com/heyhuynhgiabuu/pi-pretty/issues/8)).

### Maintenance

- Aligned Pi SDK development dependencies and package peers with Pi 0.82.0.

## [0.6.20] - 2026-07-21

### Fixed

- Restored syntax highlighting and custom rendering for managed Pi package installs by resolving built-in tool factories through Pi's host SDK alias ([#7](https://github.com/heyhuynhgiabuu/pi-pretty/issues/7)).
- Added one bottom padding row to all custom tool call headers for clearer separation from tool results.

## [0.6.19] - 2026-07-19

### Added

- Added skill-aware `SKILL.md` read rendering with themed collapsed and expanded states, frontmatter names, and syntax-highlighted content.

### Fixed

- Delegated image blocks to Pi's host renderer to prevent duplicate output and cross-package `Image` ownership failures while preserving SDK fallback notes.
- Initialized all tool output as collapsed when an interactive Pi session starts.

### Maintenance

- Declared Shiki directly, removed unused Typebox and dead rendering helpers, and cleared dependency audit findings.

## [0.6.18] - 2026-07-17

### Changed

- Upgraded `@ff-labs/fff-node` from 0.9.6 to 0.10.0.
- Standardized pi-tui `Text` resolution on static imports through Pi's extension loader.

### Fixed

- Tool calls and results no longer render blank when Pi supplies `@earendil-works/pi-tui` through a jiti alias ([#3](https://github.com/heyhuynhgiabuu/pi-pretty/issues/3), [#4](https://github.com/heyhuynhgiabuu/pi-pretty/pull/4)).
- Removed the silent `StubText` fallback while preserving explicit constructor injection for tests and custom renderers.

## [0.6.17] - 2026-07-11

### Changed

- Simplified tool headers: icon-prefixed `find`, `grep`, and `read` labels; cleaner bash result metadata and spacing.
- Disabled `ls` by default; removed the `multi_grep` custom tool.
- Added `customToolTitle()` for future pi-pretty custom tools (`⚙ <name>`).

### Fixed

- `find` renders matching paths instead of `(no matches)` when results exist.
- `read` uses native Pi TUI image rendering, with terminal fallback and success/error backgrounds.
- Failed `find`, `grep`, and `read` call headers use the error theme color.

## [0.6.16] - 2026-07-01

### Changed

- Pi **0.80.3** alignment: `peerDependencies` and dev dependencies on `@earendil-works/pi-coding-agent` `^0.80.0` / `^0.80.3`; `@earendil-works/pi-ai` `^0.80.0`.
- Tool result body indent: **one** leading space (`TOOL_RESULT_INDENT`) instead of two across read/bash/grep/ls/find/diff render paths.
- **Default collapsed tool output**: `toolOutputExpanded: false` on session start so result bodies are hidden until you expand (Pi **ctrl+o** / `app.tools.expand`, **Ctrl+Shift+O** expand all — see [Pi keybindings](https://pi.dev/docs/latest/keybindings)).
- **`find` tool**: normalize bare globs (`*.ts` → `**/*.ts`); keep `**/*` (no `*` collapse); when FFF `glob` returns 0 for a glob pattern, fall back to SDK **find (fd)**; surface engine in `details.notices` (FFF / SDK / weak-match).

### Fixed

- `fillToolBackground`: skip extra width padding when a line already has `TOOL_RESULT_INDENT` (including after ANSI SGR prefixes).
- `bash` `renderCall`: no ellipsis on command when expanded; collapsed headers clip to terminal width.
- `read` image paths use core `convertToPng` (BMP and other rasters), matching Pi 0.80.3 built-in read behavior.

## [0.6.15] - 2026-06-26

### Fixed

- `read` image attachments: `mimeType` is now `image/png` when the file is converted to PNG (e.g. BMP), so Kitty/iTerm inline previews work instead of showing a path-only placeholder.