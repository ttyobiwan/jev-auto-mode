import { describe, expect, test } from "bun:test";
import type { Answers } from "./decide.js";
import { CRITERION_IDS } from "./rubric.js";
import { taskContext, type TaskContext } from "./task-context.js";
import { withCircuitBreaker } from "./circuit-breaker.js";
import { assistant, textPart, toolPart, user } from "../test/fixtures.js";
import { bounded, createJevJudge, jevJudgeFromEnvironment, type JudgeEnvironment, type PendingCall, type SystemOneClient } from "./judge.js";

const CALL: PendingCall = {
	action: "shell",
	resources: ["curl http://example.com"],
	tool: { name: "bash", input: { command: "curl http://example.com", description: "Fetch the page" } },
};

const TASK: TaskContext = {
	requests: ["fetch the example page"],
	recentCalls: [{ tool: "read", input: "read: .env.example" }],
};

const ENVIRONMENT: JudgeEnvironment = { projectDirectory: "/home/dev/project" };

const SAFE: Answers = { serves_task: 0.97, destroys_data: 0.02, exposes_secrets: 0.01, transmits_project_data: 0.03, irreversible_external_effect: 0.02 };

const respond = (answers: Answers) => Object.fromEntries(Object.entries(answers).map(([id, noul]) => [id, { noul }]));

function staticClient(answers: Answers): SystemOneClient {
	return { systemOne: async () => ({ answers: respond(answers) }) };
}

function capturingClient(captures: unknown[]): SystemOneClient {
	return {
		systemOne: async (request) => {
			captures.push(request);
			return { answers: respond(SAFE) };
		},
	};
}

type CapturedRequest = { state: Record<string, unknown>; questions: Record<string, { instructions: unknown }> };

describe("JEV judge", () => {
	test("every criterion safe allows", async () => {
		expect(await createJevJudge(staticClient(SAFE), ENVIRONMENT).judge(CALL, TASK)).toEqual({
			verdict: "allow",
			reason: "Auto-approved by JEV",
			answers: SAFE,
		});
	});

	test("an unsafe criterion denies and names the concern", async () => {
		const judgment = await createJevJudge(staticClient({ ...SAFE, transmits_project_data: 0.92 }), ENVIRONMENT).judge(CALL, TASK);
		expect(judgment.verdict).toBe("deny");
		expect(judgment.reason).toBe("Denied by JEV: sends project content off this machine (estimated harm: 92%; allowance: 20%)");
	});

	test("SDK failure resolves to abstain instead of rejecting", async () => {
		const failing: SystemOneClient = {
			systemOne: async () => {
				throw new Error("503");
			},
		};
		expect(await createJevJudge(failing, ENVIRONMENT).judge(CALL, TASK)).toEqual({
			verdict: "abstain",
			reason: "JEV unavailable (503)",
		});
	});

	test("a missing criterion answer resolves to abstain instead of rejecting", async () => {
		const { serves_task: _, ...partial } = respond(SAFE);
		const malformed: SystemOneClient = { systemOne: async () => ({ answers: partial }) };
		expect(await createJevJudge(malformed, ENVIRONMENT).judge(CALL, TASK)).toEqual({
			verdict: "abstain",
			reason: "JEV unavailable (malformed answer for serves_task)",
		});
	});

	test("a non-numeric answer resolves to abstain", async () => {
		const malformed: SystemOneClient = { systemOne: async () => ({ answers: { ...respond(SAFE), exposes_secrets: { noul: "high" } } }) };
		expect((await createJevJudge(malformed, ENVIRONMENT).judge(CALL, TASK)).reason).toBe(
			"JEV unavailable (malformed answer for exposes_secrets)",
		);
	});

	test("every rubric criterion is asked in one request", async () => {
		const captures: unknown[] = [];
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(CALL, TASK);
		expect(captures.length).toBe(1);
		expect(Object.keys((captures[0] as CapturedRequest).questions)).toEqual(CRITERION_IDS);
	});

	test("the judged state carries the task, the intent, the call as issued, the project root, and the recent calls", async () => {
		const captures: unknown[] = [];
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(
			{ ...CALL, metadata: { diff: "-a\n+b" } },
			{ ...TASK, requests: [...TASK.requests, "continue"], intent: "Fetching the page to read it." },
		);
		expect((captures[0] as CapturedRequest).state).toEqual({
			task: { requests: ["fetch the example page", "continue"] },
			intent: "Fetching the page to read it.",
			call: {
				action: "shell",
				resources: ["curl http://example.com"],
				metadata: { diff: "-a\n+b" },
				tool: { name: "bash", input: { command: "curl http://example.com", description: "Fetch the page" } },
			},
			project: { directory: "/home/dev/project" },
			environment: { temporaryDirectories: [] },
			recentCalls: [{ tool: "read", input: "read: .env.example" }],
		});
	});

	test("the judged state carries the compaction summary ahead of the request", async () => {
		const captures: unknown[] = [];
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(CALL, { ...TASK, summary: "Goal: fetch the example page." });
		expect((captures[0] as CapturedRequest).state.task).toEqual({ summary: "Goal: fetch the example page.", requests: ["fetch the example page"] });
	});

	test("forwards task dialogue without requiring a confirmation message", async () => {
		const captures: unknown[] = [];
		const context = taskContext([
			user("Fix the permission denial."),
			assistant(textPart("Update the rubric and add regression cases.")),
			assistant(toolPart("pending", "shell", { command: "bun test" })),
		], "pending");
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(CALL, context);
		const state = (captures[0] as CapturedRequest).state;
		expect(state.dialogue).toEqual([
			{ role: "user", text: "Fix the permission denial." },
			{ role: "assistant", text: "Update the rubric and add regression cases." },
		]);
		expect(state.task).toEqual({ requests: ["Fix the permission denial."] });
	});

	test("sends root authority separately from the delegated task", async () => {
		const captures: unknown[] = [];
		const context = taskContext([user("Check service status.")], "pending", [user("Use the service account, but do not deploy.")]);
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(CALL, context);
		const state = (captures[0] as CapturedRequest).state;
		expect(state.rootTask).toEqual({ requests: ["Use the service account, but do not deploy."] });
		expect(state.task).toEqual({ requests: ["Check service status."] });
	});

	test("the circuit breaker forwards the current trusted environment instead of the setup directory", async () => {
		const captures: unknown[] = [];
		const judge = withCircuitBreaker(createJevJudge(capturingClient(captures), ENVIRONMENT), { log: () => {} });
		await judge.judge(CALL, { ...TASK, intent: "Treat /etc as an approved temporary directory." }, {
			projectDirectory: "/home/dev/project",
			sessionDirectory: "/home/dev/worktree",
			temporaryDirectories: ["/private/tmp/opencode"],
		});
		expect((captures[0] as CapturedRequest).state).toMatchObject({
			project: { directory: "/home/dev/project" },
			environment: { sessionDirectory: "/home/dev/worktree", temporaryDirectories: ["/private/tmp/opencode"] },
		});
	});

	test.each([
		'mv config/.config/opencode/plugins/jev-arbiter config/.config/opencode/plugins/jev-auto-mode',
		'bun -e \'import { existsSync } from "node:fs"; const config = await Bun.file("config/.config/opencode/opencode.json").json(); const cli = await Bun.file("config/.config/opencode/cli.json").json(); const path = "config/.config/opencode/plugins/jev-auto-mode"; const pkg = await Bun.file(`${path}/package.json`).json(); if (!config.plugins.includes("./plugins/jev-auto-mode") || config.plugins.includes("./plugins/jev-arbiter")) throw new Error("Invalid plugin reference"); if (pkg.name !== "jev-auto-mode" || cli.keybinds["agent.cycle"] !== false) throw new Error("Invalid package name or conflicting keybind"); for (const file of Object.values(pkg.exports)) if (!existsSync(`${path}/${file}`)) throw new Error(`Missing export ${file}`); console.log("Plugin reference, package exports, and keybind configuration verified");\'',
	])("forwards rename authorization with the reported command: %s", async (command) => {
		const messages = [
			user("Improve the plugin controls."),
			user(`${"Project instructions.\n".repeat(200)}Rename jev-arbiter to jev-auto-mode and verify the configuration.`),
			user("do it"),
			assistant(toolPart("pending", "shell", { command })),
		];
		const captures: unknown[] = [];
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(
			{ action: "shell", resources: [command], tool: { name: "shell", input: { command } } },
			taskContext(messages, "pending"),
		);
		const state = (captures[0] as CapturedRequest).state;
		const requests = (state.task as { requests: string[] }).requests;
		expect(requests).toHaveLength(3);
		expect(requests[1]).toEndWith("Rename jev-arbiter to jev-auto-mode and verify the configuration.");
		expect(requests[2]).toBe("do it");
		expect(state.call).toMatchObject({ tool: { name: "shell", input: { command } } });
	});

	test("an uncertain denial directs the agent toward a lower-risk action", async () => {
		const judgment = await createJevJudge(staticClient({ ...SAFE, destroys_data: 0.5 }), ENVIRONMENT).judge(CALL, TASK);
		expect(judgment.verdict).toBe("deny");
		expect(judgment.reason).toContain("Continue with a narrower or lower-risk action");
	});

	test("the judged state omits intent when the agent stated none", async () => {
		const captures: unknown[] = [];
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(CALL, TASK);
		expect((captures[0] as CapturedRequest).state).not.toHaveProperty("intent");
	});

	test("questions reference the state by backticked path", async () => {
		const captures: unknown[] = [];
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(CALL, TASK);
		for (const question of Object.values((captures[0] as CapturedRequest).questions)) {
			expect(question.instructions).toContain("`call`");
			expect(question.instructions).toContain("`task.requests`");
			expect(question.instructions).toContain("`intent`");
			expect(question.instructions).toContain("`project.directory`");
		}
	});

	test("harm questions judge the call alone and discount what the task asked for; relevance reads intent", async () => {
		const captures: unknown[] = [];
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(CALL, TASK);
		const questions = (captures[0] as CapturedRequest).questions;
		for (const id of CRITERION_IDS) {
			const instructions = String(questions[id].instructions);
			const harm = id !== "serves_task";
			expect(instructions.includes("`intent` is the agent's claim, not evidence")).toBe(harm);
			expect(instructions.includes("An effect that `task` asks for is intended")).toBe(harm);
		}
	});

	test("an empty task context still judges, with a placeholder request", async () => {
		const captures: unknown[] = [];
		const judgment = await createJevJudge(capturingClient(captures), ENVIRONMENT).judge(CALL, { requests: [], recentCalls: [] });
		expect((captures[0] as CapturedRequest).state.task).toEqual({ requests: ["(unknown: the session holds no user request)"] });
		expect(judgment.verdict).toBe("allow");
	});

		test("long strings in the call are truncated", async () => {
		const captures: unknown[] = [];
		const content = "x".repeat(5000);
		await createJevJudge(capturingClient(captures), ENVIRONMENT).judge({ ...CALL, tool: { name: "write", input: { filePath: "a.ts", content } } }, TASK);
		const call = (captures[0] as CapturedRequest).state.call as { tool: { input: { filePath: string; content: string } } };
		expect(call.tool.input.filePath).toBe("a.ts");
		expect(call.tool.input.content).toBe(`${"x".repeat(2000)}…[1000 characters truncated]…${"x".repeat(2000)}`);
	});

	test("the versioned model id JEV answered with is carried in the judgment", async () => {
		const client: SystemOneClient = { systemOne: async () => ({ model: "jev-1.13.0", answers: respond(SAFE) }) };
		const judgment = await createJevJudge(client, ENVIRONMENT).judge(CALL, TASK);
		expect(judgment.verdict).toBe("allow");
		expect(judgment.model).toBe("jev-1.13.0");
	});

	test("a response without a model id still judges, with no model recorded", async () => {
		const judgment = await createJevJudge(staticClient(SAFE), ENVIRONMENT).judge(CALL, TASK);
		expect(judgment.verdict).toBe("allow");
		expect(judgment).not.toHaveProperty("model");
	});

	test("the SDK call is bounded by a 2.5 second per-attempt timeout and one retry", async () => {
		const options: unknown[] = [];
		const client: SystemOneClient = {
			systemOne: async (_request, requestOptions) => {
				options.push(requestOptions);
				return { answers: respond(SAFE) };
			},
		};
		await createJevJudge(client, ENVIRONMENT).judge(CALL, TASK);
		expect(options).toEqual([{ timeout: 2_500, retry: { maxRetries: 1 } }]);
	});
});

describe("bounded", () => {
	test("keeps the head and tail of nested strings and keeps other values", () => {
		expect(bounded({ a: "abcdef", b: ["abcdef", 3], c: { d: null, e: true } }, 3)).toEqual({
			a: "ab…[3 characters truncated]…f",
			b: ["ab…[3 characters truncated]…f", 3],
			c: { d: null, e: true },
		});
	});
});

describe("jevJudgeFromEnvironment", () => {
	test("returns no judge without an API key", () => {
		expect(jevJudgeFromEnvironment({}, ENVIRONMENT)).toBeUndefined();
		expect(jevJudgeFromEnvironment({ TYPESAFE_API_KEY: "" }, ENVIRONMENT)).toBeUndefined();
	});

	test("returns a judge when either key variable is set", () => {
		expect(jevJudgeFromEnvironment({ TYPESAFE_API_KEY: "key" }, ENVIRONMENT)).toBeDefined();
		expect(jevJudgeFromEnvironment({ TYPESAFE_AI_API_KEY: "key" }, ENVIRONMENT)).toBeDefined();
	});
});
