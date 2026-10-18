/**
 * Offline acceptance tests for the archived-session cleanup engine.
 *
 * Runs against a synthetic harness home and a fake capability adapter, so the
 * real `C:\Users\<user>\.dsh` tree is never touched. Run with:
 *
 *   node test/engine.test.mjs
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CleanupEngine, CleanupError, encodeSegment, extractAttachmentIds } from '../core.js';

const results = [];
let failures = 0;

/** One assertion. */
function check(condition, label) {
	if (condition) results.push(`  PASS  ${label}`);
	else {
		failures += 1;
		results.push(`  FAIL  ${label}`);
	}
}

/** Attachment id for one repeated hex character pair stream. */
function attachmentId(seed) {
	const hex = seed.repeat(64).slice(0, 64).toLowerCase();
	return `sha256:${hex}`;
}

const ATTACH_ALPHA = attachmentId('a1');
const ATTACH_SHARED = attachmentId('b2');
const ATTACH_CHILD = attachmentId('c3');
const ATTACH_ORPHAN = attachmentId('d4');
const ATTACH_FILE = attachmentId('e5');

/** Build one fixture tree plus its fake host adapter. */
async function createFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-archive-cleanup-'));
	const sessionsRoot = path.join(root, 'sessions');
	const attachmentsRoot = path.join(root, 'attachments', 'v1');
	const cacheRoot = path.join(root, 'cache', 'attachments');
	const pluginDataRoot = path.join(root, 'plugin-data', 'archived-cleanup');

	const write = async (target, text) => {
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, text, 'utf8');
	};
	const logFor = (refs) => JSON.stringify([{ type: 'user/message', data: { role: 'user', content: refs.map((ref) => ({ type: 'image', attachment: { attachmentId: ref } })) } }]);

	const sessionDir = async (project, id, refs) => {
		const dir = path.join(sessionsRoot, project, encodeSegment(id));
		await write(path.join(dir, 'session.v3.jsonl.zstd'), logFor(refs));
		return dir;
	};

	const dirs = {
		alpha: await sessionDir('--proj-a--', 'session-alpha', [ATTACH_ALPHA, ATTACH_SHARED]),
		shared: await sessionDir('--proj-a--', 'session-shared-age', []),
		child: await sessionDir('--proj-b--', 'child-of-alpha', [ATTACH_CHILD]),
		keeper: await sessionDir('--proj-b--', 'session-keeper', [ATTACH_SHARED, ATTACH_FILE]),
		archiveWait: await sessionDir('--proj-a--', 'session-archived-twice', [ATTACH_SHARED])
	};

	const objectPath = async (id) => {
		const digest = id.slice('sha256:'.length);
		const target = path.join(attachmentsRoot, 'objects', digest.slice(0, 2), digest);
		await write(target, `bytes of ${id}`);
		return target;
	};
	const files = {
		alpha: await objectPath(ATTACH_ALPHA),
		shared: await objectPath(ATTACH_SHARED),
		child: await objectPath(ATTACH_CHILD),
		orphan: await objectPath(ATTACH_ORPHAN)
	};
	const fileDigest = ATTACH_FILE.slice('sha256:'.length);
	files.fileObject = path.join(attachmentsRoot, 'file-objects', fileDigest.slice(0, 2), fileDigest);
	await write(files.fileObject, 'verbatim file bytes');
	files.fileAlias = path.join(attachmentsRoot, 'files', fileDigest.slice(0, 2), fileDigest, 'report.pdf');
	await write(files.fileAlias, 'verbatim file bytes');

	const cacheA = path.join(cacheRoot, 'request-images', 'ab', 'variant-one');
	const cacheB = path.join(attachmentsRoot, 'request-images', 'cd', 'variant-two');
	await write(cacheA, 'derived request image');
	await write(cacheB, 'legacy derived request image');

	const headers = [
		{ id: 'session-alpha', cwd: 'E:\\proj-a', parentSession: undefined, createdAt: 1 },
		{ id: 'session-shared-age', cwd: 'E:\\proj-a', parentSession: undefined, createdAt: 2 },
		{ id: 'child-of-alpha', cwd: 'E:\\proj-b', parentSession: 'session-alpha', createdAt: 3 },
		{ id: 'session-keeper', cwd: 'E:\\proj-b', parentSession: undefined, createdAt: 4 },
		{ id: 'session-archived-twice', cwd: 'E:\\proj-a', parentSession: undefined, createdAt: 5 }
	];
	const logs = new Map([
		['session-alpha', logFor([ATTACH_ALPHA, ATTACH_SHARED])],
		['session-shared-age', logFor([ATTACH_SHARED])],
		['child-of-alpha', logFor([ATTACH_CHILD])],
		['session-keeper', logFor([ATTACH_SHARED, ATTACH_FILE])],
		['session-archived-twice', logFor([])]
	]);

	const state = {
		archived: ['session-alpha', 'session-shared-age', 'session-archived-twice', 'session-dangling'],
		live: new Set(),
		removed: []
	};
	const indexLog = [];
	const indexes = {
		shouldFail: false,
		async snapshot() {
			indexLog.push('snapshot');
			return { archived: [...state.archived] };
		},
		async apply(plan) {
			indexLog.push(`apply:${plan.targetIds.length + plan.indexOnlyIds.length}`);
			if (indexes.shouldFail) throw new Error('injected index failure');
			const gone = new Set([...plan.targetIds, ...plan.indexOnlyIds]);
			state.archived = state.archived.filter((id) => !gone.has(id));
		},
		async rollback(snapshot) {
			indexLog.push('rollback');
			state.archived = [...snapshot.archived];
		}
	};

	const host = {
		paths: { sessionsRoot, attachmentsRoot, cacheRoot, pluginDataRoot },
		log: () => {},
		archivedIds: async () => [...state.archived],
		listHeaders: async () => headers.map((header) => ({ ...header })),
		isLive: (id) => state.live.has(id),
		readLogText: async (id) => {
			const text = logs.get(id);
			if (text === undefined) throw new Error(`no log for ${id}`);
			return text;
		},
		indexes,
		notifyRemoved: (id) => state.removed.push(id)
	};

	const exists = async (target) => {
		try {
			await fs.stat(target);
			return true;
		} catch {
			return false;
		}
	};

	return { root, host, engine: new CleanupEngine({ host }), dirs, files, state, indexLog, indexes, sessionsRoot, attachmentsRoot, cacheRoot, pluginDataRoot, exists, cacheA, cacheB };
}

async function main() {
	// --- unit-ish helpers -------------------------------------------------
	const ids = extractAttachmentIds(`prefix ${ATTACH_ALPHA} middle ${ATTACH_ALPHA} other ${ATTACH_SHARED}`);
	check(ids.size === 2 && ids.has(ATTACH_ALPHA) && ids.has(ATTACH_SHARED), 'extractAttachmentIds finds distinct durable ids');
	check(encodeSegment('session-abc-123') === 'session-abc-123' && encodeSegment('a/b') === 'a~002Fb', 'encodeSegment mirrors the persistence backend');

	// --- acceptance 3: a non-archived session cannot be deleted ----------
	{
		const fixture = await createFixture();
		let code = null;
		try {
			await fixture.engine.plan({ mode: 'one', sessionId: 'session-keeper' });
		} catch (error) {
			code = error instanceof CleanupError ? error.code : String(error);
		}
		check(code === 'session-not-archived', 'non-archived session is refused with session-not-archived');
		check(!(await fixture.exists(path.join(fixture.pluginDataRoot, 'transactions'))), 'a refused plan creates no transaction directory');
		check(await fixture.exists(fixture.dirs.keeper), 'a refused plan leaves the session on disk');
	}

	// --- acceptance 1 + 2: reference-aware attachment deletion -----------
	{
		const fixture = await createFixture();
		const plan = await fixture.engine.plan({ mode: 'one', sessionId: 'session-alpha' });

		check(plan.targetIds.includes('session-alpha') && plan.targetIds.includes('child-of-alpha'), 'the plan cascades into the archived session\'s subagent child');
		check(!plan.targetIds.includes('session-keeper'), 'the retained session is not a target');
		check(plan.attachments.deletable.some((entry) => entry.id === ATTACH_ALPHA), 'exclusive attachment is scheduled for deletion');
		check(plan.attachments.deletable.some((entry) => entry.id === ATTACH_CHILD), 'the child session\'s exclusive attachment is scheduled for deletion');
		check(plan.attachments.sharedWithRetained.includes(ATTACH_SHARED), 'the shared attachment is recognised as still referenced');
		check(!plan.attachments.deletable.some((entry) => entry.id === ATTACH_SHARED), 'the shared attachment is NOT scheduled for deletion');
		check(!plan.attachments.deletable.some((entry) => entry.id === ATTACH_ORPHAN), 'orphan attachments are left alone by default');
		check(plan.indexOnlyIds.length === 0, 'mode "one" touches only the requested session and its descendants');
		check(plan.caches.length === 2, 'both request-images caches are scheduled for removal');

		const summary = await fixture.engine.execute(plan);
		check(summary.status === 'deleted', 'the transaction commits');
		check(!(await fixture.exists(fixture.dirs.alpha)) && !(await fixture.exists(fixture.dirs.child)), 'both target session directories are gone');
		check(await fixture.exists(fixture.dirs.keeper), 'the retained session directory survives');
		check(!(await fixture.exists(fixture.files.alpha)), 'the exclusive attachment object is gone');
		check(!(await fixture.exists(fixture.files.child)), 'the child-only attachment object is gone');
		check(await fixture.exists(fixture.files.shared), 'the shared attachment object survives');
		check(await fixture.exists(fixture.files.fileObject) && await fixture.exists(fixture.files.fileAlias), 'file objects and their aliases survive when referenced');
		check(await fixture.exists(fixture.files.orphan), 'the orphan object is untouched');
		check(!(await fixture.exists(fixture.cacheA)) && !(await fixture.exists(fixture.cacheB)), 'both request-images caches are gone');
		check(!fixture.state.archived.includes('session-alpha'), 'the archive set drops the deleted id');
		check(fixture.state.archived.includes('session-shared-age'), 'a still-existing archived session stays archived');
		check(fixture.state.archived.includes('session-dangling'), 'mode "one" leaves unrelated archive entries alone');
		check(fixture.state.removed.includes('session-alpha') && fixture.state.removed.includes('child-of-alpha'), 'removal is announced for the UI');
		check(!(await fixture.exists(path.join(fixture.pluginDataRoot, 'transactions', 'x'))), 'the transaction directory is cleaned after commit');
	}

	// --- acceptance 4: a failing index write rolls everything back -------
	{
		const fixture = await createFixture();
		fixture.indexes.shouldFail = true;
		const plan = await fixture.engine.plan({ mode: 'all' });
		let code = null;
		try {
			await fixture.engine.execute(plan);
		} catch (error) {
			code = error instanceof CleanupError ? error.code : String(error);
		}
		check(code === 'cleanup-failed-rolled-back', 'a failed transaction reports cleanup-failed-rolled-back');
		check(await fixture.exists(fixture.dirs.alpha) && await fixture.exists(fixture.dirs.child), 'rolled back: session directories are restored');
		check(await fixture.exists(fixture.files.alpha) && await fixture.exists(fixture.files.child), 'rolled back: attachment objects are restored');
		check(await fixture.exists(fixture.cacheA) && await fixture.exists(fixture.cacheB), 'rolled back: request-images caches are restored');
		check(fixture.state.archived.includes('session-alpha') && fixture.state.archived.includes('session-dangling'), 'rolled back: the archive set is restored');

		const journalDir = path.join(fixture.pluginDataRoot, 'transactions');
		const entries = await fs.readdir(journalDir);
		const journal = JSON.parse(await fs.readFile(path.join(journalDir, entries[0], 'journal.json'), 'utf8'));
		check(journal.state === 'rolled-back' && journal.error.includes('injected index failure'), 'the journal records the failure and the rolled-back state');
		check(!(await fixture.exists(path.join(journalDir, entries[0], 'quarantine'))), 'the quarantine is removed after a complete rollback');
	}

	// --- mode "all" also clears archived ids whose log is already gone ----
	{
		const fixture = await createFixture();
		const plan = await fixture.engine.plan({ mode: 'all' });
		check(plan.indexOnlyIds.includes('session-dangling'), 'an archived id with no log becomes an index-only cleanup in mode "all"');
		await fixture.engine.execute(plan);
		check(fixture.state.archived.length === 0, 'mode "all" empties the archive set, dangling ids included');
	}

	// --- crash recovery ---------------------------------------------------
	{
		const fixture = await createFixture();
		// Simulate a process that died after moving one file but before finishing.
		const txRoot = path.join(fixture.pluginDataRoot, 'transactions', 'crashed-tx');
		const quarantine = path.join(txRoot, 'quarantine', '0000');
		await fs.mkdir(quarantine, { recursive: true });
		const moved = path.join(quarantine, path.basename(fixture.dirs.alpha));
		await fs.rename(fixture.dirs.alpha, moved);
		const journal = {
			version: 1,
			txId: 'crashed-tx',
			state: 'staging',
			moves: [{ from: fixture.dirs.alpha, to: moved, kind: 'session-directory' }],
			indexSnapshot: { archived: [...fixture.state.archived] }
		};
		await fs.writeFile(path.join(txRoot, 'journal.json'), JSON.stringify(journal, null, 2), 'utf8');
		const recovered = await fixture.engine.recover();
		check(recovered.length === 1, 'recover() reports the interrupted transaction');
		check(await fixture.exists(fixture.dirs.alpha), 'recover() restores the moved session directory');
		const repaired = JSON.parse(await fs.readFile(path.join(txRoot, 'journal.json'), 'utf8'));
		check(repaired.state === 'rolled-back', 'the recovered journal is marked rolled-back');
	}

	// --- live target handling --------------------------------------------
	{
		const fixture = await createFixture();
		fixture.state.live.add('session-alpha');
		let code = null;
		try {
			await fixture.engine.plan({ mode: 'one', sessionId: 'session-alpha' });
		} catch (error) {
			code = error instanceof CleanupError ? error.code : String(error);
		}
		check(code === 'target-live', 'mode "one" refuses a running target');

		const plan = await fixture.engine.plan({ mode: 'all' });
		check(
			plan.skippedLive.includes('session-alpha') && plan.skippedLive.includes('child-of-alpha'),
			'mode "all" skips the running session together with its descendants'
		);
		check(!plan.targetIds.includes('session-alpha') && !plan.targetIds.includes('child-of-alpha'), 'the skipped sessions are not targets');
		check(plan.targetIds.includes('session-shared-age'), 'the other archived sessions still proceed');
		check(plan.warnings.some((warning) => warning.includes('skipped')), 'the plan reports what it skipped');
		const summary = await fixture.engine.execute(plan);
		check(summary.skippedLive.includes('session-alpha'), 'the summary carries the skipped sessions');
		check(await fixture.exists(fixture.dirs.alpha) && await fixture.exists(fixture.dirs.child), 'the running session and its child stay on disk');
		check(await fixture.exists(fixture.files.alpha), 'the running session\'s attachment survives');
		check(fixture.state.archived.includes('session-alpha'), 'the running session stays archived');
		check(!fixture.state.archived.includes('session-shared-age'), 'the removable archived sessions leave the archive set');
	}

	// --- unreadable retained log is fail-closed --------------------------
	{
		const fixture = await createFixture();
		const original = fixture.host.readLogText;
		fixture.host.readLogText = async (id, options) => {
			if (id === 'session-keeper') throw new Error('simulated read failure');
			return original(id, options);
		};
		const engine = new CleanupEngine({ host: fixture.host });
		let code = null;
		try {
			await engine.plan({ mode: 'one', sessionId: 'session-alpha' });
		} catch (error) {
			code = error instanceof CleanupError ? error.code : String(error);
		}
		check(code === 'retained-log-unreadable', 'an unreadable surviving log aborts the plan instead of risking an over-delete');
		check(await fixture.exists(fixture.files.alpha), 'nothing was deleted when the plan aborted');
	}

	// --- empty archive set is a no-op ------------------------------------
	{
		const fixture = await createFixture();
		fixture.state.archived = [];
		const plan = await fixture.engine.plan({ mode: 'all' });
		check(plan.noop === true && plan.movable.length === 0, 'an empty archive set plans a no-op');
		check(await fixture.exists(fixture.cacheA), 'a no-op plan does not touch the request-images cache');
	}

	console.log('\narchived-session cleanup engine tests\n');
	console.log(results.join('\n'));
	console.log(`\n${results.length - failures}/${results.length} checks passed`);
	if (failures > 0) process.exitCode = 1;
}

await main();
