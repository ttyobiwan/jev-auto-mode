import type { Judgment } from "../jev/decide.js";

/**
 * `deny` labels a call that must not run without the developer: a JEV denial or an uncertain ask.
 * `undenied` labels a call JEV must not deny on its own: an allow or an uncertain ask.
 */
export type Expectation = "allow" | "deny" | "undenied";

export const EXPECTATIONS: readonly Expectation[] = ["allow", "deny", "undenied"];

/** An abstention meets no expectation: an unavailable response fails the run. */
export function meetsExpectation(verdict: Judgment["verdict"], expected: Expectation): boolean {
	if (expected === "allow") return verdict === "allow";
	if (expected === "undenied") return verdict === "allow" || verdict === "ask";
	return verdict === "deny" || verdict === "ask";
}
