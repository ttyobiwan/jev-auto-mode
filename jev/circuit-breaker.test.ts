import { describe, expect, test } from "bun:test";
import { COOLDOWN_MS, FAILURE_LIMIT, withCircuitBreaker } from "./circuit-breaker.js";
import type { Judgment } from "./decide.js";
import type { Judge, PendingCall } from "./judge.js";

const CALL: PendingCall = { action: "shell", resources: ["ls"] };
const CONTEXT = { requests: ["list files"], recentCalls: [] };
const ABSTAIN: Judgment = { verdict: "abstain", reason: "JEV unavailable (503)" };
const ALLOW: Judgment = { verdict: "allow", reason: "Auto-approved by JEV" };

function harness(outcomes: Judgment[]) {
	let clock = 0;
	const logs: string[] = [];
	let calls = 0;
	const inner: Judge = {
		judge: async () => outcomes[Math.min(calls++, outcomes.length - 1)],
	};
	const judge = withCircuitBreaker(inner, { log: (message) => logs.push(message), now: () => clock });
	return {
		judge: () => judge.judge(CALL, CONTEXT),
		advance: (ms: number) => {
			clock += ms;
		},
		calls: () => calls,
		logs,
	};
}

describe("withCircuitBreaker", () => {
	test("passes judgments through while JEV answers", async () => {
		const h = harness([ALLOW]);
		expect(await h.judge()).toEqual(ALLOW);
		expect(h.calls()).toBe(1);
	});

	test("opens after consecutive abstentions and abstains without asking JEV", async () => {
		const h = harness([ABSTAIN]);
		for (let attempt = 0; attempt < FAILURE_LIMIT; attempt++) await h.judge();
		expect(h.logs.length).toBe(1);
		const judgment = await h.judge();
		expect(judgment.verdict).toBe("abstain");
		expect(judgment.reason).toContain("circuit open until");
		expect(h.calls()).toBe(FAILURE_LIMIT);
	});

	test("an answered judgment resets the count", async () => {
		const h = harness([ABSTAIN, ABSTAIN, ALLOW, ABSTAIN, ABSTAIN, ALLOW]);
		for (let attempt = 0; attempt < 6; attempt++) await h.judge();
		expect(h.calls()).toBe(6);
		expect(h.logs).toEqual([]);
	});

	test("after the cooldown one probe is sent; an answer closes the breaker", async () => {
		const h = harness([ABSTAIN, ABSTAIN, ABSTAIN, ALLOW]);
		for (let attempt = 0; attempt < FAILURE_LIMIT; attempt++) await h.judge();
		h.advance(COOLDOWN_MS);
		expect(await h.judge()).toEqual(ALLOW);
		expect(h.logs.at(-1)).toBe("jev-auto-mode: JEV answered; circuit closed");
		expect(await h.judge()).toEqual(ALLOW);
		expect(h.calls()).toBe(FAILURE_LIMIT + 2);
	});

	test("a failed probe reopens the breaker", async () => {
		const h = harness([ABSTAIN]);
		for (let attempt = 0; attempt < FAILURE_LIMIT; attempt++) await h.judge();
		h.advance(COOLDOWN_MS);
		await h.judge();
		expect(h.calls()).toBe(FAILURE_LIMIT + 1);
		await h.judge();
		expect(h.calls()).toBe(FAILURE_LIMIT + 1);
	});
});
