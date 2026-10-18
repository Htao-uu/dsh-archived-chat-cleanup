# dsh-archived-chat-cleanup（已归档会话清理）

[![npm](https://img.shields.io/npm/v/dsh-archived-chat-cleanup.svg)](https://www.npmjs.com/package/dsh-archived-chat-cleanup)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> A DSH plugin that deletes **archived** sessions together with their exclusively-referenced
> attachment objects and derived request-image caches — one reference-aware, journalled,
> reversible transaction. Install by package name: `dsh-archived-chat-cleanup`.

## 安装

**通过 DSH 输入包名安装（推荐）**：在 DSH 插件管理器里输入 `dsh-archived-chat-cleanup`，
或使用 CLI：

```powershell
dsh plugin --profile web add dsh-archived-chat-cleanup
```

安装/升级后需要重启宿主（模块缓存按包说明符生效）。

从源码安装（本地开发）：

```powershell
dsh plugin --profile web add <插件目录的绝对路径>
```

## English overview

DSH stores attachments content-addressed: one object can be referenced by many sessions, so
deleting a session must not blindly delete its attachments. This plugin deletes only archived
sessions, cascades into their subagent child sessions, scans every surviving session for
`sha256:` references, removes only unreferenced attachment objects, clears the
`request-images` derived caches, and updates the live indexes through the running services.
Every file move is journalled and reversible, including crash recovery on the next boot.

It ships a Host half (`delete_archived_session` tool + `archivedCleanup` Remote namespace) and
a browser half (two rows in the archived session's “…” menu). See the Chinese sections below
for the full behaviour, transaction protocol and test coverage.

删除**已归档**会话，并按引用关系回收附件实体；整个过程是一个可回滚的事务。
Host 半 + 浏览器半在同一个包里，安装后提供三个入口：会话「...」菜单、模型工具、Remote API。

## 它解决什么

DSH 的附件是**内容寻址**的：同一张图被多个会话引用时磁盘上只有一份。
所以"删除会话"不能简单地把附件一起删掉，必须先判断还有没有别的会话在引用。
DSH 自身没有删除会话的 API（`sessionPersistence` / `attachments` 都没有 delete），
这些数据只能由插件自己按事务方式落盘删除。

## 行为

一次删除调用按顺序完成：

1. **归档校验**：目标必须在 `workspaceRegistry.archivedSessionIds`（界面上的"已归档"）里。
   非归档会话直接拒绝（`session-not-archived`）。
2. **运行中会话**：`one` 模式整体拒绝（`target-live`）；`all` 模式**跳过**该会话及其全部子会话并在结果里报告（`skippedLive`），绝不删正在写的日志。
3. **级联**：递归带上目标会话的子代理子会话（它们是归档会话的内部会话，保留会让附件被"永久引用"）。
4. **取目标会话的附件引用**：完整读取会话日志，扫描其中出现的所有 `sha256:<64hex>`。
5. **取存活会话的引用**：扫描除目标外的**所有**现存会话（磁盘 + 内存 live，不区分是否归档）。
6. **判定**：
   - 未被任何存活会话引用 → 删除附件实体（镜像对象 `attachments/v1/objects/`、
     文件对象 `file-objects/`、以及别名目录 `files/`）；
   - 仍被其他会话引用 → **不删**，只随目标会话一起删除那条引用（引用存在会话日志里）；
   - 任何存活会话日志读不出来 → 整个操作中止（fail-closed，宁可不删）。
7. **删除派生缓存**：`<cacheRoot>/request-images` 与旧版遗留的 `attachments/v1/request-images`
   整体清掉（按"源对象+请求尺寸"派生，无法精确归属到某个会话，且下次看图会自动重建）。
8. **删除会话正文与索引引用**：会话目录、投影缓存记录（`session_projcache` 域）、
   message_feedback 记录、workspace 归属与归档集合。
   索引一律走**活着的服务/域**，不直接改文件——`workspaceRegistry` 会在内存里缓存状态，
   直接改文件会被它写回（这正是前两次手工清理踩过的坑）。

### 事务与回滚

- **阶段一**：把每个待删路径 `rename` 进隔离区（同卷、原子），每步写一次 journal；
- **阶段二**：改索引（先快照原值）；
- **阶段三**：两者都成功后彻底清空隔离区。
- 任意一步失败：先回滚索引，再逆序把文件搬回原位，journal 记为 `rolled-back`（隔离区清掉，journal 留作审计）。
- 进程崩溃：下次启动扫描 journal，自动恢复未完成的事务；`rollback-incomplete` 表示恢复不完全，需人工看 journal。
- 所有待删路径必须**严格位于**会话根/附件根/缓存根之内，否则 `unsafe-path` 中止。

## 用法

| 入口 | 说明 |
|---|---|
| 会话「...」菜单 | 仅在该会话已归档时显示"删除已归档会话…"（order 500）与"清理全部已归档会话…"（order 501），**点两次**才执行 |
| 模型工具 `delete_archived_session` | `{ mode: "one"\|"all", session_id?, dry_run?, confirm }`；`dry_run:true` 只报告计划；真正删除需 `confirm:true` |
| Remote 命名空间 `archivedCleanup` | 端点 `archivedCleanup/status`、`/preview`、`/deleteArchived`，参数按名字传 `{ mode, sessionId, confirm }` |

## 路径与数据

- 会话根：`ctx.sessionPersistence.root`（回退：Loader 配置 / `DSH_HOME/sessions`）
- 附件根：`ctx.attachments.root`（回退 `DSH_HOME/attachments/v1`）
- 派生缓存：`ctx.attachments.cacheRoot`（回退 `DSH_HOME/cache/attachments`）
- 插件数据：`DSH_HOME/plugin-data/archived-cleanup/`（`transactions/` journal，`reports/` 执行报告）

