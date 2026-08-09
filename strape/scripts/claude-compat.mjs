#!/usr/bin/env node
/**
 * Claude Code interop setup — idempotent.
 *
 * strape reuses the Claude Code conventions a team already has, instead of asking for AGENTS.md/.agents:
 *   - project CLAUDE.md   : already a built-in context-file candidate (core/resource-loader.ts:71). No work.
 *   - global  CLAUDE.md   : symlinked into the strape agent dir, which is where the global lookup reads.
 *   - .claude/skills      : added to the `skills` setting at global and/or project scope (additive to the
 *                           auto-scanned <agentDir>/skills, <cwd>/.strape/skills and .agents/skills).
 *
 * Deliberately NOT done: setting piConfig.configDir to ".claude". That would put strape's settings.json,
 * auth.json, trust.json and sessions inside the user's real Claude Code directory, colliding with a
 * different schema at the same path. strape uses .strape and reuses Claude's files read-only.
 *
 * Usage:
 *   node strape/scripts/claude-compat.mjs --global            # ~/.strape/agent settings + CLAUDE.md symlink
 *   node strape/scripts/claude-compat.mjs --project [DIR]     # <DIR>/.strape/settings.json (+ git exclude)
 *   node strape/scripts/claude-compat.mjs --check   [DIR]     # report only, change nothing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueAfter = (f) => {
	const i = args.indexOf(f);
	const v = i === -1 ? null : args[i + 1];
	return v && !v.startsWith("--") ? v : null;
};
const check = has("--check");
const dryRun = check || has("--dry-run");

const HOME = homedir();
const AGENT_DIR = process.env.STRAPE_CODING_AGENT_DIR || join(HOME, ".strape", "agent");
const CLAUDE_HOME = join(HOME, ".claude");

const changes = [];
const skipped = [];

const readJson = (p) => {
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch (e) {
		throw new Error(`${p} is not valid JSON (${e.message}) — fix or move it before running this.`);
	}
};

const writeJson = (p, obj) => {
	if (dryRun) return;
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, `${JSON.stringify(obj, null, "\t")}\n`);
};

/** Add a value to a settings array without duplicating or reordering what is already there. */
const addToArray = (settings, key, value) => {
	const arr = Array.isArray(settings[key]) ? [...settings[key]] : [];
	if (arr.includes(value)) {
		skipped.push(`${key} already contains "${value}"`);
		return settings;
	}
	arr.push(value);
	changes.push(`${key} += "${value}"`);
	return { ...settings, [key]: arr };
};

/** Gemini model declarations, shared by the create and upgrade paths. */
const GEMINI_MODELS = [
		{
			id: "gemini-flash-latest",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-flash-lite-latest",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1048576,
			maxTokens: 65536,
		},
];

if (has("--global") || check) {
	const settingsPath = join(AGENT_DIR, "settings.json");
	let settings = readJson(settingsPath);
	const before = JSON.stringify(settings);

	if (existsSync(join(CLAUDE_HOME, "skills"))) {
		settings = addToArray(settings, "skills", "~/.claude/skills");
	} else {
		skipped.push(`${join(CLAUDE_HOME, "skills")} does not exist — global skills reuse not configured`);
	}

	// strape targets OpenAI, xAI and Google Gemini. Keep the model list closed so a provider whose SDK we do
	// not ship is never selectable. openai-codex is included because it is how OpenAI OAuth (ChatGPT Plus/Pro)
	// is exposed — a separate provider from plain `openai`, and it needs none of the trimmed SDKs.
	const defaults = {
		defaultProvider: "xai",
		defaultModel: "grok-4.5",
		// PROVIDER-SCOPED on purpose. Patterns match against "provider/id" as well as bare "id"
		// (core/model-resolver.ts:312-316), so a bare "gemini-*" would also match the ~24 models of pi's
		// built-in `google` provider — which needs @google/genai and fails with the module-guard error.
		// Scoping keeps the unusable entries out of the picker.
		// Note: "openai-codex/*" is deliberately NOT here. That provider contributes no models until you
		// complete a ChatGPT Plus/Pro OAuth login, and an unmatched pattern warns on every startup. Add it
		// yourself after logging in if your subscription models do not appear.
		enabledModels: ["openai/gpt-*", "xai/grok-*", "gemini-openai/*"],
		enableInstallTelemetry: false,
		defaultProjectTrust: "ask",
	};
	for (const [k, v] of Object.entries(defaults)) {
		if (settings[k] === undefined) {
			settings[k] = v;
			changes.push(`${k} = ${JSON.stringify(v)}`);
		} else {
			skipped.push(`${k} already set to ${JSON.stringify(settings[k])}`);
		}
	}

	// A defaultModel pointing at a model we no longer declare would fail at startup. This happens to anyone
	// who selected gemini-2.5-flash in the TUI before we learned it is closed to new keys.
	const STALE_MODEL_IDS = new Set(["gemini-2.5-pro", "gemini-2.5-flash"]);
	if (STALE_MODEL_IDS.has(String(settings.defaultModel))) {
		const was = settings.defaultModel;
		settings.defaultModel = GEMINI_MODELS[0].id;
		changes.push(`defaultModel "${was}" is closed to new API keys -> "${settings.defaultModel}"`);
	}

	if (JSON.stringify(settings) !== before) writeJson(settingsPath, settings);

	// Gemini via Google's OpenAI-compatible endpoint. Declared in models.json as an `openai-completions`
	// provider, so it rides the `openai` client already in the shipped closure and adds ZERO packages.
	// The built-in `google` provider uses @google/genai, which strape keeps dev-only (hunk 4) — selecting a
	// model from it fails with the module-guard message rather than working, which is why we declare our own
	// provider id instead of relying on the built-in one.
	const modelsPath = join(AGENT_DIR, "models.json");
	const models = readJson(modelsPath);
	const providers = { ...(models.providers ?? {}) };
	if (providers["gemini-openai"]) {
		// Upgrade in place: an entry written before the compat flags existed would keep failing with 400.
		const existing = providers["gemini-openai"];
		const compat = { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, ...(existing.compat ?? {}) };
		// Pinned Gemini ids get closed to new users, so replace them with the alias ids. Anything the user
		// added themselves is preserved.
		const STALE = new Set(["gemini-2.5-pro", "gemini-2.5-flash"]);
		const keptModels = (existing.models ?? []).filter((m) => !STALE.has(m.id));
		const needModels = keptModels.length !== (existing.models ?? []).length || !keptModels.length;
		const nextModels = needModels ? [...GEMINI_MODELS, ...keptModels] : existing.models;
		const compatChanged = JSON.stringify(existing.compat ?? {}) !== JSON.stringify(compat);
		if (compatChanged || needModels) {
			providers["gemini-openai"] = { ...existing, compat, models: nextModels };
			if (compatChanged) changes.push('models.json: added compat flags to "gemini-openai" (fixes the 400 from Google\'s OpenAI layer)');
			if (needModels) changes.push('models.json: replaced pinned Gemini ids with -latest aliases (pinned ones 404 for new keys)');
			writeJson(modelsPath, { ...models, providers });
		} else {
			skipped.push('models.json "gemini-openai" is already up to date');
		}
	} else {
		providers["gemini-openai"] = {
			baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
			api: "openai-completions",
			// Resolved from the environment at request time; never written into this file.
			apiKey: "$GEMINI_API_KEY",
			// REQUIRED for Google's OpenAI-compatibility layer, which validates strictly and rejects any
			// field it does not know.
			//
			// supportsStore:false is the load-bearing one. pi sends `store: false`
			// (api/openai-completions.ts:711-713), an OpenAI-only field, and Google answers
			//   400 Invalid JSON payload received. Unknown name "store": Cannot find field.
			// The `openai` SDK cannot parse Google's array-wrapped error body, so this surfaces in the TUI as
			// the useless `Error: 400 status code (no body)`. Diagnosed by capturing pi's real request against
			// a local mock and replaying it: removing `store` alone made Google accept the full request,
			// tools included.
			//
			// The other two are precautionary, per upstream's guidance for OpenAI-compatible servers
			// (docs/models.md): with `reasoning: true` pi would otherwise send the system prompt as role
			// "developer" and add `reasoning_effort`. They were NOT the cause here and can be re-enabled if
			// you want Gemini's thinking controls — test before trusting.
			compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
			// Model choice, learned the hard way:
			//   * contextWindow/maxTokens MUST be declared. They default to 128000/16384 while Gemini's
			//     flash tier actually has 1,048,576 — leaving the defaults makes the harness compact far
			//     too early. Values come from the vendored catalog (packages/ai/src/providers/data).
			//   * Use the "-latest" ALIAS ids, never pinned versions. A new API key gets
			//       404 This model models/gemini-2.5-flash is no longer available to new users
			//     because Google closes pinned versions to new projects while older keys stay grandfathered,
			//     so a pinned config works for one person and 404s for their colleague. gemini-2.5-pro also
			//     answers 429 with "limit: 0" on the free tier, which means "not offered on your tier"
			//     rather than throttling. gemini-flash-lite-latest was verified 200 with a new-format key.
			models: GEMINI_MODELS,
		};
		changes.push('models.json += provider "gemini-openai" (OpenAI-compatible, no new dependency)');
		writeJson(modelsPath, { ...models, providers });
	}

	// Global context file: the global lookup reads <agentDir>/CLAUDE.md, not ~/.claude/CLAUDE.md.
	const target = join(CLAUDE_HOME, "CLAUDE.md");
	const link = join(AGENT_DIR, "CLAUDE.md");
	if (!existsSync(target)) {
		skipped.push(`${target} does not exist — no global context file to reuse`);
	} else {
		let current = null;
		try {
			current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : "REGULAR_FILE";
		} catch {}
		if (current === target) skipped.push(`${link} already links to ${target}`);
		else if (current === "REGULAR_FILE") {
			skipped.push(`${link} exists as a real file — leaving it alone (remove it yourself to link Claude's)`);
		} else {
			if (!dryRun) {
				mkdirSync(AGENT_DIR, { recursive: true });
				if (current) unlinkSync(link);
				symlinkSync(target, link);
			}
			changes.push(`symlink ${link} -> ${target}`);
		}
	}
}

if (has("--project") || (check && valueAfter("--check"))) {
	const dir = resolve(valueAfter("--project") || valueAfter("--check") || process.cwd());
	const settingsPath = join(dir, ".strape", "settings.json");
	let settings = readJson(settingsPath);
	const before = JSON.stringify(settings);

	if (existsSync(join(dir, ".claude", "skills"))) {
		// Project settings resolve relative paths against <cwd>/.strape (core/package-manager.ts:903-904),
		// so "../.claude/skills" is exactly <project>/.claude/skills.
		settings = addToArray(settings, "skills", "../.claude/skills");
	} else {
		skipped.push(`${join(dir, ".claude", "skills")} does not exist — project skills reuse not configured`);
	}
	// A defaultModel pointing at a model we no longer declare would fail at startup. This happens to anyone
	// who selected gemini-2.5-flash in the TUI before we learned it is closed to new keys.
	const STALE_MODEL_IDS = new Set(["gemini-2.5-pro", "gemini-2.5-flash"]);
	if (STALE_MODEL_IDS.has(String(settings.defaultModel))) {
		const was = settings.defaultModel;
		settings.defaultModel = GEMINI_MODELS[0].id;
		changes.push(`defaultModel "${was}" is closed to new API keys -> "${settings.defaultModel}"`);
	}

	if (JSON.stringify(settings) !== before) writeJson(settingsPath, settings);

	// Leave no trace in the user's repo: exclude .strape locally rather than editing their .gitignore.
	const exclude = join(dir, ".git", "info", "exclude");
	if (existsSync(join(dir, ".git")) && existsSync(exclude)) {
		const body = readFileSync(exclude, "utf-8");
		if (!/^\.strape\/?$/m.test(body)) {
			if (!dryRun) appendFileSync(exclude, `${body.endsWith("\n") || body === "" ? "" : "\n"}.strape/\n`);
			changes.push(`${exclude} += ".strape/"`);
		} else skipped.push(".strape/ already excluded in .git/info/exclude");
	}

	const ctx = ["CLAUDE.md", "AGENTS.md"].filter((f) => existsSync(join(dir, f)));
	if (ctx.includes("CLAUDE.md") && ctx.includes("AGENTS.md")) {
		skipped.push(
			"both AGENTS.md and CLAUDE.md exist in this directory — AGENTS.md wins (resource-loader.ts:71 order) " +
				"and CLAUDE.md is ignored here",
		);
	} else if (ctx.includes("CLAUDE.md")) {
		skipped.push("CLAUDE.md will be loaded as the project context file (no change needed)");
	} else {
		skipped.push("no CLAUDE.md/AGENTS.md in this directory");
	}
}

if (!has("--global") && !has("--project") && !check) {
	console.error("Usage: claude-compat.mjs [--global] [--project DIR] [--check DIR] [--dry-run]");
	process.exit(2);
}

console.log(check || dryRun ? "claude-compat (report only)\n" : "claude-compat\n");
for (const c of changes) console.log(`  ${dryRun ? "would" : "did "}  ${c}`);
for (const s of skipped) console.log(`  ----  ${s}`);
if (!changes.length) console.log("  (nothing to change)");
