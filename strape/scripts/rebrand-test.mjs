#!/usr/bin/env node
/**
 * Rebrand + self-update regression test (hunks 3 and 10).
 *
 * Why this exists as a *runtime* test and not only as verify-overlay assertions: every rebrand gap strape has
 * ever found was found by a person running the binary and reading the output — hunks 3, 10 and 11 (now merged
 * into hunk 3) were each discovered that way, one per session, because the `piConfig` seam
 * (config.ts:487-496) only reaches strings upstream wrote as `${APP_NAME}`/`${APP_TITLE}`. A grep over source
 * cannot tell you what a user actually sees. This runs the built CLI and reads its output the same way.
 *
 * verify-overlay.mjs asserts the source literals; this asserts the observable result. Both, deliberately:
 * the static check survives `dist/` being stale, the runtime check survives upstream adding a new string.
 *
 * Requires a build first (npm run build:offline). No network, no LLM call, no API key.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const cli = join(repoRoot, "packages/coding-agent/dist/cli.js");

if (!existsSync(cli)) {
	console.error(`Cannot find ${cli}`);
	console.error("Build first: npm run build:offline");
	process.exit(1);
}

const results = [];
const pass = (name, detail) => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });

const agentDir = mkdtempSync(join(tmpdir(), "strape-rebrand-"));

/**
 * Run the built CLI with strape's own posture. `env` entries set to `null` are *removed*, which matters for
 * PI_OFFLINE: it is the only honest way to prove a guard is doing the work rather than the offline flag.
 */
const run = (args, env = {}) => {
	const childEnv = {
		...process.env,
		STRAPE_CODING_AGENT_DIR: agentDir,
		PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1",
		NO_COLOR: "1",
		...env,
	};
	for (const [k, v] of Object.entries(env)) if (v === null) delete childEnv[k];
	const r = spawnSync(process.execPath, [cli, ...args], {
		encoding: "utf-8",
		env: childEnv,
		timeout: 60_000,
	});
	return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status };
};

/**
 * Upstream identity in output a user reads. `PI_*` env var names and pi.dev URLs are deliberately NOT
 * rebranded (hunk 1: they are hardcoded strings the launcher sets and users never type, and the URLs are
 * upstream's real endpoints), so they are excluded rather than allowed to mask a real gap.
 */
const ALLOWED = [
	/\bPI_[A-Z_]+\b/g, // literal env var names — deliberately upstream's
	/https:\/\/pi\.dev\S*/g, // upstream's real endpoints
	/@earendil-works\/pi-\S+/g, // the npm scope — deliberately not renamed
	/strape\/scripts\/sync\.mjs/g, // our own path, contains no pi token but keep the list explicit
];
const upstreamIdentityIn = (text) => {
	let scrubbed = text;
	for (const re of ALLOWED) scrubbed = scrubbed.replace(re, "");
	return [...scrubbed.matchAll(/\bpi\b|\bPi\b|π/g)].map((m) => m[0]);
};

/* 1-3. User-facing help surfaces must not name upstream. These are the exact surfaces that leaked before:
       `auth` usage was hunk 10, the interactive hint was hunk 11, the update help was found by this sweep. */
for (const [name, args] of [
	["top-level --help", ["--help"]],
	["update --help", ["update", "--help"]],
	["auth usage", ["auth"]],
]) {
	const { out } = run(args);
	const hits = upstreamIdentityIn(out);
	if (hits.length) fail(`${name} is rebranded`, `still says: ${[...new Set(hits)].join(", ")}`);
	else pass(`${name} is rebranded`, `${out.split("\n").length} lines clean`);
}

/* 4. The system prompt is the one identity string that changes behaviour rather than cosmetics: it is what
      the model is told it is. Read from dist so a stale build cannot pass. */
{
	const { buildSystemPrompt } = await import(`file://${join(repoRoot, "packages/coding-agent/dist/core/system-prompt.js")}`);
	const prompt = buildSystemPrompt({ tools: [], cwd: repoRoot });
	const hits = upstreamIdentityIn(prompt);
	if (hits.length) fail("system prompt names strape only", `model is told: ${[...new Set(hits)].join(", ")}`);
	else if (!prompt.includes("inside strape,")) fail("system prompt names strape only", "'inside strape,' missing");
	else pass("system prompt names strape only", "behavioural — no upstream name reaches the model");
}

/* 5. Hunk 10: self-update must refuse. Run it with PI_OFFLINE *removed*, so a pass proves the code guard is
      the control and not the launcher's offline posture — the whole point of making it a hunk. */
{
	const { out, code } = run(["update", "--self"], { PI_OFFLINE: null, PI_SKIP_VERSION_CHECK: null });
	const refused = /does not self-update/.test(out);
	const reachedNetwork = /Could not determine latest/.test(out);
	if (!refused) fail("self-update refuses on a fork", `no refusal in output: ${out.trim().slice(0, 200)}`);
	else if (reachedNetwork) fail("self-update refuses on a fork", "it still contacted pi.dev before refusing");
	else if (code !== 0) fail("self-update refuses on a fork", `refused but exited ${code}; should be a clean no-op`);
	else pass("self-update refuses on a fork", "refused with PI_OFFLINE unset — the guard, not the launcher");
}

/* 6. …and `update --all`, which also includes self, must refuse the self half rather than silently skipping. */
{
	const { out } = run(["update", "--all"], { PI_OFFLINE: null, PI_SKIP_VERSION_CHECK: null });
	if (!/does not self-update/.test(out)) {
		fail("update --all refuses the self half", `no refusal in output: ${out.trim().slice(0, 200)}`);
	} else pass("update --all refuses the self half", "covered by the same guard");
}

rmSync(agentDir, { recursive: true, force: true });

console.log("strape rebrand + self-update regression\n");
for (const r of results) {
	console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.error(`\n${failed.length} of ${results.length} failed. See strape/docs/HUNKS.md hunks 3 and 10.`);
	process.exit(1);
}
console.log(`\nAll ${results.length} assertions hold.`);
