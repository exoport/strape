#!/usr/bin/env node
/**
 * Extract and pin npm provenance: which repo, commit and workflow actually built each tarball.
 *
 * WHY THIS EXISTS — this is gap 4 from strape/research/09: nothing verified that a published tarball came from the
 * git tag it claims. `npm audit signatures` proves the registry signed it and that an attestation *exists*;
 * it does not tell you, or let you pin, **what the attestation says**. A SLSA provenance statement names the
 * source repository, the exact commit SHA, and the builder workflow — which is precisely the repo↔tarball
 * linkage a reviewer needs in order to diff a tarball against source.
 *
 * What this does:
 *   - fetches each shipped package's attestation bundle from the registry
 *   - decodes the SLSA provenance predicate and records repo + commit + builder
 *   - records the subject digest, and checks it matches the integrity hash in our own shrinkwrap
 *   - baselines all of it so a later republish under the same version, or a change of source repo or builder,
 *     fails CI
 *
 * What this does NOT do: re-verify the Sigstore signature chain. `npm audit signatures` already does that in
 * CI, and duplicating crypto verification here would be a second implementation to get wrong. Run both.
 *
 * Usage:
 *   node strape/scripts/provenance.mjs                    # report
 *   node strape/scripts/provenance.mjs --json <out>        # write baseline
 *   node strape/scripts/provenance.mjs --check <baseline>  # fail on repo/commit/builder/digest change
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const shrinkwrapPath = join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json");

const args = process.argv.slice(2);
const flag = (n) => {
	const i = args.indexOf(n);
	return i === -1 ? null : args[i + 1];
};
const jsonOut = flag("--json");
const checkPath = flag("--check");

const sw = JSON.parse(readFileSync(shrinkwrapPath, "utf-8"));
const pkgs = [];
for (const [path, meta] of Object.entries(sw.packages || {})) {
	if (!path.startsWith("node_modules/")) continue;
	const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
	if (name.startsWith("@earendil-works/pi-")) continue;
	pkgs.push({ name, version: meta.version, integrity: meta.integrity ?? null });
}
pkgs.sort((a, b) => a.name.localeCompare(b.name));

/** npm integrity is base64 sha512; SLSA subject digests are hex. Normalise to compare. */
const integrityToHex = (integrity) => {
	const m = /^sha512-(.+)$/.exec(integrity ?? "");
	return m ? Buffer.from(m[1], "base64").toString("hex") : null;
};

const rows = [];
for (const p of pkgs) {
	const url = `https://registry.npmjs.org/-/npm/v1/attestations/${p.name}@${p.version}`;
	let body = null;
	try {
		const res = await fetch(url, { headers: { "User-Agent": "strape-provenance" } });
		if (res.status === 404) {
			rows.push({ ...p, provenance: false, note: "no attestations published" });
			continue;
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		body = await res.json();
	} catch (e) {
		rows.push({ ...p, provenance: null, note: `lookup error: ${String(e.message ?? e)}` });
		continue;
	}

	const slsa = (body.attestations ?? []).find((a) => String(a.predicateType).includes("slsa.dev/provenance"));
	if (!slsa?.bundle?.dsseEnvelope?.payload) {
		rows.push({ ...p, provenance: false, note: "attestations present but no SLSA provenance predicate" });
		continue;
	}

	let stmt;
	try {
		stmt = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, "base64").toString("utf-8"));
	} catch (e) {
		rows.push({ ...p, provenance: null, note: `undecodable payload: ${String(e.message ?? e)}` });
		continue;
	}

	const subject = (stmt.subject ?? [])[0] ?? {};
	const pred = stmt.predicate ?? {};
	const dep = pred.buildDefinition?.resolvedDependencies?.[0] ?? {};
	const sourceUri = dep.uri ?? pred.buildDefinition?.externalParameters?.workflow?.repository ?? null;
	const row = {
		...p,
		provenance: true,
		sourceRepo: (sourceUri ?? "").replace(/^git\+/, "").replace(/\.git$/, "") || null,
		commit: dep.digest?.gitCommit ?? null,
		builderId: pred.runDetails?.builder?.id ?? null,
		workflow: pred.buildDefinition?.externalParameters?.workflow?.path ?? null,
		subjectSha512: subject.digest?.sha512 ?? null,
		note: "",
	};

	// The attestation's subject digest must be the tarball our shrinkwrap pins. If it is not, the attestation
	// describes a different artifact than the one we install, which is exactly the mismatch worth catching.
	const ours = integrityToHex(p.integrity);
	if (row.subjectSha512 && ours) {
		row.digestMatchesShrinkwrap = row.subjectSha512.toLowerCase() === ours.toLowerCase();
		if (!row.digestMatchesShrinkwrap) row.note = "ATTESTATION SUBJECT DIGEST != shrinkwrap integrity";
	} else {
		row.digestMatchesShrinkwrap = null;
	}
	rows.push(row);
}

const withProv = rows.filter((r) => r.provenance === true);
const mismatches = rows.filter((r) => r.digestMatchesShrinkwrap === false);
const errors = rows.filter((r) => r.provenance === null);

if (jsonOut) {
	writeFileSync(jsonOut, `${JSON.stringify({ source: "registry.npmjs.org attestations", packages: rows }, null, "\t")}\n`);
	console.log(`Wrote ${jsonOut}`);
}

if (checkPath) {
	if (!existsSync(checkPath)) {
		console.error(`Missing baseline ${checkPath}. Create it with --json.`);
		process.exit(1);
	}
	const base = JSON.parse(readFileSync(checkPath, "utf-8"));
	const bm = new Map((base.packages ?? []).map((r) => [`${r.name}@${r.version}`, r]));
	const problems = [];
	for (const r of rows) {
		const b = bm.get(`${r.name}@${r.version}`);
		if (!b) {
			problems.push(`${r.name}@${r.version}: not in baseline — review its provenance before allowing`);
			continue;
		}
		for (const field of ["sourceRepo", "commit", "builderId", "subjectSha512"]) {
			if (b[field] && r[field] && b[field] !== r[field]) {
				problems.push(`${r.name}@${r.version}: ${field} changed\n      was ${b[field]}\n      now ${r[field]}`);
			}
		}
		if (b.provenance === true && r.provenance === false) {
			problems.push(`${r.name}@${r.version}: provenance attestation disappeared`);
		}
		if (r.digestMatchesShrinkwrap === false) {
			problems.push(`${r.name}@${r.version}: attestation subject digest does not match our pinned integrity`);
		}
	}
	console.log(`provenance check: ${rows.length} packages against ${checkPath}`);
	if (problems.length) {
		console.error(`\n${problems.length} problem(s):`);
		for (const p of problems) console.error(`  ${p}`);
		console.error("\nA changed source repo, commit or builder for the SAME version means the package was republished.");
		process.exit(1);
	}
	console.log("Provenance unchanged.");
	process.exit(0);
}

if (!jsonOut) {
	console.log(`npm provenance for ${rows.length} shipped packages\n`);
	console.log(`  with SLSA provenance : ${withProv.length}`);
	console.log(`  without              : ${rows.filter((r) => r.provenance === false).length}`);
	console.log(`  digest verified vs shrinkwrap : ${rows.filter((r) => r.digestMatchesShrinkwrap === true).length}`);
	if (mismatches.length) {
		console.log(`\n  DIGEST MISMATCHES (${mismatches.length}) — investigate before building:`);
		for (const m of mismatches) console.log(`    ${m.name}@${m.version}`);
	}
	if (errors.length) console.log(`\n  ${errors.length} lookup error(s) — not a clean result: ${errors.map((e) => e.name).join(", ")}`);
	console.log("\n  Source repo and commit per attested package (this is the repo↔tarball linkage):");
	for (const r of withProv) {
		console.log(`    ${`${r.name}@${r.version}`.padEnd(40)} ${r.sourceRepo ?? "?"}@${(r.commit ?? "?").slice(0, 12)}`);
	}
	console.log("\n  Cryptographic verification of these bundles is `npm audit signatures --omit=dev`. Run both.");
}
