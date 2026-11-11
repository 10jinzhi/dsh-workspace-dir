# dsh-workspace-dir

一个 DeepSeek Harness（DSH）插件：管理侧边栏里的**工作区**——改目录、搬文件夹、导出/导入（含会话日志）、重建被删掉的会话。

A DSH bundle for workspace housekeeping: re-point a workspace, move a folder into a new parent, snapshot/restore workspaces **together with their session logs**, and rebuild deleted sessions.

## 安装（在 DSH 里填 GitHub 链接）

设置 → 插件 → 安装，粘贴下面任意一种（都实测可用）：

```
github:10jinzhi/dsh-workspace-dir
```
```
git+ssh://git@github.com/10jinzhi/dsh-workspace-dir.git
```

- 第一种最简短；pnpm 会自己选传输方式。**如果所在网络屏蔽了 GitHub 的 HTTPS git**（报 `git ls-remote failed … curl 28`），改用第二种走 SSH。
- 装好后多出 `dsh-workspace-dir` 这一条 bundle，行 id 是 `workspace-dir`，不需要重启 DSH。
- 升级：先卸载再按同样链接装一次（安装固定在某个 commit，不跟随 `main`）。
- 卸载：插件页点卸载。它只往 profile 写一行依赖、一条 bundle 声明和一个包目录，卸载会精确移除。

## 用法

| 入口 | 例子 |
|---|---|
| 对话（agent 工具 `workspace_directory`） | “把 deepseek bili 改到 F:\Work\bili”、“导出所有工作区”、“把这个工作区删了再导入回来” |
| 斜杠命令 `/workspace-dir` | `list` / `check <工作区>` / `move <工作区> <新目录>` / `export [文件]` / `import <文件>` / `delete <工作区>` / `map` / `refresh` |

工具参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `action` | 必填 | `list`、`check`、`move`、`moveFolder`、`map`、`export`、`import`、`delete`、`refresh` |
| `workspace` | - | 工作区标题 / ID / 当前路径（重名时用 ID） |
| `path` | - | 新目录，必须已存在、必须是完整路径 |
| `from` / `into` | - | `moveFolder`：要搬的文件夹、搬进哪个已存在目录 |
| `file` | - | `export`/`import` 的快照路径；`export` 省略时写到 `~\\workspaces-export.json` |
| `includeContent` | true | `export` 是否把会话日志字节一起复制到 `<快照>.sessions/` |
| `restoreMembership` | true | `import` 是否把会话按快照顺序挂回工作区 |
| `restoreContent` | true | `import` 是否用快照里的字节重建本地丢掉的会话日志 |
| `unarchive` | true | `import` 是否让快照里处于归档状态的会话重新可见 |
| `migrateSessions` / `force` / `dryRun` | 见说明 | 分别控制跟随、强制改、只预演 |

## 导出 / 导入（含会话日志）

```
/workspace-dir export C:\Users\me\backups\ws.json
/workspace-dir import C:\Users\me\backups\ws.json --dry-run
/workspace-dir import C:\Users\me\backups\ws.json
```

快照结构（`version: 2`）：

```json
{
  "kind": "dsh-workspace-export", "version": 2, "platform": "win32",
  "content": "embedded",
  "workspaces": [{
    "order": 0, "title": "临时小任务", "path": "C:\\...\\临时小任务", "exists": true,
    "sessions": [{
      "id": "session-…", "cwd": "C:\\...\\临时小任务", "archived": false, "pinned": false,
      "log": { "relative": "--C-…--\\session-…", "files": [{ "name": "session.v4.jsonl.zstd", "bytes": 299174, "sha256": "…" }] }
    }]
  }],
  "followMap": { "旧目录": "新目录" }
}
```

日志字节放在 `<快照>.sessions/<会话 id>/` 下。导入时按这个顺序处理：

1. **注册**：没有的工作区用 `registry.create` 建（目录必须已存在），有的只把标题改回快照值。
2. **顺序**：按 `order` 重排侧边栏。
3. **重建会话**：本地磁盘上找不到某个会话的日志目录 → 从 `<快照>.sessions/` 原样复制回 `~/.dsh/sessions/<快照记录的相对路径>/`，字节一致（sha256 可核对）。
4. **归位**：按快照顺序把会话挂回工作区（`attachSession` 是前插，所以按倒序挂、再统一 `insertSessionBefore` 排正）。只有会话 header 里的 cwd 与工作区路径一致才能挂；不一致的会逐条列在“跳过”里。
5. **归档**：快照里 `archived: true` 的会话，导入后 `unarchiveSession` 让它们重新可见（`--keep-archived` 保留归档）。
6. **跟随记录**：只合并本地缺的条目。最后 `refresh` 重建会话索引。

### 关于“会话被删掉”

DSH 没有“删除会话”这个操作，删工作区只删登记，会话仍在磁盘、会掉到「未分组」。所以：

- **工作区删除后导入** → 会话按快照归位，这正是“未分组要归位置”。
- **日志文件被手工删掉** → 只要快照里带内容，导入会按原路径、原字节重建，会话随之复活；重建后 `refresh` 若仍看不到，会提示“重启后重试导入即可归位”（DSH 的会话列表在启动时建立索引）。
- 快照里没有内容的会话（`--no-content` 导出）无法重建，只能归位已有日志。

## 跟随记录（运行期状态）

`move` / `moveFolder` 会把「旧目录 → 新目录」写进 `~/.dsh/storages/workspace-dir-follow-map.json`，让没登记在工作区里的老会话也能在下次打开时落到新目录；每个会话迁移完对应条目自动删除，用完文件消失。

## 还原

- 改错目录：`move` 回旧路径（旧目录必须存在）。
- 删错工作区：`import` 快照即可（目录和会话都还在）。
- 搬错文件夹：把文件夹移回原位，再 `move` 工作区指回去。

## 已知限制

- 会话迁移是追加日志，会在会话里留一条「工作目录已更改」的系统提示。
- 旧目录仍然存在时，会话不会跟随（DSH 用 header 的 cwd 判断归属），`move` 默认拒绝，`force` 才继续。
- 归属校验以 header cwd 为准：cwd 与工作区路径不一致的会话无法挂回去，只能留在「未分组」。
- 快照按会话 id 记录日志相对路径；跨机器恢复要求两边的会话存储布局一致（同一 cwd 拼写）。

## 协议

MIT。
