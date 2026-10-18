/**
 * Archived-session cleanup engine.
 *
 * Framework-free by design: the Host half injects every capability (path
 * resolution, session-log reads, live-session lookup, live domain indexes)
 * through `host`, so this module runs under plain Node and is exercised
 * directly by the offline fixture tests.
 *
 * Guarantees implemented here:
 *  - every deletion target is checked against the live archive set;
 *  - an attachment is deleted only when no retained session references it;
 *  - nothing is deleted outside the three known roots;
 *  - the whole operation is two-phase (quarantine, then purge) with a journal,
 *    so a failure or a crash restores the previous state instead of leaving a
 *    half-deleted one.
 *
 * @module dsh-archived-cleanup/core
 */
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** Durable attachment identity as recorded in session logs (image and file). */
const ATTACHMENT_ID_SOURCE = 'sha256:[0-9a-f]{64}';

/**
 * One engine failure with a stable code the Host half reports to its callers.
 */
export class CleanupError extends Error {
	/**
	 * @param code - stable machine-readable code.
	 * @param message - human diagnostic.
	 * @param details - structured payload for the caller.
	 */
	constructor(code, message, details = {}) {
		super(message);
		this.name = 'CleanupError';
		this.code = code;
		this.details = details;
	}
}

/**
 * Encode one raw string into a single filesystem-safe path segment, mirroring
 * `@deepseek-ai/dsh-session-persistence-jsonl`'s `encodeSegment` so a session
 * id maps to the directory the persistence backend created for it.
 * @param raw - the raw segment.
 * @returns the encoded segment.
 */
export function encodeSegment(raw) {
	if (raw.length === 0) throw new CleanupError('invalid-segment', 'cannot encode an empty path segment');
	if (raw === '.') return '~002E';
	if (raw === '..') return '~002E~002E';
	let out = '';
	for (let index = 0; index < raw.length; index += 1) {
		const code = raw.charCodeAt(index);
		const character = String.fromCharCode(code);
		if (character !== '~' && /^[A-Za-z0-9._-]$/.test(character)) out += character;
		else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
	}
	return out;
}

/**
 * Collect every durable attachment id mentioned anywhere in one session's
 * serialized event text. Scanning the whole text (rather than walking known
 * message shapes) is deliberately conservative: an unrecognized reference
 * keeps an attachment alive instead of deleting it.
 * @param text - serialized session events.
 * @returns the distinct attachment ids mentioned.
 */
export function extractAttachmentIds(text) {
	const found = new Set();
	if (typeof text !== 'string' || text.length === 0) return found;
	const pattern = new RegExp(ATTACHMENT_ID_SOURCE, 'g');
	let match;
	while ((match = pattern.exec(text)) !== null) found.add(match[0]);
	return found;
}

/** Test whether `child` is strictly inside `parent`. */
function isInside(child, parent) {
	const relative = path.relative(parent, child);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** `stat` that answers `undefined` for a missing path. */
async function statOrNull(target) {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (error?.code === 'ENOENT') return undefined;
		throw error;
	}
}

/** Total bytes and file count under one directory (or one file). */
async function measure(target) {
	const info = await statOrNull(target);
	if (info === undefined) return { bytes: 0, files: 0 };
	if (info.isFile()) return { bytes: info.size, files: 1 };
	let bytes = 0;
	let files = 0;
	const queue = [target];
	while (queue.length > 0) {
		const current = queue.pop();
		let entries;
		try {
			entries = await fs.readdir(current, { withFileTypes: true });
		} catch (error) {
			if (error?.code === 'ENOENT') continue;
			throw error;
		}
		for (const entry of entries) {
			const child = path.join(current, entry.name);
			if (entry.isDirectory()) queue.push(child);
			else {
				try {
					const stat = await fs.stat(child);
					bytes += stat.size;
					files += 1;
				} catch (error) {
					if (error?.code !== 'ENOENT') throw error;
				}
			}
		}
	}
	return { bytes, files };
}

/**
 * Move one file or directory, retrying transient Windows sharing failures and
 * falling back to copy+remove when a rename cannot cross a volume boundary.
 * @param from - existing source path.
 * @param to - destination path that must not exist.
 */
async function movePath(from, to) {
	let lastError;
	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			lastError = error;
			if (error?.code === 'ENOENT') throw error;
			if (error?.code === 'EXDEV') break;
			if (error?.code !== 'EPERM' && error?.code !== 'EACCES' && error?.code !== 'EBUSY') throw error;
			await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
		}
	}
	if (lastError?.code !== 'EXDEV') throw lastError;
	await fs.cp(from, to, { recursive: true, force: true });
	await fs.rm(from, { recursive: true, force: true });
}

/** Serialize one small JSON document durably (write temp, then rename). */
async function writeJsonAtomic(target, value) {
	const temporary = `${target}.tmp`;
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
	await fs.rename(temporary, target);
}

/**
 * The cleanup engine. One instance per Host plugin activation.
 */
export class CleanupEngine {
	/**
	 * @param options - engine wiring.
	 * @param options.host - capability adapter supplied by the Host half.
	 * @param options.log - optional `(level, message, data)` logger.
	 */
	constructor({ host, log }) {
		this.host = host;
		this.log = typeof log === 'function' ? log : () => {};
	}

	/**
	 * Report the resolvable roots, the archive set, and how much of it still
	 * has a log on disk. Read-only.
	 * @returns the status view.
	 */
	async status() {
		const archived = await this.host.archivedIds();
		const headers = await this.host.listHeaders();
		const present = new Set(headers.map((header) => header.id));
		return {
			roots: {
				sessions: this.host.paths.sessionsRoot,
				attachments: this.host.paths.attachmentsRoot,
				cache: this.host.paths.cacheRoot ?? null,
				data: this.host.paths.pluginDataRoot
			},
			sessions: headers.length,
			archived: archived.length,
			archivedWithLog: archived.filter((id) => present.has(id)).length,
			archivedWithoutLog: archived.filter((id) => !present.has(id)),
			liveTargets: archived.filter((id) => this.host.isLive(id))
		};
	}

	/**
	 * Build a complete, side-effect-free deletion plan.
	 *
	 * Every step is fail-closed: an unreadable session log on either side
	 * aborts the plan, and a live target refuses it outright.
	 * @param request - `{ mode: 'one' | 'all', sessionId?: string }`.
	 * @returns the plan.
	 */
	async plan(request = {}) {
		const mode = request.mode === 'all' ? 'all' : 'one';
		const archived = await this.host.archivedIds();
		const archiveSet = new Set(archived);
		const headers = await this.host.listHeaders();
		const byId = new Map(headers.map((header) => [header.id, header]));
		const warnings = [];

		let requested;
		if (mode === 'one') {
			const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
			if (sessionId === '') throw new CleanupError('session-id-required', 'mode "one" requires an exact sessionId', { mode });
			if (!archiveSet.has(sessionId)) {
				throw new CleanupError(
					'session-not-archived',
					`session ${sessionId} is not in the archive set; only archived sessions can be removed`,
					{ sessionId, archivedCount: archived.length }
				);
			}
			requested = [sessionId];
		} else requested = [...archived];

		const targets = new Set();
		const dangling = [];
		for (const id of requested) {
			if (byId.has(id)) targets.add(id);
			else if (mode === 'one') {
				throw new CleanupError('session-log-missing', `session ${id} is archived but has no stored log to remove`, { sessionId: id });
			} else dangling.push(id);
		}

		const childrenOf = new Map();
		for (const header of headers) {
			if (header.parentSession === undefined) continue;
			const list = childrenOf.get(header.parentSession) ?? [];
			list.push(header.id);
			childrenOf.set(header.parentSession, list);
		}
		const cascadeQueue = [...targets];
		while (cascadeQueue.length > 0) {
			const parent = cascadeQueue.pop();
			for (const child of childrenOf.get(parent) ?? []) {
				if (targets.has(child)) continue;
				targets.add(child);
				cascadeQueue.push(child);
			}
		}

		// A running session is never deleted: its log is still being written.
		// `one` refuses outright; `all` skips the live session and every
		// descendant of it, then reports exactly what was skipped.
		let targetIds = [...targets];
		let skippedLive = [];
		const live = targetIds.filter((id) => this.host.isLive(id));
		if (live.length > 0) {
			if (mode === 'one') {
				throw new CleanupError(
					'target-live',
					`refusing to delete ${live.length} session(s) that are currently running; close them first`,
					{ live }
				);
			}
			const drop = new Set(live);
			const liveQueue = [...live];
			while (liveQueue.length > 0) {
				const parent = liveQueue.pop();
				for (const child of childrenOf.get(parent) ?? []) {
					if (drop.has(child)) continue;
					drop.add(child);
					liveQueue.push(child);
				}
			}
			skippedLive = [...drop].sort();
			targetIds = targetIds.filter((id) => !drop.has(id));
			warnings.push(`${skippedLive.length} running session(s) were skipped and left untouched: ${skippedLive.join(', ')}`);
		}
		const targetSet = new Set(targetIds);

		// Target side: what does each doomed session reference?
		const targetRefs = new Map();
		const referencedByTargets = new Set();
		for (const id of targetIds) {
			let text;
			try {
				text = await this.host.readLogText(id, { live: false });
			} catch (error) {
				throw new CleanupError('target-log-unreadable', `cannot read the log of target session ${id}: ${error?.message ?? error}`, {
					sessionId: id,
					cause: String(error?.message ?? error)
				});
			}
			const refs = extractAttachmentIds(text);
			targetRefs.set(id, refs);
			for (const ref of refs) referencedByTargets.add(ref);
		}

		// Retained side: any surviving session keeps its attachments alive.
		const remaining = new Set(referencedByTargets);
		const retainedCount = headers.length - targetIds.length;
		if (remaining.size > 0) {
			for (const header of headers) {
				if (targetSet.has(header.id)) continue;
				let text;
				try {
					text = await this.host.readLogText(header.id, { live: this.host.isLive(header.id) });
				} catch (error) {
					throw new CleanupError(
						'retained-log-unreadable',
						`cannot verify references held by surviving session ${header.id}; nothing was deleted: ${error?.message ?? error}`,
						{ sessionId: header.id, cause: String(error?.message ?? error) }
					);
				}
				for (const ref of extractAttachmentIds(text)) {
					if (remaining.delete(ref)) {
						if (remaining.size === 0) break;
					}
				}
				if (remaining.size === 0) break;
			}
		}

		const shared = [...referencedByTargets].filter((id) => !remaining.has(id));
		const deletableAttachments = [];
		const missingAttachments = [];
		for (const id of remaining) {
			const digest = id.slice('sha256:'.length);
			const prefix = digest.slice(0, 2);
			const candidates = [
				{ kind: 'image-object', path: path.join(this.host.paths.attachmentsRoot, 'objects', prefix, digest) },
				{ kind: 'file-object', path: path.join(this.host.paths.attachmentsRoot, 'file-objects', prefix, digest) },
				{ kind: 'file-alias', path: path.join(this.host.paths.attachmentsRoot, 'files', prefix, digest) }
			];
			const paths = [];
			let bytes = 0;
			for (const candidate of candidates) {
				const info = await statOrNull(candidate.path);
				if (info === undefined) continue;
				const measured = await measure(candidate.path);
				paths.push({ path: candidate.path, kind: candidate.kind, bytes: measured.bytes, files: measured.files });
				bytes += measured.bytes;
			}
			if (paths.length === 0) {
				missingAttachments.push(id);
				continue;
			}
			deletableAttachments.push({ id, paths, bytes });
		}

		// Derived request-image caches: keyed by (source, target), so they cannot
		// be attributed to one session. Whole directories are dropped; they are
		// pure caches and rebuild on the next image view.
		const caches = [];
		const cacheCandidates = [
			this.host.paths.cacheRoot === undefined ? undefined : path.join(this.host.paths.cacheRoot, 'request-images'),
			path.join(this.host.paths.attachmentsRoot, 'request-images')
		];
		for (const candidate of cacheCandidates) {
			if (candidate === undefined) continue;
			const info = await statOrNull(candidate);
			if (info === undefined || !info.isDirectory()) continue;
			const measured = await measure(candidate);
			if (measured.files === 0) continue;
			caches.push({ path: candidate, bytes: measured.bytes, files: measured.files });
		}

		// Session directories, located by scanning the store rather than by
		// re-deriving the project key.
		const sessionDirs = await this.#resolveSessionDirs(targetIds);
		const sessions = [];
		let sessionBytes = 0;
		for (const id of targetIds) {
			const header = byId.get(id);
			const dir = sessionDirs.get(id);
			const measured = dir === undefined ? { bytes: 0, files: 0 } : await measure(dir);
			sessionBytes += measured.bytes;
			sessions.push({
				id,
				kind: requested.includes(id) ? 'archived' : 'descendant',
				title: header?.title ?? null,
				cwd: header?.cwd ?? null,
				parentSession: header?.parentSession ?? null,
				directory: dir ?? null,
				bytes: measured.bytes,
				attachmentCount: targetRefs.get(id)?.size ?? 0
			});
		}

		const movable = [];
		const guard = (target, root, kind, label) => {
			if (!isInside(target, root)) {
				throw new CleanupError('unsafe-path', `refusing to touch ${target}: it is not strictly inside ${root}`, { target, root, kind });
			}
			movable.push({ path: target, kind, label });
		};
		for (const session of sessions) if (session.directory !== null) guard(session.directory, this.host.paths.sessionsRoot, 'session-directory', session.id);
		for (const attachment of deletableAttachments) {
			for (const entry of attachment.paths) guard(entry.path, this.host.paths.attachmentsRoot, entry.kind, attachment.id);
		}
		for (const cache of caches) {
			const root = isInside(cache.path, this.host.paths.attachmentsRoot) ? this.host.paths.attachmentsRoot : this.host.paths.cacheRoot;
			guard(cache.path, root, 'request-images-cache', 'request-images');
		}

		const attachmentBytes = deletableAttachments.reduce((total, entry) => total + entry.bytes, 0);
		const cacheBytes = caches.reduce((total, entry) => total + entry.bytes, 0);

		// Nothing to remove at all: report a no-op plan instead of dropping the
		// derived caches for no reason.
		if (targetIds.length === 0 && dangling.length === 0) {
			return {
				mode,
				requestedSessionId: mode === 'one' ? requested[0] : null,
				createdAt: new Date().toISOString(),
				noop: true,
				targetIds: [],
				skippedLive,
				indexOnlyIds: [],
				sessions: [],
				retainedCount: headers.length,
				attachments: { referencedByTargets: [], sharedWithRetained: [], deletable: [], missing: [], bytes: 0 },
				caches: [],
				cacheBytes: 0,
				sessionBytes: 0,
				totalBytes: 0,
				movable: [],
				warnings: warnings.length === 0 ? ['no archived session to remove'] : warnings
			};
		}

		return {
			mode,
			requestedSessionId: mode === 'one' ? requested[0] : null,
			createdAt: new Date().toISOString(),
			targetIds,
			skippedLive,
			indexOnlyIds: dangling,
			sessions,
			retainedCount,
			attachments: {
				referencedByTargets: [...referencedByTargets].sort(),
				sharedWithRetained: shared.sort(),
				deletable: deletableAttachments,
				missing: missingAttachments.sort(),
				bytes: attachmentBytes
			},
			caches,
			cacheBytes,
			sessionBytes,
			totalBytes: attachmentBytes + cacheBytes + sessionBytes,
			movable,
			warnings
		};
	}

	/**
	 * Execute one plan as a two-phase transaction.
	 *
	 * Phase 1 moves every doomed path into a quarantine directory on the same
	 * volume, journalling each move. Phase 2 mutates the live indexes. Only
	 * after both succeed is the quarantine purged. Any failure rolls the
	 * indexes back and restores every moved path.
	 * @param plan - a plan produced by {@link CleanupEngine#plan}.
	 * @param options - optional `{ dryRun }`.
	 * @returns the executed summary.
	 */
	async execute(plan, options = {}) {
		if (plan.noop === true) return { ...summarize(plan), dryRun: options.dryRun === true, status: 'noop' };
		if (options.dryRun === true) return { ...summarize(plan), dryRun: true, status: 'planned' };
		const host = this.host;
		const transactionsRoot = path.join(host.paths.pluginDataRoot, 'transactions');
		const txId = `${new Date().toISOString().replace(/[:.]/g, '')}-${randomUUID().slice(0, 8)}`;
		const txRoot = path.join(transactionsRoot, txId);
		const quarantine = path.join(txRoot, 'quarantine');
		const journalPath = path.join(txRoot, 'journal.json');
		await fs.mkdir(quarantine, { recursive: true });

		const journal = {
			version: 1,
			txId,
			startedAt: new Date().toISOString(),
			state: 'staging',
			targetIds: plan.targetIds,
			indexOnlyIds: plan.indexOnlyIds,
			plannedPaths: plan.movable.length,
			moves: [],
			indexSnapshot: null,
			error: null
		};
		await writeJsonAtomic(journalPath, journal);

		let indexSnapshot = null;
		let mutated = false;
		try {
			let slot = 0;
			for (const item of plan.movable) {
				const info = await statOrNull(item.path);
				if (info === undefined) {
					journal.moves.push({ from: item.path, to: null, kind: item.kind, skipped: 'already-absent' });
					await writeJsonAtomic(journalPath, journal);
					continue;
				}
				const to = path.join(quarantine, String(slot).padStart(4, '0'), path.basename(item.path));
				await fs.mkdir(path.dirname(to), { recursive: true });
				await movePath(item.path, to);
				journal.moves.push({ from: item.path, to, kind: item.kind, skipped: null });
				slot += 1;
				await writeJsonAtomic(journalPath, journal);
			}

			journal.state = 'indexing';
			await writeJsonAtomic(journalPath, journal);
			indexSnapshot = await host.indexes.snapshot(plan);
			journal.indexSnapshot = indexSnapshot;
			await writeJsonAtomic(journalPath, journal);
			await host.indexes.apply(plan);
			mutated = true;

			journal.state = 'purging';
			await writeJsonAtomic(journalPath, journal);
			await fs.rm(quarantine, { recursive: true, force: true });
			journal.state = 'done';
			journal.finishedAt = new Date().toISOString();
			await writeJsonAtomic(journalPath, journal);

			for (const id of [...plan.targetIds, ...plan.indexOnlyIds]) host.notifyRemoved?.(id);

			const summary = { ...summarize(plan), dryRun: false, status: 'deleted', txId, finishedAt: journal.finishedAt };
			// Everything past this point is bookkeeping: the transaction is
			// already committed, so a failure here must never trigger a rollback.
			try {
				await writeJsonAtomic(path.join(host.paths.pluginDataRoot, 'reports', `${txId}.json`), summary);
			} catch (reportError) {
				this.log('warn', `could not write the cleanup report for ${txId}`, { error: String(reportError?.message ?? reportError) });
			}
			try {
				await fs.rm(txRoot, { recursive: true, force: true });
			} catch (cleanupError) {
				this.log('warn', `could not remove the transaction directory ${txId}`, { error: String(cleanupError?.message ?? cleanupError) });
			}
			this.log('info', `archived cleanup ${txId} committed`, { sessions: plan.targetIds.length, bytes: summary.totalBytes });
			return summary;
		} catch (error) {
			const rollbackErrors = [];
			if (mutated && indexSnapshot !== null) {
				try {
					await host.indexes.rollback(indexSnapshot);
				} catch (rollbackError) {
					rollbackErrors.push(`index rollback: ${rollbackError?.message ?? rollbackError}`);
				}
			}
			for (const move of [...journal.moves].reverse()) {
				if (move.to === null) continue;
				try {
					await movePath(move.to, move.from);
				} catch (rollbackError) {
					rollbackErrors.push(`restore ${move.from}: ${rollbackError?.message ?? rollbackError}`);
				}
			}
			journal.state = rollbackErrors.length === 0 ? 'rolled-back' : 'rollback-incomplete';
			journal.error = String(error?.message ?? error);
			journal.rollbackErrors = rollbackErrors;
			journal.finishedAt = new Date().toISOString();
			if (rollbackErrors.length === 0) {
				// A complete restore leaves nothing behind but the audit journal.
				await fs.rm(quarantine, { recursive: true, force: true }).catch(() => {});
			}
			try {
				await writeJsonAtomic(journalPath, journal);
			} catch {
				/* the journal on disk stays as the last durable checkpoint */
			}
			this.log('error', `archived cleanup ${txId} failed and was rolled back`, { error: journal.error, rollbackErrors });
			throw new CleanupError('cleanup-failed-rolled-back', `cleanup failed and was rolled back: ${journal.error}`, {
				txId,
				cause: journal.error,
				rollbackErrors,
				state: journal.state
			});
		}
	}

	/**
	 * Restore any transaction that did not reach a terminal state — the crash
	 * path for "no half-deleted state".
	 * @returns the transaction ids that were restored.
	 */
	async recover() {
		const transactionsRoot = path.join(this.host.paths.pluginDataRoot, 'transactions');
		let entries;
		try {
			entries = await fs.readdir(transactionsRoot, { withFileTypes: true });
		} catch (error) {
			if (error?.code === 'ENOENT') return [];
			throw error;
		}
		const recovered = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const journalPath = path.join(transactionsRoot, entry.name, 'journal.json');
			let journal;
			try {
				journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
			} catch {
				continue;
			}
			if (journal.state === 'done' || journal.state === 'rolled-back') continue;
			const rollbackErrors = [];
			if (journal.indexSnapshot != null) {
				try {
					await this.host.indexes.rollback(journal.indexSnapshot);
				} catch (error) {
					rollbackErrors.push(`index rollback: ${error?.message ?? error}`);
				}
			}
			for (const move of [...(journal.moves ?? [])].reverse()) {
				if (move.to == null) continue;
				try {
					const info = await statOrNull(move.to);
					if (info === undefined) continue;
					await movePath(move.to, move.from);
				} catch (error) {
					rollbackErrors.push(`restore ${move.from}: ${error?.message ?? error}`);
				}
			}
			journal.state = rollbackErrors.length === 0 ? 'rolled-back' : 'rollback-incomplete';
			journal.recoveredAt = new Date().toISOString();
			journal.rollbackErrors = rollbackErrors;
			await writeJsonAtomic(journalPath, journal);
			if (rollbackErrors.length === 0) {
				await fs.rm(path.join(transactionsRoot, entry.name, 'quarantine'), { recursive: true, force: true }).catch(() => {});
			}
			recovered.push(entry.name);
			this.log('warn', `recovered interrupted cleanup transaction ${entry.name}`, { rollbackErrors });
		}
		return recovered;
	}

	/**
	 * Map every requested session id to its directory under the session root.
	 * @param ids - session ids to locate.
	 * @returns id → absolute directory for the ids that have one.
	 */
	async #resolveSessionDirs(ids) {
		const found = new Map();
		if (ids.length === 0) return found;
		const wanted = new Map(ids.map((id) => [encodeSegment(id), id]));
		let projects;
		try {
			projects = await fs.readdir(this.host.paths.sessionsRoot, { withFileTypes: true });
		} catch (error) {
			if (error?.code === 'ENOENT') return found;
			throw error;
		}
		for (const project of projects) {
			if (!project.isDirectory()) continue;
			const projectDir = path.join(this.host.paths.sessionsRoot, project.name);
			let entries;
			try {
				entries = await fs.readdir(projectDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				const id = wanted.get(entry.name);
				if (id === undefined) continue;
				found.set(id, path.join(projectDir, entry.name));
			}
		}
		return found;
	}
}

/** Compact, JSON-safe view of one plan for reports and tool output. */
export function summarize(plan) {
	return {
		mode: plan.mode,
		requestedSessionId: plan.requestedSessionId,
		sessions: plan.sessions.map((session) => ({
			id: session.id,
			kind: session.kind,
			title: session.title,
			bytes: session.bytes,
			attachmentCount: session.attachmentCount
		})),
		indexOnlyIds: plan.indexOnlyIds,
		skippedLive: plan.skippedLive ?? [],
		retainedCount: plan.retainedCount,
		attachments: {
			referenced: plan.attachments.referencedByTargets.length,
			sharedWithRetained: plan.attachments.sharedWithRetained,
			sharedCount: plan.attachments.sharedWithRetained.length,
			deleted: plan.attachments.deletable.map((entry) => ({ id: entry.id, bytes: entry.bytes, paths: entry.paths.length })),
			deletedCount: plan.attachments.deletable.length,
			deletedBytes: plan.attachments.bytes,
			missing: plan.attachments.missing
		},
		caches: plan.caches,
		cacheBytes: plan.cacheBytes,
		sessionBytes: plan.sessionBytes,
		totalBytes: plan.totalBytes,
		warnings: plan.warnings
	};
}
