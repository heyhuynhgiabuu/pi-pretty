/**
 * pi-pretty: FFF lifecycle management.
 *
 * Manages the FFF file finder lifecycle: create, wait for scan, destroy.
 * Tools check `isAvailable` and use `finder` directly for search operations.
 * Graceful fallback: if FFF is not installed or fails, tools degrade to SDK.
 */

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";

import type { FileFinder as FffFileFinder, GrepCursor } from "@ff-labs/fff-node";

export interface FffInitOptions {
	enableHomeDirScanning: boolean;
	enableFsRootScanning: boolean;
}

export type FffInitFailureKind = "restricted-base-path" | "native";
export type FffRestrictedScanScope = "home" | "root";

export class FffInitError extends Error {
	readonly kind: FffInitFailureKind;
	readonly restrictedScope: FffRestrictedScanScope | undefined;

	constructor(kind: FffInitFailureKind, message: string, restrictedScope?: FffRestrictedScanScope) {
		super(message);
		this.name = "FffInitError";
		this.kind = kind;
		this.restrictedScope = restrictedScope;
	}
}

export function isFffRestrictedBasePathError(error: unknown, options: FffInitOptions): boolean {
	if (!(error instanceof Error) || error.name !== "FffInitError") return false;
	// FffService persists across extension reloads on globalThis, so a reloaded module may
	// receive an FffInitError constructed from another load's class object; instanceof would
	// wrongly fail there. Check the structural name instead.
	if ((error as FffInitError).kind !== "restricted-base-path") return false;
	if ((error as FffInitError).restrictedScope === "home") return !options.enableHomeDirScanning;
	if ((error as FffInitError).restrictedScope === "root") return !options.enableFsRootScanning;
	return false;
}

const DEFAULT_FFF_INIT_OPTIONS: FffInitOptions = {
	enableHomeDirScanning: false,
	enableFsRootScanning: false,
};

// ---------------------------------------------------------------------------
// Cursor store — pagination cursors for grep
// ---------------------------------------------------------------------------

export class CursorStore {
	private cursors = new Map<string, GrepCursor>();
	private counter = 0;
	private maxSize: number;

	constructor(maxSize = 200) {
		this.maxSize = maxSize;
	}

	store(cursor: GrepCursor): string {
		const id = `fff_c${++this.counter}`;
		this.cursors.set(id, cursor);
		if (this.cursors.size > this.maxSize) {
			const first = this.cursors.keys().next().value;
			if (first) this.cursors.delete(first);
		}
		return id;
	}

	get(id: string): GrepCursor | undefined {
		return this.cursors.get(id);
	}

	get size(): number {
		return this.cursors.size;
	}
}

// ---------------------------------------------------------------------------
// FffService — wraps a single FileFinder instance
// ---------------------------------------------------------------------------

const SHARED_FFF_SERVICE_KEY = Symbol.for("pi-pretty.fff-service");

type SharedFffState = {
	service: FffService;
};

type FinderConfig = {
	basePath: string;
	enableHomeDirScanning: boolean;
	enableFsRootScanning: boolean;
};

type GlobalWithFffService = typeof globalThis & {
	[SHARED_FFF_SERVICE_KEY]?: SharedFffState;
};

export function getSharedFffService(fffModule?: typeof import("@ff-labs/fff-node"), agentDir?: string): FffService {
	const sharedGlobal = globalThis as GlobalWithFffService;
	const existing = sharedGlobal[SHARED_FFF_SERVICE_KEY];
	if (existing) {
		existing.service.configure(fffModule, agentDir);
		return existing.service;
	}

	const service = new FffService(fffModule, agentDir);
	sharedGlobal[SHARED_FFF_SERVICE_KEY] = { service };
	return service;
}

export function resetSharedFffServiceForTests(): void {
	const sharedGlobal = globalThis as GlobalWithFffService;
	sharedGlobal[SHARED_FFF_SERVICE_KEY]?.service.destroy();
	delete sharedGlobal[SHARED_FFF_SERVICE_KEY];
}

export class FffService {
	finder: FffFileFinder | null = null;
	partialIndex = false;
	cursorStore = new CursorStore();

	private fffModule: typeof import("@ff-labs/fff-node") | null = null;
	private dbDir: string | null = null;
	private finderConfig: FinderConfig | null = null;
	private finderPromise: Promise<void> | null = null;
	private finderPromiseConfig: FinderConfig | null = null;

	constructor(fffModule?: typeof import("@ff-labs/fff-node"), agentDir?: string) {
		this.configure(fffModule, agentDir);
	}

	configure(fffModule?: typeof import("@ff-labs/fff-node"), agentDir?: string): void {
		if (fffModule) this.fffModule = fffModule;
		if (agentDir) {
			this.dbDir = join(agentDir, "pi-pretty", "fff");
			try {
				mkdirSync(this.dbDir, { recursive: true });
			} catch {
				// FFF can still run without persistent frecency/history paths.
			}
		}
	}

	/** Returns true if the FFF native module is loaded (installed). */
	isModuleLoaded(): boolean {
		return this.fffModule !== null;
	}

	get isAvailable(): boolean {
		return this.finder !== null && !this.finder.isDestroyed;
	}

	/** Attempt to load FFF module dynamically (called during session_start if not injected). */
	async tryLoadModule(): Promise<boolean> {
		if (this.fffModule) return true;
		try {
			const mod = await import("@ff-labs/fff-node");
			this.fffModule = mod;
			if (!this.dbDir && process.env.HOME) {
				this.dbDir = join(process.env.HOME, ".pi/agent", "pi-pretty", "fff");
				try {
					mkdirSync(this.dbDir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
			return true;
		} catch {
			return false;
		}
	}

	async ensureFinder(cwd: string, options: FffInitOptions = DEFAULT_FFF_INIT_OPTIONS): Promise<void> {
		const requestedConfig = finderConfig(cwd, options);

		for (;;) {
			if (this.finder && !this.finder.isDestroyed && sameFinderConfig(this.finderConfig, requestedConfig)) return;

			const pending = this.finderPromise;
			if (pending) {
				const pendingConfig = this.finderPromiseConfig;
				try {
					await pending;
				} catch (error) {
					// A concurrent request for the same scope must observe the same
					// failure. A different scope can retry after the pending attempt.
					if (sameFinderConfig(pendingConfig, requestedConfig)) throw error;
				}
				continue;
			}

			const promise = this._createFinder(cwd, options, requestedConfig);
			this.finderPromise = promise;
			this.finderPromiseConfig = requestedConfig;
			try {
				await promise;
				return;
			} finally {
				if (this.finderPromise === promise) {
					this.finderPromise = null;
					this.finderPromiseConfig = null;
				}
			}
		}
	}

	private async _createFinder(cwd: string, options: FffInitOptions, config: FinderConfig): Promise<void> {
		if (!this.fffModule) return;

		const result = this.createFinder(cwd, this.dbDir, options);
		if (!result.ok) {
			const kind = isRestrictedBasePathMessage(result.error) ? "restricted-base-path" : "native";
			throw new FffInitError(
				kind,
				result.error,
				kind === "restricted-base-path" ? restrictedScanScope(cwd) : undefined,
			);
		}

		const candidate = result.value;
		let scan: Awaited<ReturnType<typeof candidate.waitForScan>>;
		try {
			scan = await candidate.waitForScan(15_000);
		} catch (error) {
			if (!candidate.isDestroyed) {
				try {
					candidate.destroy();
				} catch {
					// Preserve the scan failure; the candidate is no longer selected.
				}
			}
			throw error;
		}

		const previous = this.finder;
		this.finder = candidate;
		this.partialIndex = scan.ok && !scan.value;
		this.finderConfig = config;
		if (previous && previous !== candidate && !previous.isDestroyed) {
			try {
				previous.destroy();
			} catch {
				// Keep the replacement active; native cleanup is best effort.
			}
		}
	}

	private createFinder(
		cwd: string,
		dbDir: string | null,
		options: FffInitOptions,
	): ReturnType<typeof import("@ff-labs/fff-node").FileFinder.create> {
		if (!this.fffModule) throw new Error("FFF module is not loaded");
		const commonOptions = {
			basePath: cwd,
			aiMode: true,
			enableHomeDirScanning: options.enableHomeDirScanning,
			enableFsRootScanning: options.enableFsRootScanning,
		};
		const result = this.fffModule.FileFinder.create({
			...commonOptions,
			frecencyDbPath: dbDir ? join(dbDir, "frecency.mdb") : "",
			historyDbPath: dbDir ? join(dbDir, "history.mdb") : "",
		});
		if (result.ok || !isAlreadyOpenError(result.error) || !dbDir) return result;

		const isolatedDir = join(dbDir, `runtime-${process.pid}-${Date.now()}`);
		try {
			mkdirSync(isolatedDir, { recursive: true });
		} catch {
			return result;
		}
		return this.fffModule.FileFinder.create({
			...commonOptions,
			frecencyDbPath: join(isolatedDir, "frecency.mdb"),
			historyDbPath: join(isolatedDir, "history.mdb"),
		});
	}

	destroy(): void {
		this.disposeFinder();
		this.finderPromise = null;
		this.finderPromiseConfig = null;
	}

	private disposeFinder(): void {
		if (this.finder && !this.finder.isDestroyed) this.finder.destroy();
		this.finder = null;
		this.finderConfig = null;
		this.partialIndex = false;
	}

	getFinder(): import("@ff-labs/fff-node").FileFinder | null {
		return this.finder;
	}

	getCursorStore(): CursorStore {
		return this.cursorStore;
	}
}

function finderConfig(cwd: string, options: FffInitOptions): FinderConfig {
	return {
		basePath: canonicalPath(cwd),
		enableHomeDirScanning: options.enableHomeDirScanning,
		enableFsRootScanning: options.enableFsRootScanning,
	};
}

function sameFinderConfig(left: FinderConfig | null, right: FinderConfig): boolean {
	return (
		left?.basePath === right.basePath &&
		left.enableHomeDirScanning === right.enableHomeDirScanning &&
		left.enableFsRootScanning === right.enableFsRootScanning
	);
}

function isAlreadyOpenError(error: string): boolean {
	return /environment already open/i.test(error);
}

function isRestrictedBasePathMessage(error: string): boolean {
	return /certain FFF features in a file system root or home directories/i.test(error);
}

function restrictedScanScope(cwd: string): FffRestrictedScanScope | undefined {
	const basePath = canonicalPath(cwd);
	if (basePath === parse(basePath).root) return "root";
	if (basePath === canonicalPath(homedir())) return "home";
	return undefined;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}
