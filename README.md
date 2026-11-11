# dsh-workspace-dir

一个 DeepSeek Harness（DSH）插件：把侧边栏里**已注册工作区**指向的目录换成另一个目录，或者把整个文件夹搬进新位置，并让工作区名下的会话跟着走。

A DSH bundle that re-points a registered workspace at another directory — or moves a folder into a new parent — and lets the sessions that lived there follow the move.

## 安装（在 DSH 里填 GitHub 链接）

设置 → 插件 → 安装，粘贴下面任意一种（都实测可用）：

```
github:10jinzhi/dsh-workspace-dir
```

```
git+ssh://git@github.com/10jinzhi/dsh-workspace-dir.git
```

- 第一种最简短；pnpm 会自己选传输方式。**如果所在网络屏蔽了 GitHub 的 HTTPS git**（会报 `git ls-remote failed … curl 28`），改用第二种走 SSH（需要本机已配置 GitHub SSH key）。
- 装好后会多出 `dsh-workspace-dir` 这一条 bundle，行 id 是 `workspace-dir`，不需要重启 DSH。
- 需要 DSH 桌面版（profile 里有 `tools`、`commands`、`workspaceRegistry`，默认都有）。
- 升级：插件页卸载后按同样链接再装一次（安装固定在某个 commit，不会自动跟随 `main`）。
- 卸载：插件页点卸载（等同 `remove_bundle`）。它只往 profile 写一行依赖、一条 bundle 声明和一个包目录，卸载会精确移除；DSH 程序文件不会被动过。

## 用法

两个入口，同一套实现：

| 入口 | 例子 |
|---|---|
| 对话（agent 工具 `workspace_directory`） | “把 deepseek bili 工作区改到 F:\Work\bili” |
| 斜杠命令 `/workspace-dir` | `list` / `check <工作区>` / `move <工作区> <新目录>` / `map` |

工具参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `action` | 必填 | `list` 列出工作区；`check` 看某工作区会话的跟随状态；`move` 改工作区路径；`moveFolder` 搬文件夹并跟随；`map` 看跟随记录；`refresh` 重建会话索引 |
| `workspace` | - | 工作区标题 / ID / 当前路径（重名时用 ID） |
| `path` | - | 新目录，必须已存在、必须是完整路径 |
| `from` / `into` | - | `moveFolder`：要搬的文件夹、搬进哪个已存在目录 |
| `migrateSessions` | true | 让会话跟随 |
| `force` | false | 旧目录仍然存在时也强制改 |
| `dryRun` | false | 只校验和预演，不写入 |

## 它做了什么

- **工作区路径**：写入 DSH 自己的工作区域持久化表（原子写 + schema 校验），并触发 `domain/changed`，侧边栏即时刷新——不会手改 `workspace.json`。
- **会话跟随**：会话的 `cwd` 存在它自己的日志 header 里（append-only，不能改写）。所以真正发生的是——
  - 运行中的会话：当场 `workingDirectory.set` 到新目录；
  - 未打开的会话：下次打开时，由插件的 `agent/created` 监听器完成同样的迁移，会话日志里追加一条 `working-directory/change`。不会出现“目录不存在打不开”。
- **旧目录仍然存在时**：DSH 用 header 里的 cwd 判断会话归属，旧目录还在的话这些会话不会跟随、也会从该工作区列表里消失（会话本身不删），所以默认拒绝，`force` 才继续。
- **索引刷新**：DSH 的会话归属索引只在启动时构建；文件夹搬走后调用 `refresh`，用存储里的 header 重建它，工作区的会话计数立刻恢复。

## 跟随记录

`move` / `moveFolder` 会把「旧目录 → 新目录」写进 `%USERPROFILE%\.dsh\storages\workspace-dir-follow-map.json`。
这样即使某个会话没有被任何工作区登记（老会话大多如此），它下次打开时也会落到新目录。
每个会话被迁移后对应条目自动删除；全部用完文件自动消失。删掉这个文件就等于立刻停用跟随。

## 批量搬家

对每个要搬的文件夹调一次 `moveFolder`（`from` = 原目录，`into` = 目标父目录）：插件把文件夹整目录移过去、把对应工作区的路径改到新位置、并写入跟随记录（覆盖该目录下**所有**会话）。搬完调一次 `refresh`。

## 还原

把文件夹移回原位置，再用 `move` 把工作区指回旧路径（工具输出每次都附还原指引）。插件不保存额外状态，跟随记录用完即删。

## 已知限制

- 迁移是“追加日志”，因此会话里会留下一条「工作目录已更改」的系统提示。
- 旧目录仍然存在时无法让会话跟随（见上），这是 DSH 的归属规则决定的。
- 会话 header 里的 cwd 字符串不会改变；只有旧目录消失时才按“缺失”状态保留其归属。

## 协议

MIT。图标为原创 SVG。
