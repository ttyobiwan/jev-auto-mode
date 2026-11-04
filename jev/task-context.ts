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
const ARTIFACTS_LIMIT = 20;
const ARTIFACT_CONTENT_LIMIT = 4000;
const ARTIFACT_CONTENT_BUDGET = 8000;

/** A file that an earlier completed call in this session wrote. */
export interface SessionArtifact {
	path: string;
	/** The latest content the session wrote, present when the pending call references the file. */
	content?: string;
}

/** Each written path with its latest known content, in order of last write. */
type Writes = Map<string, string | undefined>;

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
	artifacts?: SessionArtifact[];
}

export function taskContext(messages: readonly SessionMessage[], pendingCallId: string, rootMessages?: readonly SessionMessage[]): TaskContext {
	const context: TaskContext = { requests: [], recentCalls: [] };
	if (rootMessages) context.rootTask = taskRequests(rootMessages);
	let latest: AssistantMessage | undefined;
	let issuing: AssistantMessage | undefined;
	let pendingInput: Record<string, unknown> | undefined;
	const writes: Writes = new Map();
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
			const input = part.state.status === "streaming" ? {} : part.state.input;
			if (part.id === pendingCallId) {
				issuing ??= message;
				pendingInput ??= input;
				continue;
			}
			if (part.state.status === "completed") recordWrites(writes, part.name, input);
			context.recentCalls.push({ tool: part.name, input: describeCall(part.name, input) });
			if (context.recentCalls.length > RECENT_CALLS_LIMIT) context.recentCalls.shift();
		}
	}
	context.requests = boundedRequests(context.requests);
	if (dialogue.length) context.dialogue = boundedDialogue(dialogue);
	if (writes.size) context.artifacts = sessionArtifacts(writes, pendingInput);
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

/** Records the files a completed file-tool call wrote; content is known for full writes and edits of known content. */
function recordWrites(writes: Writes, tool: string, input: Record<string, unknown>): void {
	const write = (path: string, content: string | undefined) => {
		writes.delete(path);
		writes.set(path, content);
	};
	const path = typeof input.path === "string" ? input.path : typeof input.filePath === "string" ? input.filePath : undefined;
	if (tool === "write" && path) write(path, typeof input.content === "string" ? input.content : undefined);
	else if (tool === "edit" && path) write(path, editedContent(writes.get(path), input));
	else if (tool === "patch" && typeof input.patchText === "string") {
		for (const file of patchedFiles(input.patchText)) {
			if (file.deleted) writes.delete(file.path);
			else write(file.path, file.content);
		}
	}
}

function editedContent(content: string | undefined, input: Record<string, unknown>): string | undefined {
	const { oldString, newString } = input;
	if (content === undefined || typeof oldString !== "string" || typeof newString !== "string" || !oldString || !content.includes(oldString)) return undefined;
	return input.replaceAll === true ? content.replaceAll(oldString, () => newString) : content.replace(oldString, () => newString);
}

/** The files a patch adds, updates, moves, or deletes; content is known only for added files. */
function patchedFiles(patchText: string): Array<{ path: string; content?: string; deleted?: true }> {
	const files: Array<{ path: string; deleted?: true; lines?: string[] }> = [];
	for (const line of patchText.split("\n")) {
		const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
		if (!header) {
			if (line.startsWith("+")) files.at(-1)?.lines?.push(line.slice(1));
			continue;
		}
		const [, kind, path] = header;
		const previous = files.at(-1);
		if (kind === "Move to" && previous) previous.deleted = true;
		files.push({ path: path.trim(), ...(kind === "Add File" ? { lines: [] } : {}), ...(kind === "Delete File" ? { deleted: true as const } : {}) });
	}
	return files.map(({ lines, ...file }) => (lines ? { ...file, content: lines.join("\n") } : file));
}

/** The latest written paths; contents only for files the pending call references, newest first within the budget. */
function sessionArtifacts(writes: Writes, pendingInput: Record<string, unknown> | undefined): SessionArtifact[] {
	const recent = [...writes].slice(-ARTIFACTS_LIMIT);
	const referenced = pendingInput ? stringValues(pendingInput).join("\n") : "";
	let remaining = ARTIFACT_CONTENT_BUDGET;
	const artifacts: SessionArtifact[] = [];
	for (let index = recent.length - 1; index >= 0; index--) {
		const [path, content] = recent[index];
		if (content === undefined || remaining <= TRUNCATION_MARKER.length || !references(referenced, path)) {
			artifacts.push({ path });
			continue;
		}
		const excerpt = truncateExcerpt(content, Math.min(ARTIFACT_CONTENT_LIMIT, remaining));
		remaining -= excerpt.length;
		artifacts.push({ path, content: excerpt });
	}
	return artifacts.reverse();
}

/** Whether `text` names `path` in full or by its file name; a cd into the file's directory leaves only the name. */
function references(text: string, path: string): boolean {
	if (!text) return false;
	if (text.includes(path)) return true;
	const name = path.split("/").at(-1);
	if (!name) return false;
	return new RegExp(`(^|[\\s/'"<>=:(])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[\\s'"<>;|&)])`).test(text);
}

function stringValues(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(stringValues);
	if (typeof value === "object" && value !== null) return Object.values(value).flatMap(stringValues);
	return [];
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
