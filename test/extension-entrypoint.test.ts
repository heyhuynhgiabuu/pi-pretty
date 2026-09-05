import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Run outside Vitest's module graph: native JS imports and jiti aliases must
// behave exactly as they do when a local extension has its own SDK dependency.
describe("manifest extension entrypoint", () => {
	it("freezes completed host rows while another message thinks, even with a local SDK", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-pretty-entry-"));
		try {
			mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
			writeFileSync(join(dir, ".pi", "agent", "settings.json"), JSON.stringify({ hideThinkingBlock: true }));
			const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.cwd();
const dir = process.env.PROBE_DIR;
const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
const jitiPath = join(dirname(fileURLToPath(sdk)), '../node_modules/jiti/lib/jiti-static.mjs');
const { createJiti } = await import(pathToFileURL(jitiPath));
const hostPath = join(dir, 'host.mjs');
writeFileSync(hostPath, \`export * from \${JSON.stringify(sdk)};
export class AssistantMessageComponent {
  constructor(timestamp) { this.lastMessage = { timestamp }; }
  setHiddenThinkingLabel(label) { this.label = label; }
}\`);
const { AssistantMessageComponent: HostRow } = await import(pathToFileURL(hostPath));
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { '@earendil-works/pi-coding-agent': hostPath },
});
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const extension = await jiti.import(join(root, manifest.pi.extensions[0]), { default: true });
const handlers = new Map();
await extension({ on: (name, handler) => handlers.set(name, handler), registerTool() {}, registerCommand() {} }, { sdk: {}, fffModule: { FileFinder: { create: () => ({ ok: false, error: 'disabled in loader test' }) } } });
const rows = [new HostRow(1), new HostRow(2), new HostRow(3)];
const ctx = {
  mode: 'tui', cwd: dir,
  sessionManager: { getSessionName: () => undefined },
  ui: {
    theme: { fg: (_, text) => text, getFgAnsi: () => '' },
    setToolsExpanded() {}, setWorkingVisible() {}, setWidget() {},
    setHiddenThinkingLabel(label) { for (const row of rows) row.setHiddenThinkingLabel(label); },
    notify(message) { if (!message.startsWith('FFF init failed:')) throw new Error(message); },
  },
};
let now = 10000;
Date.now = () => now;
const emit = (name, event = {}) => handlers.get(name)(event, ctx);
const thinking = timestamp => ({ role: 'assistant', timestamp, content: [{ type: 'thinking', thinking: 'reason' }] });
try {
  await emit('session_start');
  await emit('agent_start');
  for (const timestamp of [1, 2]) {
    const message = thinking(timestamp);
    await emit('message_update', { message });
    now += timestamp * 4000;
    await emit('message_update', { message: { ...message, content: [...message.content, { type: 'text', text: 'done' }] } });
    await emit('message_end', { message });
  }
  await emit('message_update', { message: thinking(3) });
  console.log(JSON.stringify(rows.map(row => row.label?.replace(/\\x1b\\[[0-9;]*m/g, ''))));
} finally {
  await emit('session_shutdown');
}
`], {
				cwd: process.cwd(),
				env: { ...process.env, PROBE_DIR: dir, PI_CODING_AGENT_DIR: dir, HOME: dir, PRETTY_WORKING_INDICATOR: "false", PRETTY_THINKING_INDICATOR: "true" },
				encoding: "utf8",
				timeout: 60_000,
			});
			expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual([
				"Thought for 4s", "Thought for 8s", "Thinking... 0s",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 65_000);
});
