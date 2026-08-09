#!/usr/bin/env node
/**
 * Triage tool for the expected-test-failure baseline.
 *
 * WHY THIS EXISTS
 * 46 of the 65 entries in `strape/audit/expected-test-failures.json` once carried `hunk: "1 (probable)"` and a
 * shared reason that admitted the truth: "NOT individually root-caused yet ... a few may be
 * environment-dependent". That was honest, and it was also a 46-entry hole in the gate everything else leans
 * on — a real regression landing in that bucket would be indistinguishable from the noise.
 *
 * The bucket lied twice. First: of the original 57, **13 were not divergence at all** — 10 were a missing `fd`
 * and 3 a missing `rg`, both artefacts of `test.sh` isolating HOME so the harness cannot see its own
 * `<agentDir>/bin`. Second, on 2026-08-11 the remaining 46 were read one by one against a real suite log, and
 * the shared label was wrong about the split: **42 are hunk 1** (in two distinct forms — a hardcoded `.pi`
 * config dir, and a hardcoded `PI_CODING_AGENT_DIR` env var that hunk 1 renames via
 * `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`, config.ts:495) and **4 are hunk 10**, the self-update refusal.
 * Zero were environment-dependent, and zero were hunk 9 — the two git-update tests that look like hunk 9
 * never reach the argv, because the checkout path moved first.
 *
 * As of that pass the bucket is EMPTY. If entries ever land in it again, this tool is how they get read.
 *
 * WHAT THE PASS TAUGHT ABOUT THIS TOOL'S SUGGESTIONS
 * They are pattern matches on the error line, and three were wrong in ways worth knowing:
 *   - `stdout-cleanliness` was suggested as hunk 3 because the OBSERVED string contains "strape - AI coding";
 *     that is the help banner the assertion captured, not the thing under test.
 *   - three `pi install` / `pi --help` literals were suggested as hunk 3 but are hunk 1: those strings are
 *     upstream's own `${APP_NAME}` templates (package-manager-cli.ts:79-89, 723), byte-identical to vendor.
 *     Hunk 3 is for literals strape EDITED. Check `git show v0.84.1:<file>` before crediting hunk 3.
 *   - one ENOENT was suggested as ENVIRONMENT but was the test's own readFileSync of `.pi/settings.json`.
 *
 * WHAT IT DOES
 * Reads a completed suite log, extracts the failure text for every failing test, normalises it into a
 * SIGNATURE, and groups. 46 investigations become a handful of groups, each of which a human names once.
 *
 * It deliberately does NOT write verdicts. It suggests a cause per group and leaves the classification to a
 * person, because the whole problem with the bucket was a cause asserted without evidence. Suggestions are
 * labelled as such.
 *
 * Usage:
 *   ./test.sh > /tmp/suite.log 2>&1 || true        # see CLAUDE.md for the PATH this needs
 *   node strape/scripts/triage-expectations.mjs --log /tmp/suite.log
 *   node strape/scripts/triage-expectations.mjs --log /tmp/suite.log --hunk "1 (probable)"   # one bucket
 *   node strape/scripts/triage-expectations.mjs --log /tmp/suite.log --group 3               # tests in group 3
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const baselinePath = join(repoRoot, "strape/audit/expected-test-failures.json");

const args = process.argv.slice(2);
const flag = (n) => {
	const i = args.indexOf(n);
	return i === -1 ? null : args[i + 1];
};
const logPath = flag("--log");
const onlyHunk = flag("--hunk");
const showGroup = flag("--group");

if (!logPath || !existsSync(logPath)) {
	console.error("Usage: triage-expectations.mjs --log <suite output> [--hunk <value>] [--group <n>]");
	process.exit(2);
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const raw = stripAnsi(readFileSync(logPath, "utf-8"));
if (!/Test Files\s+\d+/.test(raw)) {
	console.error(`${logPath} does not look like a completed vitest run. Refusing to triage a truncated log.`);
	process.exit(2);
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf-8")) : { tests: {} };

/**
 * vitest prints ` FAIL  <file> > <suite> > <test>` and then the error, ending at the `⎯⎯[n/m]⎯` separator or
 * the next FAIL. Take the block between, which is where the assertion diff lives.
 */
const lines = raw.split("\n");
const failures = [];
for (let i = 0; i < lines.length; i++) {
	const m = lines[i].match(/^\s*FAIL\s+(test\/.+?)\s*$/);
	if (!m) continue;
	const name = m[1].replace(/\s+\d+ms$/, "").trim();
	const block = [];
	for (let j = i + 1; j < Math.min(i + 30, lines.length); j++) {
		if (/^\s*FAIL\s+test\//.test(lines[j])) break;
		if (/⎯{3,}/.test(lines[j])) break;
		block.push(lines[j]);
	}
	failures.push({ name, block: block.join("\n") });
}

/**
 * Normalise a failure into something that groups. Paths, temp dirs, ports and numbers are the noise that makes
 * 46 failures look unique when they are five causes.
 */
const signature = (block) => {
	const first =
		block
			.split("\n")
			.map((l) => l.trim())
			.find((l) => /^(AssertionError|Error|TypeError|ReferenceError|Test timed out)/.test(l)) ?? "(no error line)";
	return first
		.replace(/\/tmp\/[^\s'"]+/g, "<tmp>")
		.replace(/\/home\/[^\s'"]+/g, "<path>")
		.replace(/\b\d{4,}\b/g, "<n>")
		.replace(/\s+/g, " ")
		.slice(0, 150);
};

/**
 * Suggestions only — a human decides. Matched against the ERROR LINE, not the whole block: a 30-line block
 * from package-command-paths.test.ts mentions "trust" in its setup regardless of why it failed, which
 * mislabelled several groups on the first pass. Ordered; first match wins.
 */
const SUGGEST = [
	[/Test timed out/, "TIMEOUT — flake or host-dependent; check it in isolation before blaming a hunk"],
	// Rebrand: the test asserts a literal "pi ..." that strape renders as "strape ...".
	[/to contain ['"][^'"]*\bpi\s+(install|update|auth|uninstall|list|--help)/, "hunk 3 — asserts a literal 'pi <cmd>' string"],
	[/['"]pi --help['"]|Use ['"]pi /, "hunk 3 — asserts a literal 'pi --help' string"],
	[/pi docs|pi documentation|inside pi|Pi documentation/, "hunk 3 — asserts a rebranded identity string"],
	[/strape - AI coding|APP_NAME|APP_TITLE/, "hunk 3 — branding surfaced through config"],
	[/\.pi\b|['"]\.pi['"]/, "hunk 1 — hardcoded .pi config dir vs strape's .strape"],
	[/ignore-scripts|--ignore-scripts/, "hunk 9 — asserts the exact npm argv strape changes"],
	[/Project is not trusted|projectTrusted/, "hunk 7/11 — project-trust boundary"],
	[/ENOENT|command not found|spawnSync|Cannot find module/, "ENVIRONMENT? — missing file/binary; confirm it is not a hunk side effect"],
	[/ripgrep|fdfind/, "ENVIRONMENT — external tool availability"],
];
const suggest = (sig, block) =>
	SUGGEST.find(([re]) => re.test(sig))?.[1] ?? SUGGEST.find(([re]) => re.test(block))?.[1] ?? "UNCLASSIFIED — read by hand";

const groups = new Map();
for (const f of failures) {
	const recorded = baseline.tests?.[f.name];
	if (onlyHunk && String(recorded?.hunk) !== onlyHunk) continue;
	// Signature includes the test FILE, not just the error line. A generic assertion like
	// "expected false to be true" is produced by five unrelated causes across five files — grouping on the
	// message alone merged them and hid that. More groups, each internally coherent, is the useful trade.
	const file = f.name.split(" > ")[0];
	const sig = `${file} | ${signature(f.block)}`;
	if (!groups.has(sig)) groups.set(sig, { sig, suggestion: suggest(sig, f.block), tests: [], sample: f.block });
	groups.get(sig).tests.push({ name: f.name, hunk: recorded?.hunk ?? "(not in baseline)" });
}

const ordered = [...groups.values()].sort((a, b) => b.tests.length - a.tests.length);

if (showGroup) {
	const g = ordered[Number(showGroup) - 1];
	if (!g) {
		console.error(`No group ${showGroup}. There are ${ordered.length}.`);
		process.exit(2);
	}
	console.log(`Group ${showGroup} — ${g.tests.length} test(s)\n`);
	console.log(`signature : ${g.sig}`);
	console.log(`suggestion: ${g.suggestion}\n`);
	console.log("tests:");
	for (const t of g.tests) console.log(`  [${t.hunk}] ${t.name}`);
	console.log("\nsample failure text:\n");
	console.log(g.sample.split("\n").slice(0, 18).join("\n"));
	process.exit(0);
}

const scope = onlyHunk ? `entries recorded as hunk "${onlyHunk}"` : "all failures in the log";
console.log(`triage: ${failures.length} failing test(s) in the log; ${ordered.reduce((n, g) => n + g.tests.length, 0)} in scope (${scope})`);
console.log(`grouped into ${ordered.length} signature(s)\n`);

let n = 0;
for (const g of ordered) {
	n++;
	console.log(`${String(n).padStart(2)}. ${String(g.tests.length).padStart(3)} test(s)  ${g.suggestion}`);
	console.log(`      sig: ${g.sig}`);
	console.log(`      e.g. ${g.tests[0].name.slice(0, 96)}`);
	if (g.tests.length > 1) console.log(`      ... and ${g.tests.length - 1} more (--group ${n} to list)`);
	console.log();
}

const unclassified = ordered.filter((g) => g.suggestion.startsWith("UNCLASSIFIED"));
console.log(`${ordered.length - unclassified.length} group(s) have a suggested cause; ${unclassified.length} need a human read.`);
console.log(`Tests needing a hand read: ${unclassified.reduce((s, g) => s + g.tests.length, 0)}`);
console.log("\nSuggestions are NOT verdicts. Confirm each group, then write a specific reason into");
console.log("strape/audit/expected-test-failures.json — that file's own rule is: never an entry without a reason.");
