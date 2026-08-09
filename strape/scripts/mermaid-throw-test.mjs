#!/usr/bin/env node
/**
 * Regression test for hunk 15: a mermaid parser throw must not break message rendering.
 *
 * WHY THIS EXISTS
 * `render()` runs on MODEL-CONTROLLED text — any mermaid block the assistant emits — and the transformer sits
 * in the markdown path for every rendered message, with no try/catch anywhere up the chain. A throw there does
 * not cost one diagram; it breaks rendering of the whole message. grok-mermaid is deliberate about not
 * throwing (60k fuzz cases threw nothing at 0.2.2, and it returns null + warnings instead), but that is a
 * property of one reviewed version of a single-maintainer parser we have chosen to keep updating.
 *
 * WHY IT STUBS THE PARSER
 * The honest way to test "survives a throw" is to make it throw. Feeding pathological mermaid to the real
 * parser would pass whether or not the guard exists — the exact shape of green-for-the-wrong-reason this repo
 * has been bitten by. So a loader hook replaces the `grok-mermaid` specifier with a module whose render()
 * always throws, and the assertion is on what the transformer returns.
 *
 * Requires a build (npm run build:offline). No network. Writes only to a temp dir.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const distMermaid = join(repoRoot, "packages/coding-agent/dist/modes/interactive/components/mermaid.js");

const results = [];
const check = (name, ok, detail) => results.push({ ok, name, detail });

const root = mkdtempSync(join(tmpdir(), "strape-mermaid-throw-"));

// A resolve hook that swaps the real parser for one that always throws.
writeFileSync(
	join(root, "loader.mjs"),
	`export async function resolve(specifier, context, next) {
  if (specifier === "grok-mermaid") {
    return {
      url: "data:text/javascript," + encodeURIComponent("export function render(){ throw new Error('parser exploded'); }"),
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
`,
);
writeFileSync(
	join(root, "register.mjs"),
	`import { register } from "node:module";
register("./loader.mjs", import.meta.url);
`,
);
// Drives the real transformer over a real mermaid block and reports what came back.
writeFileSync(
	join(root, "probe.mjs"),
	`const { createMermaidMarkdownTransformer } = await import(${JSON.stringify(`file://${distMermaid}`)});
const transform = createMermaidMarkdownTransformer({ getMode: () => "final" });
const source = "flowchart LR\\n  A --> B";
const markdown = "before\\n\\n\\u0060\\u0060\\u0060mermaid\\n" + source + "\\n\\u0060\\u0060\\u0060\\n\\nafter\\n";
const out = transform(markdown, { messageType: "assistant", isStreaming: false, availableWidth: 200 });
process.stdout.write(JSON.stringify({ ok: true, keptSource: out.includes("A --> B"), out }));
`,
);

const run = (withStub) => {
	const args = withStub ? ["--import", join(root, "register.mjs"), join(root, "probe.mjs")] : [join(root, "probe.mjs")];
	try {
		const stdout = execFileSync(process.execPath, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
		return { crashed: false, ...JSON.parse(stdout) };
	} catch (e) {
		return { crashed: true, stderr: String(e.stderr ?? e.message) };
	}
};

try {
	// 1. The control: parser throws on model-controlled input.
	const thrown = run(true);
	check(
		"a throwing parser does not crash message rendering",
		!thrown.crashed,
		thrown.crashed ? `process died: ${String(thrown.stderr).split("\n")[0].slice(0, 90)}` : "transformer returned normally",
	);
	check(
		"...and falls back to showing the diagram source",
		thrown.crashed === false && thrown.keptSource === true,
		thrown.crashed ? "n/a — it crashed" : `keptSource=${thrown.keptSource}`,
	);

	// 2. Stand-aside: with the real parser, diagrams must still render as art rather than source.
	const real = run(false);
	check("the real parser still renders art", !real.crashed && real.out.includes("─"), real.crashed ? "crashed" : "box-drawing output present");
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log("strape mermaid parser-throw fallback (hunk 15)\n");
for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.name} — ${r.detail}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
	console.error(`\n${failed.length} assertion(s) failed: a parser throw can still break rendering.`);
	process.exit(1);
}
console.log(`\nAll ${results.length} assertions hold.`);
