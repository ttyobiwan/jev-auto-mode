import type { SessionMessage } from "../jev/task-context.js";

type Assistant = Extract<SessionMessage, { type: "assistant" }>;
type Part = Assistant["content"][number];
type ToolPart = Extract<Part, { type: "tool" }>;
type ToolInput = Extract<ToolPart["state"], { status: "running" }>["input"];

export const user = (text: string): Extract<SessionMessage, { type: "user" }> => ({
	id: "user", time: { created: 0 }, type: "user", text,
});

export const assistant = (...content: Part[]): Assistant => ({
	id: "assistant", time: { created: 0 }, type: "assistant", agent: "build",
	model: { providerID: "test", id: "test" }, content,
});

export const toolPart = (id: string, name: string, input: ToolInput | string): ToolPart => ({
	type: "tool", id, name, time: { created: 0 },
	state: typeof input === "string" ? { status: "streaming", input } : { status: "running", input, metadata: {} },
});

export const textPart = (text: string): Extract<Part, { type: "text" }> => ({ type: "text", text });
export const reasoningPart = (text: string): Extract<Part, { type: "reasoning" }> => ({ type: "reasoning", text });

export function compaction(summary: string, status: "completed" | "running" | "failed" = "completed"): Extract<SessionMessage, { type: "compaction" }> {
	const base = { type: "compaction", id: "compaction", time: { created: 0 }, reason: "auto" } as const;
	return status === "failed"
		? { ...base, status, error: { type: "error", message: "failed" } }
		: { ...base, status, summary, recent: "" };
}
