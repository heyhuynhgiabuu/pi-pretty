/**
 * Cross-load `FffInitError` classification.
 *
 * `FffService` is deliberately persisted across extension reloads on
 * `globalThis[Symbol.for("pi-pretty.fff-service")]`, so after a `/reload` the service
 * still runs the first load's code and builds its `FffInitError` with the first load's
 * class object, while `isFffRestrictedBasePathError` runs as the new module. An
 * `instanceof` check therefore fails there and a deliberate home/fs-root scan refusal
 * surfaces as "Warning: FFF init failed: ..." on every reload.
 *
 * Two details make the difference between real coverage and a green test that proves
 * nothing:
 *  - cwd must be `homedir()`: `restrictedScanScope()` returns "home" only for
 *    `canonicalPath(homedir())`, so a project-dir cwd yields `restrictedScope:
 *    undefined` and *correctly* warns — passing on the pre-fix code as well.
 *  - the reload is modelled with `vi.resetModules()`, which keeps the static
 *    `FffInitError` import bound to load 1 while `getSharedFffService()` returns the
 *    persisted service. That reproduces the real asymmetry without a live `/reload`.
 */

import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FffInitError,
	getSharedFffService,
	isFffRestrictedBasePathError,
	resetSharedFffServiceForTests,
} from "../src/fff.js";

const RESTRICTED =
	"Failed to init file picker: Can not run certain FFF features in a file system root or home directories. Consider smaller per-project directories.";

const SCAN_OFF = { enableHomeDirScanning: false, enableFsRootScanning: false };
const SCAN_ON = { enableHomeDirScanning: true, enableFsRootScanning: true };

async function loadSecondModule(): Promise<typeof import("../src/fff.js")> {
	vi.resetModules();
	return import("../src/fff.js");
}

afterEach(() => {
	resetSharedFffServiceForTests();
	vi.resetModules();
});

describe("cross-load FffInitError identity", () => {
	it("an error built by load 1 is not instanceof load 2's class", async () => {
		const second = await loadSecondModule();
		const error = new FffInitError("restricted-base-path", "boom", "home");

		expect(error).toBeInstanceOf(FffInitError);
		expect(error instanceof second.FffInitError).toBe(false);
		expect(error.name).toBe("FffInitError");
	});

	it("load 2's classifier suppresses load 1's refusal when scanning is disabled", async () => {
		const second = await loadSecondModule();
		const error = new FffInitError("restricted-base-path", RESTRICTED, "home");

		expect(second.isFffRestrictedBasePathError(error, SCAN_OFF)).toBe(true);
	});

	it("load 2's classifier warns for a home refusal when home scanning was opted in", async () => {
		const second = await loadSecondModule();
		const error = new FffInitError("restricted-base-path", RESTRICTED, "home");

		expect(second.isFffRestrictedBasePathError(error, SCAN_ON)).toBe(false);
	});

	it("load 2's classifier warns for a root refusal when root scanning was opted in", async () => {
		const second = await loadSecondModule();
		const error = new FffInitError("restricted-base-path", RESTRICTED, "root");

		expect(second.isFffRestrictedBasePathError(error, SCAN_ON)).toBe(false);
	});

	it("load 2's classifier warns for a native failure", async () => {
		const second = await loadSecondModule();
		const error = new FffInitError("native", "native failure");

		expect(second.isFffRestrictedBasePathError(error, SCAN_OFF)).toBe(false);
	});

	it("classifies the error a persisted service throws as built by the previous load", async () => {
		// The first load creates the shared (globalThis-persisted) service, as activation does.
		const service = getSharedFffService({
			FileFinder: { create: () => ({ ok: false, error: RESTRICTED }) },
		} as never);

		// A reload: new module instance, same persisted service.
		const second = await loadSecondModule();
		expect(second.getSharedFffService()).toBe(service);

		let caught: unknown;
		try {
			// $HOME is the case from the report: the sweep is refused there.
			await service.ensureFinder(homedir(), SCAN_OFF);
		} catch (error: unknown) {
			caught = error;
		}

		// Built by load 1's class...
		expect(caught).toBeInstanceOf(FffInitError);
		expect(caught instanceof second.FffInitError).toBe(false);
		expect((caught as FffInitError).kind).toBe("restricted-base-path");

		// ...but classified by load 2, which is where instanceof used to fail.
		expect(second.isFffRestrictedBasePathError(caught, SCAN_OFF)).toBe(true);
		expect(second.isFffRestrictedBasePathError(caught, SCAN_ON)).toBe(false);
		expect(isFffRestrictedBasePathError(caught, SCAN_OFF)).toBe(true);
	});
});
