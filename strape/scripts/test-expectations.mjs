#!/usr/bin/env node
/**
 * Expected-test-failure gate.
 *
 * WHY THIS EXISTS
 * strape deliberately changes upstream behaviour, and upstream's tests pin the old behaviour. Two examples:
 *   - hunk 1 renames the config dir to `.strape`, but ~40 tests hardcode `.pi`
 *     (e.g. package-manager.test.ts:162 `join(tempDir, ".pi", "extensions")`)
 *   - hunk 9 adds `--ignore-scripts`, and 9 tests assert the exact npm argv
 * So a green suite is impossible without either editing upstream test files (divergence in files that churn
 * constantly) or reverting the fork's whole point. The alternative used here: record the exact expected
 * failure set and fail CI on any DEVIATION from it, in either direction.
 *
 * This is stronger than "ignore the failures":
 *   - a NEW failure fails the build — a real regression cannot hide in the noise
 *   - an expected failure that starts PASSING also fails the build — it means upstream changed the test and
 *     the entry (and possibly the hunk it justifies) must be re-examined
 *
 * Usage:
 *   ./test.sh > /tmp/suite.log 2>&1 || true
 *   node strape/scripts/test-expectations.mjs --log /tmp/suite.log            # gate
 *   node strape/scripts/test-expectations.mjs --log /tmp/suite.log --record   # write the baseline
 *
 * HOW TO RUN THE SUITE SO THE BASELINE MEANS ANYTHING
 * Two environment requirements, both learned the hard way:
 *   1. On a Volta-managed machine the real node must come first in PATH — test.sh runs under an isolated
 *      HOME (test.sh:43) and Volta's shim resolves its toolchain from $HOME.
 *   2. The harness's own pinned rg/fd must be reachable. That same isolated HOME hides <agentDir>/bin, so
 *      getToolPath() falls through to system PATH (utils/tools-manager.ts:96-98). The baseline is recorded
 *      WITH them present, because that is what a real strape install has — and because the alternative is
 *      silently testing against whatever unpinned rg the host distro happens to ship, or against nothing.
 *
 *   node strape/scripts/provision-tools.mjs     # once: pinned, sha256-verified rg/fd
 *   PATH="$(dirname "$(readlink -f "$(volta which node)")"):$HOME/.strape/agent/bin:$PATH" ./test.sh \
 *     > /tmp/suite.log 2>&1
 *
 * Recorded without them, 10 find-tool tests and 3 grep-tool tests enter the baseline as though they were
 * strape divergence. They are not: they are a missing binary.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const baselinePath = join(repoRoot, "strape/audit/expected-test-failures.json");

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i === -1 ? null : args[i + 1];
};
const record = args.includes("--record");
const logPath = flag("--log");

if (!logPath || !existsSync(logPath)) {
	console.error("Usage: test-expectations.mjs --log <suite output> [--record]");
	console.error("Produce the log with: ./test.sh > /tmp/suite.log 2>&1 || true");
	process.exit(2);
}

/** vitest prints ` FAIL  <file> > <suite> > <test>`; strip ANSI and dedupe. */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const raw = stripAnsi(readFileSync(logPath, "utf-8"));
const failing = [
	...new Set(
		raw
			.split("\n")
			.map((l) => l.match(/^\s*FAIL\s+(test\/.+?)\s*$/))
			.filter(Boolean)
			.map((m) => m[1].replace(/\s+\d+ms$/, "").trim()),
	),
].sort();

/** Sanity: refuse to gate against a log that clearly is not a completed suite run. */
if (!/Test Files\s+\d+/.test(raw)) {
	console.error(`${logPath} does not look like a completed vitest run (no "Test Files" summary).`);
	console.error("Refusing to compare — a truncated log would silently 'pass'.");
	process.exit(2);
}

if (record) {
	const existing = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf-8")) : { tests: {} };
	const out = {
		$comment:
			"Tests that fail BY DESIGN because strape changes upstream behaviour. Any deviation from this exact " +
			"set fails CI: a new failure is a regression, and an expected failure that starts passing means " +
			"upstream changed the test and this entry needs re-examining. Never add an entry without a reason.",
		// Carried, not regenerated: these are human judgements about the host, not observations of this run.
		// Rebuilding the file without them would silently drop the list and re-introduce the deviation.
		$environmentSensitive: existing.$environmentSensitive ?? {},
		pin: existsSync(join(repoRoot, "strape/audit/UPSTREAM_PIN"))
			? readFileSync(join(repoRoot, "strape/audit/UPSTREAM_PIN"), "utf-8").trim().split(/\s+/)[0]
			: null,
		tests: {},
	};
	const envSensitiveAtRecord = new Set(Object.keys(out.$environmentSensitive));
	for (const t of failing) {
		// Recording on a host where an environment-sensitive test happens to fail must not bake that host's
		// toolchain into the baseline — that is exactly how the machine-specific entry got in originally.
		if (envSensitiveAtRecord.has(t)) continue;
		out.tests[t] = existing.tests?.[t] ?? { reason: "UNCLASSIFIED — a human must state why this fails by design", hunk: null };
	}
	writeFileSync(baselinePath, `${JSON.stringify(out, null, "\t")}\n`);
	const unclassified = Object.values(out.tests).filter((v) => v.reason.startsWith("UNCLASSIFIED")).length;
	const skipped = failing.length - Object.keys(out.tests).length;
	console.log(`Wrote ${baselinePath} with ${Object.keys(out.tests).length} expected failures.`);
	if (skipped) console.log(`${skipped} observed failure(s) skipped as environment-sensitive (see $environmentSensitive).`);
	if (unclassified) console.log(`${unclassified} entries need a human-written reason.`);
	process.exit(0);
}

if (!existsSync(baselinePath)) {
	console.error(`Missing ${baselinePath}. Create it with --record, then classify each entry.`);
	process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
const expected = new Set(Object.keys(baseline.tests || {}));
/**
 * Tests whose outcome is decided by the HOST toolchain rather than by anything strape changed, so they
 * legitimately differ between a developer machine and a runner. They are excluded from the comparison in
 * BOTH directions — asserting either outcome would guarantee a permanently red gate on one side, and a gate
 * that is always red somewhere is a gate people learn to ignore. Each entry states its root cause; this is a
 * narrow, evidenced exemption, not a place to park failures that are merely inconvenient.
 */
const envSensitive = baseline.$environmentSensitive ?? {};
const envSensitiveNames = new Set(Object.keys(envSensitive));
const expectedStrict = [...expected].filter((t) => !envSensitiveNames.has(t));
const newFailures = failing.filter((t) => !expected.has(t) && !envSensitiveNames.has(t));
const nowPassing = expectedStrict.filter((t) => !failing.includes(t));

console.log(`strape expected-test-failure gate (pin ${baseline.pin ?? "unset"})\n`);
console.log(`  failing now      : ${failing.length}`);
console.log(`  expected to fail : ${expected.size}`);

const byReason = new Map();
for (const [, v] of Object.entries(baseline.tests || {})) {
	const key = v.hunk ? `hunk ${v.hunk}` : "unclassified";
	byReason.set(key, (byReason.get(key) ?? 0) + 1);
}
console.log(`  by cause         : ${[...byReason].map(([k, n]) => `${k}=${n}`).join(", ")}`);

// Report, never assert. Silence here would hide the fact that the gate is not covering these at all.
if (envSensitiveNames.size) {
	console.log(`\n  environment-sensitive (excluded from the comparison, both directions):`);
	for (const t of envSensitiveNames) {
		console.log(`    ${failing.includes(t) ? "failing" : "passing"} here — ${t}`);
	}
}

if (newFailures.length) {
	console.error(`\n  ${newFailures.length} NEW failure(s) — these are regressions, not expected divergence:`);
	for (const t of newFailures) console.error(`    + ${t}`);
	// The baseline assumes the harness's own pinned rg/fd are reachable, because that is what a real strape
	// install has. test.sh isolates HOME, so <agentDir>/bin is invisible during the suite and getToolPath()
	// falls through to PATH (utils/tools-manager.ts:96-98). Without them the grep/find tool tests fail and
	// read as regressions — which cost a full debugging session on 2026-08-09.
	const onPath = (bin) =>
		(process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));
	const missing = ["rg", "fd"].filter((b) => !onPath(b));
	if (missing.length && newFailures.some((t) => /grep tool|find tool|3302-find|3303-find/.test(t))) {
		console.error(`\n  HINT: ${missing.join(" and ")} not found on PATH, and the new failures are grep/find tool tests.`);
		console.error("  The baseline is recorded WITH the pinned tools reachable. Re-run the suite as:");
		console.error('    PATH="$(dirname "$(readlink -f "$(volta which node)")"):$HOME/.strape/agent/bin:$PATH" ./test.sh');
		console.error("  (install them first with: node strape/scripts/provision-tools.mjs)");
	}
}
if (nowPassing.length) {
	console.error(`\n  ${nowPassing.length} expected failure(s) now PASS — upstream likely changed the test:`);
	for (const t of nowPassing) console.error(`    - ${t}`);
	console.error("    Re-examine the entry and the hunk that justified it, then re-record.");
}

if (newFailures.length || nowPassing.length) {
	console.error(`\nGate FAILED. Re-record only after understanding each change: --record`);
	process.exit(1);
}
console.log("\nFailure set matches the reviewed baseline exactly.");
