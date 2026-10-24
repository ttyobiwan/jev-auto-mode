import { expect, test } from "bun:test";
import { createIndicator } from "./indicator.js";

test("the indicator hides when off or unavailable", async () => {
	const shown: boolean[] = [];
	let enabled = true;
	const indicator = createIndicator(async () => enabled, (value) => shown.push(value));
	await indicator.select("root");
	expect(shown.at(-1)).toBe(true);
	enabled = false;
	await indicator.refresh();
	expect(shown.at(-1)).toBe(false);
	const failed = createIndicator(async () => { throw new Error("disconnected"); }, (value) => shown.push(value));
	await failed.select("root");
	expect(shown.at(-1)).toBe(false);
});

test("late responses cannot restore a previous session's indicator", async () => {
	const first = Promise.withResolvers<boolean>();
	let shown = false;
	const indicator = createIndicator((id) => id === "first" ? first.promise : Promise.resolve(false), (value) => { shown = value; });
	const pending = indicator.select("first");
	await indicator.select("second");
	first.resolve(true);
	await pending;
	expect(shown).toBe(false);
});

test("returning to the home prompt hides the indicator without a session read", async () => {
	const reads: string[] = [];
	let shown = false;
	const indicator = createIndicator(async (id) => { reads.push(id); return true; }, (value) => { shown = value; });
	await indicator.select("root");
	expect(shown).toBe(true);
	await indicator.select(undefined);
	await indicator.refresh();
	expect(shown).toBe(false);
	expect(reads).toEqual(["root"]);
});

test("a newer refresh wins and disposal suppresses pending results", async () => {
	const first = Promise.withResolvers<boolean>();
	let reads = 0;
	let shown = false;
	const indicator = createIndicator(() => ++reads === 1 ? first.promise : Promise.resolve(false), (value) => { shown = value; });
	const pending = indicator.select("root");
	await indicator.refresh();
	first.resolve(true);
	await pending;
	expect(shown).toBe(false);
	const late = Promise.withResolvers<boolean>();
	const disposed = createIndicator(() => late.promise, (value) => { shown = value; });
	const request = disposed.select("root");
	disposed.dispose();
	late.resolve(true);
	await request;
	expect(shown).toBe(false);
});
