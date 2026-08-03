import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createLandstripBashOperations, type PiLandstripRuntimeV2 } from "../src/landstrip.js";

function createRuntime() {
	return { prepareProcess: vi.fn() } as unknown as PiLandstripRuntimeV2;
}

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
