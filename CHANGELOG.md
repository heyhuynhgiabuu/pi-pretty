# Changelog

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