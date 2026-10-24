import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { CommandDefinition, CommandEditor, CommandInvocation } from "@opencode/plugin/promise/command";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import plugin from "./index.js";

let savedKey: string | undefined;
let savedAlternate: string | undefined;
let warning: ReturnType<typeof spyOn>;
beforeEach(() => {
	savedKey = process.env.TYPESAFE_API_KEY;
	savedAlternate = process.env.TYPESAFE_AI_API_KEY;
	delete process.env.TYPESAFE_API_KEY;
	delete process.env.TYPESAFE_AI_API_KEY;
	warning = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
	else process.env.TYPESAFE_API_KEY = savedKey;
	if (savedAlternate === undefined) delete process.env.TYPESAFE_AI_API_KEY;
	else process.env.TYPESAFE_AI_API_KEY = savedAlternate;
	warning.mockRestore();
});

async function setup() {
	const commands: CommandDefinition[] = [];
	const notices: Array<{ text: string; resume: boolean }> = [];
	const events: unknown[] = [];
	const values = new Map<string, unknown>();
	const hooks = new Map<string, (event: PermissionEvaluation) => Promise<void>>();
	let rpc: Record<string, (input: { sessionID: string }) => Promise<{ enabled: boolean }>> = {};
	const context = {
		options: {},
		location: { directory: "/project", project: { directory: "/project" } },
		command: { transform: async (callback: (editor: CommandEditor) => void) => callback({ add: (command) => commands.push(command) }) },
		session: {
			get: async ({ sessionID }: { sessionID: string }) => sessionID === "child" ? { parentID: "root" } : {},
			synthetic: async (notice: { text: string; resume: boolean }) => { notices.push(notice); },
		},
		storage: {
			get: async (key: string) => values.get(key),
			set: async (key: string, value: unknown) => { values.set(key, value); },
		},
		permission: { hook: async (name: string, callback: (event: PermissionEvaluation) => Promise<void>) => {
			hooks.set(name, callback);
			return { dispose: async () => {} };
		} },
		rpc: { register: async (_definition: unknown, handlers: typeof rpc) => {
			rpc = handlers;
			return { events: { emit: async (_name: string, value: unknown) => { events.push(value); } } };
		} },
	};
	await plugin.setup(context as unknown as Plugin.Context);
	return { commands, notices, events, rpc, hooks };
}

test("slash and RPC toggles share state and publish updates without a judge", async () => {
	const { commands, notices, events, rpc } = await setup();
	expect(commands[0].name).toBe("auto");
	await commands[0].execute({ sessionID: "root", prompt: { text: "" }, delivery: "steer" } as CommandInvocation);
	expect(notices).toEqual([expect.objectContaining({ text: "auto mode off", resume: false })]);
	expect(await rpc.get({ sessionID: "child" })).toMatchObject({ enabled: false });
	expect(await rpc.toggle({ sessionID: "child" })).toMatchObject({ enabled: true });
	expect(events).toEqual([{ rootSessionID: "root" }, { rootSessionID: "root" }]);
});

test("without credentials auto mode approves only edits and toggling off restores prompts", async () => {
	const { hooks, rpc } = await setup();
	const evaluate = hooks.get("evaluate");
	expect(evaluate).toBeDefined();
	const edit: PermissionEvaluation = {
		sessionID: "child" as PermissionEvaluation["sessionID"],
		action: "edit", resources: ["src/index.ts"], effect: "ask",
	};
	await evaluate!(edit);
	expect(edit.effect).toBe("allow");
	for (const action of ["shell", "external_directory"]) {
		const pending: PermissionEvaluation = { ...edit, action, effect: "ask" };
		await evaluate!(pending);
		expect(pending.effect).toBe("ask");
	}
	const denied: PermissionEvaluation = { ...edit, effect: "deny", message: "protected path" };
	await evaluate!(denied);
	expect(denied.effect).toBe("deny");
	expect(denied.message).toBe("protected path");
	await rpc.toggle({ sessionID: "root" });
	const pending: PermissionEvaluation = { ...edit, effect: "ask", message: undefined };
	await evaluate!(pending);
	expect(pending.effect).toBe("ask");
	expect(pending.message).toBeUndefined();
});

test("with credentials the registered hook preserves explicit denials", async () => {
	process.env.TYPESAFE_API_KEY = "test-key";
	const { hooks } = await setup();
	const event: PermissionEvaluation = {
		sessionID: "root" as PermissionEvaluation["sessionID"],
		action: "shell", resources: ["command"], effect: "deny", message: "configured denial",
	};
	await hooks.get("evaluate")!(event);
	expect(event.effect).toBe("deny");
	expect(event.message).toBe("configured denial");
});
