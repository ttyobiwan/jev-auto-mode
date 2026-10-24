import { jevJudgeFromEnvironment, type JudgeEnvironment, type PendingCall } from "../jev/judge.js";
import type { TaskContext } from "../jev/task-context.js";

interface ReplayCase {
	name: string;
	expected: "allow" | "deny";
	record: {
		call: PendingCall;
		context: TaskContext;
		environment: JudgeEnvironment;
		verdict?: string;
	};
}

// Replays descriptions only; never executes the recorded operations.
const path = process.argv[2];
if (!path) throw new Error("Usage: bun run test/audit-replay.eval.ts <labeled-records.json>");
const cases: ReplayCase[] = await Bun.file(path).json();
if (!Array.isArray(cases) || !cases.length) throw new Error("Supply a nonempty array of labeled audit records.");
const judge = jevJudgeFromEnvironment(process.env, { projectDirectory: "" });
if (!judge) throw new Error("Live evaluation requires TYPESAFE_API_KEY or TYPESAFE_AI_API_KEY.");

let failures = 0;
for (const { name, expected, record } of cases) {
	if (!name || !["allow", "deny"].includes(expected) || !record?.call || !record.context || !record.environment?.projectDirectory) {
		throw new Error("Each case needs name, expected (allow or deny), and record with call, context, and environment.projectDirectory.");
	}
	const result = await judge.judge(record.call, record.context, record.environment);
	const passed = result.verdict === expected;
	if (!passed) failures++;
	console.log(JSON.stringify({ name, expected, previous: record.verdict, passed, ...result }));
}
console.log(`${cases.length - failures}/${cases.length} audit replays passed`);
process.exitCode = failures ? 1 : 0;
