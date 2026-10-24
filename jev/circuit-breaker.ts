import type { Judge } from "./judge.js";

/** Consecutive abstentions that open the breaker. */
export const FAILURE_LIMIT = 3;
/** How long an open breaker abstains without asking JEV. */
export const COOLDOWN_MS = 60_000;

export interface CircuitBreakerDeps {
	log(message: string): void;
	/** Clock; defaults to Date.now. */
	now?(): number;
}

export function withCircuitBreaker(judge: Judge, deps: CircuitBreakerDeps): Judge {
	const now = deps.now ?? Date.now;
	let failures = 0;
	let openUntil = 0;
	return {
		async judge(call, context, environment) {
			if (now() < openUntil) {
				return { verdict: "abstain", reason: `JEV unavailable (circuit open until ${new Date(openUntil).toISOString()})` };
			}
			const judgment = await judge.judge(call, context, environment);
			if (judgment.verdict !== "abstain") {
				if (failures >= FAILURE_LIMIT) deps.log("jev-auto-mode: JEV answered; circuit closed");
				failures = 0;
				return judgment;
			}
			failures++;
			if (failures >= FAILURE_LIMIT) {
				openUntil = now() + COOLDOWN_MS;
				deps.log(`jev-auto-mode: ${failures} consecutive JEV failures; circuit open for ${COOLDOWN_MS / 1000} s, asks are left to the human`);
			}
			return judgment;
		},
	};
}
