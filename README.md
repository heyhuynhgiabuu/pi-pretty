# pi-pretty

[![npm version](https://img.shields.io/npm/v/@heyhuynhgiabuu/pi-pretty)](https://www.npmjs.com/package/@heyhuynhgiabuu/pi-pretty)
[![GitHub release](https://img.shields.io/github/v/release/heyhuynhgiabuu/pi-pretty)](https://github.com/heyhuynhgiabuu/pi-pretty/releases/latest)

A [pi](https://pi.dev) extension that upgrades built-in tool output in the terminal without changing tool behavior.

It currently enhances:

- **`read`**: syntax-highlighted text previews with line numbers, plus inline image rendering when the terminal supports it
- **`bash`**: colored exit summary (`exit 0`/`exit 1`) with a preview body of command output
- **`ls` / `find` / `grep`**: Nerd Font file icons with tree/grouped layouts and clearer match rendering

> Companion to [@heyhuynhgiabuu/pi-diff](https://github.com/heyhuynhgiabuu/pi-diff) for `write`/`edit` diff rendering.

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-pretty
```

Latest release: https://github.com/heyhuynhgiabuu/pi-pretty/releases/latest

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
When running in **tmux**, pi-pretty uses passthrough escape sequences so inline image protocols still work.

## Configuration

Optional environment variables:

- `PRETTY_THEME` (default: `github-dark`)
- `PRETTY_MAX_HL_CHARS` (default: `80000`)
- `PRETTY_MAX_PREVIEW_LINES` (default: `80`)
- `PRETTY_CACHE_LIMIT` (default: `128`)
- `PRETTY_ICONS` (`nerd` by default, set to `none` to disable icons)

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
```

## License

MIT — [huynhgiabuu](https://github.com/heyhuynhgiabuu)
