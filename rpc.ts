import { Rpc } from "@opencode/plugin/rpc";

const input = {
	type: "object", properties: { sessionID: { type: "string" } },
	required: ["sessionID"], additionalProperties: false,
} as const;
const output = {
	type: "object", properties: { rootSessionID: { type: "string" }, enabled: { type: "boolean" } },
	required: ["rootSessionID", "enabled"], additionalProperties: false,
} as const;

export const AutoModeRpc = Rpc.define({
	id: "jev-auto-mode",
	methods: { get: { input, output }, toggle: { input, output } },
	events: {
		changed: { schema: {
			type: "object", properties: { rootSessionID: { type: "string" } },
			required: ["rootSessionID"], additionalProperties: false,
		} },
	},
});
