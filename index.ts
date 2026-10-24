import { Plugin } from "@opencode/plugin";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PermissionEvaluation } from "@opencode/plugin/promise/permission";
import { createAutoCommand } from "./command.js";
import { withCircuitBreaker } from "./jev/circuit-breaker.js";
import type { Judgment } from "./jev/decide.js";
import { bounded, CALL_STRING_LIMIT, jevJudgeFromEnvironment, type Judge, type JudgeEnvironment, type PendingCall } from "./jev/judge.js";
import { taskContext, toolCall, type TaskContext } from "./jev/task-context.js";
import { createModeController, type ModeController } from "./mode.js";
import { AutoModeRpc } from "./rpc.js";

export interface EvaluationContext {
	judge: Judge | undefined;
	environment: JudgeEnvironment;
	modes: ModeController;
	session: Pick<Plugin.Context["session"], "context" | "get">;
	storage: Pick<Plugin.Context["storage"], "set">;
	log(message: string): void;
}

interface JudgedAsk {
	call: PendingCall;
	context: TaskContext;
	environment: JudgeEnvironment;
	judgment: Judgment;
	elapsedMs: number;
}

export async function evaluatePermission(event: PermissionEvaluation, deps: EvaluationContext): Promise<void> {
	if (event.effect !== "ask") return;
	let rootSessionID: string;
	try {
		const mode = await deps.modes.get(event.sessionID);
		if (!mode.enabled) return;
		rootSessionID = mode.rootSessionID;
	} catch (error) {
		deps.log(`jev-auto-mode: mode unavailable (${String(error)}); leaving the ask to the human`);
		return;
	}
	if (event.action === "edit") {
		event.effect = "allow";
		event.message = "Edit approved by auto mode";
		return;
	}
	if (!deps.judge) return;
	const pendingCallId = event.source?.type === "tool" ? event.source.id : "";
	const [messages, rootMessages, directory] = await Promise.all([
		sessionMessages(deps, event.sessionID),
		rootSessionID !== event.sessionID ? sessionMessages(deps, rootSessionID) : undefined,
		sessionDirectory(deps, event.sessionID),
	]);
	const environment = { ...deps.environment, ...(directory ? { sessionDirectory: directory } : {}) };
	const tool = pendingCallId ? toolCall(messages, pendingCallId) : undefined;
	const call: PendingCall = {
		action: event.action,
		resources: event.resources,
		...(event.metadata ? { metadata: event.metadata } : {}),
		...(tool ? { tool } : {}),
	};
	const context = taskContext(messages, pendingCallId, rootMessages);
	const started = Date.now();
	const judgment = await deps.judge.judge(call, context, environment);
	void recordAudit(deps, event, { call, context, environment, judgment, elapsedMs: Date.now() - started });
	if (judgment.verdict === "abstain") {
		deps.log(`jev-auto-mode: ${judgment.reason}; leaving the ask to the human`);
		return;
	}
	event.effect = judgment.verdict;
	event.message = judgment.reason;
}

async function sessionMessages(deps: EvaluationContext, sessionID: string) {
	try {
		return await deps.session.context({ sessionID });
	} catch (error) {
		deps.log(`jev-auto-mode: session context unavailable (${String(error)}); judging the call alone`);
		return [];
	}
}

async function sessionDirectory(deps: EvaluationContext, sessionID: string): Promise<string | undefined> {
	try {
		return (await deps.session.get({ sessionID })).location.directory;
	} catch (error) {
		deps.log(`jev-auto-mode: session location unavailable (${String(error)}); judging without a session directory`);
		return undefined;
	}
}

/** Audit failures must not block permission evaluation. */
async function recordAudit(deps: EvaluationContext, event: PermissionEvaluation, judged: JudgedAsk): Promise<void> {
	const record = {
		time: new Date().toISOString(),
		sessionID: event.sessionID,
		agent: event.agent ?? null,
		action: event.action,
		resources: [...event.resources],
		call: bounded(judged.call, CALL_STRING_LIMIT),
		context: judged.context,
		environment: judged.environment,
		answers: judged.judgment.answers ?? null,
		model: judged.judgment.model ?? null,
		verdict: judged.judgment.verdict,
		reason: judged.judgment.reason,
		elapsedMs: judged.elapsedMs,
	};
	try {
		const toolCallId = event.source?.type === "tool" ? event.source.id : undefined;
		await deps.storage.set(`decision/${Date.now()}-${toolCallId || randomUUID()}`, JSON.parse(JSON.stringify(record)));
	} catch (error) {
		deps.log(`jev-auto-mode: audit write failed (${String(error)})`);
	}
}

export default Plugin.define({
	// Retain the storage namespace for saved session modes and decision records.
	id: "jev-auto-mode",
	async setup(ctx) {
		const log = (message: string) => console.warn(message);
		const modes = createModeController({ getSession: ctx.session.get, storage: ctx.storage });
		const toggle = async (sessionID: string) => {
			const state = await modes.toggle(sessionID);
			try {
				await rpc.events.emit("changed", { rootSessionID: state.rootSessionID });
			} catch (error) {
				log(`jev-auto-mode: auto mode changed but notification failed (${String(error)})`);
			}
			return state;
		};
		const rpc = await ctx.rpc.register(AutoModeRpc, {
			get: async (input) => modes.get((input as { sessionID: string }).sessionID),
			toggle: async (input) => toggle((input as { sessionID: string }).sessionID),
		});
		await ctx.command.transform((editor) => {
			editor.add(createAutoCommand({
				toggle,
				notify: async (sessionID, text) => { await ctx.session.synthetic({ sessionID, text, resume: false }); },
			}));
		});
		const environment: JudgeEnvironment = {
			projectDirectory: ctx.location.project.directory,
			temporaryDirectories: [join(realpathSync(tmpdir()), "opencode")],
		};
		const judge = jevJudgeFromEnvironment(process.env, environment);
		if (!judge) {
			log("jev-auto-mode: no TYPESAFE_API_KEY or TYPESAFE_AI_API_KEY set; non-edit asks keep prompting the user");
		}
		const deps = { judge: judge ? withCircuitBreaker(judge, { log }) : undefined, environment, modes, session: ctx.session, storage: ctx.storage, log };
		await ctx.permission.hook("evaluate", (event) => evaluatePermission(event, deps));
	},
});
