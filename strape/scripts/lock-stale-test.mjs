#!/usr/bin/env node
/**
 * Regression test for hunk 16: a lock must not be stolen from a holder that is merely slow.
 *
 * WHAT WAS WRONG
 * proper-lockfile reclaims a lock purely on AGE — `stale`, default 10s (lib/lockfile.js:52). It is not
 * PID- or ownership-based: if the process holding the lock stalls past that window (slow disk, GC pause,
 * SIGSTOP, laptop suspend, a debugger breakpoint), a second local writer takes the lock over while the first
 * still believes it holds one. Only the ORIGINAL holder learns of it, through the `onCompromised` callback;
 * the new acquirer proceeds normally and neither writer knows it is racing. Found by the dependency review of
 * proper-lockfile (dep-review-v0.84.0.md).
 *
 * strape locks `auth.json`, `trust.json` and `settings.json` with this. Two concurrent writers to the trust
 * store is a security-relevant outcome, not a cosmetic one.
 *
 * WHY 30s AND NOT "FOREVER"
 * A lock that is never reclaimable turns any crash into a permanently wedged config directory, so the value
 * has to be a window, not an absence. 30s is what auth-storage's async path already chose deliberately
 * (`stale: 30_000` with an `onCompromised` handler); this hunk brings the three synchronous call sites in
 * line rather than inventing a fourth number. The surrounding retry loops still give up after ~200ms, so
 * `stale` governs only when an EXISTING lock is judged abandoned.
 *
 * HOW IT IS TESTED
 * By ageing a real lock rather than waiting. A lock aged 15s is stale under the old 10s default and fresh
 * under 30s, so the two behaviours are distinguishable in milliseconds. Both directions are asserted: a
 * lock that is merely slow must NOT be stolen, and a genuinely abandoned one must still be reclaimable —
 * otherwise the fix would just be "locking is now impossible", which would also pass a fail-closed test.
 *
 * Requires a build (npm run build:offline). Writes only to a temp dir.
 */

import { mkdtempSync, mkdirSync, rmSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const distTrust = join(repoRoot, "packages/coding-agent/dist/core/trust-manager.js");

const results = [];
const check = (name, ok, detail) => results.push({ ok, name, detail });

const root = mkdtempSync(join(tmpdir(), "strape-lock-stale-"));
const agentDir = join(root, "agent");
const projectDir = join(root, "project");
mkdirSync(agentDir, { recursive: true });
mkdirSync(projectDir, { recursive: true });
process.env.STRAPE_CODING_AGENT_DIR = agentDir;

/** proper-lockfile judges staleness from the lock directory's mtime. */
const lockPath = join(agentDir, "trust.json.lock");
const ageLockBy = (seconds) => {
	if (!existsSync(lockPath)) mkdirSync(lockPath, { recursive: true });
	const when = new Date(Date.now() - seconds * 1000);
	utimesSync(lockPath, when, when);
};
const clearLock = () => rmSync(lockPath, { recursive: true, force: true });

const tryWrite = (store) => {
	try {
		store.set(projectDir, true);
		return { ok: true };
	} catch (e) {
		return { ok: false, code: e?.code ?? "", message: String(e?.message ?? e) };
	}
};

try {
	const { ProjectTrustStore } = await import(`file://${distTrust}`);
	const store = new ProjectTrustStore(agentDir);

	// 1. The control: a holder that is slow, not dead. 15s is past the old 10s default and inside 30s.
	ageLockBy(15);
	const slow = tryWrite(store);
	check(
		"a 15s-old lock is NOT stolen (it would be at the 10s default)",
		slow.ok === false && slow.code === "ELOCKED",
		slow.ok ? "STOLEN — the write went through while another holder had the lock" : `refused with ${slow.code}`,
	);

	// 2. Stand-aside: a genuinely abandoned lock must still be reclaimable, or a crash wedges the config dir.
	clearLock();
	ageLockBy(45);
	const abandoned = tryWrite(store);
	check(
		"a 45s-old lock IS reclaimed, so a crash does not wedge the store",
		abandoned.ok === true,
		abandoned.ok ? "reclaimed and written" : `still refused: ${abandoned.code} ${abandoned.message.slice(0, 60)}`,
	);

	// 3. Stand-aside: with no lock at all, ordinary writes work.
	clearLock();
	const plain = tryWrite(store);
	check("an uncontended write succeeds", plain.ok === true, plain.ok ? "written" : `refused: ${plain.code}`);

	// 4. The other two call sites are not driven end-to-end here; verify-overlay asserts all three literals.
	//    Recorded so the coverage boundary is explicit rather than assumed.
	check(
		"coverage note: settings-manager and auth-storage are covered by the invariant, not by this test",
		true,
		"behavioural coverage is the trust store; the other two are source-asserted",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("strape lock stale window (hunk 16)\n");
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.error(`\n${failed.length} assertion(s) failed: a slow lock holder can still have its lock stolen.`);
	process.exit(1);
}
console.log(`\nAll ${results.length} assertions hold.`);
