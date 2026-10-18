/**
 * Host half of `dsh-archived-cleanup`.
 *
 * Responsibilities:
 *  - resolve the session, attachment, cache, and plugin-data roots from the
 *    live services (never from a guessed path);
 *  - adapt the live Harness services into the framework-free engine
 *    (`./core.js`): session headers, session-log text, live-session lookup,
 *    and the durable indexes that must stop referencing the removed sessions;
 *  - expose the capability to the browser through a Typert *source-mode*
 *    Remote namespace (`archivedCleanup`), written by hand so this bundle
 *    imports no Harness package;
 *  - expose it to the model as the `delete_archived_session` tool.
 *
 * @module dsh-archived-cleanup
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CleanupEngine, CleanupError, summarize } from './core.js';

/**
 * Hard dependency on the tool registry: the model-facing surface is a service
 * property access, which Cordis only permits for a declared dependency. Every
 * other service this plugin touches is read through `ctx.get()` with an
 * explicit undefined check, so a profile without one deactivates that feature
 * instead of failing activation.
 */
export const inject = ['tools'];

/**
 * The prototype property the Typert protocol's `@Remote` decorator would set.
 * Writing it by hand puts this service on the Gateway's source-mode path,
 * whose descriptors are derived from the method's own parameter names.
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** Cordis service key and wire namespace for the Remote surface. */
const SERVICE_KEY = 'archivedCleanup';

/** Read one service property without letting a proxy throw. */
function readProperty(target, key) {
	try {
		return target?.[key];
	} catch {
		return undefined;
	}
}

/** Normalize a stored session header into the shape the engine consumes. */
function normalizeHeader(header) {
	if (header === null || typeof header !== 'object') return undefined;
	const id = header.id;
	if (typeof id !== 'string' || id.length === 0) return undefined;
	return {
		id,
		cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
		parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
		createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0
	};
}

/**
 * Build the capability adapter the engine talks to. Everything here is read
 * from live services on each call so a reloaded profile cannot leave the
 * engine holding a stale root or a stale archive set.
 * @param ctx - the plugin's Cordis context.
 * @param log - `(level, message, data)` logger.
 * @returns the adapter.
 */
function createHost(ctx, log) {
	/**
	 * Resolve the four roots. The first choice is always the owning service's
	 * own resolved property (`sessionPersistence.root`, `attachments.root`),
	 * because that is what the backend actually uses.
	 */
	const resolvePaths = async () => {
		const persistence = ctx.get('sessionPersistence');
		const attachments = ctx.get('attachments');
		let sessionsRoot = readProperty(persistence, 'root');
		let attachmentsRoot = readProperty(attachments, 'root');
		let cacheRoot = readProperty(attachments, 'cacheRoot');
		if (typeof sessionsRoot !== 'string') sessionsRoot = undefined;
		if (typeof attachmentsRoot !== 'string') attachmentsRoot = undefined;
		if (typeof cacheRoot !== 'string') cacheRoot = undefined;

		let dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : undefined;
		const loader = ctx.get('loader');
		if ((sessionsRoot === undefined || attachmentsRoot === undefined || dshHome === undefined) && loader !== undefined) {
			let entries = [];
			try {
				entries = [...loader.entries()];
			} catch {
				entries = [];
			}
			for (const entry of entries) {
				const name = entry?.options?.name;
				const config = entry?.options?.config;
				if (typeof config !== 'object' || config === null) continue;
				if (sessionsRoot === undefined && typeof name === 'string' && name.includes('session-persistence') && typeof config.root === 'string') {
					sessionsRoot = config.root;
				}
				if (dshHome === undefined && typeof config.dshHome === 'string') dshHome = config.dshHome;
			}
		}
		if (dshHome === undefined && sessionsRoot !== undefined) dshHome = path.dirname(sessionsRoot);
		if (sessionsRoot === undefined && dshHome !== undefined) sessionsRoot = path.join(dshHome, 'sessions');
		if (attachmentsRoot === undefined && dshHome !== undefined) attachmentsRoot = path.join(dshHome, 'attachments', 'v1');
		if (cacheRoot === undefined && dshHome !== undefined) cacheRoot = path.join(dshHome, 'cache', 'attachments');

		if (sessionsRoot === undefined || attachmentsRoot === undefined || dshHome === undefined) {
			throw new CleanupError('paths-unresolved', 'cannot resolve the harness data roots; refusing to delete anything', {
				sessionsRoot: sessionsRoot ?? null,
				attachmentsRoot: attachmentsRoot ?? null,
				dshHome: dshHome ?? null
			});
		}
		const sessionsInfo = await fs.stat(sessionsRoot).catch(() => undefined);
		if (sessionsInfo === undefined || !sessionsInfo.isDirectory()) {
			throw new CleanupError('paths-unresolved', `the session root ${sessionsRoot} is not a directory`, { sessionsRoot });
		}
		return {
			sessionsRoot,
			attachmentsRoot,
			cacheRoot,
			pluginDataRoot: path.join(dshHome, 'plugin-data', 'archived-cleanup')
		};
	};

	const listHeaders = async () => {
		const collected = new Map();
		const sessions = ctx.get('sessions');
		if (sessions !== undefined) {
			let live = [];
			try {
				live = sessions.list();
			} catch {
				live = [];
			}
			for (const session of live) {
				const normalized = normalizeHeader(session?.header);
				if (normalized !== undefined) collected.set(normalized.id, normalized);
			}
		}
		const persistence = ctx.get('sessionPersistence');
		if (persistence !== undefined) {
			const snapshots = await persistence.list();
			for (const snapshot of snapshots) {
				const normalized = normalizeHeader(snapshot?.header);
				if (normalized !== undefined && !collected.has(normalized.id)) collected.set(normalized.id, normalized);
			}
		}
		return [...collected.values()];
	};

	const isLive = (id) => {
		const sessions = ctx.get('sessions');
		try {
			if (sessions?.get(id) !== undefined) return true;
		} catch {
			/* treat an unreadable store as "not live" only after the agent check below */
		}
		const agents = ctx.get('agents');
		try {
			return agents?.get(id) !== undefined;
		} catch {
			return false;
		}
	};

	/**
	 * Read one complete session log as text. Live sessions come from the
	 * live-preferred query service so unflushed events are included; stored
	 * sessions are streamed through the persistence handle in event batches to
	 * keep peak memory bounded.
	 */
	const readLogText = async (id, options = {}) => {
		const query = ctx.get('sessionQuery');
		if (options.live === true && query?.readSession !== undefined) {
			const snapshot = await query.readSession(id);
			return JSON.stringify(snapshot?.events ?? []);
		}
		const persistence = ctx.get('sessionPersistence');
		if (persistence?.open !== undefined) {
			const handle = await persistence.open(id, 'read');
			try {
				const batches = [];
				const batchSize = 1000;
				let offset = 0;
				for (;;) {
					const page = await handle.read(offset, batchSize);
					const events = page?.events ?? [];
					if (events.length === 0) break;
					batches.push(JSON.stringify(events));
					offset += events.length;
					if (events.length < batchSize) break;
				}
				if (batches.length > 0) return batches.join('\n');
			} finally {
				try {
					await handle.close();
				} catch {
					/* a failed close must not mask the read result */
				}
			}
		}
		if (query?.readSession !== undefined) {
			const snapshot = await query.readSession(id);
			return JSON.stringify(snapshot?.events ?? []);
		}
		throw new CleanupError('log-unreadable', `no session backend can read ${id}`, { sessionId: id });
	};

	const archivedIds = async () => {
		const registry = ctx.get('workspaceRegistry');
		if (registry === undefined) {
			throw new CleanupError('registry-missing', 'the workspace registry is not mounted, so archived state cannot be established; nothing was deleted', {});
		}
		return [...registry.archivedSessionIds].map(String);
	};

	/**
	 * The durable indexes that must stop naming a deleted session.
	 *
	 * The workspace registry caches its own state in memory and has no
	 * change-listener, so it is mutated exclusively through its own API; the
	 * projection cache and message-feedback stores are plain domain tables
	 * read through the shared live domain instance.
	 */
	const indexes = {
		snapshot: async (plan) => {
			const snapshot = { archived: null, pinned: null, workspaceRecords: {}, projcache: {}, feedback: {} };
			const registry = ctx.get('workspaceRegistry');
			if (registry !== undefined) {
				snapshot.archived = [...registry.archivedSessionIds].map(String);
				snapshot.pinned = [...registry.pinnedSessionIds].map(String);
			}
			const domain = ctx.get('storageDomain');
			const workspaceDomain = domain?.get('workspace');
			if (workspaceDomain !== undefined) {
				const ids = new Set([...plan.targetIds, ...plan.indexOnlyIds]);
				for (const [workspaceId, record] of workspaceDomain.table('workspaces').entries()) {
					if (!Array.isArray(record?.sessionIds)) continue;
					if (!record.sessionIds.some((id) => ids.has(String(id)))) continue;
					snapshot.workspaceRecords[workspaceId] = JSON.parse(JSON.stringify(record));
				}
			}
			const projcacheDomain = domain?.get('session_projcache');
			if (projcacheDomain !== undefined) {
				const table = projcacheDomain.table('sessions');
				for (const id of [...plan.targetIds, ...plan.indexOnlyIds]) {
					const value = table.get(id);
					if (value !== undefined) snapshot.projcache[id] = value;
				}
			}
			const feedbackDomain = domain?.get('message_feedback');
			if (feedbackDomain !== undefined) {
				const table = feedbackDomain.table('sessions');
				for (const id of [...plan.targetIds, ...plan.indexOnlyIds]) {
					const value = table.get(id);
					if (value !== undefined) snapshot.feedback[id] = value;
				}
			}
			return snapshot;
		},

		apply: async (plan) => {
			const domain = ctx.get('storageDomain');
			const projcacheDomain = domain?.get('session_projcache');
			if (projcacheDomain !== undefined) {
				const table = projcacheDomain.table('sessions');
				for (const id of [...plan.targetIds, ...plan.indexOnlyIds]) {
					if (table.get(id) !== undefined) await table.delete(id);
				}
			}
			const feedbackDomain = domain?.get('message_feedback');
			if (feedbackDomain !== undefined) {
				const table = feedbackDomain.table('sessions');
				for (const id of [...plan.targetIds, ...plan.indexOnlyIds]) {
					if (table.get(id) !== undefined) await table.delete(id);
				}
			}
			const registry = ctx.get('workspaceRegistry');
			if (registry !== undefined) {
				for (const id of plan.targetIds) {
					for (const workspace of registry.list()) {
						if (!workspace.sessionIds.some((candidate) => String(candidate) === id)) continue;
						const entity = registry.get(workspace.id);
						if (entity?.detachSession !== undefined) await entity.detachSession(id);
					}
				}
				for (const id of [...plan.targetIds, ...plan.indexOnlyIds]) {
					await registry.unarchiveSession(id);
				}
			}
		},

		rollback: async (snapshot) => {
			const domain = ctx.get('storageDomain');
			const projcacheDomain = domain?.get('session_projcache');
			if (projcacheDomain !== undefined) {
				const table = projcacheDomain.table('sessions');
				for (const [id, value] of Object.entries(snapshot.projcache ?? {})) await table.put(id, value);
			}
			const feedbackDomain = domain?.get('message_feedback');
			if (feedbackDomain !== undefined) {
				const table = feedbackDomain.table('sessions');
				for (const [id, value] of Object.entries(snapshot.feedback ?? {})) await table.put(id, value);
			}
			const registry = ctx.get('workspaceRegistry');
			if (registry !== undefined) {
				for (const [workspaceId, record] of Object.entries(snapshot.workspaceRecords ?? {})) {
					const entity = registry.get(workspaceId);
					const current = entity?.sessionIds ?? [];
					for (const id of record.sessionIds.map(String)) {
						if (current.some((candidate) => String(candidate) === id)) continue;
						try {
							await entity?.attachSession?.(id);
						} catch (error) {
							log('warn', `could not re-attach session ${id} to workspace ${workspaceId}`, { error: String(error?.message ?? error) });
						}
					}
				}
				for (const id of snapshot.archived ?? []) {
					if (registry.archivedSessionIds.some((candidate) => String(candidate) === id)) continue;
					try {
						await registry.archiveSession(id, { stopActivity: true });
					} catch (error) {
						log('warn', `could not re-archive session ${id}`, { error: String(error?.message ?? error) });
					}
				}
			}
		}
	};

	return {
		paths: undefined,
		log,
		archivedIds,
		listHeaders,
		isLive,
		readLogText,
		indexes,
		async prepare() {
			this.paths = await resolvePaths();
			return this.paths;
		},
		notifyRemoved: (id) => {
			try {
				ctx.emit('api-session/removed', id);
			} catch (error) {
				log('warn', `could not announce removal of ${id}`, { error: String(error?.message ?? error) });
			}
		}
	};
}

/**
 * The Remote surface. Source-mode descriptors are derived from these methods'
 * parameter names, so the methods must keep plain identifier parameters and
 * the descriptor below must stay in declaration order.
 */
class ArchivedCleanupService {
	/**
	 * @param host - the capability adapter.
	 * @param engine - the cleanup engine.
	 */
	constructor(host, engine) {
		this.host = host;
		this.engine = engine;
		this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY });
	}

	/** Read-only: what the engine can see and what an `all` cleanup would remove. */
	async status() {
		await this.host.prepare();
		return { ok: true, value: await this.engine.status() };
	}

	/**
	 * Plan a cleanup without touching anything.
	 * @param mode - `"one"` or `"all"`.
	 * @param sessionId - exact session id for `"one"`.
	 */
	async preview(mode, sessionId) {
		await this.host.prepare();
		const plan = await this.engine.plan({ mode, sessionId });
		return { ok: true, value: summarize(plan) };
	}

	/**
	 * Delete one archived session, or every archived session.
	 * @param mode - `"one"` or `"all"`.
	 * @param sessionId - exact session id for `"one"`.
	 * @param confirm - must be exactly `true`; anything else refuses.
	 */
	async deleteArchived(mode, sessionId, confirm) {
		if (confirm !== true) {
			return { ok: false, error: { code: 'confirm-required', message: 'pass confirm: true to delete archived sessions', details: {} } };
		}
		await this.host.prepare();
		try {
			const plan = await this.engine.plan({ mode, sessionId });
			const summary = await this.engine.execute(plan);
			return { ok: true, value: summary };
		} catch (error) {
			if (error instanceof CleanupError) return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
			return { ok: false, error: { code: 'cleanup-failed', message: String(error?.message ?? error), details: {} } };
		}
	}
}

Object.defineProperty(ArchivedCleanupService.prototype, REMOTE_METHOD_DESCRIPTOR, {
	configurable: true,
	value: Object.freeze({
		version: 1,
		methods: Object.freeze([
			Object.freeze({ method: 'status', invocation: Object.freeze({ kind: 'direct' }) }),
			Object.freeze({ method: 'preview', invocation: Object.freeze({ kind: 'direct' }) }),
			Object.freeze({ method: 'deleteArchived', invocation: Object.freeze({ kind: 'direct' }) })
		])
	})
});

/** Exported for the wire-contract test; not part of the plugin's runtime surface. */
export { ArchivedCleanupService, REMOTE_METHOD_DESCRIPTOR, SERVICE_KEY };

/** Tool description shown to the model. */
const TOOL_DESCRIPTION = [
	'Delete one archived session, or every archived session, together with the attachments only it referenced.',
	'A session can be removed only while it is in the archive set; a running session is refused.',
	'An attachment is deleted only when no surviving session references it (attachments are content-addressed and shared).',
	'Descendant subagent sessions of an archived session are removed with it.',
	'Every call runs as a transaction: on any failure the previous state is restored, so no half-deleted state is left.',
	'Call it with dry_run first to inspect the plan; deleting needs confirm: true.'
].join(' ');

/**
 * Register the host capability.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
	const log = (level, message, data) => {
		try {
			const logger = ctx.logger;
			const emit = typeof logger?.[level] === 'function' ? logger[level].bind(logger) : undefined;
			if (emit !== undefined) emit(`[archived-cleanup] ${message}`, data ?? '');
		} catch {
			/* logging must never break the feature */
		}
	};

	const host = createHost(ctx, log);
	const engine = new CleanupEngine({ host, log });
	const service = new ArchivedCleanupService(host, engine);

	ctx.provide(SERVICE_KEY, service);

	// Startup recovery: a process that died mid-transaction left a journal;
	// restore it before anything else can run. The workspace registry and its
	// domain come up asynchronously, so wait until the archive set is readable
	// before recovering 鈥?restoring indexes against a half-started registry
	// would wrongly report success.
	const waitUntilReady = async (timeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				await host.prepare();
				await host.archivedIds();
				return true;
			} catch (error) {
				if (Date.now() >= deadline) return false;
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}
	};
	Promise.resolve()
		.then(async () => {
			if (!(await waitUntilReady(120000))) {
				log('warn', 'timed out waiting for the workspace registry; interrupted transactions stay journalled for the next start');
				return;
			}
			const recovered = await engine.recover();
			if (recovered.length > 0) log('warn', `restored ${recovered.length} interrupted cleanup transaction(s)`, { recovered });
		})
		.catch((error) => log('warn', 'startup recovery failed', { error: String(error?.message ?? error) }));

	ctx.tools.register({
		name: 'delete_archived_session',
		description: TOOL_DESCRIPTION,
		parameters: {
			type: 'object',
			properties: {
				mode: {
					type: 'string',
					enum: ['one', 'all'],
					description: '"one" removes the session named by session_id; "all" removes every archived session.'
				},
				session_id: {
					type: 'string',
					description: 'Exact session id; required when mode is "one".'
				},
				dry_run: {
					type: 'boolean',
					description: 'When true, only report the plan and delete nothing. Defaults to false.'
				},
				confirm: {
					type: 'boolean',
					description: 'Must be true to actually delete. Use dry_run first.'
				}
			},
			required: ['mode'],
			additionalProperties: false
		},
		output: {
			schema: { type: 'object', additionalProperties: true },
			render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
		},
		async execute(args) {
			await host.prepare();
			try {
				const plan = await engine.plan({ mode: args.mode, sessionId: args.session_id });
				if (args.dry_run === true) return { ok: true, status: 'planned', plan: summarize(plan) };
				if (args.confirm !== true) {
					return { ok: false, error: { code: 'confirm-required', message: 're-run with confirm: true (and dry_run first to inspect the plan)' } };
				}
				const summary = await engine.execute(plan);
				return { ok: true, status: summary.status, result: summary };
			} catch (error) {
				if (error instanceof CleanupError) return { ok: false, error: { code: error.code, message: error.message, details: error.details } };
				return { ok: false, error: { code: 'cleanup-failed', message: String(error?.message ?? error), details: {} } };
			}
		}
	});
}
