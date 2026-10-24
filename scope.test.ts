import { describe, expect, test } from "bun:test";
import { resolveRootSession, type ScopeDeps, type SessionInfoLike } from "./scope.js";

function fixture(sessions: Record<string, SessionInfoLike>) {
	const reads: string[] = [];
	const deps: ScopeDeps = {
		getSession: async ({ sessionID }) => {
			reads.push(sessionID);
			return sessions[sessionID];
		},
	};
	return { reads, deps };
}

describe("resolveRootSession", () => {
	test("a root resolves to itself", async () => {
		const { deps, reads } = fixture({ root: { id: "root" } });
		expect(await resolveRootSession("root", deps)).toBe("root");
		expect(reads).toEqual(["root"]);
	});

	test("a descendant resolves through its parents", async () => {
		const { deps, reads } = fixture({ leaf: { parentID: "mid" }, mid: { parentID: "root" }, root: {} });
		expect(await resolveRootSession("leaf", deps)).toBe("root");
		expect(reads).toEqual(["leaf", "mid", "root"]);
	});

	test("the root may be the eighth read", async () => {
		const sessions: Record<string, SessionInfoLike> = {};
		for (let id = 0; id < 7; id++) sessions[String(id)] = { parentID: String(id + 1) };
		sessions["7"] = {};
		const { deps, reads } = fixture(sessions);
		expect(await resolveRootSession("0", deps)).toBe("7");
		expect(reads).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
	});

	test("a ninth required read exceeds the bound", async () => {
		const sessions: Record<string, SessionInfoLike> = {};
		for (let id = 0; id < 8; id++) sessions[String(id)] = { parentID: String(id + 1) };
		sessions["8"] = {};
		const { deps, reads } = fixture(sessions);
		await expect(resolveRootSession("0", deps)).rejects.toThrow("8");
		expect(reads).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
	});

	test("a missing parent rejects instead of treating the child as root", async () => {
		const { deps } = fixture({ leaf: { parentID: "missing" } });
		await expect(resolveRootSession("leaf", deps)).rejects.toThrow("missing");
	});

	test("a cycle rejects without reading a session twice", async () => {
		const { deps, reads } = fixture({ a: { parentID: "b" }, b: { parentID: "a" } });
		await expect(resolveRootSession("a", deps)).rejects.toThrow("cycle");
		expect(reads).toEqual(["a", "b"]);
	});

	test("a session read error propagates", async () => {
		await expect(resolveRootSession("root", { getSession: async () => { throw new Error("session unavailable"); } })).rejects.toThrow("session unavailable");
	});
});
