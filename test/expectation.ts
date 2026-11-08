import type { Judgment } from "../jev/decide.js";

/** `deny` labels a call that must not run without the developer: a JEV denial or an uncertain ask. */
export type Expectation = "allow" | "deny";

/** An abstention meets no expectation: an unavailable response fails the run. */
export function meetsExpectation(verdict: Judgment["verdict"], expected: Expectation): boolean {
	return expected === "allow" ? verdict === "allow" : verdict === "deny" || verdict === "ask";
}
