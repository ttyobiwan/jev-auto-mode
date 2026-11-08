import { describe, expect, test } from "bun:test";
import { ALLOW_THRESHOLD, DENY_THRESHOLD, RELEVANCE_THRESHOLD, decide, failingCriteria, type Answers } from "./decide.js";

const SAFE: Answers = { serves_task: 0.97, destroys_data: 0.02, exposes_secrets: 0.01, transmits_project_data: 0.03, irreversible_external_effect: 0.02 };

describe("decide", () => {
	test("every criterion safe allows", () => {
		expect(decide(SAFE)).toEqual({ verdict: "allow", reason: "Auto-approved by JEV", answers: SAFE });
	});

	test("a harm criterion exactly at the allow threshold allows", () => {
		expect(decide({ ...SAFE, destroys_data: 0.35 }).verdict).toBe("allow");
		expect(1 - 0.35).toBe(ALLOW_THRESHOLD);
	});

	test("calibrated scores allow recorded directory listings and supporting guidance", () => {
		expect(decide({ ...SAFE, serves_task: 0.65, exposes_secrets: 0.17 }).verdict).toBe("allow");
		expect(decide({ ...SAFE, serves_task: 0.38, exposes_secrets: 0.04 }).verdict).toBe("allow");
	});

	test("calibrated scores allow recorded inspections and task file writes", () => {
		expect(decide({ ...SAFE, exposes_secrets: 0.21 }).verdict).toBe("allow");
		expect(decide({ ...SAFE, destroys_data: 0.3 }).verdict).toBe("allow");
		expect(decide({ ...SAFE, irreversible_external_effect: 0.31 }).verdict).toBe("allow");
	});

	test("harm and relevance immediately outside the calibrated floors ask the human", () => {
		expect(decide({ ...SAFE, exposes_secrets: 0.36 }).verdict).toBe("ask");
		expect(decide({ ...SAFE, serves_task: 0.34 }).verdict).toBe("ask");
	});

	test("relevance exactly at its own threshold allows", () => {
		expect(decide({ ...SAFE, serves_task: RELEVANCE_THRESHOLD }).verdict).toBe("allow");
	});

	test("relevance between its threshold and the harm threshold allows", () => {
		expect(decide({ ...SAFE, serves_task: 0.7 }).verdict).toBe("allow");
	});

	test("a harm criterion answered yes denies as a JEV denial naming the concern", () => {
		expect(decide({ ...SAFE, destroys_data: 0.94 })).toEqual({
			verdict: "deny",
			reason: "Denied by JEV: destroys data version control cannot restore (estimated harm: 94%; allowance: 35%)",
			answers: { ...SAFE, destroys_data: 0.94 },
		});
	});

	test("the task criterion answered no denies as a JEV denial", () => {
		expect(decide({ ...SAFE, serves_task: 0.1 }).reason).toBe("Denied by JEV: does not serve the task (estimated irrelevance: 90%; allowance: 65%)");
	});

	test("a criterion exactly at the deny threshold counts as decisive", () => {
		expect(decide({ ...SAFE, serves_task: DENY_THRESHOLD }).reason).toBe("Denied by JEV: does not serve the task (estimated irrelevance: 85%; allowance: 65%)");
	});

	test("a harm criterion between thresholds asks the human and names the concern", () => {
		expect(decide({ ...SAFE, destroys_data: 0.5 })).toEqual({
			verdict: "ask",
			reason: "JEV uncertain: destroys data version control cannot restore (estimated harm: 50%; allowance: 35%)",
			answers: { ...SAFE, destroys_data: 0.5 },
		});
	});

	test("an unauthorized external effect is a harm criterion", () => {
		expect(decide({ ...SAFE, irreversible_external_effect: 0.9 }).reason).toBe("Denied by JEV: makes an unauthorized remote or system change (estimated harm: 90%; allowance: 35%)");
	});

	test("relevance below its threshold but above the deny threshold asks the human", () => {
		const judgment = decide({ ...SAFE, serves_task: 0.3 });
		expect(judgment.verdict).toBe("ask");
		expect(judgment.reason).toBe("JEV uncertain: does not serve the task (estimated irrelevance: 70%; allowance: 65%)");
	});

	test("every failing criterion is named, a decisive one makes it a JEV denial", () => {
		expect(decide({ ...SAFE, serves_task: 0.3, transmits_project_data: 0.99 }).reason).toBe(
			"Denied by JEV: does not serve the task (estimated irrelevance: 70%; allowance: 65%); sends project content off this machine (estimated harm: 99%; allowance: 35%)",
		);
	});
});

describe("failingCriteria", () => {
	test("is empty when every criterion clears its floor", () => {
		expect(failingCriteria(SAFE)).toEqual([]);
	});

	test("names each criterion below its floor with its safety, in rubric order", () => {
		expect(failingCriteria({ ...SAFE, serves_task: 0.3, exposes_secrets: 0.5 })).toEqual([
			{ id: "serves_task", safety: 0.3 },
			{ id: "exposes_secrets", safety: 0.5 },
		]);
	});
});
