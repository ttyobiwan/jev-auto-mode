import { TypeSafeClient } from "@typesafe-ai/sdk";
import { decide, type Answers, type Judgment } from "./decide.js";
import { CRITERION_IDS, RUBRIC } from "./rubric.js";
import type { TaskContext } from "./task-context.js";

/** Per-attempt timeout. */
export const JUDGE_TIMEOUT_MS = 2_500;
/** Retries after the first attempt; bounds an unanswered ask at ~5.5 s. */
export const JUDGE_MAX_RETRIES = 1;
/** Characters per string in the forwarded call; bounds a write's content or an edit's diff. */
export const CALL_STRING_LIMIT = 4000;
const NO_REQUEST = "(unknown: the session holds no user request)";

/** The call the arbiter forwards from a PermissionEvaluation event. */
export interface PendingCall {
	action: string;
	resources: readonly string[];
	/** Permission metadata OpenCode attached, such as an edit's diff. */
	metadata?: Record<string, unknown>;
	/** The tool call as the agent issued it, when the session holds it. */
	tool?: { name: string; input: Record<string, unknown> };
}

/** Trusted host context, separate from agent-authored tool input. */
export interface JudgeEnvironment {
	projectDirectory: string;
	sessionDirectory?: string;
	temporaryDirectories?: readonly string[];
}

const QUESTIONS = Object.fromEntries(CRITERION_IDS.map((id) => [id, RUBRIC[id].question]));

/** The slice of the TypeSafe client the judge uses. */
export interface SystemOneClient {
	systemOne(
		request: unknown,
		options?: { timeout?: number; retry?: { maxRetries?: number } },
	): Promise<{ model?: unknown; answers: Record<string, { noul?: unknown } | undefined> }>;
}

export interface Judge {
	/** An unavailable backend resolves to abstain instead of rejecting. */
	judge(call: PendingCall, context: TaskContext, environment?: JudgeEnvironment): Promise<Judgment>;
}

export function createJevJudge(client: SystemOneClient, defaultEnvironment: JudgeEnvironment): Judge {
	return {
		async judge(call, context, environment = defaultEnvironment) {
			const state = {
				task: {
					...(context.summary ? { summary: context.summary } : {}),
					requests: context.requests.length ? context.requests : [NO_REQUEST],
				},
				...(context.rootTask ? { rootTask: context.rootTask } : {}),
				...(context.intent ? { intent: context.intent } : {}),
				...(context.dialogue?.length ? { dialogue: context.dialogue } : {}),
				call: bounded(call, CALL_STRING_LIMIT),
				project: { directory: environment.projectDirectory },
				environment: {
					...(environment.sessionDirectory ? { sessionDirectory: environment.sessionDirectory } : {}),
					temporaryDirectories: environment.temporaryDirectories ?? [],
				},
				recentCalls: context.recentCalls,
			};
			try {
				const { model, answers } = await client.systemOne(
					{ state, questions: QUESTIONS },
					{ timeout: JUDGE_TIMEOUT_MS, retry: { maxRetries: JUDGE_MAX_RETRIES } },
				);
				return { ...decide(parseAnswers(answers)), ...(typeof model === "string" ? { model } : {}) };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { verdict: "abstain", reason: `JEV unavailable (${message})` };
			}
		},
	};
}

/** Every criterion's probability, or an error naming the first missing one. */
function parseAnswers(answers: Record<string, { noul?: unknown } | undefined>): Answers {
	const parsed = {} as Answers;
	for (const id of CRITERION_IDS) {
		const probability = answers[id]?.noul;
		if (typeof probability !== "number" || !Number.isFinite(probability)) throw new Error(`malformed answer for ${id}`);
		parsed[id] = probability;
	}
	return parsed;
}

/** A deep copy with every string longer than `limit` cut to its head and tail around a marker. */
export function bounded<T>(value: T, limit: number): T {
	if (typeof value === "string") {
		if (value.length <= limit) return value;
		const head = Math.ceil(limit / 2);
		const tail = limit - head;
		return `${value.slice(0, head)}…[${value.length - limit} characters truncated]…${value.slice(value.length - tail)}` as T;
	}
	if (Array.isArray(value)) return value.map((item) => bounded(item, limit)) as T;
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bounded(item, limit)])) as T;
	}
	return value;
}

export function jevJudgeFromEnvironment(env: Record<string, string | undefined>, environment: JudgeEnvironment): Judge | undefined {
	const apiKey = env.TYPESAFE_API_KEY || env.TYPESAFE_AI_API_KEY;
	if (!apiKey) return undefined;
	return createJevJudge(new TypeSafeClient({ apiKey }) as unknown as SystemOneClient, environment);
}
