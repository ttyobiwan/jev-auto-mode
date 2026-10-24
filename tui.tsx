import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { createIndicator } from "./indicator.js";
import type { AutoMode } from "./mode.js";
import { AutoModeRpc } from "./rpc.js";

export default Plugin.define({
	id: "jev-auto-mode",
	setup(context) {
		const rpc = context.client.rpc(AutoModeRpc);
		const location = (sessionID: string) => context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default();
		context.keymap.layer(() => ({
			commands: [{
				id: "jev-auto-mode.auto", title: "auto", description: "Toggle auto mode", palette: true, bind: "shift+tab",
				enabled: () => context.ui.router.current().type === "session",
				async run() {
					const route = context.ui.router.current();
					if (route.type !== "session") return;
					try {
						await rpc.toggle({ sessionID: route.sessionID }, { location: location(route.sessionID) });
					} catch (error) {
						context.ui.toast.show({ message: `Could not toggle auto mode: ${String(error)}`, variant: "error" });
					}
				},
			}],
		}));
		return context.ui.slot({
			append: "prompt.footer.status",
			render(props) {
				const [enabled, setEnabled] = createSignal(false);
				const indicator = createIndicator(async (sessionID) => {
					const state = await rpc.get({ sessionID }, { location: location(sessionID) }) as AutoMode;
					return state.enabled;
				}, setEnabled);
				const unsubscribe = rpc.events.on("changed", (event) => {
					const { rootSessionID } = event.data as { rootSessionID: string };
					if (props.sessionID && rootSessionID === context.data.session.root(props.sessionID)) void indicator.refresh();
				});
				const reconnect = context.data.on("server.connected", () => { void indicator.refresh(); });
				createEffect(() => { void indicator.select(props.sessionID); });
				onCleanup(() => { indicator.dispose(); unsubscribe(); reconnect(); });
				return <Show when={enabled()}><text fg={context.theme.text.muted}>auto mode on</text></Show>;
			},
		});
	},
});
