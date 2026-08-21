# pi-pretty

[![npm version](https://img.shields.io/npm/v/@heyhuynhgiabuu/pi-pretty)](https://www.npmjs.com/package/@heyhuynhgiabuu/pi-pretty)
[![GitHub release](https://img.shields.io/github/v/release/buddingnewinsights/pi-pretty)](https://github.com/buddingnewinsights/pi-pretty/releases/latest)

A [pi](https://pi.dev) extension that upgrades built-in tool output in the terminal and includes built-in FFF-powered search for `find`/`grep`.

Tool **result bodies** start **collapsed** (header + line count). Use Pi **Ctrl+O** (`app.tools.expand`) on a tool block to show full output; **Ctrl+Shift+O** expands all. See [Pi keybindings](https://pi.dev/docs/latest/keybindings).

It currently enhances:

- **`read`**: syntax-highlighted text previews with line numbers, plus inline image rendering when the terminal supports it
- **`bash`**: colored exit summary (`exit 0`/`exit 1`) with a preview body of command output
- **`ls`**: Nerd Font file icons with tree-oriented rendering
- **`find` / `grep`**: built-in FFF-backed search with frecency-aware results, plus grouped/highlighted rendering

> Companion to [@heyhuynhgiabuu/pi-diff](https://github.com/buddingnewinsights/pi-diff) for `write`/`edit` diff rendering.

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-pretty
```

Latest release: https://github.com/buddingnewinsights/pi-pretty/releases/latest

Or load locally:

```bash
pi -e ./src/index.ts
```

## Screenshots

![Bash and read rendering](media/bash-and-read.png)
*`bash` exit summary + output preview, and syntax-highlighted `read` text output.*

![Icons and grep rendering](media/icons-and-grep.png)
*`ls`/`find`/`grep` with Nerd Font icons and grouped/tree-oriented rendering.*

![Inline image rendering](media/inline-image.png)
*`read` rendering an image inline in supported terminals.*

## Terminal support for inline images

Inline image previews are supported in **Ghostty**, **Kitty**, **iTerm2**, and **WezTerm**.  
When running in **tmux**, pi-pretty uses passthrough escape sequences.

> tmux must allow passthrough. Enable it with:
>
> ```tmux
> set -g allow-passthrough on
> ```
>
> (or run once in a session: `tmux set -g allow-passthrough on`)

## Bundled FFF search

`pi-pretty` now bundles `@ff-labs/fff-node` and owns the built-in `find` / `grep` search behavior directly.

If you use bundled FFF mode, do not load `pi-fff` at the same time, because Pi extensions do not compositionally share ownership of the same built-in tool names.

FFF data is stored under a pi-pretty-specific path:

```text
~/.pi/agent/pi-pretty/fff/
```

This makes it clear that the cache belongs to this extension rather than Pi core.

## How to use it

### 1. Install and load only `pi-pretty`

```bash
pi install npm:@heyhuynhgiabuu/pi-pretty
```

Do **not** also load `pi-fff` in the same Pi setup.

### 2. Start Pi in a project

```bash
cd /path/to/your/project
pi
```

On session start, pi-pretty initializes the bundled FFF index for the current working directory.

### 3. Use the built-in tools normally

You keep using the normal built-in tool names — pi-pretty owns them directly.

Examples:

```text
find pattern="*.ts" path="src"
grep pattern="handleRequest" glob="*.ts"
read path="src/index.ts"
ls path="src"
```

### 4. Check FFF status or force a rescan

pi-pretty also provides two maintenance commands:

```text
/fff-health
/fff-rescan
```

Use them when:
- you want to confirm indexing is active
- the session started with a partial index warning
- you made large filesystem changes and want a fresh scan

### Notes

- `find` results are frecency-aware, so files you touch more often can bubble up earlier.
- `grep` can show a cursor notice when more results are available.
- If you see a partial index warning, let the session settle or run `/fff-rescan`.

## Configuration

### Config file: `~/.pi/agent/pi-pretty.json`

Place a JSON file alongside Pi's `settings.json` to customize pi-pretty. Every option can also be set via environment variables, which take precedence over the config file: **`env var > pi-pretty.json > built-in default`** (the theme additionally falls back to `~/.pi/agent/settings.json`'s `theme` before the default).

```json
{
	"background": {
		"tool": "#1e1e2e",
		"error": "#2a1e1e"
	},
	"theme": "github-dark",
	"icons": "nerd",
	"enableTools": ["ls"],
	"disableTools": ["grep"],
	"maxHlChars": 80000,
	"maxPreviewLines": 80,
	"cacheLimit": 128
}
```

| Key | Type | Env var override | Default |
| --- | --- | --- | --- |
| `background.tool` | hex color | — | terminal default |
| `background.error` | hex color | — | `background.tool` |
| `theme` | Shiki theme name | `PRETTY_THEME` | `github-dark` (after `pi-pretty.json` `theme`, then `~/.pi/agent/settings.json` `theme`, when valid Shiki themes) |
| `icons` | `nerd` \| `none` (or `off`) | `PRETTY_ICONS` | `nerd` |
| `enableTools` | string array | `PRETTY_ENABLE_TOOLS` | `[]` (`ls` is opt-in) |
| `disableTools` | string array | `PRETTY_DISABLE_TOOLS` | `[]` |
| `maxHlChars` | positive int | `PRETTY_MAX_HL_CHARS` | `80000` |
| `maxPreviewLines` | positive int | `PRETTY_MAX_PREVIEW_LINES` | `80` |
| `cacheLimit` | positive int | `PRETTY_CACHE_LIMIT` | `128` |

- Config values take priority over theme-provided backgrounds (`toolBg` / `toolErrorBg`).
- All options except `background.*` are read once at startup; restart pi to apply changes to them (`background.*` applies live).
- To override the config directory, set `PRETTY_CONFIG_DIR` env var.

### Environment variables

Optional environment variables:

- `PRETTY_THEME` (overrides `pi-pretty.json` `theme`, which overrides `~/.pi/agent/settings.json` `theme`; otherwise pi-pretty falls back to that setting before `github-dark`)
- `PRETTY_CONFIG_DIR` — directory to read `pi-pretty.json` from (default: `~/.pi/agent/`)
- `PRETTY_MAX_HL_CHARS` (default: `80000`)
- `PRETTY_MAX_PREVIEW_LINES` (default: `80`)
- `PRETTY_CACHE_LIMIT` (default: `128`)
- `PRETTY_ICONS` (`nerd` by default, set to `none` to disable icons)
- `PRETTY_DISABLE_TOOLS` — comma-separated list of tool names to skip during registration (e.g. `read,grep`). Explicit disables take precedence over enabled defaults.
- `PRETTY_ENABLE_TOOLS` — comma-separated list of opt-in tools. `ls` is disabled by default; set `PRETTY_ENABLE_TOOLS=ls` to register it.

## Development

Future pi-pretty custom-tool renderers should use `customToolTitle(name)` from `src/tools/labels.ts`; it returns `⚙ <name>`. Built-in tool replacements keep their own labels.

```bash
npm install
npm run typecheck
npm run lint
npm test
```

## License

MIT — [huynhgiabuu](https://github.com/buddingnewinsights)
