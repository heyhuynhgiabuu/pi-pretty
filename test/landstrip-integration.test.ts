import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
	type BashToolOptions,
	createEventBus as createPiEventBus,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	ExtensionRunner,
	type InlineExtension,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { publishLandstripRuntime } from "pi-landstrip/api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetSharedFffServiceForTests } from "../src/fff.js";
import piPrettyExtension from "../src/index.js";
import { createLandstripBashOperations, type PiLandstripRuntimeV2 } from "../src/landstrip.js";

const REGISTER_EVENT = "landstrip:runtime:register:v2";
const DISCOVER_EVENT = "landstrip:runtime:discover:v2";
type LifecycleHandler = (...args: any[]) => unknown;

function createEventBus() {
	const emitter = new EventEmitter();
	return {
		emit: (channel: string, data: unknown) => void emitter.emit(channel, data),
		on(channel: string, handler: (data: unknown) => void) {
			emitter.on(channel, handler);
			return () => void emitter.off(channel, handler);
		},
	};
}

function createRuntime(sandbox: "enabled" | "disabled" | "unavailable" = "enabled") {
	return {
		version: 2,
		getContext: vi.fn(() => ({ version: 2, host: "pi", role: "primary", sandbox, cwd: "/workspace", depth: 0 })),
		registerShellProvider: vi.fn(),
		prepareProcess: vi.fn(),
		registerWorkerExtension: vi.fn(),
		getWorkerExtensions: vi.fn(() => []),
		on: vi.fn(),
	} as unknown as PiLandstripRuntimeV2;
}

function publishRuntime(bus: ReturnType<typeof createEventBus>, runtime: PiLandstripRuntimeV2): () => void {
	const unsubscribe = bus.on(DISCOVER_EVENT, (value) => {
		const discovery = value as { version?: number; register?: (runtime: PiLandstripRuntimeV2) => void };
		if (discovery.version === 2) discovery.register?.(runtime);
	});
	bus.emit(REGISTER_EVENT, { version: 2, runtime });
	return unsubscribe;
}

async function loadExtension(
	bus: ReturnType<typeof createEventBus>,
	sdkExecute: ReturnType<typeof vi.fn>,
	landstripExecute: ReturnType<typeof vi.fn>,
) {
	const tools = new Map<string, any>();
	const lifecycle = new Map<string, LifecycleHandler[]>();
	const createBashTool = vi.fn((_cwd: string, options?: BashToolOptions) => ({
		parameters: {},
		execute: options?.operations ? landstripExecute : sdkExecute,
	}));
	const pi = {
		events: bus,
		registerCommand: vi.fn(),
		registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
		on: vi.fn((event: string, handler: LifecycleHandler) => {
			const handlers = lifecycle.get(event) ?? [];
			handlers.push(handler);
			lifecycle.set(event, handlers);
		}),
	} as unknown as ExtensionAPI;
	await piPrettyExtension(pi, {
		sdk: {
			createBashToolDefinition: createBashTool,
			getAgentDir: () => "/tmp/pi-pretty-landstrip-test",
		},
	});
	return { createBashTool, lifecycle, tools };
}

async function startSession(lifecycle: Map<string, LifecycleHandler[]>, ctx: ExtensionContext): Promise<void> {
	const handlers = lifecycle.get("session_start") ?? [];
	for (const handler of handlers) await handler({}, ctx);
}

function createLandstripOwnerExtension(
	runtime: PiLandstripRuntimeV2,
	execute: ReturnType<typeof vi.fn>,
): ExtensionFactory {
	return (pi) => {
		let unpublish: (() => void) | undefined = publishLandstripRuntime(pi, runtime);
		pi.registerTool({
			name: "bash",
			label: "Landstrip Bash",
			description: "Execute shell commands through Landstrip.",
			parameters: {},
			execute,
		});
		pi.on("session_start", () => {
			unpublish?.();
			unpublish = publishLandstripRuntime(pi, runtime);
		});
		pi.on("session_shutdown", () => {
			unpublish?.();
			unpublish = undefined;
		});
	};
}

async function loadWithPiRunner(extensionFactories: InlineExtension[]): Promise<ExtensionRunner> {
	const loader = new DefaultResourceLoader({
		cwd: "/workspace",
		agentDir: "/tmp/pi-pretty-landstrip-test",
		settingsManager: SettingsManager.inMemory(),
		eventBus: createPiEventBus(),
		extensionFactories,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const { extensions, errors, runtime } = loader.getExtensions();
	expect(errors).toEqual([]);
	return new ExtensionRunner(extensions, runtime, "/workspace", SessionManager.inMemory("/workspace"), {} as never);
}

afterEach(resetSharedFffServiceForTests);

describe("pi-landstrip autodetection", () => {
	it.each([
		["pi-pretty first", true],
		["pi-landstrip first", false],
	] as const)("preserves Bash ownership when %s across session restarts", async (_label, prettyFirst) => {
		const runtime = createRuntime();
		const sdkExecute = vi.fn().mockResolvedValue({ content: [] });
		const prettyLandstripExecute = vi.fn().mockResolvedValue({ content: [] });
		const landstripOwnerExecute = vi.fn().mockResolvedValue({ content: [] });
		const createBashTool = vi.fn((_cwd: string, options?: BashToolOptions) => ({
			parameters: {},
			execute: options?.operations ? prettyLandstripExecute : sdkExecute,
		}));
		const prettyExtension: ExtensionFactory = (pi) =>
			piPrettyExtension(pi, {
				sdk: {
					createBashToolDefinition: createBashTool,
					getAgentDir: () => "/tmp/pi-pretty-landstrip-test",
				},
			});
		const landstripExtension = createLandstripOwnerExtension(runtime, landstripOwnerExecute);
		const runner = await loadWithPiRunner(
			prettyFirst ? [prettyExtension, landstripExtension] : [landstripExtension, prettyExtension],
		);
		const executeBash = async () => {
			const bash = runner.getToolDefinition("bash");
			expect(bash).toBeDefined();
			await bash?.execute("bash-call", { command: "printf test" }, undefined, undefined, runner.createContext());
		};

		await runner.emit({ type: "session_start", reason: "startup" });
		await executeBash();
		await runner.emit({ type: "session_shutdown", reason: "reload" });
		await runner.emit({ type: "session_start", reason: "reload" });
		await executeBash();

		if (prettyFirst) {
			expect(prettyLandstripExecute).toHaveBeenCalledTimes(2);
			expect(landstripOwnerExecute).not.toHaveBeenCalled();
		} else {
			expect(landstripOwnerExecute).toHaveBeenCalledTimes(2);
			expect(prettyLandstripExecute).not.toHaveBeenCalled();
		}
		expect(sdkExecute).not.toHaveBeenCalled();
	});

	it("rejects V2 runtimes missing any required capability", async () => {
		const bus = createEventBus();
		const sdkExecute = vi.fn().mockResolvedValue({ content: [] });
		const landstripExecute = vi.fn().mockResolvedValue({ content: [] });
		const { lifecycle, tools } = await loadExtension(bus, sdkExecute, landstripExecute);
		const ctx = { cwd: "/workspace" } as ExtensionContext;
		const requiredMethods = [
			"getContext",
			"registerShellProvider",
			"prepareProcess",
			"registerWorkerExtension",
			"getWorkerExtensions",
			"on",
		] as const;

		await startSession(lifecycle, ctx);
		for (const [index, method] of requiredMethods.entries()) {
			bus.emit(REGISTER_EVENT, { version: 2, runtime: { ...createRuntime(), [method]: undefined } });
			await tools.get("bash").execute("bash-call", {}, undefined, undefined, ctx);
			expect(sdkExecute).toHaveBeenCalledTimes(index + 1);
			expect(landstripExecute).not.toHaveBeenCalled();
		}
	});

	it("uses the SDK when pi-landstrip is absent, then adopts a late V2 runtime", async () => {
		const bus = createEventBus();
		const sdkExecute = vi.fn().mockResolvedValue({ content: [] });
		const landstripExecute = vi.fn().mockResolvedValue({ content: [] });
		const { lifecycle, tools } = await loadExtension(bus, sdkExecute, landstripExecute);
		const ctx = { cwd: "/workspace" } as ExtensionContext;
		const params = { command: "printf test" };
		const signal = new AbortController().signal;
		const update = vi.fn();

		await startSession(lifecycle, ctx);
		expect(tools.has("bash")).toBe(true);
		await tools.get("bash").execute("bash-call", params, signal, update, ctx);
		expect(sdkExecute).toHaveBeenCalledWith("bash-call", params, signal, undefined, ctx);

		bus.emit(REGISTER_EVENT, { version: 1, runtime: createRuntime() });
		const unpublish = publishRuntime(bus, createRuntime());
		await tools.get("bash").execute("bash-call", params, signal, update, ctx);
		expect(landstripExecute).toHaveBeenCalledOnce();
		expect(landstripExecute).toHaveBeenCalledWith("bash-call", params, signal, update, ctx);
		unpublish();
	});

	it("continues through the V2 runtime when sandboxing is disabled", async () => {
		const bus = createEventBus();
		const unpublish = publishRuntime(bus, createRuntime("disabled"));
		const sdkExecute = vi.fn().mockResolvedValue({ content: [] });
		const landstripExecute = vi.fn().mockResolvedValue({ content: [] });
		const { lifecycle, tools } = await loadExtension(bus, sdkExecute, landstripExecute);
		const ctx = { cwd: "/workspace" } as ExtensionContext;

		await startSession(lifecycle, ctx);
		await tools.get("bash").execute("bash-call", {}, undefined, undefined, ctx);

		expect(landstripExecute).toHaveBeenCalledOnce();
		expect(sdkExecute).not.toHaveBeenCalled();
		unpublish();
	});

	it("refuses execution when the V2 sandbox is unavailable", async () => {
		const bus = createEventBus();
		const runtime = createRuntime("unavailable");
		const unpublish = publishRuntime(bus, runtime);
		const sdkExecute = vi.fn().mockResolvedValue({ content: [] });
		const landstripExecute = vi.fn().mockResolvedValue({ content: [] });
		const { lifecycle, tools } = await loadExtension(bus, sdkExecute, landstripExecute);
		const ctx = { cwd: "/workspace" } as ExtensionContext;

		await startSession(lifecycle, ctx);
		const result = await tools.get("bash").execute("bash-call", {}, undefined, undefined, ctx);

		expect(result).toMatchObject({ isError: true, content: [{ text: "Sandbox is unavailable; refusing command" }] });
		expect(sdkExecute).not.toHaveBeenCalled();
		expect(landstripExecute).not.toHaveBeenCalled();
		unpublish();
	});
});

describe("pi-landstrip Bash operations", () => {
	it("prepares, streams, and disposes a V2 process", async () => {
		const child = new EventEmitter() as EventEmitter & {
			stdin: PassThrough;
			stdout: PassThrough;
			stderr: PassThrough;
			kill: ReturnType<typeof vi.fn>;
		};
		child.stdin = new PassThrough();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = vi.fn(() => true);
		const dispose = vi.fn().mockResolvedValue(undefined);
		const spawn = vi.fn(() => {
			queueMicrotask(() => {
				child.emit("exit", 0, null);
				setTimeout(() => child.stdout.emit("data", Buffer.from("out")), 80);
				setTimeout(() => child.stderr.emit("data", Buffer.from("err")), 160);
				setTimeout(() => {
					child.stdout.emit("end");
					child.stderr.emit("end");
				}, 220);
			});
			return child;
		});
		const runtime = createRuntime();
		vi.mocked(runtime.prepareProcess).mockResolvedValue({
			command: "/bin/bash",
			args: ["-c", "printf test"],
			cwd: "/workspace",
			env: {},
			spawn,
			dispose,
		});
		const ctx = { cwd: "/workspace" } as ExtensionContext;
		const output: string[] = [];

		const result = await createLandstripBashOperations(runtime, ctx).exec("printf test", "/workspace", {
			onData: (data) => output.push(data.toString()),
			env: {},
		});

		expect(result).toEqual({ exitCode: 0 });
		expect(runtime.prepareProcess).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/workspace", ctx, readPaths: expect.any(Array) }),
		);
		expect(spawn).toHaveBeenCalledOnce();
		expect(output).toEqual(["out", "err"]);
		expect(dispose).toHaveBeenCalledOnce();
	});
});
