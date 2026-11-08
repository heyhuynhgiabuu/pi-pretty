# Changelog

## [0.10.0] - 2026-11-08

### Added

- `claudeStyle.expandFileTools` (default `false`): open `write`/`edit`/`apply_patch` diffs by default instead of one collapsed `+N -N` row. Each file tool opens **once**, tracked in a `WeakSet`, so a later collapse from a click or Ctrl+O sticks. Opt-in because an open diff puts its group on the uncached render path.
- `claudeStyle.groupInlineTools` (default `[]`): extra tool names, added to `write`/`edit`/`apply_patch`, whose expanded body stays inside a tool group instead of breaking it apart. Only affects tools the style already renders as rows (`bash` `read` `grep` `find` `ls` `write` `edit` `apply_patch` `codemode` `recall`) — an arbitrary MCP tool is ignored. Note that a group holding an expanded member cannot use the cached render path, so it re-renders every frame.

### Changed

- `toolStyle: "claudecode"`: an expanded file tool now keeps its place in the group and shows its diff inline, with pi-diff's own green and red row backgrounds. Every other tool still leaves the group when expanded, so its full output, syntax highlighting and images render as before.
- Tool **bodies** are now painted, not just call headers. `codemode` and `recall` render in the host's `"self"` shell, where no box is drawn, so every unpainted row showed the terminal's own background — an expanded `codemode` script read as a hole under its header. `recall`, which has no result renderer of its own, now builds a body instead of falling back to the host's plain-text path. `task`, `agents` and `peer` are deliberately untouched: they keep the host `Box`, which already paints `toolPendingBg`/`toolSuccessBg`/`toolErrorBg` with the right padding.
- `config.claudeStyle` is now built member by member. It was assigned wholesale, so a second key would have silently erased the first.

### Fixed

- `recall`'s expanded body is sanitized before it is drawn. Raw escape sequences in tool output — an OSC title change, `ESC[2J` — previously reached the terminal, which can reprogram it. Stripping is per content block, in the host's order (ANSI, then binary controls, then CR): sanitizing after joining blocks let an unterminated OSC in one block consume the next block's text up to its BEL.
- `pi-tui`'s `stripTerminalSequences` is not used for that: it scans to the first `m`/`G`/`K`/`H`/`J` and discards everything between, so `"keep ESC[?25l me"` becomes `"keepe"`, and it misses C1 entirely. The ANSI regex is ported from the host's `utils/ansi.js` instead.
- A tool whose result carries an image now always breaks its group, config or not. A tree row filters image payload lines, so grouping one hid the image behind its fallback note. The check is structural and independent of expansion, because the host adds its image components whether or not the tool is expanded.

#### Verification

- 381 tests passing across 25 files; typecheck and build passing; no new lint errors.
- Ten mutations, each caught: the three paint sites, the pi-diff exclusion, `external = true` on the local path, the ANSI filter, the control filter, the `toolOutput` foreground, the `Text` background, sanitizing after the join, CR before the ANSI strip, the image guard, and its expansion-independence.

## [0.9.0] - 2026-11-02

### Fixed

- `preserveBoxBackground` truncated extended foreground sequences, so a 256-colour foreground whose palette index fell in the 40-49 or 100-107 range lost its colour entirely. The `38` branch kept only its introducer and sub-code, so the arguments were re-read as standalone SGR codes: `38;5;42` came out as `38;5`, and `38;5;42;1` came out as `38;5;1` — red instead of palette 42, with the bold lost. Sweeping all 256 palette indices against the previous code, 18 lost their colour (40-49 and 100-107). `38;2` was already handled correctly and is unchanged.
- `preserveBoxBackground`'s `48;2` branch skipped six parameters instead of five, swallowing whatever code followed an extended background: `1;48;2;1;2;3;31` came out as `1`, losing the red. Both branches now take exactly the arguments that belong to them.
- The `fff` restricted-base-path refusal no longer reappears after `/reload`. The service survives on `globalThis`, so a reloaded extension's classifier ran against an error built by the previous module instance and `instanceof` failed (#19, thanks @DeadKper).

### Changed

- `toolStyle: "claudecode"`: the call row now paints its background across the full render width. The style renders in the host's `"self"` shell, which draws no box, so a tool call previously had no background at all and its expanded body sat on the terminal background with the header floating above it. Only the header row is painted; body lines stay the tool's own output. Folded group members keep their text colours and drop the background, so a group does not become a stack of painted bars.
- `toolStyle: "claudecode"`: the tool name uses `toolTitle` instead of `text`. On Pi's bundled `dark` and `light` themes both keys resolve to the same colour, so the visible change appears only under themes that define a distinct title colour — on `catppuccin` the name goes from `#cdd6f4` to `#f9e2af`.

### Maintenance

- devDependencies follow the pi runtime at 1.5.0. The mismatch was hiding a real break: 1.5.0's `highlightCode` resolves colours through the global theme, so the codemode test needed `initTheme` before the file's module mock applies.

#### Verification

- 367 tests passing across 25 files; typecheck and build passing; no new lint errors.
- The `preserveBoxBackground` tests were written against the previous code first: 3 of the 8 fail there and all 8 pass now.
- The background paint is pinned by three tests, each of which fails when its behaviour is reverted: dropping the fill, dropping the width padding, and painting the body.

## [0.8.0] - 2026-10-22

### Added

- `workingIndicator.intervalMs` and `thinkingIndicator.intervalMs` (or `PRETTY_WORKING_INTERVAL_MS` / `PRETTY_THINKING_INTERVAL_MS`) tune how often the indicator animators request a full re-render. Both default to 33 ms and are clamped to that floor; raising them cuts render pressure on long sessions ([#18](https://github.com/heyhuynhgiabuu/pi-pretty/pull/18), thanks @october2823).
- `userRail` draws a one-cell tinted bar beside user messages instead of a full-width background, so translucent and acrylic terminals keep their blur ([#18](https://github.com/heyhuynhgiabuu/pi-pretty/pull/18), thanks @october2823).

### Fixed

- `ls` header entry count no longer includes the SDK's `[N entries limit reached…]` notice line.
- `toolStyle: "claudecode"`: settled tool groups are cached by member identity rather than by key alone, so a rebuilt transcript (`/tree`, fork, reload) no longer serves rows whose mouse handlers point at dropped components. Interrupted calls are marked instead of showing a frozen `Running` spinner, and the cache no longer fills with stale widths after a resize ([#17](https://github.com/heyhuynhgiabuu/pi-pretty/pull/17), thanks @october2823).

## [0.7.1] - 2026-10-16

### Fixed

- `toolStyle: "claudecode"`: expanding a collapsed `read`, `bash`, `find`, `grep`, or `ls` result no longer falls back to the host's plain-text renderer. The original renderer is now handed only its own previous component, never a collapsed row, so syntax highlighting and line-number gutters are kept ([#14](https://github.com/heyhuynhgiabuu/pi-pretty/issues/14)).
- Windows: `pi-pretty.json`, `settings.json` and the FFF data directory are now found when `HOME` is unset. The default agent directory falls back to `os.homedir()` instead of silently ignoring the config ([#16](https://github.com/heyhuynhgiabuu/pi-pretty/issues/16)).
- `ls` tree view now shows a per-type Nerd Font icon for files (directories keep the folder icon), and keeps the SDK's `[N entries limit reached…]` notices below the tree instead of rendering them as entries ([#15](https://github.com/heyhuynhgiabuu/pi-pretty/pull/15), thanks @october2823).

### Maintenance

- Remove `bun.lock`; the project uses npm.

## [0.7.0] - 2026-10-10

### Added

- Opt-in `toolStyle: "claudecode"` (default `default`, no change for existing users): collapsed tools render as `✓ Name (args)` with an `└` result row (line counts, duration, bash `timeout`, `+N -N` for edits), a braille spinner while running, `·` while pending, and `✗` on failure.
- Fold consecutive tool calls into `Done (…)` / `Running (…)` groups with a `├─`/`└─` tree. Clicking a tool in a group expands it; Ctrl+O expands everything. Tools the style does not cover break a group instead of being flattened into it.
- Style `write`, `edit`, `apply_patch` (pi-diff), `codemode` (Pi built-in), and `recall` (pikit) without re-registering them, by deciding their renderers per component by tool name. Their full output remains available when expanded.
- `(ctrl+o to expand)` / `(ctrl+o to collapse)` hints on folded groups and expanded calls, and `thought 3s (ctrl+t to expand)` for hidden thinking, using the user's own key bindings.
- In this style: flush-left `thinking` / `thought 3s` labels, no `❯` prefix on user messages, and an input box with plain horizontal rules and a flush-left `❯` instead of the rounded border.

### Maintenance

- Add `vitest.config.ts` so tests never read the developer's real `~/.pi/agent/pi-pretty.json`.
- Add regression coverage for rows, grouping, click-to-expand, delegated renderers, and the unboxed prompt editor.

## [0.6.31] - 2026-10-08

### Added

- Honor Pi's `outputPad` setting in self-rendered `read`, `bash`, `ls`, `find`, and `grep` output, with one-space fallback on older hosts. Keep directory/file nesting independent of outer padding.
- Prefer Pi's recorded `durationMs` for execution-time displays, including zero-duration and failed bash results, with fallback to existing elapsed metadata on older hosts.

### Fixed

- Preserve the SDK read tool's `outputSchema`, retaining structured results when called through codemode.
- Keep read highlighting and bash render caches consistent when padding or execution timing changes.
- Resolve the host's jiti dependency without assuming a nested `node_modules` layout in the extension entrypoint test.

### Maintenance

- Align the four Pi development SDK dependencies and both lockfiles with Pi 1.1.0. Runtime peer ranges remain unchanged.
- Add regression coverage for padding, nesting, timing fallbacks, and stale asynchronous highlighting.

## [0.6.30] - 2026-09-30

### Fixed

- Preserve the SDK bash tool's optional `outputSchema` when pi-pretty re-registers it, retaining structured-result schema metadata.

### Maintenance

- Update Pi development SDK dependencies from `^0.85.0` to `^0.87.0`.

## [0.6.29] - 2026-09-14

### Fixed

- Regenerated `bun.lock`, which had drifted: it declared the `^0.85.0` pi toolchain without re-resolving, so it still pinned the 0.82.1 packages and `bun install --frozen-lockfile` failed. Bun now resolves the pi toolchain to 0.85.1 with `undici` 8.9.0 (fixes GHSA-4cwx-7wf7-3272 / CVE-2026-13697 plus the other advisories in the stale tree), `@ff-labs/fff-node` 0.10.6, and `@shikijs/cli` 4.4.3; `bun audit` reports no vulnerabilities.

## [0.6.28] - 2026-09-13

### Fixed

- Corrected the `bash` tool's ripgrep guidance: `-u` is `--no-ignore` only (hidden files need `--hidden`/`-uu`), alternation patterns must be quoted, and Pi's built-in bash prompt guidelines are now merged instead of replaced.
- The `read` tool now preserves Pi's built-in prompt guideline, tool-list snippet, and constrained-sampling hint instead of dropping them when pi-pretty re-registers it, and `ls` keeps its tool-list snippet.

## [0.6.27] - 2026-09-09

### Added

- User messages render with a `❯` prompt icon using `userMessageText`; live input follows Pi's active thinking-level color (`thinkingOff` through `thinkingMax`) for its icon and now renders as a theme-colored rounded box.

### Fixed

- Tool titles again have one blank row above and below them, and custom tool bodies now retain one blank row below their output. Host `edit`/`write` renderers remain unchanged.
- Collapsed file-read previews now place their line count and `ctrl+o` expand hint in the title row instead of a separate body row.
- Collapsed `bash`, `find`, `grep`, and `ls` summaries now appear in their title rows instead of separate body rows.
- Collapsed reads of Pi's `README.md`, `docs/`, and `examples/` paths now use the `read docs` label, matching Pi's default renderer.
- The working shimmer now uses Pi's embedded working-status row at the top border of the input when supported, with the older above-editor widget retained as a compatibility fallback.
- The working shimmer no longer appends its own interrupt hint or live token-count suffix; legacy `workingIndicator.hint` configuration remains accepted but is ignored.
- Hidden-thinking labels now include left padding and show millisecond precision below one second (`250ms` instead of `0s`).
- FFF no longer surfaces a startup error when Pi launches from the exact home directory or filesystem root. It now falls back to SDK-backed `find`/`grep`; home and root indexing require explicit opt-in via `pi-pretty.json`, environment variables, or CLI flags.
- FFF initialization failures no longer duplicate the `FFF init failed:` prefix; unexpected failures are reported once as warnings.

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