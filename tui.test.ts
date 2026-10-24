import "@opentui/solid/preload";
import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { JSX } from "@opentui/solid";
import type { Plugin } from "@opencode/plugin/tui";
import type { KeymapLayer, SlotMap } from "@opencode/plugin/tui/context";

test("the TUI entrypoint loads from an installed package under node_modules", async () => {
	const directory = await mkdtemp(join(tmpdir(), "jev-auto-mode-"));
	try {
		const installed = join(directory, "node_modules", "jev-auto-mode");
		await mkdir(installed, { recursive: true });
		for (const file of ["package.json", "tui.ts", "indicator.ts", "rpc.ts"]) {
			await copyFile(join(import.meta.dir, file), join(installed, file));
		}
		await symlink(join(import.meta.dir, "node_modules"), join(installed, "node_modules"));
		const entry = pathToFileURL(join(installed, "tui.ts")).href;
		const process = Bun.spawn([Bun.which("bun")!, "--preload", import.meta.resolve("@opentui/solid/preload"), "-e", `await import(${JSON.stringify(entry)})`], {
			cwd: directory,
			stdout: "pipe",
			stderr: "pipe",
		});
		const error = await new Response(process.stderr).text();
		expect(await process.exited, error).toBe(0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Shift+Tab and the palette toggle auto mode beside the prompt", async () => {
	const { default: plugin } = await import("./tui.js");
	const { testRender } = await import("@opentui/solid");
	const { createSignal } = await import("solid-js");
	const [sessionID, setSessionID] = createSignal<string | undefined>("child");
	let enabled = true;
	let changed: ((event: { data: { rootSessionID: string } }) => void) | undefined;
	let layer: KeymapLayer = {};
	let slot: { append: string; render(props: SlotMap["prompt.footer.status"]): JSX.Element } | undefined;
	const calls: unknown[] = [];
	const context = {
		client: { rpc: () => ({
			get: async () => ({ rootSessionID: "root", enabled }),
			toggle: async (input: unknown, options: unknown) => {
				calls.push({ input, options });
				enabled = !enabled;
				changed?.({ data: { rootSessionID: "root" } });
				return { rootSessionID: "root", enabled };
			},
			events: { on: (_name: string, handler: typeof changed) => { changed = handler; return () => { changed = undefined; }; } },
		}) },
		data: {
			session: { get: () => ({ location: { directory: "/project" } }), root: () => "root" },
			on: () => () => {},
		},
		keymap: { layer: (factory: () => KeymapLayer) => { layer = factory(); } },
		ui: {
			router: { current: () => sessionID() ? { type: "session", sessionID: sessionID() } : { type: "home" } },
			slot: (claim: typeof slot) => { slot = claim; return () => {}; },
		},
		theme: { text: { muted: "#888888" } },
	};
	await plugin.setup(context as unknown as Plugin.Context);
	expect(layer.commands?.[0]).toMatchObject({ title: "auto", palette: true, bind: "shift+tab" });
	expect(slot?.append).toBe("prompt.footer.status");
	const view = await testRender(() => slot!.render({ get sessionID() { return sessionID(); }, mode: "normal", showDetails: true }), { width: 30, height: 3 });
	try {
		await view.waitForFrame((frame) => frame.includes("auto mode on"));
		await layer.commands![0].run();
		await view.waitForFrame((frame) => !frame.includes("auto mode on"));
		await layer.commands![0].run();
		await view.waitForFrame((frame) => frame.includes("auto mode on"));
		expect(calls[0]).toEqual({ input: { sessionID: "child" }, options: { location: { directory: "/project" } } });
		setSessionID(undefined);
		await view.waitForFrame((frame) => !frame.includes("auto mode on"));
		changed?.({ data: { rootSessionID: "root" } });
		await layer.commands![0].run();
		expect(calls).toHaveLength(2);
	} finally {
		view.renderer.destroy();
	}
	expect(changed).toBeUndefined();
});
