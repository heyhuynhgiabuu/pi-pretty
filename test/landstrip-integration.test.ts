import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	createBashToolDefinition,
	createEventBus,
	DefaultResourceLoader,
	type ExtensionFactory,
	ExtensionRunner,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createLandstripIntegration } from "pi-landstrip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetSharedFffServiceForTests } from "../src/fff.js";
import piPrettyExtension from "../src/index.js";

class MockText {
	private text = "";
	setText(value: string) {
		this.text = value;
	}
	getText() {
		return this.text;
	}
	render() {
		return this.text.split("\n");
	}
}

const theme = { fg: (_key: string, text: string) => text, bold: (text: string) => text };
let cwd: string;
let agentDir: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "pi-pretty-landstrip-"));
	agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	vi.stubEnv("PRETTY_CONFIG_DIR", agentDir);
	vi.stubEnv("PRETTY_DISABLE_TOOLS", "read,find,grep,ls");
});

afterEach(() => {
	resetSharedFffServiceForTests();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(cwd, { recursive: true, force: true });
});

const prettyExtension: ExtensionFactory = (pi) =>
	piPrettyExtension(pi, {
		sdk: { getAgentDir: () => agentDir },
		fffModule: { FileFinder: { create: () => ({ ok: false, error: "disabled in test" }) } } as never,
		TextComponent: MockText,
	});

async function loadWithPiRunner(factories: ExtensionFactory[]) {
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		eventBus: createEventBus(),
		extensionFactories: factories,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const { extensions, errors, runtime } = loader.getExtensions();
	expect(errors).toEqual([]);
	runtime.getThinkingLevel = () => "off";
	const runner = new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), {} as never);
	const runnerErrors: unknown[] = [];
	runner.onError((error) => runnerErrors.push(error));
	return { runner, extensions, runnerErrors };
}

function renderPartial(runner: ExtensionRunner, tool: ToolDefinition, result: any) {
	const renderers = runner.resolveToolRenderers("bash", () => tool)!;
	expect(renderers.renderShell).toBe("self");
	const component = new MockText();
	const rendered = renderers.renderResult!(
		result,
		{ expanded: true, isPartial: true },
		theme as never,
		{
			state: {},
			expanded: true,
			isPartial: true,
			lastComponent: component,
		} as never,
	) as unknown as MockText;
	expect(rendered).toBe(component);
	expect(stripVTControlCharacters(rendered.getText())).toContain("running…");
	expect(stripVTControlCharacters(rendered.getText())).not.toContain("done");
}

describe("native Landstrip Bash ownership", () => {
	it.each([true, false])(
		"preserves execution and rendering across session restarts (pretty first=%s)",
		async (prettyFirst) => {
			const integration = createLandstripIntegration({ cwd });
			const dispose = vi.fn();
			const prepare = vi.fn(({ command }) => ({
				executable: process.execPath,
				args: ["-e", `process.stdout.write(${JSON.stringify(command)})`],
				launcherEnv: {},
				dispose,
			}));
			const unregister = integration.registerShellProvider({ id: "test-shell", prepare });
			const prepareProcess = vi.spyOn(integration, "prepareProcess");
			let ownerTool: ToolDefinition;
			const landstripExtension: ExtensionFactory = (pi) =>
				integration.register({
					...pi,
					getFlag: (name) => (name === "no-sandbox" ? true : pi.getFlag(name)),
					registerTool: (tool) => {
						ownerTool = tool;
						pi.registerTool(tool);
					},
				});
			const { runner, extensions, runnerErrors } = await loadWithPiRunner(
				prettyFirst ? [prettyExtension, landstripExtension] : [landstripExtension, prettyExtension],
			);
			expect(extensions[prettyFirst ? 0 : 1].tools.has("bash")).toBe(false);
			expect(runner.getToolDefinition("bash")).toBe(ownerTool!);
			const nativeExecute = ownerTool!.execute;
			try {
				for (const reason of ["startup", "reload"] as const) {
					await runner.emit({ type: "session_start", reason });
					expect(runner.getToolDefinition("bash")!.execute).toBe(nativeExecute);
					const signal = new AbortController().signal;
					const update = vi.fn((result) => renderPartial(runner, ownerTool!, result));
					const result = await ownerTool!.execute(
						"bash-call",
						{ command: "printf test" },
						signal,
						update,
						runner.createContext(),
					);
					expect(result.content).toEqual([{ type: "text", text: "printf test" }]);
					expect(update).toHaveBeenCalled();
					expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ command: "printf test", cwd, signal }));
					await runner.emit({ type: "session_shutdown", reason: "reload" });
				}
				expect(prepare).toHaveBeenCalledTimes(2);
				expect(dispose).toHaveBeenCalledTimes(2);
				expect(prepareProcess).not.toHaveBeenCalled();
				expect(runnerErrors).toEqual([]);
			} finally {
				unregister();
				await runner.emit({ type: "session_shutdown", reason: "exit" });
			}
		},
	);

	it("does not fall through to local execution when the native shell provider rejects", async () => {
		const integration = createLandstripIntegration({ cwd });
		const failure = new Error("provider denied command");
		const prepare = vi.fn().mockRejectedValue(failure);
		const unregister = integration.registerShellProvider({ id: "rejecting-shell", prepare });
		const landstripExtension: ExtensionFactory = (pi) => integration.register({ ...pi, getFlag: () => true });
		const { runner } = await loadWithPiRunner([prettyExtension, landstripExtension]);
		try {
			await runner.emit({ type: "session_start", reason: "startup" });
			await expect(
				runner
					.getToolDefinition("bash")!
					.execute("bash-call", { command: "printf test" }, undefined, undefined, runner.createContext()),
			).rejects.toBe(failure);
			expect(prepare).toHaveBeenCalledOnce();
		} finally {
			unregister();
			await runner.emit({ type: "session_shutdown", reason: "exit" });
		}
	});
});

describe("native Pi Bash without Landstrip", () => {
	it("leaves the SDK backend untouched and renders its empty initial update as running", async () => {
		const { runner, extensions } = await loadWithPiRunner([prettyExtension]);
		const nativeTool = createBashToolDefinition(cwd);
		const execute = nativeTool.execute;
		expect(extensions[0].tools.has("bash")).toBe(false);
		const updates: any[] = [];
		const update = (result: any) => {
			updates.push(result);
			renderPartial(runner, nativeTool, result);
		};
		const command = `"${process.execPath.replaceAll("\\", "/")}" -e "process.stdout.write('sdk-output')"`;
		try {
			await runner.emit({ type: "session_start", reason: "startup" });
			const result = await nativeTool.execute("sdk-call", { command }, undefined, update, runner.createContext());
			expect(nativeTool.execute).toBe(execute);
			expect(updates[0].content).toEqual([]);
			expect(result.content).toEqual([{ type: "text", text: "sdk-output" }]);
			expect(result.structuredContent?.exit_code).toBe(0);
		} finally {
			await runner.emit({ type: "session_shutdown", reason: "exit" });
		}
	});
});
