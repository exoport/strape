import { EventEmitter } from "node:events";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;
// Node's 250ms default can terminate valid connection attempts on high-latency routes.
const DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 2_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

// strape hunk 13: refuse cross-origin redirects at the dispatcher.
//
// undici's fetch() strips Authorization/Cookie/Proxy-Authorization when a redirect crosses origin
// (lib/web/fetch/index.js:1350-1358) but, per spec, keeps every other header and REPLAYS THE BODY on 307/308.
// Provider calls go through the global fetch that undici.install() replaces, so a DNS-hijacked or compromised
// provider host answering 307 would POST the entire conversation to an attacker origin. Bearer tokens are
// stripped, but api-key/x-api-key style headers are not — and the conversation itself is the sensitive part.
//
// This is enforced here rather than with `redirect: "error"` at each provider fetch for two reasons: this
// module is the single funnel every request passes through, and a per-call-site flag is exactly what a future
// upstream merge drops silently. Same-origin redirects still work, so ordinary /v1 -> /v1/ behaviour is
// unaffected; only a redirect that leaves the origin fails, and it fails loudly.
//
// Note undici's own `stripHeadersOnCrossOriginRedirect` option exists only for undici.request, not for fetch.
const CROSS_ORIGIN_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isCrossOriginRedirect(requestOrigin: string, location: string): boolean {
	try {
		return new URL(location, requestOrigin).origin !== new URL(requestOrigin).origin;
	} catch {
		// An unparseable Location is not something to follow optimistically.
		return true;
	}
}

/**
 * Wraps each handler method explicitly rather than extending undici's internal DecoratorHandler: deep-importing
 * `undici/lib/handler/decorator-handler` would couple strape to a path outside the package's public exports,
 * and prototype-inheriting from the caller's handler would break undici's private (#) fields by changing `this`.
 * Throwing from onResponseStart is the supported failure path — core/request.js:344 wraps the call in try/catch
 * and aborts the request with the thrown error.
 */
function crossOriginRedirectGuard() {
	return (dispatch: (opts: object, handler: Record<string, unknown>) => unknown) =>
		(opts: { origin?: unknown }, handler: Record<string, (...args: unknown[]) => unknown>) => {
			const call = (name: string, args: unknown[]): unknown =>
				typeof handler[name] === "function" ? handler[name](...args) : undefined;
			const wrapped: Record<string, unknown> = {
				onRequestStart: (...args: unknown[]) => call("onRequestStart", args),
				onRequestUpgrade: (...args: unknown[]) => call("onRequestUpgrade", args),
				onResponseStart: (...args: unknown[]) => {
					const [, statusCode, headers] = args as [unknown, number, Record<string, unknown> | undefined];
					if (CROSS_ORIGIN_REDIRECT_STATUSES.has(statusCode)) {
						const location = headers?.location;
						const origin = String(opts.origin ?? "");
						if (typeof location === "string" && location && isCrossOriginRedirect(origin, location)) {
							throw new Error(
								`strape: refusing a cross-origin redirect (${statusCode}) from ${origin} to ${location}. ` +
									"Following it would replay the request body to another origin.",
							);
						}
					}
					return call("onResponseStart", args);
				},
				onResponseData: (...args: unknown[]) => call("onResponseData", args),
				onResponseEnd: (...args: unknown[]) => call("onResponseEnd", args),
				onResponseError: (...args: unknown[]) => call("onResponseError", args),
				onBodySent: (...args: unknown[]) => call("onBodySent", args),
			};
			return dispatch(opts, wrapped);
		};
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing pi.
function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			connect: {
				autoSelectFamilyAttemptTimeout: DEFAULT_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
			},
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	// hunk 13: compose the guard onto the global dispatcher so every request inherits it.
	undici.setGlobalDispatcher(
		(dispatcher as unknown as { compose: (i: unknown) => undici.Dispatcher }).compose(crossOriginRedirectGuard()),
	);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}
