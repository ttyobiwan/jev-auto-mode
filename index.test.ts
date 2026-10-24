import { describe, expect, test } from "bun:test";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import type { SessionMessage, TaskContext } from "./jev/task-context.js";
import type { Judge, JudgeEnvironment, PendingCall } from "./jev/judge.js";
import { decide, type Answers, type Judgment } from "./jev/decide.js";
import { evaluatePermission, type EvaluationContext } from "./index.js";
import { createModeController, type ModeController } from "./mode.js";
import { assistant, textPart, toolPart, user } from "./test/fixtures.js";

const ANSWERS: Answers = { serves_task: 0.97, destroys_data: 0.02, exposes_secrets: 0.01, transmits_project_data: 0.03, irreversible_external_effect: 0.02 };

interface EventShape {
	sessionID: string;
	agent?: string;
	action: string;
	resources: readonly string[];
	metadata?: Record<string, unknown>;
	source?: { type: "tool"; messageID: string; id: string };
	effect: "allow" | "ask" | "deny";
	message?: string;
}

const event = (overrides: Partial<EventShape> = {}): PermissionEvaluation =>
	({
		sessionID: "s1",
		agent: "build",
		action: "shell",
		resources: ["curl http://example.com"],
		source: { type: "tool", messageID: "msg-1", id: "call-1" },
		effect: "ask",
		...overrides,
	}) as PermissionEvaluation;

interface Harness {
	evaluate: (event: PermissionEvaluation) => Promise<void>;
	judged: Array<{ call: PendingCall; context: TaskContext }>;
	audit: Array<{ key: string; value: unknown }>;
	logs: string[];
	reads: string[];
	modes: ModeController;
	contextReads: string[];
	environments: Array<JudgeEnvironment | undefined>;
}

function harness(options: { judge?: Judge; sessions?: Record<string, { agent?: string; id?: string; parentID?: string; location?: { directory: string } }>; messages?: Record<string, SessionMessage[]>; failStorage?: boolean; failContext?: boolean | string; failModeRead?: boolean; enabled?: boolean } = {}): Harness {
	const judged: Array<{ call: PendingCall; context: TaskContext }> = [];
	const audit: Array<{ key: string; value: unknown }> = [];
	const logs: string[] = [];
	const reads: string[] = [];
	const contextReads: string[] = [];
	const environments: Array<JudgeEnvironment | undefined> = [];
	const values = new Map<string, unknown>();
	if (options.enabled !== undefined) values.set("auto/s1", options.enabled);
	const getSession = async ({ sessionID }: { sessionID: string }) => {
		reads.push(sessionID);
		return options.sessions ? options.sessions[sessionID] : { agent: "build", id: sessionID, location: { directory: "/project" } };
	};
	const modes = createModeController({
		getSession,
		storage: {
			get: async (key) => {
				if (options.failModeRead) throw new Error("mode store unavailable");
				return values.get(key);
			},
			set: async (key, value) => { values.set(key, value); },
		},
	});
	const judge: Judge =
		options.judge ??
		{
			judge: async (call, context, environment) => {
				judged.push({ call, context });
				environments.push(environment);
				const judgment: Judgment = { verdict: "deny", reason: "Denied by JEV (test)" };
				return judgment;
			},
		};
	const deps: EvaluationContext = {
		judge,
		environment: { projectDirectory: "/project", temporaryDirectories: ["/private/tmp/opencode"] },
		modes,
		session: {
			get: getSession as EvaluationContext["session"]["get"],
			context: async ({ sessionID }) => {
				contextReads.push(sessionID);
				if (options.failContext === true || options.failContext === sessionID) throw new Error("session store unavailable");
				return options.messages?.[sessionID] ?? [
					user("fetch the example page"),
					assistant(
						textPart("Fetching the page now."),
						toolPart("call-0", "bash", { command: "ls" }),
						toolPart("call-1", "bash", { command: "curl x" }),
					),
				];
			},
		},
		storage: {
			set: async (key, value) => {
				if (options.failStorage) throw new Error("disk full");
				audit.push({ key, value });
			},
		},
		log: (message) => logs.push(message),
	};
	return {
		evaluate: (pending) => evaluatePermission(pending, deps),
		judged,
		audit,
		logs,
		reads,
		modes,
		contextReads,
		environments,
	};
}

/** Let the best-effort audit write finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("evaluatePermission", () => {
	test("allow passes through untouched", async () => {
		const h = harness();
		const allowed = event({ effect: "allow" });
		await h.evaluate(allowed);
		expect(allowed.effect).toBe("allow");
		expect(allowed.message).toBeUndefined();
		expect(h.judged).toEqual([]);
		expect(h.reads).toEqual([]);
		expect(h.audit).toEqual([]);
	});

	test("an automatic ask becomes the judge's effect with the reason as message", async () => {
		const h = harness();
		const pending = event();
		await h.evaluate(pending);
		expect(pending.effect).toBe("deny");
		expect(pending.message).toBe("Denied by JEV (test)");
		expect(h.judged.length).toBe(1);
	});

	test("auto mode approves edits without reading context or calling JEV", async () => {
		const h = harness({ failContext: true });
		const pending = event({ action: "edit", resources: ["src/index.ts"], metadata: { diff: "-a\n+b" } });
		await h.evaluate(pending);
		expect(pending.effect).toBe("allow");
		expect(h.judged).toEqual([]);
		expect(h.contextReads).toEqual([]);
	});

	test("external directory access for an edit still requires JEV", async () => {
		const h = harness();
		const pending = event({ action: "external_directory", resources: ["/outside/*"], metadata: { diff: "-a\n+b" } });
		await h.evaluate(pending);
		expect(pending.effect).toBe("deny");
		expect(h.judged).toHaveLength(1);
		expect(h.judged[0].call.action).toBe("external_directory");
	});

	test("each judgment and audit use the current session directory and trusted temporary roots", async () => {
		const session = { location: { directory: "/worktrees/first" } };
		const h = harness({ sessions: { s1: session } });
		await h.evaluate(event());
		session.location.directory = "/worktrees/second";
		await h.evaluate(event());
		expect(h.environments).toEqual([
			{ projectDirectory: "/project", sessionDirectory: "/worktrees/first", temporaryDirectories: ["/private/tmp/opencode"] },
			{ projectDirectory: "/project", sessionDirectory: "/worktrees/second", temporaryDirectories: ["/private/tmp/opencode"] },
		]);
		expect(h.audit[0].value).toMatchObject({ environment: h.environments[0] });
		expect(h.audit[1].value).toMatchObject({ environment: h.environments[1] });
	});

	test("the judged call carries the permission request and the pending tool call, excluded from context", async () => {
		const h = harness();
		await h.evaluate(event({ metadata: { diff: "-a\n+b" } }));
		const { call, context } = h.judged[0];
		expect(call).toEqual({
			action: "shell",
			resources: ["curl http://example.com"],
			metadata: { diff: "-a\n+b" },
			tool: { name: "bash", input: { command: "curl x" } },
		});
		expect(context).toEqual({
			requests: ["fetch the example page"],
			dialogue: [
				{ role: "user", text: "fetch the example page" },
				{ role: "assistant", text: "Fetching the page now." },
			],
			intent: "Fetching the page now.",
			recentCalls: [{ tool: "bash", input: "bash: ls" }],
		});
	});

	test("without a tool source the call carries the permission request alone", async () => {
		const h = harness();
		await h.evaluate(event({ source: undefined }));
		expect(h.judged[0].call).toEqual({ action: "shell", resources: ["curl http://example.com"] });
	});

	test.each(["shell", "edit"])("when auto mode is off a %s ask stays unchanged without judging", async (action) => {
		const h = harness({ enabled: false });
		const pending = event({ action, agent: "build" });
		await h.evaluate(pending);
		expect(pending.effect).toBe("ask");
		expect(pending.message).toBeUndefined();
		expect(h.judged).toEqual([]);
		expect(h.contextReads).toEqual([]);
	});

	test.each(["shell", "edit"])("an explicit %s deny does not resolve modes or read context", async (action) => {
		const h = harness({ failModeRead: true });
		const pending = event({ action, effect: "deny", message: "configured deny" });
		await h.evaluate(pending);
		expect(pending.effect).toBe("deny");
		expect(pending.message).toBe("configured deny");
		expect(h.reads).toEqual([]);
		expect(h.contextReads).toEqual([]);
		expect(h.judged).toEqual([]);
	});

	test.each(["shell", "edit"])("mode lookup failure leaves a %s ask unchanged", async (action) => {
		const h = harness({ failModeRead: true });
		const pending = event({ action });
		await h.evaluate(pending);
		expect(pending.effect).toBe("ask");
		expect(h.judged).toEqual([]);
		expect(h.contextReads).toEqual([]);
		expect(h.logs[0]).toContain("mode store unavailable");
	});

	test("missing ancestry leaves an automatic ask unchanged", async () => {
		const h = harness({ sessions: { s1: { parentID: "missing" } } });
		const pending = event();
		await h.evaluate(pending);
		expect(pending.effect).toBe("ask");
		expect(h.judged).toEqual([]);
		expect(h.logs[0]).toContain("missing");
	});

	test("root mode changes affect a child's next evaluation without switching agents", async () => {
		const h = harness({ sessions: { s1: { agent: "general", parentID: "root" }, root: { agent: "build" } } });
		const first = event({ agent: "general" });
		await h.evaluate(first);
		expect(first.effect).toBe("deny");
		await h.modes.toggle("root");
		const next = event({ agent: "general" });
		await h.evaluate(next);
		expect(next.effect).toBe("ask");
		expect(h.judged).toHaveLength(1);
	});

	test("child judgments include fresh root requests while keeping child input and directory", async () => {
		const messages = {
			root: [user("Inspect the service using its authenticated CLI."), assistant(toolPart("call-1", "shell", { command: "root command" }))],
			s1: [user("Check the service status."), assistant(toolPart("call-1", "shell", { command: "service-cli status" }))],
		};
		const h = harness({
			sessions: {
				root: { location: { directory: "/project" } },
				s1: { parentID: "root", location: { directory: "/worktrees/child" } },
			},
			messages,
		});
		await h.evaluate(event());
		expect(h.judged[0].context.rootTask).toEqual({ requests: ["Inspect the service using its authenticated CLI."] });
		expect(h.judged[0].context.requests).toEqual(["Check the service status."]);
		expect(h.judged[0].call.tool?.input).toEqual({ command: "service-cli status" });
		expect(h.environments[0]?.sessionDirectory).toBe("/worktrees/child");
		messages.root.push(user("Stop. Do not access the service."));
		await h.evaluate(event());
		expect(h.judged[1].context.rootTask?.requests.at(-1)).toBe("Stop. Do not access the service.");
		expect(h.contextReads).toEqual(["s1", "root", "s1", "root"]);
		expect(h.audit[1].value).toMatchObject({ context: { rootTask: h.judged[1].context.rootTask } });
	});

	test("root judgments read their conversation only once", async () => {
		const h = harness();
		await h.evaluate(event());
		expect(h.contextReads).toEqual(["s1"]);
		expect(h.judged[0].context).not.toHaveProperty("rootTask");
	});

	test("failed root context reads retain the child task without inventing root authorization", async () => {
		const h = harness({
			sessions: { root: { location: { directory: "/project" } }, s1: { parentID: "root", location: { directory: "/child" } } },
			failContext: "root",
		});
		await h.evaluate(event());
		expect(h.contextReads).toEqual(["s1", "root"]);
		expect(h.judged[0].context.requests).toEqual(["fetch the example page"]);
		expect(h.judged[0].context.rootTask).toEqual({ requests: [] });
		expect(h.logs).toHaveLength(1);
		expect(h.logs[0]).toContain("session context unavailable");
	});

	test("an already-running judgment retains its initial mode", async () => {
		const entered = Promise.withResolvers<void>();
		const result = Promise.withResolvers<Judgment>();
		const h = harness({ judge: { judge: async () => { entered.resolve(); return result.promise; } } });
		const pending = event();
		const evaluating = h.evaluate(pending);
		await entered.promise;
		await h.modes.toggle("s1");
		result.resolve({ verdict: "allow", reason: "approved" });
		await evaluating;
		expect(pending.effect).toBe("allow");
		const next = event();
		await h.evaluate(next);
		expect(next.effect).toBe("ask");
	});

	test("an allow verdict from the judge sets effect allow", async () => {
		const h = harness({
			judge: { judge: async () => ({ verdict: "allow", reason: "Auto-approved by JEV", answers: ANSWERS }) },
		});
		const pending = event();
		await h.evaluate(pending);
		expect(pending.effect).toBe("allow");
		expect(pending.message).toBe("Auto-approved by JEV");
	});

	test("the decision is audited after it is applied, with what the judge saw", async () => {
		const h = harness({
			judge: { judge: async () => ({ verdict: "allow", reason: "Auto-approved by JEV", answers: ANSWERS, model: "jev-1.13.0" }) },
		});
		const pending = event({ agent: undefined });
		await h.evaluate(pending);
		expect(h.audit.length).toBe(1);
		const { key, value } = h.audit[0];
		expect(key).toMatch(/^decision\/\d+-call-1$/);
		expect(value).toMatchObject({
			sessionID: "s1",
			agent: null,
			action: "shell",
			resources: ["curl http://example.com"],
			call: { action: "shell", resources: ["curl http://example.com"], tool: { name: "bash", input: { command: "curl x" } } },
			context: { requests: ["fetch the example page"], intent: "Fetching the page now.", recentCalls: [{ tool: "bash", input: "bash: ls" }] },
			answers: ANSWERS,
			model: "jev-1.13.0",
			verdict: "allow",
			reason: "Auto-approved by JEV",
		});
		expect(typeof (value as { time: string }).time).toBe("string");
		expect(typeof (value as { elapsedMs: number }).elapsedMs).toBe("number");
	});

	test("the audit bounds long strings in the call", async () => {
		const content = "x".repeat(5000);
		const h = harness({
			judge: { judge: async () => ({ verdict: "allow", reason: "Auto-approved by JEV", answers: ANSWERS }) },
		});
		await h.evaluate(event({ metadata: { diff: content } }));
		const call = (h.audit[0].value as { call: { metadata: { diff: string } } }).call;
		expect(call.metadata.diff).toBe(`${"x".repeat(2000)}…[1000 characters truncated]…${"x".repeat(2000)}`);
	});

	test("a storage failure is logged and discarded, the decision still applies", async () => {
		const h = harness({ failStorage: true });
		const pending = event();
		await h.evaluate(pending);
		await settle();
		expect(pending.effect).toBe("deny");
		expect(h.logs.length).toBe(1);
	});

	test("audit records of parallel asks in the same millisecond get distinct keys", async () => {
		const h = harness();
		await Promise.all([
			h.evaluate(event()),
			h.evaluate(event({ source: { type: "tool", messageID: "msg-1", id: "call-2" } })),
			h.evaluate(event({ source: undefined })),
			h.evaluate(event({ source: undefined })),
		]);
		expect(new Set(h.audit.map(({ key }) => key)).size).toBe(4);
	});

	test("an abstention leaves the ask to the human, logs it, and is audited", async () => {
		const h = harness({ judge: { judge: async () => ({ verdict: "abstain", reason: "JEV unavailable (503)" }) } });
		const pending = event();
		await h.evaluate(pending);
		expect(pending.effect).toBe("ask");
		expect(pending.message).toBeUndefined();
		expect(h.logs).toEqual(["jev-auto-mode: JEV unavailable (503); leaving the ask to the human"]);
		expect(h.audit.length).toBe(1);
		expect((h.audit[0].value as { verdict: string }).verdict).toBe("abstain");
	});

	test("repeated uncertain asks receive the same guidance and remain denied", async () => {
		const uncertain: Answers = { ...ANSWERS, destroys_data: 0.5 };
		const h = harness({
			judge: { judge: async () => decide(uncertain) },
		});
		const first = event();
		await h.evaluate(first);
		const second = event({ source: { type: "tool", messageID: "msg-2", id: "call-2" } });
		await h.evaluate(second);
		expect(first.effect).toBe("deny");
		expect(second.effect).toBe("deny");
		expect(first.message).toContain("Continue with a narrower or lower-risk action");
		expect(second.message).toBe(first.message);
	});

	test("a session context read failure degrades to judging the call alone", async () => {
		const h = harness({ failContext: true });
		const pending = event();
		await h.evaluate(pending);
		expect(h.judged.length).toBe(1);
		expect(h.judged[0].context).toEqual({ requests: [], recentCalls: [] });
		expect(pending.effect).toBe("deny");
		expect(h.audit.length).toBe(1);
		expect((h.audit[0].value as { answers: unknown }).answers).toBeNull();
		expect((h.audit[0].value as { model: unknown }).model).toBeNull();
		expect((h.audit[0].value as { context: unknown }).context).toEqual({ requests: [], recentCalls: [] });
		expect(h.logs.length).toBe(1);
		expect(h.logs[0]).toContain("session context unavailable");
	});
});
