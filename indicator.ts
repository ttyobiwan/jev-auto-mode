export function createIndicator(read: (sessionID: string) => Promise<boolean>, show: (enabled: boolean) => void) {
	let sessionID: string | undefined;
	let revision = 0;
	async function refresh() {
		const current = ++revision;
		if (!sessionID) return;
		try {
			const enabled = await read(sessionID);
			if (current === revision) show(enabled);
		} catch {
			if (current === revision) show(false);
		}
	}
	return {
		select(id: string | undefined) {
			sessionID = id;
			show(false);
			return refresh();
		},
		refresh,
		dispose() { sessionID = undefined; revision++; },
	};
}
