#!/usr/bin/env node
/**
 * Model-catalog freeze.
 *
 * WHY THIS EXISTS
 * Hunk 6 vendors `packages/ai/src/providers/data/` (39 files, ~600K, 1219 models) so strape builds offline and
 * so model/pricing changes are a reviewable git diff instead of an invisible build-time fetch. That closed the
 * *build* hole. It left a *provenance* hole open, and the hole has a name: the vendored data is a snapshot of
 * LIVE THIRD-PARTY STATE, but nothing in the repo says which state.
 *
 * The generator (`packages/ai/scripts/generate-models.ts`) fetches https://models.dev/api.json at run time,
 * plus two live provider catalogs. So `npm run hydrate:model-data` during an upstream sync pulls models.dev
 * **as of the day you run it**, not as of the tag you are adopting. On 2026-08-09 that is exactly what
 * happened: re-hydrating while adopting v0.84.1 changed the `opencode` model shapes and broke an upstream
 * test's type assumption — a change that came from a third party's database, arrived inside a commit labelled
 * "adopt v0.84.1", and was indistinguishable from upstream's own work in the diff.
 *
 * WHAT THIS DOES
 * Pins the catalog by content and makes any movement a reviewed event rather than a silent one:
 *
 *   --record            write strape/audit/model-catalog-<pin>.json (per-file sha256 + model inventory)
 *   --check [baseline]  fail if the vendored catalog no longer matches that record
 *
 * WHY THE RECORD CARRIES A MODEL INVENTORY AND NOT JUST DIGESTS
 * "sha256 moved" is not reviewable — it is true for a typo and for a deleted provider alike. The gate that
 * gets read is the one that says *what* moved, so a drift failure prints the added/removed model ids and the
 * changed pricing/context fields. That is the unit a human can actually sign off on. The digest is what makes
 * the claim binding; the inventory is what makes it legible.
 *
 * NOT A SUBSTITUTE FOR READING THE DIFF. This gate proves the catalog did not move without someone noticing.
 * It cannot tell you whether models.dev was right. When it fails during a sync, the answer is to read the
 * model delta and re-record deliberately — never to re-record to get green.
 *
 * Dependency-free on purpose (CLAUDE.md): a supply-chain tool must not enlarge the supply chain it measures.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const dataDir = join(repoRoot, "packages/ai/src/providers/data");
const pinPath = join(repoRoot, "strape/audit/UPSTREAM_PIN");

const args = process.argv.slice(2);
const record = args.includes("--record");
const checkIndex = args.indexOf("--check");
const check = checkIndex !== -1;

if (record === check) {
	console.error("Usage: model-catalog.mjs --record | --check [baseline.json]");
	console.error("  --record            write strape/audit/model-catalog-<pin>.json");
	console.error("  --check [baseline]  fail on drift from that record (defaults to the pin-named file)");
	process.exit(2);
}

if (!existsSync(dataDir)) {
	console.error(`Missing ${dataDir}.`);
	console.error("The vendored catalog is hunk 6. Restore it with: npm run hydrate:model-data");
	console.error("But note that hydrating pulls models.dev as of TODAY — see this script's header.");
	process.exit(1);
}

const pin = existsSync(pinPath) ? readFileSync(pinPath, "utf-8").trim().split(/\s+/)[0] : null;

/**
 * The sources the generator contacts. Recorded as data rather than prose so that a future reader can diff
 * them: a new endpoint appearing here is a supply-chain change to the catalog, even though no npm package
 * moved. Line numbers are into packages/ai/scripts/generate-models.ts at the recorded pin.
 */
const SOURCES = [
	{ url: "https://models.dev/api.json", role: "the whole catalog", site: "generate-models.ts:1289" },
	{ url: "https://integrate.api.nvidia.com/v1/models", role: "NVIDIA NIM model ids", site: "generate-models.ts:973" },
	{ url: "https://ai-gateway.vercel.sh/v1/models", role: "Vercel AI Gateway catalog", site: "generate-models.ts:1057" },
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Upstream's generator writes `.manifest.json` beside the provider files: schemaVersion, generatedAt, a
 * structureHash, and a sha256 per provider file. It is a DOTFILE, which is exactly why it is easy to miss —
 * the first version of this script globbed `*.json`, silently swallowed it as a 40th provider, and inflated
 * the model count by 127 because its `files` map parsed as an api-to-model table. Excluded here by name, and
 * cross-checked below, because a manifest that disagrees with the files it describes means something wrote
 * the catalog without regenerating it.
 */
const MANIFEST_NAME = ".manifest.json";

/** Read the catalog into { files: {name: {sha256, bytes, models}}, models: Map<"provider/api/id", model> }. */
function readCatalog() {
	const names = readdirSync(dataDir)
		.filter((n) => n.endsWith(".json") && !n.startsWith("."))
		.sort();
	const files = {};
	const models = new Map();
	for (const name of names) {
		const buf = readFileSync(join(dataDir, name));
		let parsed;
		try {
			parsed = JSON.parse(buf.toString("utf-8"));
		} catch (error) {
			console.error(`${name} is not valid JSON: ${error.message}`);
			process.exit(1);
		}
		let count = 0;
		for (const [api, byId] of Object.entries(parsed)) {
			for (const [id, model] of Object.entries(byId ?? {})) {
				models.set(`${name.replace(/\.json$/, "")}/${api}/${id}`, model);
				count++;
			}
		}
		files[name] = { sha256: sha256(buf), bytes: buf.length, models: count };
	}
	// One digest over the sorted (file, sha256) pairs: the single value a review record can cite.
	const digest = sha256(Object.entries(files).map(([n, f]) => `${n} ${f.sha256}`).join("\n"));
	return { files, models, digest };
}

/**
 * Verify upstream's own manifest against the files on disk. This is the offline half of the "regenerator"
 * this script was asked for: strape cannot re-run the generator without the network, but it can prove the
 * vendored manifest still describes the vendored files. A mismatch means the catalog was edited (by hand, by
 * a merge, or by a partial hydrate) without the manifest being regenerated — which would make every later
 * `structureHash` comparison meaningless.
 */
function readManifest(files) {
	const path = join(dataDir, MANIFEST_NAME);
	if (!existsSync(path)) return { present: false, problems: [`${MANIFEST_NAME} is missing — upstream's generator writes it; the catalog may be partially hydrated.`] };
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		return { present: true, problems: [`${MANIFEST_NAME} is not valid JSON: ${error.message}`] };
	}
	const problems = [];
	const recorded = manifest.files ?? {};
	for (const [name, hash] of Object.entries(recorded)) {
		if (!files[name]) problems.push(`${MANIFEST_NAME} lists ${name}, which is not on disk`);
		else if (files[name].sha256 !== hash) problems.push(`${name}: content sha256 ${files[name].sha256.slice(0, 12)}… != ${MANIFEST_NAME}'s ${String(hash).slice(0, 12)}…`);
	}
	for (const name of Object.keys(files)) {
		if (!(name in recorded)) problems.push(`${name} is on disk but absent from ${MANIFEST_NAME}`);
	}
	return {
		present: true,
		schemaVersion: manifest.schemaVersion ?? null,
		generatedAt: manifest.generatedAt ?? null,
		structureHash: manifest.structureHash ?? null,
		problems,
	};
}

const catalog = readCatalog();
const manifest = readManifest(catalog.files);
const totalModels = [...catalog.models.keys()].length;

if (record) {
	const outPath = join(repoRoot, `strape/audit/model-catalog-${pin ?? "unpinned"}.json`);
	const out = {
		$comment:
			"Content pin for the vendored model catalog (hunk 6). The generator fetches models.dev and two " +
			"live provider catalogs at run time, so re-hydrating pulls third-party state as of the day it runs, " +
			"not as of the adopted upstream tag. This record makes that movement visible: " +
			"model-catalog.mjs --check fails on any drift, and the fix is to read the model delta and re-record " +
			"deliberately, never to re-record for green.",
		pin,
		recordedAt: new Date().toISOString().slice(0, 10),
		generator: "npm run hydrate:model-data  (packages/ai/scripts/generate-models.ts --strict --data-only)",
		sources: SOURCES,
		// Upstream's own manifest, carried so a re-hydrate is visible even if the model values happen to be
		// identical: generatedAt is the wall-clock moment models.dev was read, which is the provenance fact
		// hunk 6 otherwise loses.
		upstreamManifest: {
			schemaVersion: manifest.schemaVersion ?? null,
			generatedAt: manifest.generatedAt ?? null,
			structureHash: manifest.structureHash ?? null,
		},
		fileCount: Object.keys(catalog.files).length,
		modelCount: totalModels,
		digest: catalog.digest,
		files: catalog.files,
		models: Object.fromEntries(
			[...catalog.models.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, m]) => [
				key,
				// Only the fields worth reviewing a change to. The full model object is in git; this is the
				// summary a human reads when the gate fails.
				//
				// `baseUrl` is here for a security reason, not a bookkeeping one: it is the host strape sends
				// the API key and the whole conversation to. A models.dev entry that repointed a provider
				// would move exactly one string, add and remove no models, and change no price — so a record
				// tracking only cost/context would have reported "content moved, nothing tracked differs".
				// It was left out of the first draft and put back after a negative test surfaced precisely
				// that case. `api` is tracked with it because it selects the client, and so the wire format.
				{
					baseUrl: m.baseUrl ?? null,
					api: m.api ?? null,
					cost: m.cost ?? null,
					contextWindow: m.contextWindow ?? null,
					maxTokens: m.maxTokens ?? null,
				},
			]),
		),
	};
	// Refuse to record a catalog whose own manifest disagrees with it: that would freeze an inconsistent
	// state and make every later comparison a comparison against a lie.
	if (manifest.problems.length) {
		console.error(`Refusing to record: upstream's ${MANIFEST_NAME} does not describe the files on disk.`);
		for (const p of manifest.problems) console.error(`  ${p}`);
		console.error("\nRegenerate the catalog (npm run hydrate:model-data) or restore it from git, then re-record.");
		process.exit(1);
	}
	writeFileSync(outPath, `${JSON.stringify(out, null, "\t")}\n`);
	console.log(`Wrote ${outPath}`);
	console.log(`  pin        : ${pin ?? "unset"}`);
	console.log(`  files      : ${out.fileCount}`);
	console.log(`  models     : ${out.modelCount}`);
	console.log(`  digest     : ${out.digest}`);
	console.log(`  hydrated   : ${out.upstreamManifest.generatedAt ?? "unknown"}  (when models.dev was actually read)`);
	console.log("\nThis is a snapshot of live third-party data. Review the git diff before committing it.");
	process.exit(0);
}

const baselinePath = args[checkIndex + 1] && !args[checkIndex + 1].startsWith("--")
	? args[checkIndex + 1]
	: join(repoRoot, `strape/audit/model-catalog-${pin ?? "unpinned"}.json`);

if (!existsSync(baselinePath)) {
	console.error(`Missing baseline ${baselinePath}. Create it with: node strape/scripts/model-catalog.mjs --record`);
	process.exit(1);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));

console.log(`strape model-catalog freeze (baseline ${baselinePath.replace(`${repoRoot}/`, "")})\n`);
console.log(`  baseline pin : ${baseline.pin ?? "unset"}${pin && baseline.pin !== pin ? `  (repo pin is ${pin})` : ""}`);
console.log(`  recorded     : ${baseline.recordedAt ?? "unknown"}`);
console.log(`  files        : ${Object.keys(catalog.files).length} now / ${baseline.fileCount} recorded`);
console.log(`  models       : ${totalModels} now / ${baseline.modelCount} recorded`);
console.log(`  hydrated     : ${manifest.generatedAt ?? "unknown"} now / ${baseline.upstreamManifest?.generatedAt ?? "not recorded"} recorded`);

// Upstream's manifest disagreeing with the files is a failure in its own right, independent of drift from the
// baseline: it means the catalog was written without the manifest being regenerated, so structureHash no
// longer means anything. Report it before the digest comparison so it is not read as a consequence of drift.
if (manifest.problems.length) {
	console.error(`\n  ${MANIFEST_NAME} does not describe the files on disk:`);
	for (const p of manifest.problems) console.error(`    FAIL  ${p}`);
	console.error("\n  The vendored catalog and its own manifest are inconsistent. Restore from git or re-hydrate.");
	process.exit(1);
}

if (catalog.digest === baseline.digest) {
	console.log(`  digest       : ${catalog.digest}`);
	// Same bytes but a different generatedAt means someone re-ran the generator and models.dev happened to
	// return identical data. Worth saying out loud — it is the one case where provenance moved and content
	// did not, and it is invisible in a content-only gate.
	if (baseline.upstreamManifest?.generatedAt && manifest.generatedAt !== baseline.upstreamManifest.generatedAt) {
		console.log(`\n  NOTE: the catalog was re-hydrated (${baseline.upstreamManifest.generatedAt} -> ${manifest.generatedAt})`);
		console.log("  and models.dev returned byte-identical data. Content is unchanged; re-record to update provenance.");
	}
	console.log("\nCatalog matches the reviewed record exactly.");
	process.exit(0);
}

console.error(`  digest       : ${catalog.digest}\n                 != ${baseline.digest} (recorded)`);

const failures = [];

// --- file-level movement -------------------------------------------------------------------------------
const nowFiles = new Set(Object.keys(catalog.files));
const wasFiles = new Set(Object.keys(baseline.files ?? {}));
const addedFiles = [...nowFiles].filter((f) => !wasFiles.has(f));
const removedFiles = [...wasFiles].filter((f) => !nowFiles.has(f));
const changedFiles = [...nowFiles].filter((f) => wasFiles.has(f) && catalog.files[f].sha256 !== baseline.files[f].sha256);

for (const f of addedFiles) failures.push(`provider file ADDED: ${f} (${catalog.files[f].models} models)`);
for (const f of removedFiles) failures.push(`provider file REMOVED: ${f} (${baseline.files[f].models} models were recorded)`);

// --- model-level movement, which is the reviewable part ------------------------------------------------
const nowModels = catalog.models;
const wasModels = new Map(Object.entries(baseline.models ?? {}));
const addedModels = [...nowModels.keys()].filter((k) => !wasModels.has(k)).sort();
const removedModels = [...wasModels.keys()].filter((k) => !nowModels.has(k)).sort();

const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const changedModels = [];
for (const [key, model] of nowModels) {
	const was = wasModels.get(key);
	if (!was) continue;
	const deltas = [];
	// baseUrl first, and shouted: it is the only field here whose change is a security event rather than a
	// pricing update.
	if ((model.baseUrl ?? null) !== (was.baseUrl ?? null)) deltas.push(`*** baseUrl ${was.baseUrl} -> ${model.baseUrl ?? null} ***`);
	if ((model.api ?? null) !== (was.api ?? null)) deltas.push(`api ${was.api} -> ${model.api ?? null}`);
	if (!sameJson(model.cost ?? null, was.cost)) deltas.push(`cost ${JSON.stringify(was.cost)} -> ${JSON.stringify(model.cost ?? null)}`);
	if ((model.contextWindow ?? null) !== (was.contextWindow ?? null)) deltas.push(`contextWindow ${was.contextWindow} -> ${model.contextWindow ?? null}`);
	if ((model.maxTokens ?? null) !== (was.maxTokens ?? null)) deltas.push(`maxTokens ${was.maxTokens} -> ${model.maxTokens ?? null}`);
	if (deltas.length) changedModels.push(`${key}: ${deltas.join("; ")}`);
}

const show = (label, items, limit = 25) => {
	if (!items.length) return;
	console.error(`\n  ${label} (${items.length}):`);
	for (const i of items.slice(0, limit)) console.error(`    ${i}`);
	// Never truncate silently: a gate that hides what it dropped reads as "that was everything".
	if (items.length > limit) console.error(`    … and ${items.length - limit} more (not shown; read the git diff)`);
};

show("models ADDED", addedModels);
show("models REMOVED", removedModels);
show("models CHANGED (baseUrl / api / cost / contextWindow / maxTokens)", changedModels);

// A file whose bytes moved but whose model inventory did not is the quiet case: formatting, a field this
// record does not track, or a reordering. Say so explicitly rather than leaving it unexplained.
const quiet = changedFiles.filter(
	(f) =>
		!addedModels.some((k) => k.startsWith(`${f.replace(/\.json$/, "")}/`)) &&
		!removedModels.some((k) => k.startsWith(`${f.replace(/\.json$/, "")}/`)) &&
		!changedModels.some((k) => k.startsWith(`${f.replace(/\.json$/, "")}/`)),
);
show("files whose CONTENT moved with no tracked model change (read the diff — a field this record does not track)", quiet);

if (!failures.length && !addedModels.length && !removedModels.length && !changedModels.length && !quiet.length) {
	failures.push("digest moved but nothing tracked differs — the record itself may be malformed. Read the git diff.");
}

console.error("\n  Files changed: " + (changedFiles.length ? changedFiles.join(", ") : "(none)"));
for (const f of failures) console.error(`  FAIL  ${f}`);

console.error("\nModel-catalog drift. This is third-party data that moved under a pinned upstream tag.");
console.error("Read the delta above and the git diff, decide deliberately, then:");
console.error("  node strape/scripts/model-catalog.mjs --record");
console.error("Re-recording to get a green build defeats the entire point of the freeze.");
process.exit(1);
