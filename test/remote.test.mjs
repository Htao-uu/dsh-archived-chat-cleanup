/**
 * Wire-contract test for the hand-written Typert source-mode Remote surface.
 *
 * The browser half reaches the Host through the shared `/api` carrier, so the
 * descriptor on the service prototype and the method parameter names ARE the
 * contract. This test drives the real installed
 * `@deepseek-ai/dsh-typert-protocol` package (the same code the Gateway uses)
 * against this plugin's service class, instead of a copy of it.
 *
 *   node test/remote.test.mjs
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { ArchivedCleanupService, REMOTE_METHOD_DESCRIPTOR, SERVICE_KEY } from '../index.js';

const require = createRequire(import.meta.url);
const requireFromCwd = createRequire(path.join(process.cwd(), 'package.json'));
function resolveProtocol() {
	if (process.env.DSH_TYPERT_PROTOCOL_PATH) return process.env.DSH_TYPERT_PROTOCOL_PATH;
	for (const resolver of [require, requireFromCwd]) {
		try {
			return resolver.resolve('@deepseek-ai/dsh-typert-protocol');
		} catch {}
	}
	return undefined;
}
const protocolDir = resolveProtocol();
if (protocolDir === undefined || !existsSync(protocolDir)) {
	console.error('cannot find @deepseek-ai/dsh-typert-protocol; install the plugin devDependencies');
	console.error('(npm install), or set DSH_TYPERT_PROTOCOL_PATH to its lib/index.js');
	process.exit(1);
}
const { remoteMethods, isTypertRemoteSegment } = await import(pathToFileURL(protocolDir).href);

const results = [];
let failures = 0;
const check = (condition, label) => {
	if (condition) results.push(`  PASS  ${label}`);
	else {
		failures += 1;
		results.push(`  FAIL  ${label}`);
	}
};

/** Mirrors the Gateway's `methodParameterNames` (it is not exported). */
function methodParameterNames(service, method) {
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), method);
	if (descriptor === undefined || typeof descriptor.value !== 'function') return undefined;
	const source = Function.prototype.toString.call(descriptor.value);
	const open = source.indexOf('(');
	const close = source.indexOf(')', open + 1);
	if (open < 0 || close < 0) return undefined;
	const body = source.slice(open + 1, close).trim();
	if (body.length === 0) return [];
	const names = body.split(',').map((part) => part.trim());
	return names.every((name) => /^[$A-Z_a-z][$\w]*$/u.test(name)) ? names : undefined;
}

// A service instance needs no live Host for its prototype contract to be read.
const service = new ArchivedCleanupService({ prepare: async () => ({}) }, {});
const prototype = Object.getPrototypeOf(service);

// 1. The @Remote descriptor the Gateway's source-mode fallback reads.
const own = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
check(own !== undefined && own.value?.version === 1, 'the prototype carries a version-1 Remote method descriptor');
const markers = remoteMethods(service);
check(markers.length === 3, `the real protocol package reads exactly 3 Remote markers (got ${markers.length})`);
check(
	['status', 'preview', 'deleteArchived'].every((method) => markers.some((marker) => marker.method === method)),
	'status, preview and deleteArchived are all marked'
);
check(
	markers.every((marker) => marker.invocation.kind === 'direct' && marker.exportName === undefined),
	'every marker is a direct invocation exported under its own method name'
);

// 2. The visible binding the Gateway validates field by field.
const binding = service.typertRemote;
check(binding !== undefined && binding.service === service, 'typertRemote.service is the service instance itself');
check(binding.serviceKey === SERVICE_KEY && binding.namespace === SERVICE_KEY, `typertRemote binds service key and namespace to "${SERVICE_KEY}"`);
check(Object.isFrozen(binding), 'the binding is frozen, as the protocol package produces it');

// 3. Endpoint grammar and named wire arguments.
const namespace = binding.namespace;
check(isTypertRemoteSegment(namespace), 'the namespace satisfies the RPC endpoint segment grammar');
const expected = {
	status: [],
	preview: ['mode', 'sessionId'],
	deleteArchived: ['mode', 'sessionId', 'confirm']
};
for (const [method, names] of Object.entries(expected)) {
	const endpoint = `${namespace}/${method}`;
	check(endpoint.split('/').length === 2, `endpoint "${endpoint}" has exactly two segments`);
	const parsed = methodParameterNames(service, method);
	check(parsed !== undefined, `"${method}" uses identifier-only parameters (source-mode requirement)`);
	check(
		parsed !== undefined && parsed.length === names.length && names.every((name, index) => parsed[index] === name),
		`"${method}" wire arguments are exactly { ${names.join(', ')} }`
	);
}

// 4. The confirm gate: nothing is deleted without an explicit true.
const refusals = await service.deleteArchived('all', undefined, undefined);
check(refusals?.ok === false && refusals.error.code === 'confirm-required', 'deleteArchived refuses without confirm: true');
const refusalsTwo = await service.deleteArchived('all', undefined, false);
check(refusalsTwo?.ok === false && refusalsTwo.error.code === 'confirm-required', 'deleteArchived refuses confirm: false');

console.log('\nRemote wire-contract tests\n');
console.log(results.join('\n'));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
if (failures > 0) process.exitCode = 1;