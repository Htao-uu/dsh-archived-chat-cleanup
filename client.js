/**
 * Browser half of `dsh-archived-chat-cleanup`.
 *
 * Contributes two rows to the Session "..." menu — one for a single archived
 * session and one that sweeps every archived session. Both are visible only
 * while the row's session is in the archive set, both require a second click
 * to confirm, and both reach the Host through the shared `/api` RPC carrier as
 * the `archivedCleanup` namespace (the Host half declares it in source mode).
 *
 * The rows are plain `role="menuitem"` buttons styled with theme tokens; this
 * package imports no Harness Client package.
 */
window.__ModuleLoader__.load({
	id: 'dsh-archived-chat-cleanup',
	factory(require) {
		const React = require('react');
		const h = React.createElement;
		const SLOT = 'sidebar.workspaces.session.menu.item';
		const PACKAGE = 'dsh-archived-chat-cleanup';
		let pluginCtx;

		const TEXT = {
			single: '删除已归档会话…',
			singleConfirm: '再次点击确认删除（附件按引用回收）',
			singleBusy: '正在删除…',
			all: '清理全部已归档会话…',
			allConfirm: '再次点击确认清理全部已归档',
			allBusy: '正在清理…',
			done: '已删除'
		};

		/** Localized text when the host locale namespace happens to carry it. */
		function translate(props, key, fallback) {
			try {
				const t = props?.t;
				if (typeof t !== 'function') return fallback;
				const value = t(key);
				return typeof value === 'string' && value.length > 0 && value !== key ? value : fallback;
			} catch {
				return fallback;
			}
		}

		/** One `/api` call against this package's own Remote namespace. */
		async function callHost(method, args) {
			const connection = pluginCtx?.get?.('connection');
			if (connection === undefined || typeof connection.rpc?.call !== 'function') throw new Error('连接服务不可用（connection.rpc）');
			const response = await connection.rpc.call('/api', `archivedCleanup/${method}`, { args });
			if (response !== null && typeof response === 'object' && response.ok === true) {
				const value = response.value;
				if (value !== null && typeof value === 'object' && value.ok === false) throw new Error(value.error?.message ?? value.error?.code ?? '远程调用被拒绝');
				return value;
			}
			const failure = response?.error;
			throw new Error(failure?.message ?? failure?.code ?? '远程调用失败');
		}

		/** Shared row behavior: idle → confirm → busy → done/failed. */
		function useRow() {
			const [phase, setPhase] = React.useState('idle');
			const [message, setMessage] = React.useState(null);
			const [hover, setHover] = React.useState(false);
			return { phase, message, hover, setPhase, setMessage, setHover };
		}

		function rowStyle(state, disabled) {
			const danger = state.phase === 'confirm' || state.phase === 'failed';
			return {
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				width: '100%',
				minHeight: '34px',
				padding: '6px 8px',
				border: 'none',
				borderRadius: 'var(--dsw-radius-md, 8px)',
				background: state.hover && !disabled ? 'var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-bg-layer-2))' : 'transparent',
				cursor: disabled ? 'not-allowed' : 'pointer',
				fontSize: '13px',
				lineHeight: '20px',
				textAlign: 'left',
				color: danger ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-primary)',
				opacity: disabled ? 0.6 : 1
			};
		}

		/**
		 * Read the archive membership of one row. Prefers the slot's own
		 * `useArchived` hook and falls back to the shared workspace snapshot.
		 */
		function useArchivedState(props) {
			const sessionId = props?.sessionId;
			const useArchived = props?.useArchived;
			const useWorkspaces = props?.useWorkspaces;
			if (typeof useArchived === 'function') return useArchived((set) => set.has(sessionId));
			if (typeof useWorkspaces === 'function') return useWorkspaces((state) => state.archivedSessionIds.includes(sessionId));
			return false;
		}

		/** `[open, setOpen]` from the menu's injected hook, with a safe default. */
		function useMenu(props) {
			const factory = props?.useMenuOpenState;
			if (typeof factory !== 'function') return [false, () => {}];
			const pair = factory();
			return Array.isArray(pair) ? pair : [false, () => {}];
		}

		function DeleteArchivedSessionRow(props) {
			const archived = useArchivedState(props);
			const menu = useMenu(props);
			const row = useRow();
			if (!archived) return null;
			const disabled = row.phase === 'busy' || row.phase === 'done';
			const single = translate(props, 'menu.deleteArchivedSession', TEXT.single);
			const label = row.phase === 'busy' ? TEXT.singleBusy
				: row.phase === 'confirm' ? TEXT.singleConfirm
					: row.phase === 'failed' ? `删除失败：${row.message ?? '未知错误'}`
						: row.phase === 'done' ? TEXT.done : single;
			const onClick = async () => {
				if (disabled) return;
				if (row.phase === 'idle') {
					row.setPhase('confirm');
					return;
				}
				row.setPhase('busy');
				row.setMessage(null);
				try {
					await callHost('deleteArchived', { mode: 'one', sessionId: props.sessionId, confirm: true });
					row.setPhase('done');
					if (typeof menu[1] === 'function') menu[1](false);
				} catch (error) {
					row.setPhase('failed');
					row.setMessage(String(error?.message ?? error));
					// eslint-disable-next-line no-console
					console.error(`[${PACKAGE}] delete archived session failed`, error);
				}
			};
			return h('button', {
				type: 'button',
				role: 'menuitem',
				disabled,
				title: label,
				style: rowStyle(row, disabled),
				onMouseEnter: () => row.setHover(true),
				onMouseLeave: () => row.setHover(false),
				onFocus: () => row.setHover(true),
				onBlur: () => row.setHover(false),
				onClick
			}, label);
		}

		function DeleteAllArchivedRow(props) {
			const archived = useArchivedState(props);
			const menu = useMenu(props);
			const row = useRow();
			if (!archived) return null;
			const disabled = row.phase === 'busy' || row.phase === 'done';
			const label = row.phase === 'busy' ? TEXT.allBusy
				: row.phase === 'confirm' ? TEXT.allConfirm
					: row.phase === 'failed' ? `清理失败：${row.message ?? '未知错误'}`
						: row.phase === 'done' ? TEXT.done : translate(props, 'menu.deleteAllArchivedSessions', TEXT.all);
			const onClick = async () => {
				if (disabled) return;
				if (row.phase === 'idle') {
					row.setPhase('confirm');
					return;
				}
				row.setPhase('busy');
				row.setMessage(null);
				try {
					await callHost('deleteArchived', { mode: 'all', confirm: true });
					row.setPhase('done');
					if (typeof menu[1] === 'function') menu[1](false);
				} catch (error) {
					row.setPhase('failed');
					row.setMessage(String(error?.message ?? error));
					// eslint-disable-next-line no-console
					console.error(`[${PACKAGE}] delete all archived sessions failed`, error);
				}
			};
			return h('button', {
				type: 'button',
				role: 'menuitem',
				disabled,
				title: label,
				style: rowStyle(row, disabled),
				onMouseEnter: () => row.setHover(true),
				onMouseLeave: () => row.setHover(false),
				onFocus: () => row.setHover(true),
				onBlur: () => row.setHover(false),
				onClick
			}, label);
		}

		return {
			inject: ['slots'],
			apply(ctx) {
				pluginCtx = ctx;
				ctx.slots.inject(SLOT, () => [
					ctx.slots.register({ name: SLOT, id: `${PACKAGE}.delete-session`, order: 500 }, DeleteArchivedSessionRow),
					ctx.slots.register({ name: SLOT, id: `${PACKAGE}.delete-all`, order: 501 }, DeleteAllArchivedRow)
				]);
			}
		};
	}
});
