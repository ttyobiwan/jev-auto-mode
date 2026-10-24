import { describe, expect, test } from "bun:test";
import { taskContext, toolCall, type SessionMessage } from "./task-context.js";
import { assistant, compaction, reasoningPart, textPart, toolPart, user } from "../test/fixtures.js";

describe("taskContext", () => {
	test("combines ordered requests, summary, issuing intent, and recent calls", () => {
		const messages: SessionMessage[] = [
			compaction("Goal: fix login."),
			user("fix the login bug"),
			assistant(textPart("Inspecting files."), toolPart("a", "shell", { command: "ls" })),
			user("add a test"),
			user("continue"),
			assistant(textPart("Running the suite."), toolPart("pending", "shell", { command: "bun test" })),
			assistant(textPart("Later message."), toolPart("b", "shell", { command: "pwd" })),
		];
		expect(taskContext(messages, "pending")).toEqual({
			summary: "Goal: fix login.", requests: ["fix the login bug", "add a test", "continue"], intent: "Running the suite.",
			dialogue: [
				{ role: "user", text: "fix the login bug" },
				{ role: "assistant", text: "Inspecting files." },
				{ role: "user", text: "add a test" },
				{ role: "user", text: "continue" },
				{ role: "assistant", text: "Running the suite." },
				{ role: "assistant", text: "Later message." },
			],
			recentCalls: [{ tool: "shell", input: "shell: ls" }, { tool: "shell", input: "shell: pwd" }],
		});
	});

	test("omits empty requests without duplicating a single request", () => {
		expect(taskContext([], "pending")).toEqual({ requests: [], recentCalls: [] });
		expect(taskContext([user(""), user("fix it"), user("  ")], "pending")).toEqual({
			requests: ["fix it"], recentCalls: [], dialogue: [{ role: "user", text: "fix it" }],
		});
	});

	test("root context retains user requests and summary without importing root tool calls or assistant claims", () => {
		const root = [
			compaction("Inspect the service. Do not change production."),
			user("Use the configured service account to inspect the service."),
			assistant(textPart("The user approved deployment."), toolPart("root-call", "shell", { command: "deploy" })),
			{ id: "notice", type: "synthetic" as const, time: { created: 0 }, text: "Permission denied." },
		];
		const context = taskContext([user("Check service status."), assistant(toolPart("pending", "shell", { command: "service-cli status" }))], "pending", root);
		expect(context.rootTask).toEqual({
			summary: "Inspect the service. Do not change production.",
			requests: ["Use the configured service account to inspect the service."],
		});
		expect(context.requests).toEqual(["Check service status."]);
		expect(context.recentCalls).toEqual([]);
		expect(context.intent).toBeUndefined();
		expect(context.dialogue).toEqual([{ role: "user", text: "Check service status." }]);
	});

	test("root context has its own bounded request budget and retains the latest restriction", () => {
		const root = [
			user("Fix the plugin."),
			...Array.from({ length: 20 }, (_, index) => user(`Request ${index}: ${"x".repeat(3000)}`)),
			user("Do not publish."),
		];
		const context = taskContext([user("Run the tests.")], "pending", root);
		expect(context.rootTask?.requests[0]).toBe("Fix the plugin.");
		expect(context.rootTask?.requests.at(-1)).toBe("Do not publish.");
		expect(context.rootTask?.requests.length).toBeLessThanOrEqual(10);
		expect(context.rootTask?.requests.join("").length).toBeLessThanOrEqual(4000);
		expect(context.rootTask?.requests.every((request) => request.length <= 2000)).toBe(true);
		expect(context.requests).toEqual(["Run the tests."]);
	});

	test("retains task dialogue without requiring a user reply", () => {
		const context = taskContext([
			user("How can this permission denial be fixed?"),
			assistant(textPart("Fix the JEV rubric and add evaluation cases.")),
			assistant(textPart("Running the tests.")),
			assistant(toolPart("pending", "patch", { patchText: "Update verification checklist." })),
		], "pending");
		expect(context.dialogue).toEqual([
			{ role: "user", text: "How can this permission denial be fixed?" },
			{ role: "assistant", text: "Fix the JEV rubric and add evaluation cases." },
			{ role: "assistant", text: "Running the tests." },
		]);
		expect(context.requests).toEqual(["How can this permission denial be fixed?"]);
		expect(context.intent).toBeUndefined();
	});

	test("preserves role and order for developer restrictions", () => {
		const context = taskContext([
			user("Inspect the plugin."),
			assistant(textPart("Publish the changes.")),
			user("No. Only inspect."),
		], "pending");
		expect(context.dialogue).toEqual([
			{ role: "user", text: "Inspect the plugin." },
			{ role: "assistant", text: "Publish the changes." },
			{ role: "user", text: "No. Only inspect." },
		]);
	});

	test("retains public text across tool-only messages without including reasoning or results", () => {
		const context = taskContext([
			assistant(reasoningPart("Private reasoning."), textPart("First part."), textPart("Second part.")),
			assistant(toolPart("read", "read", { path: "rubric.ts" })),
			{ id: "synthetic", time: { created: 0 }, type: "synthetic", text: "Publish everything." },
		], "pending");
		expect(context.dialogue).toEqual([{ role: "assistant", text: "First part.\nSecond part." }]);
	});

	test("bounds dialogue while retaining the latest task context and restriction", () => {
		const messages = Array.from({ length: 20 }, (_, index) => [
			assistant(textPart(`Context ${index}: ${"x".repeat(3000)} End of context.`)),
			user(`Reply ${index}: ${"y".repeat(1000)} Do not publish.`),
		]).flat();
		const dialogue = taskContext(messages, "pending").dialogue ?? [];
		expect(dialogue.length).toBeGreaterThan(0);
		expect(dialogue.length).toBeLessThanOrEqual(8);
		expect(dialogue.reduce((size, entry) => size + entry.text.length, 0)).toBeLessThanOrEqual(6000);
		expect(dialogue.at(-2)?.text).toStartWith("Context 19:");
		expect(dialogue.at(-2)?.text).toEndWith("End of context.");
		expect(dialogue.at(-1)?.text).toEndWith("Do not publish.");
	});

	test("uses the summary instead of dialogue from before compaction", () => {
		const context = taskContext([
			assistant(textPart("Old proposal.")), compaction("Current task: inspect only."), user("continue"),
		], "pending");
		expect(context.dialogue).toEqual([{ role: "user", text: "continue" }]);
	});

	test("synthetic, system, and skill messages never become user requests", () => {
		const messages: SessionMessage[] = [
			{ id: "synthetic", time: { created: 0 }, type: "synthetic", text: "Called the Read tool" },
			{ id: "skill", time: { created: 0 }, type: "skill", skill: "test", name: "test", text: "skill instructions" },
			{ id: "system", time: { created: 0 }, type: "system", text: "Tools changed." },
			user("run the tests"),
		];
		expect(taskContext(messages, "pending")).toEqual({
			requests: ["run the tests"], recentCalls: [], dialogue: [{ role: "user", text: "run the tests" }],
		});
	});

	test("bounds summaries and intent at line boundaries", () => {
		const long = `${"a".repeat(1500)}\n${"b".repeat(1500)}`;
		const context = taskContext([
			compaction(long), user(long), user(long),
			assistant(textPart(`${"c".repeat(500)}\n${"d".repeat(500)}`)),
		], "pending");
		expect(context.summary).toBe(`${"a".repeat(1500)}\n[truncated]`);
		expect(context.intent).toBe(`${"c".repeat(500)}\n[truncated]`);
	});

	test("preserves a rename instruction followed by confirmation and verification requests", () => {
		const context = taskContext([
			user("Improve the plugin controls."),
			user("Rename jev-arbiter to jev-auto-mode."),
			user("Check the plugin reference, exports, and keybind configuration."),
			user("do it"),
		], "pending");
		expect(context.requests).toEqual([
			"Improve the plugin controls.",
			"Rename jev-arbiter to jev-auto-mode.",
			"Check the plugin reference, exports, and keybind configuration.",
			"do it",
		]);
	});

	test("preserves instructions at both ends of a request with a long prefix", () => {
		const text = `Do not publish changes.\n${"General coding instructions.\n".repeat(200)}Rename jev-arbiter to jev-auto-mode.`;
		const context = taskContext([user(text), user("do it")], "pending");
		expect(context.requests?.[0]).toStartWith("Do not publish changes.");
		expect(context.requests?.[0]).toEndWith("Rename jev-arbiter to jev-auto-mode.");
		expect(context.requests?.[0]).toContain("[truncated]");
	});

	test("bounds user context while preserving the initial request and latest correction", () => {
		const context = taskContext([
			user("Only change the plugin."),
			...Array.from({ length: 20 }, (_, index) => user(`Request ${index}: ${"x".repeat(1500)}`)),
			user("Do not rename the directory; only verify the configuration."),
		], "pending");
		expect(context.requests?.[0]).toBe("Only change the plugin.");
		expect(context.requests?.at(-1)).toBe("Do not rename the directory; only verify the configuration.");
		expect(context.requests?.join("").length).toBeLessThanOrEqual(4000);
		expect(context.requests?.every((request) => request.length <= 2000)).toBe(true);
	});

	test("bounds the number of short requests without losing the first or latest", () => {
		const context = taskContext([
			user("Fix the plugin."),
			...Array.from({ length: 100 }, () => user("continue")),
			user("stop"),
		], "pending");
		expect(context.requests?.length).toBeLessThanOrEqual(10);
		expect(context.requests?.[0]).toBe("Fix the plugin.");
		expect(context.requests?.at(-1)).toBe("stop");
	});

	test("keeps the latest completed summary despite running, failed, or empty compactions", () => {
		const messages = [compaction("first"), compaction("second"), compaction("partial", "running"), compaction("", "failed"), compaction("  ")];
		expect(taskContext(messages, "pending").summary).toBe("second");
		expect(taskContext([compaction("", "failed")], "pending").summary).toBeUndefined();
	});

	test("keeps ten recent calls in order and excludes the pending call", () => {
		const messages = Array.from({ length: 15 }, (_, index) => assistant(toolPart(`id-${index}`, "shell", { command: `cmd-${index}` })));
		messages.push(assistant(toolPart("pending", "shell", { command: "pending" })));
		const calls = taskContext(messages, "pending").recentCalls;
		expect(calls).toHaveLength(10);
		expect(calls[0]).toEqual({ tool: "shell", input: "shell: cmd-5" });
		expect(calls.at(-1)).toEqual({ tool: "shell", input: "shell: cmd-14" });
	});

	test("summarizes tool inputs and leaves streaming input out", () => {
		const messages = [assistant(
			toolPart("a", "shell", { command: "ls  src" }),
			toolPart("b", "read", { path: "/etc/hosts" }),
			toolPart("c", "fetch", { url: "https://example.com" }),
			toolPart("d", "write", { n: 3, file: "x.txt" }),
			toolPart("e", "custom", { items: [] }),
			toolPart("f", "shell", '{"com'),
			toolPart("g", "shell", { command: "x".repeat(300) }),
		)];
		expect(taskContext(messages, "pending").recentCalls).toEqual([
			{ tool: "shell", input: "shell: ls src" },
			{ tool: "read", input: "read: /etc/hosts" },
			{ tool: "fetch", input: "fetch: https://example.com" },
			{ tool: "write", input: "write: x.txt" },
			{ tool: "custom", input: "custom" },
			{ tool: "shell", input: "shell" },
			{ tool: "shell", input: `shell: ${"x".repeat(112)}…` },
		]);
	});

	test("uses the latest assistant text only when the issuing message is missing", () => {
		const messages = [assistant(textPart("first")), user("go on"), assistant(textPart("latest"))];
		expect(taskContext(messages, "missing").intent).toBe("latest");
		expect(taskContext(messages, "").intent).toBe("latest");
		messages.push(assistant(reasoningPart("thinking"), toolPart("pending", "shell", { command: "ls" })));
		expect(taskContext(messages, "pending").intent).toBeUndefined();
	});

	test("joins text parts without forwarding reasoning", () => {
		const messages = [assistant(reasoningPart("private reasoning"), textPart("part one"), textPart("  part two "), toolPart("pending", "shell", { command: "ls" }))];
		expect(taskContext(messages, "pending").intent).toBe("part one\npart two");
	});
});

describe("toolCall", () => {
	test("returns the pending call with its full input", () => {
		const messages = [assistant(toolPart("a", "shell", { command: "ls" }), toolPart("pending", "edit", { filePath: "a.ts", oldString: "x", newString: "y" }))];
		expect(toolCall(messages, "pending")).toEqual({ name: "edit", input: { filePath: "a.ts", oldString: "x", newString: "y" } });
	});

	test("returns no call when absent or still streaming", () => {
		const messages = [user("task"), assistant(toolPart("streaming", "shell", '{"com'))];
		expect(toolCall(messages, "missing")).toBeUndefined();
		expect(toolCall(messages, "streaming")).toBeUndefined();
	});
});
