import { dirname } from "node:path";

import { type BashOperations, type ExtensionContext, getShellConfig } from "@earendil-works/pi-coding-agent";
import { type LandstripPreparedProcess, type PiLandstripRuntimeV2, useLandstrip } from "pi-landstrip/api";

export type { PiLandstripRuntimeV2 };
export { useLandstrip };

const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const EXIT_STDIO_GRACE_MS = 100;
type LandstripProcess = ReturnType<LandstripPreparedProcess["spawn"]>;

function validateTimeout(timeout: number | undefined): void {
	if (timeout === undefined) return;
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) {
		throw new Error(`Invalid timeout: must be between 0 and ${MAX_TIMEOUT_SECONDS} seconds`);
	}
}

function killProcess(process: LandstripProcess): void {
	process.kill("SIGKILL");
}

function waitForProcess(process: LandstripProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		let stdoutEnded = process.stdout === null;
		let stderrEnded = process.stderr === null;
		const cleanup = (): void => {
			if (graceTimer) clearTimeout(graceTimer);
			process.stdout?.off("end", onStdoutEnd);
			process.stderr?.off("end", onStderrEnd);
			process.stdout?.off("data", onData);
			process.stderr?.off("data", onData);
			process.off("exit", onExit);
			process.off("error", onError);
		};
		const finish = (action: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			process.stdout?.destroy();
			process.stderr?.destroy();
			action();
		};
		const maybeFinish = (): void => {
			if (exited && stdoutEnded && stderrEnded) finish(() => resolve(exitCode));
		};
		const armGraceTimer = (): void => {
			if (graceTimer) clearTimeout(graceTimer);
			graceTimer = setTimeout(() => finish(() => resolve(exitCode)), EXIT_STDIO_GRACE_MS);
		};
		const onData = (): void => {
			if (exited && !settled) armGraceTimer();
		};
		const onStdoutEnd = (): void => {
			stdoutEnded = true;
			maybeFinish();
		};
		const onStderrEnd = (): void => {
			stderrEnded = true;
			maybeFinish();
		};
		const onExit = (code: number | null): void => {
			exited = true;
			exitCode = code;
			maybeFinish();
			if (!settled) armGraceTimer();
		};
		const onError = (error: Error): void => finish(() => reject(error));

		process.stdout?.once("end", onStdoutEnd);
		process.stderr?.once("end", onStderrEnd);
		process.stdout?.on("data", onData);
		process.stderr?.on("data", onData);
		process.once("exit", onExit);
		process.once("error", onError);
	});
}

export function createLandstripBashOperations(runtime: PiLandstripRuntimeV2, ctx: ExtensionContext): BashOperations {
	return {
		async exec(command, cwd, { onData, signal, timeout, env }) {
			validateTimeout(timeout);
			if (signal?.aborted) throw new Error("aborted");

			const shell = getShellConfig();
			const commandFromStdin = shell.commandTransport === "stdin";
			const args = commandFromStdin ? shell.args : [...shell.args, command];
			const prepared = await runtime.prepareProcess({
				command: shell.shell,
				args,
				cwd,
				env,
				ctx,
				readPaths: [shell.shell, dirname(shell.shell)],
				signal,
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			let timedOut = false;

			try {
				if (signal?.aborted) throw new Error("aborted");
				const process = prepared.spawn(prepared.command, prepared.args, {
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				});
				const abort = (): void => killProcess(process);

				process.stdout?.on("data", onData);
				process.stderr?.on("data", onData);
				if (commandFromStdin) {
					process.stdin?.on("error", () => {});
					process.stdin?.end(command);
				}
				signal?.addEventListener("abort", abort, { once: true });
				if (signal?.aborted) abort();
				if (timeout !== undefined) {
					timer = setTimeout(() => {
						timedOut = true;
						killProcess(process);
					}, timeout * 1000);
				}

				try {
					let exitCode: number | null;
					try {
						exitCode = await waitForProcess(process);
					} catch (error) {
						if (signal?.aborted) throw new Error("aborted");
						if (timedOut) throw new Error(`timeout:${timeout}`);
						throw error;
					}
					if (signal?.aborted) throw new Error("aborted");
					if (timedOut) throw new Error(`timeout:${timeout}`);
					return { exitCode };
				} finally {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
				}
			} finally {
				await prepared.dispose();
			}
		},
	};
}
