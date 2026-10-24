import { expect, test } from "bun:test";
import type { CommandInvocation } from "@opencode/plugin/promise/command";
import { createAutoCommand } from "./command.js";

test("/auto toggles once and reports only on or off", async () => {
	let enabled = true;
	const notices: string[] = [];
	const command = createAutoCommand({
		toggle: async () => ({ rootSessionID: "root", enabled: enabled = !enabled }),
		notify: async (_sessionID, text) => { notices.push(text); },
	});
	const invocation = { sessionID: "root", prompt: { text: "" }, delivery: "steer" } as CommandInvocation;
	await command.execute(invocation);
	await command.execute(invocation);
		expect(notices).toEqual(["auto mode off", "auto mode on"]);
});

test("removed mode arguments do not change state", async () => {
	let toggles = 0;
	const notices: string[] = [];
	const command = createAutoCommand({
		toggle: async () => { toggles++; return { rootSessionID: "root", enabled: false }; },
		notify: async (_sessionID, text) => { notices.push(text); },
	});
	await command.execute({ sessionID: "root", prompt: { text: "shadow" }, delivery: "steer" } as CommandInvocation);
		expect(toggles).toBe(0);
		expect(notices).toEqual(["Usage: /auto"]);
});
