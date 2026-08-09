#!/usr/bin/env node
/**
 * Diagnose an OpenAI-compatible provider by showing the error the SDK hides.
 *
 * WHY THIS EXISTS
 * The `openai` client renders any error body it cannot parse as `NNN status code (no body)`. Google's
 * OpenAI-compatibility layer wraps errors in a JSON **array**, so a perfectly explicit message like
 *   400 Invalid JSON payload received. Unknown name "store": Cannot find field.
 * reaches the user as `400 status code (no body)` — a dead end. It also answers 400 for auth failures rather
 * than 401, so the status code itself tells you nothing. Two real debugging sessions were spent on that.
 *
 * This probe talks to the provider directly with no SDK in the way, unwraps array-shaped error bodies, and
 * prints the message. It reads the provider straight out of models.json, so it tests the configuration you
 * actually run rather than an approximation of it.
 *
 * Usage:
 *   node strape/scripts/provider-probe.mjs                        # probe every provider in models.json
 *   node strape/scripts/provider-probe.mjs gemini-openai          # one provider
 *   node strape/scripts/provider-probe.mjs gemini-openai --models # also list what the key can see
 *
 * Reads $STRAPE_CODING_AGENT_DIR/models.json (default ~/.strape/agent/models.json). Never prints the key.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const AGENT_DIR = process.env.STRAPE_CODING_AGENT_DIR || join(homedir(), ".strape", "agent");
const modelsPath = join(AGENT_DIR, "models.json");
const authPath = join(AGENT_DIR, "auth.json");

/**
 * A credential saved by `/login` takes PRECEDENCE over the provider's configured apiKey
 * (core/provider-composer.ts:341-350: `if (input.credential) … else if (rawKey !== undefined)`). A probe that
 * only read models.json would therefore test a different key than strape uses — which is exactly the trap that
 * made one debugging round useless. Read auth.json and honour the same order.
 */
const storedCredentials = (() => {
	if (!existsSync(authPath)) return {};
	try {
		return JSON.parse(readFileSync(authPath, "utf-8"));
	} catch {
		console.error(`warning: ${authPath} is not valid JSON — ignoring stored credentials`);
		return {};
	}
})();

const args = process.argv.slice(2);
const wantModels = args.includes("--models");
const only = args.find((a) => !a.startsWith("--"));

if (!existsSync(modelsPath)) {
	console.error(`No ${modelsPath}. Run: node strape/scripts/claude-compat.mjs --global`);
	process.exit(1);
}
const providers = JSON.parse(readFileSync(modelsPath, "utf-8")).providers ?? {};
const names = only ? [only] : Object.keys(providers);
if (!names.length) {
	console.error(`models.json declares no providers.`);
	process.exit(1);
}

/** Resolve `$VAR` / `${VAR}` the way pi's config-value resolution does, without ever printing the value. */
const resolveKey = (raw) => {
	if (typeof raw !== "string") return { value: undefined, source: "unset" };
	const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw.trim());
	if (!m) return { value: raw, source: "literal in models.json" };
	const v = process.env[m[1]];
	return { value: v, source: v ? `$${m[1]} (set, ${v.length} chars)` : `$${m[1]} (NOT SET in this environment)` };
};

/** Google answers with [{error:{...}}]; OpenAI with {error:{...}}; some servers with plain text. */
const explain = async (res) => {
	const text = await res.text();
	if (!text) return "(empty body)";
	try {
		let d = JSON.parse(text);
		if (Array.isArray(d)) d = d[0];
		return d?.error?.message ?? JSON.stringify(d).slice(0, 300);
	} catch {
		return text.slice(0, 300);
	}
};

let failures = 0;

for (const name of names) {
	const p = providers[name];
	if (!p) {
		console.error(`provider "${name}" is not in models.json (have: ${Object.keys(providers).join(", ")})`);
		failures++;
		continue;
	}
	const base = String(p.baseUrl ?? "").replace(/\/+$/, "");
	let { value: key, source } = resolveKey(p.apiKey);
	const stored = storedCredentials[name];
	if (stored && typeof stored.key === "string" && stored.key.length) {
		key = stored.key;
		source = `auth.json (stored by /login, ${stored.key.length} chars, starts "${stored.key.slice(0, 4)}…") — OVERRIDES the configured apiKey`;
	}
	const declared = (p.models ?? []).map((m) => m.id).filter(Boolean);

	console.log(`\n${name}`);
	console.log(`  baseUrl : ${base}`);
	console.log(`  api     : ${p.api}`);
	console.log(`  apiKey  : ${source}`);
	console.log(`  compat  : ${JSON.stringify(p.compat ?? {})}`);
	console.log(`  models  : ${declared.join(", ") || "(none declared)"}`);

	if (!key) {
		console.error(`  RESULT  : cannot probe — no API key resolved. Export the variable, then re-run.`);
		failures++;
		continue;
	}
	if (!declared.length) {
		console.error(`  RESULT  : cannot probe — the provider declares no models.`);
		failures++;
		continue;
	}

	const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

	if (wantModels) {
		try {
			const r = await fetch(`${base}/models`, { headers });
			if (r.ok) {
				const d = await r.json();
				const ids = (d.data ?? []).map((m) => String(m.id).replace(/^models\//, ""));
				console.log(`  visible : ${ids.length} models for this key`);
				for (const m of declared) {
					const has = ids.includes(m);
					console.log(`            ${has ? "ok  " : "MISS"} ${m}`);
					if (!has) {
						const near = ids.filter((i) => i.startsWith(m.split("-").slice(0, 2).join("-"))).slice(0, 6);
						console.log(`                 closest available: ${near.join(", ") || "(none similar)"}`);
					}
				}
			} else {
				console.log(`  models  : list failed ${r.status} — ${await explain(r)}`);
			}
		} catch (e) {
			console.log(`  models  : list unreachable — ${String(e.message ?? e).slice(0, 120)}`);
		}
	}

	// Probe EVERY declared model: availability and quota differ per model. On Google's free tier
	// gemini-2.5-pro reports `limit: 0`, so a working key still cannot call it.
	for (const model of declared) {
	try {
		const r = await fetch(`${base}/chat/completions`, {
			method: "POST",
			headers,
			body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 8 }),
		});
		if (r.ok) {
			console.log(`  ${model}: OK (${r.status}) — auth, path and model all valid`);
		} else {
			const msg = await explain(r);
			console.error(`  ${model}: ${r.status} — ${msg.split("\n")[0].slice(0, 160)}`);
			// The two failures that cost real debugging time, named so nobody repeats it.
			if (/Unknown name/.test(msg)) {
				console.error(`            ^ strict field validation. Set the matching compat flag on this provider`);
				console.error(`              (e.g. \`store\` -> "compat": { "supportsStore": false }).`);
			} else if (/valid API key|API key not valid/i.test(msg)) {
				console.error(`            ^ this is an AUTH failure that arrived as ${r.status}, not 401.`);
			} else if (r.status === 404) {
				console.error(`            ^ usually "this key/project cannot see that model". Re-run with --models.`);
			} else if (r.status === 429 && /limit: 0/.test(msg)) {
				console.error(`            ^ limit: 0 means this model is not offered on your tier at all, not a rate limit.`);
			}
			failures++;
		}
	} catch (e) {
		console.error(`  ${model}: unreachable — ${String(e.message ?? e).slice(0, 160)}`);
		failures++;
	}
	}
}

console.log();
process.exit(failures ? 1 : 0);
