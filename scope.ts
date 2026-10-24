/** Maximum local reads to resolve a session's root. */
export const SESSION_SCOPE_DEPTH = 8;

export interface SessionInfoLike {
	id?: string;
	parentID?: string;
}

export interface ScopeDeps {
	getSession(input: { sessionID: string }): Promise<SessionInfoLike | undefined>;
}

export async function resolveRootSession(sessionID: string, deps: ScopeDeps): Promise<string> {
	const visited = new Set<string>();
	let current = sessionID;
	for (let depth = 0; depth < SESSION_SCOPE_DEPTH; depth++) {
		if (visited.has(current)) throw new Error(`Session ancestry cycle at ${current}`);
		visited.add(current);
		const session = await deps.getSession({ sessionID: current });
		if (!session) throw new Error(`Session ${current} not found`);
		if (!session.parentID) return current;
		current = session.parentID;
	}
	throw new Error(`Session chain from ${sessionID} exceeded the ${SESSION_SCOPE_DEPTH}-read depth bound`);
}
