import type { SessionMessage } from "../jev/task-context.js";

type Assistant = Extract<SessionMessage, { type: "assistant" }>;
type Part = Assistant["content"][number];
type ToolPart = Extract<Part, { type: "tool" }>;
type ToolInput = Extract<ToolPart["state"], { status: "running" }>["input"];

export const user = (text: string): Extract<SessionMessage, { type: "user" }> => ({
	id: "user", time: { created: 0 }, type: "user", text,
});

type User = Extract<SessionMessage, { type: "user" }>;

/** A user message that invokes skills, each loaded with its body. */
export const userWithSkills = (text: string, skills: Array<{ name: string; text: string }>): User => ({
	...user(text), skills: skills.map(({ name, text }) => ({ id: name, name, text })) as NonNullable<User["skills"]>,
});

export const assistant = (...content: Part[]): Assistant => ({
	id: "assistant", time: { created: 0 }, type: "assistant", agent: "build",
	model: { providerID: "test", id: "test" }, content,
});

export const toolPart = (id: string, name: string, input: ToolInput | string): ToolPart => ({
	type: "tool", id, name, time: { created: 0 },
	state: typeof input === "string" ? { status: "streaming", input } : { status: "running", input, metadata: {} },
});

export const completedToolPart = (id: string, name: string, input: ToolInput): ToolPart => ({
	type: "tool", id, name, time: { created: 0 },
	state: { status: "completed", input, content: [{ type: "text", text: "done" }] },
});

/** A completed question call; the host records the developer's answers in metadata, one list per question. */
export const answeredQuestionPart = (id: string, questions: ToolInput["questions"], answers: string[][]): ToolPart => ({
	type: "tool", id, name: "question", time: { created: 0 },
	state: { status: "completed", input: { questions }, content: [{ type: "text", text: "User has answered your questions." }], metadata: { answers } },
});

export const failedToolPart = (id: string, name: string, input: ToolInput): ToolPart => ({
	type: "tool", id, name, time: { created: 0 },
	state: { status: "error", input, error: { type: "permission.rejected", message: "Denied" } },
});

export const textPart = (text: string): Extract<Part, { type: "text" }> => ({ type: "text", text });
export const reasoningPart = (text: string): Extract<Part, { type: "reasoning" }> => ({ type: "reasoning", text });

export function compaction(summary: string, status: "completed" | "running" | "failed" = "completed"): Extract<SessionMessage, { type: "compaction" }> {
	const base = { type: "compaction", id: "compaction", time: { created: 0 }, reason: "auto" } as const;
	return status === "failed"
		? { ...base, status, error: { type: "error", message: "failed" } }
		: { ...base, status, summary, recent: "" };
}
