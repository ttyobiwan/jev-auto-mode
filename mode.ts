import { resolveRootSession, type ScopeDeps } from "./scope.js";

export interface AutoMode {
	rootSessionID: string;
	enabled: boolean;
}

export interface ModeController {
	get(sessionID: string): Promise<AutoMode>;
	toggle(sessionID: string): Promise<AutoMode>;
}

export function createModeController(deps: ScopeDeps & {
	storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> };
}): ModeController {
	const pending = new Map<string, Promise<AutoMode>>();
	async function read(rootSessionID: string): Promise<AutoMode> {
		const stored = await deps.storage.get(`auto/${rootSessionID}`);
		if (stored !== undefined && typeof stored !== "boolean") throw new Error("Invalid stored auto mode");
		return { rootSessionID, enabled: stored ?? true };
	}
	return {
		async get(sessionID) {
			return read(await resolveRootSession(sessionID, deps));
		},
		async toggle(sessionID) {
			const root = await resolveRootSession(sessionID, deps);
			const update = (pending.get(root) ?? Promise.resolve()).catch(() => {}).then(async () => {
				const state = await read(root);
				state.enabled = !state.enabled;
				await deps.storage.set(`auto/${root}`, state.enabled);
				return state;
			});
			pending.set(root, update);
			try {
				return await update;
			} finally {
				if (pending.get(root) === update) pending.delete(root);
			}
		},
	};
}
