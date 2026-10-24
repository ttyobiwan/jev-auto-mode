import type { CommandDefinition } from "@opencode/plugin/promise/command";
import type { AutoMode } from "./mode.js";

export function createAutoCommand(deps: {
	toggle(sessionID: string): Promise<AutoMode>;
	notify(sessionID: string, text: string): Promise<void>;
}): CommandDefinition {
	return {
		name: "auto",
		description: "Toggle auto mode",
		async execute({ sessionID, prompt }) {
			if (prompt.text.trim()) {
				await deps.notify(sessionID, "Usage: /auto");
				return;
			}
			const { enabled } = await deps.toggle(sessionID);
			await deps.notify(sessionID, `auto mode ${enabled ? "on" : "off"}`);
		},
	};
}
