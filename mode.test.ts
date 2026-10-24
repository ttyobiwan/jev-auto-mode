import { describe, expect, test } from "bun:test";
import { createModeController } from "./mode.js";

function fixture() {
	const values = new Map<string, unknown>();
	const sessions: Record<string, { parentID?: string; agent: string }> = {
		root: { agent: "build" }, child: { parentID: "root", agent: "general" }, other: { agent: "build" },
	};
	const storage = {
		get: async (key: string) => values.get(key),
		set: async (key: string, value: unknown) => { values.set(key, value); },
	};
	const deps = { storage, getSession: async ({ sessionID }: { sessionID: string }) => sessions[sessionID] };
	return { values, sessions, storage, deps, modes: createModeController(deps) };
}

describe("auto mode", () => {
	test("starts on and toggles off then on", async () => {
		const { modes } = fixture();
		expect(await modes.get("root")).toEqual({ rootSessionID: "root", enabled: true });
		expect((await modes.toggle("root")).enabled).toBe(false);
		expect((await modes.toggle("root")).enabled).toBe(true);
	});

	test("a child shares its root's persistent switch independently of agents", async () => {
		const { modes, sessions, deps, values } = fixture();
		await modes.toggle("child");
		sessions.root.agent = "reviewer";
		expect(values.get("auto/root")).toBe(false);
		expect(await createModeController(deps).get("child")).toEqual({ rootSessionID: "root", enabled: false });
		expect((await modes.get("other")).enabled).toBe(true);
	});

	test("two concurrent toggles restore the initial state", async () => {
		const { modes } = fixture();
		const results = await Promise.all([modes.toggle("root"), modes.toggle("child")]);
		expect(results.map((result) => result.enabled)).toEqual([false, true]);
		expect((await modes.get("root")).enabled).toBe(true);
	});

	test("a failed toggle does not change state or block the next toggle", async () => {
		const { modes, storage } = fixture();
		const save = storage.set;
		storage.set = async () => { throw new Error("disk full"); };
		await expect(modes.toggle("root")).rejects.toThrow("disk full");
		storage.set = save;
		expect((await modes.toggle("root")).enabled).toBe(false);
	});

	test("invalid storage and missing ancestry reject instead of enabling", async () => {
		const { modes, values } = fixture();
		values.set("auto/root", "invalid");
		await expect(modes.get("child")).rejects.toThrow("auto mode");
		await expect(modes.toggle("missing")).rejects.toThrow("missing");
	});
});
