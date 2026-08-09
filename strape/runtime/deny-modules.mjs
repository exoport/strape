/**
 * Fail-closed provider-SDK guard.
 *
 * strape targets OpenAI and xAI only. Hunk 4 removes the other provider SDKs from the shipped closure, so
 * importing one already fails — but with an opaque MODULE_NOT_FOUND from deep inside pi-ai. This hook turns
 * that into a legible policy error, and catches the case where someone reinstates a dependency without
 * thinking about the review gate.
 *
 * Loaded by strape/bin/strape via `node --import`. Disable with STRAPE_NO_MODULE_GUARD=1.
 */

import { registerHooks } from "node:module";

const DENIED = [
	"@anthropic-ai/sdk",
	"@aws-sdk/client-bedrock-runtime",
	"@smithy/node-http-handler",
	"@google/genai",
	"@mistralai/mistralai",
	"google-auth-library",
];

const isDenied = (spec) => DENIED.some((d) => spec === d || spec.startsWith(`${d}/`));

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (isDenied(specifier)) {
			throw new Error(
				`[strape] blocked module load: ${specifier}\n` +
					"This provider SDK is disabled by policy (strape ships OpenAI/xAI only; see strape/audit/review-*.md).\n" +
					`Imported from: ${context.parentURL ?? "unknown"}`,
			);
		}
		return nextResolve(specifier, context);
	},
});
