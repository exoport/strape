#!/usr/bin/env node
/**
 * Validate strape's hand-rolled SBOM generator against Syft (Anchore).
 *
 * WHY THIS EXISTS
 * `sbom.mjs` is deliberately dependency-free — a supply-chain tool should not enlarge the supply chain it
 * measures — but that means it is bespoke, security-critical code with no second opinion. This is the second
 * opinion: an independent, widely-used SBOM generator over the same tree.
 *
 * WHAT IS ASSERTED, and what deliberately is not:
 *   ASSERTED  — every component strape reports must also appear in Syft's output. A component we invent, or
 *               a version we get wrong, is a bug in our generator and fails this check.
 *   NOT ASSERTED — set equality. Syft scanning a directory walks example-extension and dev-only
 *               `node_modules` trees; strape's SBOM describes only the SHIPPED closure from the generated
 *               shrinkwrap. Syft finding more is correct behaviour for a different question, so the extras are
 *               reported for a human to eyeball, not gated on.
 *
 * Usage:
 *   node strape/scripts/fetch-tool.mjs syft          # once, hash-verified
 *   node strape/scripts/sbom-crosscheck.mjs
 */

import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const syft = join(repoRoot, "strape/tools/syft");
const pin = existsSync(join(repoRoot, "strape/audit/UPSTREAM_PIN"))
	? readFileSync(join(repoRoot, "strape/audit/UPSTREAM_PIN"), "utf-8").trim().split(/\s+/)[0]
	: "unpinned";
const minePath = join(repoRoot, `strape/audit/sbom-${pin}.json`);

if (!existsSync(syft)) {
	console.error(`Syft not present. Fetch it first: node strape/scripts/fetch-tool.mjs syft`);
	process.exit(1);
}
if (!existsSync(minePath)) {
	console.error(`Missing ${minePath}. Generate it: node strape/scripts/sbom.mjs`);
	process.exit(1);
}
// Never trust a tool we did not verify, even one we fetched ourselves.
execFileSync(process.execPath, [join(repoRoot, "strape/scripts/fetch-tool.mjs"), "--verify"], { stdio: "inherit" });

const tmp = mkdtempSync(join(tmpdir(), "strape-syft-"));
const out = join(tmp, "syft.cdx.json");
try {
	execFileSync(syft, ["scan", `dir:${join(repoRoot, "packages/coding-agent")}`, "-q", "--output", `cyclonedx-json=${out}`], {
		stdio: ["ignore", "pipe", "inherit"],
		maxBuffer: 128 * 1024 * 1024,
	});

	const id = (c) => `${c.name}@${c.version}`;
	const syftSet = new Set(
		(JSON.parse(readFileSync(out, "utf-8")).components ?? [])
			.filter((c) => (c.purl ?? "").startsWith("pkg:npm"))
			.map(id),
	);
	const mine = JSON.parse(readFileSync(minePath, "utf-8"));
	const mineComponents = mine.components ?? [];

	const missing = mineComponents.map(id).filter((x) => !syftSet.has(x));
	const extra = [...syftSet].filter((x) => !mineComponents.some((c) => id(c) === x)).sort();

	console.log(`SBOM cross-check (pin ${pin})\n`);
	console.log(`  strape SBOM (shipped closure) : ${mineComponents.length} components`);
	console.log(`  syft (directory scan)          : ${syftSet.size} npm components`);
	console.log(`  components strape reports that syft does not find: ${missing.length}`);

	// Integrity coverage is the other thing worth validating about our own generator.
	const noHash = mineComponents.filter((c) => !c.hashes?.length).map(id);
	console.log(`  components with no integrity hash in strape SBOM : ${noHash.length}${noHash.length ? ` (${noHash.join(", ")})` : ""}`);

	if (extra.length) {
		console.log(`\n  syft additionally found ${extra.length} component(s) outside the shipped closure.`);
		console.log("  Expected: syft walks example-extension and dev-only node_modules. Eyeball for surprises:");
		for (const e of extra.slice(0, 40)) console.log(`    ${e}`);
		if (extra.length > 40) console.log(`    … and ${extra.length - 40} more`);
	}

	if (missing.length) {
		console.error(`\nFAILED: strape's SBOM lists ${missing.length} component(s) syft cannot find:`);
		for (const m of missing) console.error(`  ${m}`);
		console.error("\nThat is a bug in strape/scripts/sbom.mjs (a phantom component or a wrong version), not a syft issue.");
		process.exit(1);
	}
	console.log("\nEvery component in strape's SBOM is corroborated by syft.");
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
