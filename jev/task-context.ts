import type { Plugin } from "@opencode/plugin";

export type SessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number];
type AssistantMessage = Extract<SessionMessage, { type: "assistant" }>;

const REQUEST_LIMIT = 2000;
const REQUESTS_BUDGET = 4000;
const REQUESTS_LIMIT = 10;
const TRUNCATION_MARKER = "\n[truncated]\n";
const RECENT_CALLS_LIMIT = 10;
const CALL_DESCRIPTION_LIMIT = 120;
const INTENT_LIMIT = 600;
const SUMMARY_LIMIT = 2000;
const DIALOGUE_LIMIT = 8;
const DIALOGUE_TEXT_LIMIT = 1500;
const DIALOGUE_BUDGET = 6000;

interface DialogueEntry {
	role: "user" | "assistant";
	text: string;
}

interface TaskRequests {
	summary?: string;
	requests: string[];
}

export interface TaskContext extends TaskRequests {
	rootTask?: TaskRequests;
	dialogue?: DialogueEntry[];
	intent?: string;
	recentCalls: Array<{ tool: string; input: string }>;
}

export function taskContext(messages: readonly SessionMessage[], pendingCallId: string, rootMessages?: readonly SessionMessage[]): TaskContext {
	const context: TaskContext = { requests: [], recentCalls: [] };
	if (rootMessages) context.rootTask = taskRequests(rootMessages);
	let latest: AssistantMessage | undefined;
	let issuing: AssistantMessage | undefined;
	const dialogue: DialogueEntry[] = [];
	for (const message of messages) {
		if (message.type === "compaction" && message.status === "completed" && message.summary.trim()) {
			context.summary = truncateLines(message.summary.trim(), SUMMARY_LIMIT);
			dialogue.length = 0;
		}
		const text = message.type === "user" ? message.text.trim() : message.type === "assistant" ? assistantText(message) : "";
		if (text && (message.type === "user" || message.type === "assistant")) {
			dialogue.push({ role: message.type, text: truncateExcerpt(text, DIALOGUE_TEXT_LIMIT) });
			if (dialogue.length > DIALOGUE_LIMIT) dialogue.shift();
		}
		if (message.type === "user" && message.text.trim()) {
			context.requests.push(message.text.trim());
			if (context.requests.length > REQUESTS_LIMIT) context.requests.splice(1, 1);
		}
		if (message.type !== "assistant") continue;
		latest = message;
		for (const part of message.content) {
			if (part.type !== "tool") continue;
			if (part.id === pendingCallId) {
				issuing ??= message;
				continue;
			}
			const input = part.state.status === "streaming" ? {} : part.state.input;
			context.recentCalls.push({ tool: part.name, input: describeCall(part.name, input) });
			if (context.recentCalls.length > RECENT_CALLS_LIMIT) context.recentCalls.shift();
		}
	}
	context.requests = boundedRequests(context.requests);
	if (dialogue.length) context.dialogue = boundedDialogue(dialogue);
	const text = assistantText(issuing ?? latest);
	if (text) context.intent = truncateLines(text, INTENT_LIMIT);
	return context;
}

function taskRequests(messages: readonly SessionMessage[]): TaskRequests {
	const task: TaskRequests = { requests: [] };
	for (const message of messages) {
		if (message.type === "compaction" && message.status === "completed" && message.summary.trim()) {
			task.summary = truncateLines(message.summary.trim(), SUMMARY_LIMIT);
		}
		if (message.type === "user" && message.text.trim()) {
			task.requests.push(message.text.trim());
			if (task.requests.length > REQUESTS_LIMIT) task.requests.splice(1, 1);
		}
	}
	task.requests = boundedRequests(task.requests);
	return task;
}

function assistantText(message: AssistantMessage | undefined): string {
	return message?.content
		.filter((part) => part.type === "text")
		.map((part) => part.text.trim())
		.filter(Boolean)
		.join("\n") ?? "";
}

function boundedDialogue(dialogue: DialogueEntry[]): DialogueEntry[] {
	const recent: DialogueEntry[] = [];
	let remaining = DIALOGUE_BUDGET;
	for (let index = dialogue.length - 1; index >= 0 && remaining > TRUNCATION_MARKER.length; index--) {
		const entry = dialogue[index];
		const text = truncateExcerpt(entry.text, remaining);
		recent.push({ role: entry.role, text });
		remaining -= text.length;
	}
	return recent.reverse();
}

/** Reserve the initial request, then fill the remaining budget newest first. */
function boundedRequests(requests: readonly string[]): string[] {
	if (!requests.length) return [];
	const first = truncateExcerpt(requests[0], REQUEST_LIMIT);
	let remaining = REQUESTS_BUDGET - first.length;
	const recent: string[] = [];
	for (let index = requests.length - 1; index > 0 && remaining > TRUNCATION_MARKER.length; index--) {
		const text = truncateExcerpt(requests[index], Math.min(REQUEST_LIMIT, remaining));
		recent.push(text);
		remaining -= text.length;
	}
	return [first, ...recent.reverse()];
}

function truncateExcerpt(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const available = limit - TRUNCATION_MARKER.length;
	const head = Math.ceil(available / 2);
	return `${text.slice(0, head)}${TRUNCATION_MARKER}${text.slice(text.length - (available - head))}`;
}

export function toolCall(messages: readonly SessionMessage[], id: string): { name: string; input: Record<string, unknown> } | undefined {
	for (const message of messages) {
		if (message.type !== "assistant") continue;
		for (const part of message.content) {
			if (part.type !== "tool" || part.id !== id) continue;
			return part.state.status === "streaming" ? undefined : { name: part.name, input: part.state.input };
		}
	}
	return undefined;
}

function describeCall(tool: string, input: Record<string, unknown>): string {
	const value = input.command ?? input.path ?? input.url ?? Object.values(input).find((value) => typeof value === "string");
	const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
	const description = text ? `${tool}: ${text}` : tool;
	return description.length <= CALL_DESCRIPTION_LIMIT ? description : `${description.slice(0, CALL_DESCRIPTION_LIMIT - 1)}…`;
}

function truncateLines(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const head = text.slice(0, limit);
	const lineEnd = head.lastIndexOf("\n");
	return `${lineEnd > limit / 2 ? head.slice(0, lineEnd) : head}\n[truncated]`;
}
