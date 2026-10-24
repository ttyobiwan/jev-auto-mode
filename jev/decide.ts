import { CRITERION_IDS, RUBRIC, type CriterionId } from "./rubric.js";

/** Safety a harm criterion must reach to allow. */
export const ALLOW_THRESHOLD = 0.8;
/** Safety the relevance criterion must reach to allow: an off-task call wastes work, it does not cause harm. */
export const RELEVANCE_THRESHOLD = 0.35;
/** Safety at or below which a criterion is a decisive denial rather than an uncertain one. */
export const DENY_THRESHOLD = 0.15;

/** JEV's yes-probability for every rubric criterion. */
export type Answers = Record<CriterionId, number>;

export interface Judgment {
	/** `abstain`: JEV was unavailable and the ask is left to the human. */
	verdict: "allow" | "deny" | "abstain";
	reason: string;
	/** The judged answers, absent when JEV abstained. */
	answers?: Answers;
	/** The versioned JEV model that answered, absent when JEV abstained. */
	model?: string;
}

export function decide(answers: Answers): Judgment {
	const failures = failingCriteria(answers);
	if (failures.length === 0) return { verdict: "allow", reason: "Auto-approved by JEV", answers };
	const concerns = failures.map(({ id, safety }) => {
		const estimate = RUBRIC[id].kind === "harm" ? "harm" : "irrelevance";
		return `${RUBRIC[id].violation} (estimated ${estimate}: ${Math.round((1 - safety) * 100)}%; allowance: ${Math.round((1 - allowFloor(id)) * 100)}%)`;
	}).join("; ");
	if (failures.some(({ safety }) => safety <= DENY_THRESHOLD)) return { verdict: "deny", reason: `Denied by JEV: ${concerns}`, answers };
	return {
		verdict: "deny",
		reason: `Denied by auto mode: JEV uncertain: ${concerns}. Continue with a narrower or lower-risk action.`,
		answers,
	};
}

/** Every criterion below its allow floor, with its safety, in rubric order. */
export function failingCriteria(answers: Answers): Array<{ id: CriterionId; safety: number }> {
	return CRITERION_IDS.map((id) => ({ id, safety: safety(id, answers[id]) })).filter(({ id, safety }) => safety < allowFloor(id));
}

/** The probability that a criterion's answer is the safe one. */
export function safety(id: CriterionId, yes: number): number {
	return RUBRIC[id].safeAnswer === "yes" ? yes : 1 - yes;
}

function allowFloor(id: CriterionId): number {
	return RUBRIC[id].kind === "relevance" ? RELEVANCE_THRESHOLD : ALLOW_THRESHOLD;
}
