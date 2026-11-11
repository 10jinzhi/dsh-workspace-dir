/**
 * Workspace directory plugin (Host half).
 *
 * Re-point a registered Workspace at a different existing directory, and keep
 * the sessions it owns usable on the new directory.
 *
 * Everything goes through public Harness seams:
 * - `ctx.workspaceRegistry` for the durable workspace record,
 * - `ctx.workingDirectory` for a session's directory change (a live session now,
 *   a stored session when it is next opened, which appends the change to its own
 *   log instead of rewriting it),
 * - `ctx.tools` / `ctx.commands` for the two entry points.
 *
 * The plugin owns no files, no storage domain and no configuration, so
 * uninstalling the bundle removes every trace of it.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, posix, win32 } from 'node:path'

const isWindows = process.platform === 'win32'
const pathApi = isWindows ? win32 : posix

/** A stable, human-readable message for any thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Whether a spelling names one fixed location instead of a cwd-relative path. */
function isFullyQualified(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  if (!isWindows) return posix.isAbsolute(value)
  const root = win32.parse(value).root
  return win32.isAbsolute(value) && root !== '\\' && root !== '/'
}

/** Workspace paths compare case-insensitively on Windows, byte-wise elsewhere. */
function samePath(left, right) {
  return isWindows ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** Whether one path exists and is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** Canonicalize an existing directory, rejecting relative and missing paths. */
async function canonicalDirectory(path) {
  const spelling = typeof path === 'string' ? path.trim() : ''
  if (!isFullyQualified(spelling)) {
    throw new Error(`目录必须是完整路径（例如 C:\\Users\\me\\project）：${JSON.stringify(path)}`)
  }
  let canonical
  try {
    canonical = await realpath(spelling)
  } catch (error) {
    const code = error !== null && typeof error === 'object' ? error.code : undefined
    if (code === 'ENOENT') throw new Error(`目录不存在：${spelling}`)
    throw new Error(`无法解析目录 ${spelling}：${messageOf(error)}`)
  }
  if (!(await isDirectory(canonical))) throw new Error(`不是目录：${spelling}`)
  return canonical
}

function requireService(ctx, key) {
  const service = ctx.get(key)
  if (service === undefined) throw new Error(`当前 profile 没有加载 "${key}" 服务，无法修改工作区目录`)
  return service
}

/** Find one workspace by id, recorded path, or (unique) title. */
function findWorkspace(registry, selector) {
  const all = registry.list()
  const wanted = typeof selector === 'string' ? selector.trim() : ''
  if (wanted === '') throw new Error('请指定要修改的工作区（标题、ID 或当前路径）')

  const byId = all.find((workspace) => String(workspace.id) === wanted)
  if (byId !== undefined) return byId

  const byPath = all.find((workspace) => samePath(workspace.path, wanted))
  if (byPath !== undefined) return byPath

  const lowered = wanted.toLowerCase()
  const byTitle = all.filter((workspace) => workspace.title.toLowerCase() === lowered)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    throw new Error(
      `有 ${byTitle.length} 个工作区都叫「${wanted}」，请改用 ID 指定：\n`
      + byTitle.map((workspace) => `- ${workspace.id} — ${workspace.path}`).join('\n'),
    )
  }

  const partial = all.filter((workspace) => workspace.title.toLowerCase().includes(lowered))
  if (partial.length === 1) return partial[0]

  throw new Error(
    all.length === 0
      ? '当前没有注册任何工作区'
      : `找不到工作区「${wanted}」。现有工作区：\n`
        + all.map((workspace) => `- ${workspace.title} — ${workspace.path}（id: ${workspace.id}）`).join('\n'),
  )
}

/** Read every workspace plus whether its directory still exists. */
async function readWorkspaces(registry) {
  const rows = []
  for (const workspace of registry.list()) {
    const sessionIds = [...workspace.sessionIds].map(String)
    rows.push({
      id: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
      exists: await isDirectory(workspace.path),
      sessionIds,
      updatedAt: workspace.updatedAt,
    })
  }
  return rows
}

function formatWorkspaceList(rows) {
  if (rows.length === 0) return '当前没有注册任何工作区。'
  const lines = [`共 ${rows.length} 个工作区（按侧边栏顺序）：`]
  rows.forEach((row, index) => {
    const state = row.exists ? '目录存在' : '目录不存在'
    lines.push(`${index + 1}. ${row.title} — ${row.path}（${state}，${row.sessionIds.length} 个会话，id: ${row.id}）`)
  })
  return lines.join('\n')
}

/** Read one session's stored header without starting an agent. */
async function sessionHeaderOf(ctx, sessionId) {
  const live = ctx.get('agents')?.get(sessionId)
  if (live !== undefined) return live.session.header
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  try {
    const snapshot = await persistence.stat(sessionId)
    return snapshot?.header
  } catch {
    return undefined
  }
}

/** Directory keys compare case-insensitively on Windows, byte-wise elsewhere. */
function directoryKey(path) {
  return isWindows ? path.toLowerCase() : path
}

/**
 * Follow map: `{ oldDirectory -> newDirectory }`, the one piece of state this
 * plugin owns. It lets a session whose directory was moved follow the move even
 * when no workspace record claims it (most sessions are not registered in one).
 * Entries are consumed as each session is opened, and deleting the file — or
 * uninstalling the plugin — ends the behavior. No session log is rewritten here.
 */
const MAP_VERSION = 1
const MAP_FILE_NAME = 'workspace-dir-follow-map.json'

function dshHomeDirectory() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env
  return join(homedir(), '.dsh')
}

function mapFilePath() {
  return join(dshHomeDirectory(), 'storages', MAP_FILE_NAME)
}

async function readFollowMap() {
  try {
    const parsed = JSON.parse(await readFile(mapFilePath(), 'utf8'))
    if (parsed?.version !== MAP_VERSION || typeof parsed?.entries !== 'object' || parsed.entries === null) return {}
    const entries = {}
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (typeof value?.target === 'string') entries[key] = { target: value.target, at: value.at }
    }
    return entries
  } catch {
    return {}
  }
}

async function writeFollowMap(entries) {
  const file = mapFilePath()
  if (Object.keys(entries).length === 0) {
    try {
      await unlink(file)
    } catch {
      /* Already absent. */
    }
    return
  }
  await mkdir(dirname(file), { recursive: true })
  const payload = { version: MAP_VERSION, entries, updatedAt: new Date().toISOString() }
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8')
  await rename(temporary, file)
}

/** Add (or replace) one old-directory → new-directory follow entry. */
async function recordFollow(ctx, from, to) {
  const entries = await readFollowMap()
  entries[directoryKey(from)] = { target: to, at: new Date().toISOString() }
  await writeFollowMap(entries)
}

/** Drop the entry a session just consumed. */
async function forgetFollow(from) {
  const entries = await readFollowMap()
  if (entries[directoryKey(from)] === undefined) return
  delete entries[directoryKey(from)]
  await writeFollowMap(entries)
}

/**
 * The directory one stored session should follow, or undefined.
 *
 * A session follows only when its own recorded directory is gone and either the
 * follow map names the move or exactly one workspace claims it. A session whose
 * directory still resolves is never touched.
 * @returns the new directory and, when the follow map supplied it, its key.
 */
async function followTargetOf(ctx, registry, session) {
  const cwd = session.header?.cwd
  if (typeof cwd !== 'string' || !isFullyQualified(cwd)) return undefined
  if (await isDirectory(cwd)) return undefined

  const entries = await readFollowMap()
  const direct = entries[directoryKey(cwd)]
  if (typeof direct?.target === 'string' && await isDirectory(direct.target)) {
    return { target: direct.target, mapKey: directoryKey(cwd) }
  }
  // A session whose directory sat inside a moved folder follows the same sub-path.
  const separator = isWindows ? '\\' : '/'
  const key = directoryKey(cwd)
  const nested = Object.entries(entries)
    .filter(([from]) => key.startsWith(from + separator))
    .sort((left, right) => right[0].length - left[0].length)[0]
  if (nested !== undefined) {
    const candidate = join(nested[1].target, key.slice(nested[0].length + 1))
    if (await isDirectory(candidate)) return { target: candidate, mapKey: nested[0] }
  }

  const owners = registry.list().filter((workspace) => {
    try {
      return [...workspace.sessionIds].some((id) => String(id) === String(session.id))
    } catch {
      return false
    }
  })
  if (owners.length !== 1) return undefined
  const target = owners[0].path
  if (samePath(target, cwd)) return undefined
  return (await isDirectory(target)) ? { target } : undefined
}

/** Point one live session at the new directory. */
async function migrateLiveSession(ctx, agent, target, signal) {
  const workingDirectory = requireService(ctx, 'workingDirectory')
  try {
    await workingDirectory.set(agent, target, signal)
    return { status: 'live' }
  } catch (error) {
    return { status: 'failed', reason: messageOf(error) }
  }
}

/** Read the sessions a workspace's durable record accounts for, before any cwd filtering. */
function recordedSessionIds(registry, workspaceId, fallback) {
  try {
    const record = registry.table?.get?.(workspaceId)
    if (record !== undefined && Array.isArray(record.sessionIds)) return record.sessionIds.map(String)
  } catch {
    /* Fall back to the entity's filtered view. */
  }
  return fallback.map(String)
}

/**
 * Rebuild the registry's session/directory index from stored headers.
 *
 * Workspace membership is derived from each session header's canonical cwd, and
 * that index is only built at startup. A folder that just moved therefore still
 * reads as "belongs to the old path" until this refresh, which makes the moved
 * sessions count as missing — the state in which they stay attached to the
 * workspace and are picked up by the follow rule.
 */
async function refreshSessionIndex(ctx, warnings) {
  const registry = requireService(ctx, 'workspaceRegistry')
  if (typeof registry.replaceHeaderIndex !== 'function' || typeof registry.listStoredHeaders !== 'function') return false
  try {
    await registry.replaceHeaderIndex(await registry.listStoredHeaders())
    if (typeof registry.rebuildEntities === 'function') registry.rebuildEntities()
    return true
  } catch (error) {
    if (warnings !== undefined) warnings.push(`会话索引刷新失败（重启 DSH 后会恢复）：${messageOf(error)}`)
    return false
  }
}

const EXPORT_KIND = 'dsh-workspace-export'
const EXPORT_VERSION = 2

/** Absolute path for an export/import file, defaulting to the home directory. */
function exportFilePath(requested) {
  const spelling = typeof requested === 'string' ? requested.trim() : ''
  if (spelling === '') return join(homedir(), 'workspaces-export.json')
  if (!isFullyQualified(spelling)) throw new Error(`文件必须是完整路径（例如 C:\\Users\\me\\workspaces.json）：${spelling}`)
  return spelling
}

function sessionStoreRoot() {
  return join(dshHomeDirectory(), 'sessions')
}

/**
 * Locate one session's log directory under the session store. The store groups
 * logs by the mangled cwd of the session, and the plugin must not re-derive that
 * spelling, so it finds the directory by session id and records the relative
 * path for a byte-identical restore.
 */
async function findSessionLogDir(sessionId) {
  const root = sessionStoreRoot()
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, sessionId)
    if (await isDirectory(candidate)) return { absolute: candidate, relative: join(entry.name, sessionId) }
  }
  return undefined
}

function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Describe one session's durable log, and — when `contentDir` is given — copy
 * its bytes beside the export file so the snapshot alone can rebuild the session.
 */
async function describeSessionLog(sessionId, contentDir) {
  const dir = await findSessionLogDir(sessionId)
  if (dir === undefined) return undefined
  let names
  try {
    names = (await readdir(dir.absolute, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name)
  } catch {
    return undefined
  }
  const files = []
  for (const name of names.sort()) {
    const absolute = join(dir.absolute, name)
    const info = await stat(absolute)
    files.push({ name, bytes: info.size, sha256: await sha256Of(absolute) })
    if (contentDir !== undefined) {
      await mkdir(join(contentDir, sessionId), { recursive: true })
      await copyFile(absolute, join(contentDir, sessionId, name))
    }
  }
  return { relative: dir.relative, files }
}

/** Whether this build can see a durable session with this id. */
async function sessionKnown(ctx, sessionId) {
  const live = ctx.get('agents')?.get(sessionId)
  if (live !== undefined) return true
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return false
  try {
    return (await persistence.stat(sessionId)) !== undefined
  } catch {
    return false
  }
}

/**
 * Write a portable snapshot of every workspace registration: title, absolute
 * path, display order, the sessions its record accounts for (with their log
 * bytes when `includeContent`), and the pending follow entries. Re-importing
 * recreates whatever is missing — including session logs that were deleted.
 */
async function exportWorkspaces(ctx, options) {
  const registry = requireService(ctx, 'workspaceRegistry')
  const file = exportFilePath(options.file)
  const includeContent = options.includeContent !== false
  const contentDir = includeContent ? `${file}.sessions` : undefined
  const archived = new Set(registry.archivedSessionIds.map(String))
  const pinned = new Set(registry.pinnedSessionIds.map(String))
  const selected = options.workspace === undefined ? registry.list() : [findWorkspace(registry, options.workspace)]
  const rows = []
  let sessionCount = 0
  let contentFiles = 0
  let contentBytes = 0
  let missingLogs = 0
  for (const [index, workspace] of selected.entries()) {
    const record = registry.table?.get?.(workspace.id)
    const ids = Array.isArray(record?.sessionIds)
      ? record.sessionIds.map(String)
      : [...workspace.sessionIds].map(String)
    const sessions = []
    for (const id of ids) {
      const header = await sessionHeaderOf(ctx, id)
      const log = await describeSessionLog(id, contentDir)
      if (log === undefined) missingLogs += 1
      else {
        contentFiles += log.files.length
        contentBytes += log.files.reduce((total, item) => total + item.bytes, 0)
      }
      sessions.push({
        id,
        cwd: typeof header?.cwd === 'string' ? header.cwd : undefined,
        createdAt: header?.createdAt,
        archived: archived.has(id),
        pinned: pinned.has(id),
        log,
      })
      sessionCount += 1
    }
    rows.push({
      title: workspace.title,
      path: workspace.path,
      order: index,
      exists: await isDirectory(workspace.path),
      sessions,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    })
  }
  const follow = await readFollowMap()
  const payload = {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    platform: process.platform,
    sessionsRoot: sessionStoreRoot(),
    content: includeContent ? 'embedded' : 'none',
    workspaces: rows,
    followMap: Object.fromEntries(Object.entries(follow).map(([key, value]) => [key, value.target])),
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return {
    file,
    contentDir,
    workspaces: rows.length,
    missing: rows.filter((row) => !row.exists).length,
    sessions: sessionCount,
    missingLogs,
    contentFiles,
    contentBytes,
    archivedSessions: rows.reduce((total, row) => total + row.sessions.filter((item) => item.archived).length, 0),
    followEntries: Object.keys(follow).length,
  }
}

function formatBytes(total) {
  if (total >= 1024 * 1024) return `${(total / (1024 * 1024)).toFixed(1)} MB`
  if (total >= 1024) return `${Math.round(total / 1024)} KB`
  return `${total} B`
}

function formatExport(result) {
  return [
    `已导出 ${result.workspaces} 个工作区到：${result.file}`,
    `  会话 ${result.sessions} 个（日志缺失 ${result.missingLogs} 个），归档 ${result.archivedSessions} 个`,
    result.contentDir === undefined
      ? '  未包含会话日志内容'
      : `  会话日志 ${result.contentFiles} 个文件 / ${formatBytes(result.contentBytes)}，复制到：${result.contentDir}`,
    result.missing > 0 ? `  其中 ${result.missing} 个工作区的目录当前不存在（导入时会跳过）` : '',
    `  跟随记录 ${result.followEntries} 条`,
  ].filter((line) => line !== '').join('\n')
}

/** Accept both snapshot generations: v1 listed bare session ids, v2 carries objects. */
function normalizeSessionEntries(value) {
  if (!Array.isArray(value)) return []
  const items = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      items.push({ id: entry, log: undefined })
      continue
    }
    if (entry !== null && typeof entry === 'object' && typeof entry.id === 'string') {
      items.push({
        id: entry.id,
        cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
        archived: entry.archived === true,
        pinned: entry.pinned === true,
        log: entry.log !== null && typeof entry.log === 'object' ? entry.log : undefined,
      })
    }
  }
  return items
}

/** Copy a snapshot's session log bytes back into the session store. */
async function restoreSessionLog(exportFile, item) {
  const relative = item.log?.relative
  if (typeof relative !== 'string' || relative === '') return undefined
  if (!Array.isArray(item.log.files) || item.log.files.length === 0) return undefined
  const contentRoot = `${exportFile}.sessions`
  const targetDir = join(sessionStoreRoot(), relative)
  await mkdir(targetDir, { recursive: true })
  const copied = []
  for (const file of item.log.files) {
    if (typeof file?.name !== 'string') continue
    await copyFile(join(contentRoot, item.id, file.name), join(targetDir, file.name))
    copied.push(file.name)
  }
  return copied
}

/**
 * Recreate the workspaces an export describes: create what is missing, restore
 * titles and display order, rebuild deleted session logs from the snapshot's
 * bytes, re-attach the recorded sessions at their recorded positions, surface
 * archived sessions, and merge the follow entries.
 */
async function importWorkspaces(ctx, options) {
  const registry = requireService(ctx, 'workspaceRegistry')
  const file = exportFilePath(options.file)
  let payload
  try {
    payload = JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`读不到或解析不了导出文件：${file}（${messageOf(error)}）`)
  }
  if (payload?.kind !== EXPORT_KIND || !Array.isArray(payload.workspaces)) {
    throw new Error('这不是本插件导出的工作区文件（缺少 kind/workspaces）')
  }
  if (payload.version !== 1 && payload.version !== 2) {
    throw new Error(`导出文件版本是 ${String(payload.version)}，本插件只认 1 和 2`)
  }
  const dryRun = options.dryRun === true
  const restoreMembership = options.restoreMembership !== false
  const restoreContent = options.restoreContent !== false
  const unarchive = options.unarchive !== false
  const report = {
    file,
    dryRun,
    created: [],
    existing: [],
    renamed: [],
    missing: [],
    membership: { restored: 0, ordered: 0, skipped: [] },
    archive: { restored: 0, kept: 0 },
    content: { rebuilt: 0 },
    followMerged: 0,
    warnings: [],
  }

  for (const entry of payload.workspaces) {
    const path = typeof entry?.path === 'string' ? entry.path : ''
    if (!isFullyQualified(path)) {
      report.missing.push({ path, title: entry?.title, reason: '路径不合法' })
      continue
    }
    const current = registry.list().find((workspace) => samePath(workspace.path, path))
    if (current !== undefined) {
      report.existing.push({ title: current.title, path: current.path })
      const wanted = typeof entry.title === 'string' ? entry.title.trim() : ''
      if (wanted !== '' && wanted !== current.title && !dryRun) {
        try {
          await current.setTitle(wanted)
          report.renamed.push({ path: current.path, from: current.title, to: wanted })
        } catch (error) {
          report.warnings.push(`重命名 ${current.path} 失败：${messageOf(error)}`)
        }
      }
      continue
    }
    if (!await isDirectory(path)) {
      report.missing.push({ path, title: entry?.title, reason: '目录不存在' })
      continue
    }
    if (dryRun) {
      report.created.push({ path, title: entry?.title })
      continue
    }
    try {
      const wanted = typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title.trim() : undefined
      const workspace = await registry.create(path, wanted)
      report.created.push({ path: workspace.path, title: workspace.title })
    } catch (error) {
      report.warnings.push(`创建 ${path} 失败：${messageOf(error)}`)
    }
  }

  if (!dryRun) {
    const ordered = [...payload.workspaces].sort((left, right) => (left?.order ?? 0) - (right?.order ?? 0))
    let anchor
    for (const entry of [...ordered].reverse()) {
      const workspace = registry.list().find((candidate) => samePath(candidate.path, entry?.path))
      if (workspace === undefined) continue
      try {
        await registry.insertBefore(workspace.id, anchor)
        anchor = workspace.id
      } catch (error) {
        report.warnings.push(`调整顺序 ${entry?.path} 失败：${messageOf(error)}`)
      }
    }
  }

  if (restoreMembership && !dryRun) {
    for (const entry of payload.workspaces) {
      const workspace = registry.list().find((candidate) => samePath(candidate.path, entry?.path))
      if (workspace === undefined) continue
      const items = normalizeSessionEntries(entry.sessions)

      // Sessions whose durable log is gone come back from the snapshot's bytes.
      for (const item of items) {
        if (await findSessionLogDir(item.id) !== undefined) continue
        if (item.log === undefined) {
          report.membership.skipped.push({ id: item.id, reason: '本地没有该会话日志，快照里也没有内容' })
          continue
        }
        try {
          const copied = await restoreSessionLog(file, item)
          if (copied === undefined) {
            report.membership.skipped.push({ id: item.id, reason: '快照缺少该会话的日志内容' })
            continue
          }
          report.content.rebuilt += 1
          if (!(await sessionKnown(ctx, item.id))) {
            report.warnings.push(`会话 ${item.id} 的日志已重建（${copied.length} 个文件），但 DSH 暂时还看不到；重启后重试导入即可归位。`)
          }
        } catch (error) {
          report.membership.skipped.push({ id: item.id, reason: `重建日志失败：${messageOf(error)}` })
        }
      }

      // attachSession prepends, so re-attach in reverse snapshot order.
      const rawIds = () => {
        try {
          const record = registry.table?.get?.(workspace.id)
          return Array.isArray(record?.sessionIds) ? record.sessionIds.map(String) : []
        } catch {
          return []
        }
      }
      for (const item of [...items].reverse()) {
        if (rawIds().includes(item.id)) continue
        try {
          await workspace.attachSession(item.id)
          report.membership.restored += 1
        } catch (error) {
          report.membership.skipped.push({ id: item.id, reason: messageOf(error) })
        }
      }
      // Then enforce the recorded order among the sessions that are accounted.
      for (const item of items) {
        if (!rawIds().includes(item.id)) continue
        try {
          await workspace.insertSessionBefore(item.id)
          report.membership.ordered += 1
        } catch {
          /* Not accounted (cwd mismatch); the record keeps what it can. */
        }
      }

      for (const item of items) {
        if (item.archived !== true) continue
        if (unarchive) {
          try {
            await registry.unarchiveSession(item.id)
            report.archive.restored += 1
          } catch (error) {
            report.warnings.push(`恢复归档会话 ${item.id} 可见失败：${messageOf(error)}`)
          }
        } else {
          report.archive.kept += 1
        }
      }
    }
    await refreshSessionIndex(ctx, report.warnings)
  }

  if (!dryRun && payload.followMap !== null && typeof payload.followMap === 'object') {
    const current = await readFollowMap()
    for (const [from, to] of Object.entries(payload.followMap)) {
      if (typeof from !== 'string' || typeof to !== 'string') continue
      if (current[directoryKey(from)] !== undefined) continue
      if (!isFullyQualified(to) || !await isDirectory(to)) continue
      current[directoryKey(from)] = { target: to, at: new Date().toISOString() }
      report.followMerged += 1
    }
    if (report.followMerged > 0) await writeFollowMap(current)
  }

  return report
}

function formatImport(result) {
  const lines = []
  if (result.dryRun) lines.push('（预演，未写入任何改动）')
  lines.push(`${result.dryRun ? '将' : '已'}从 ${result.file} 导入：`)
  lines.push(`  新建工作区: ${result.created.length} 个`)
  for (const entry of result.created) lines.push(`    + ${entry.title ?? '(无标题)'} — ${entry.path}`)
  lines.push(`  已存在、跳过: ${result.existing.length} 个`)
  if (result.renamed.length > 0) {
    lines.push(`  改回标题: ${result.renamed.length} 个`)
    for (const entry of result.renamed) lines.push(`    ~ ${entry.from} → ${entry.to}`)
  }
  if (result.missing.length > 0) {
    lines.push(`  无法导入: ${result.missing.length} 个`)
    for (const entry of result.missing) lines.push(`    ! ${entry.title ?? ''} ${entry.path}（${entry.reason}）`)
  }
  if (result.membership.restored > 0 || result.membership.ordered > 0 || result.membership.skipped.length > 0) {
    lines.push(`  会话归位: 恢复 ${result.membership.restored} 个，按快照顺序排 ${result.membership.ordered} 个`)
    for (const entry of result.membership.skipped) lines.push(`    ! ${entry.id}（${entry.reason}）`)
  }
  if (result.content.rebuilt > 0) lines.push(`  重建被删除的会话日志: ${result.content.rebuilt} 个`)
  if (result.archive.restored > 0 || result.archive.kept > 0) {
    lines.push(`  归档会话: 重新可见 ${result.archive.restored} 个${result.archive.kept > 0 ? `，保持归档 ${result.archive.kept} 个` : ''}`)
  }
  if (result.followMerged > 0) lines.push(`  合并跟随记录: ${result.followMerged} 条`)
  for (const warning of result.warnings) lines.push(`  注意: ${warning}`)
  return lines.join('\n')
}

/** Remove one workspace registration; its directory and sessions are untouched. */
async function deleteWorkspace(ctx, selector) {
  const registry = requireService(ctx, 'workspaceRegistry')
  const workspace = findWorkspace(registry, selector)
  const before = {
    id: String(workspace.id),
    title: workspace.title,
    path: workspace.path,
    sessions: recordedSessionIds(registry, workspace.id, [...workspace.sessionIds]).length,
  }
  const deleted = await registry.delete(workspace.id)
  if (typeof registry.rebuildEntities === 'function') registry.rebuildEntities()
  await refreshSessionIndex(ctx, undefined)
  return { ...before, deleted }
}

function formatDelete(result) {
  return [
    result.deleted
      ? `已删除工作区「${result.title}」（id: ${result.id}）`
      : `工作区「${result.title}」本就不存在`,
    `  目录 ${result.path} 保留，${result.sessions} 个会话保留——它们会显示在「未分组」下（或仍是归档状态）`,
    '  想找回：导入对应的快照，或用 move 重新指向该目录。',
  ].join('\n')
}

/**
 * Move one workspace onto a new directory.
 * @param ctx - plugin context carrying the Harness services.
 * @param options - workspace selector, target path, and behavior flags.
 * @param signal - caller cancellation.
 */
async function relocateWorkspace(ctx, options, signal) {
  const registry = requireService(ctx, 'workspaceRegistry')
  const workspace = findWorkspace(registry, options.workspace)
  const oldPath = workspace.path
  const target = await canonicalDirectory(options.path)
  const sessionIds = recordedSessionIds(registry, workspace.id, [...workspace.sessionIds])
  const migrateSessions = options.migrateSessions !== false
  const force = options.force === true
  const warnings = []

  if (samePath(oldPath, target)) {
    return {
      changed: false,
      dryRun: options.dryRun === true,
      workspaceId: String(workspace.id),
      title: workspace.title,
      oldPath,
      newPath: target,
      sessions: sessionIds.length,
      migrated: [],
      warnings: ['新目录与当前目录相同，未做修改。'],
    }
  }

  const conflict = registry.list().find(
    (candidate) => String(candidate.id) !== String(workspace.id) && samePath(candidate.path, target),
  )
  if (conflict !== undefined) {
    throw new Error(`目录 ${target} 已经属于工作区「${conflict.title}」（id: ${conflict.id}），同一个目录不能注册两次`)
  }

  const oldDirectoryExists = await isDirectory(oldPath)
  if (migrateSessions && sessionIds.length > 0 && oldDirectoryExists && !force) {
    throw new Error(
      `旧目录仍然存在：${oldPath}\n`
      + `DSH 用会话 header 里的 cwd 判断会话归属，旧目录还在时这些会话（${sessionIds.length} 个）会从该工作区掉出去，也不会跟随到新目录。`
      + `若旧目录已不再使用（例如已改名），请先处理它，或带 force: true 强制执行。`,
    )
  }
  if (!oldDirectoryExists && sessionIds.length > 0) {
    warnings.push(
      `旧目录已不存在：${sessionIds.length} 个旧会话会在下次打开时自动跟随到新目录（它们的日志会各追加一条目录变更记录）。`,
    )
  }
  if (oldDirectoryExists && sessionIds.length > 0) {
    warnings.push(
      `旧目录仍然存在：这 ${sessionIds.length} 个旧会话的 cwd 仍指向旧目录，所以不会跟随，也不再显示在该工作区下（工作区登记和会话本身都不删除）。`,
    )
  }
  if (!migrateSessions && sessionIds.length > 0) {
    warnings.push('按你的要求不自动迁移会话。')
  }

  if (options.dryRun === true) {
    return {
      changed: false,
      dryRun: true,
      workspaceId: String(workspace.id),
      title: workspace.title,
      oldPath,
      newPath: target,
      sessions: sessionIds.length,
      migrateSessions,
      migrated: [],
      warnings,
    }
  }

  const table = registry.table
  if (table === undefined || typeof table.update !== 'function') {
    throw new Error('内部错误：工作区注册表未就绪（拿不到可写的 workspaces 表）')
  }
  try {
    await table.update(workspace.id, (record) => ({ ...record, path: target, updatedAt: new Date().toISOString() }))
  } catch (error) {
    throw new Error(`写入工作区目录失败：${messageOf(error)}`)
  }

  if (typeof registry.rebuildEntities === 'function') {
    try {
      registry.rebuildEntities()
    } catch (error) {
      warnings.push(`工作区缓存重建失败（重启 DSH 后会恢复一致）：${messageOf(error)}`)
    }
  }

  try {
    await recordFollow(ctx, oldPath, target)
  } catch (error) {
    warnings.push(`跟随记录未能保存（未登记在工作区里的会话不会跟随）：${messageOf(error)}`)
  }

  const migrated = []
  if (migrateSessions) {
    const agents = ctx.get('agents')
    for (const sessionId of sessionIds) {
      if (signal !== undefined && signal.aborted) {
        warnings.push('操作被取消，剩余会话未处理。')
        break
      }
      try {
        const header = await sessionHeaderOf(ctx, sessionId)
        const cwd = header?.cwd
        if (header === undefined) {
          migrated.push({ sessionId, status: 'unknown' })
          continue
        }
        const cwdResolves = typeof cwd === 'string' && isFullyQualified(cwd) && await isDirectory(cwd)
        const live = agents?.get(sessionId)
        if (live !== undefined) {
          if (cwdResolves) continue
          migrated.push({ sessionId, ...(await migrateLiveSession(ctx, live, target, signal)) })
          continue
        }
        if (cwdResolves) continue
        migrated.push({ sessionId, status: 'pending' })
      } catch (error) {
        migrated.push({ sessionId, status: 'failed', reason: messageOf(error) })
      }
    }
  }

  const failed = migrated.filter((entry) => entry.status === 'failed')
  if (failed.length > 0) warnings.push(`${failed.length} 个会话无法自动跟随，需要手动处理。`)

  await refreshSessionIndex(ctx, warnings)

  return {
    changed: true,
    dryRun: false,
    workspaceId: String(workspace.id),
    title: workspace.title,
    oldPath,
    newPath: target,
    sessions: sessionIds.length,
    migrateSessions,
    migrated,
    warnings,
  }
}

function formatRelocation(result) {
  if (result.dryRun !== true && !result.changed) return result.warnings.join('\n') || '没有改动。'
  const lines = []
  if (result.dryRun === true) lines.push('（预演，未写入任何改动）')
  lines.push(`${result.changed ? '已把' : '将把'}工作区「${result.title}」的目录改为：`)
  lines.push(`  旧: ${result.oldPath}`)
  lines.push(`  新: ${result.newPath}`)
  lines.push(`  登记会话: ${result.sessions} 个`)
  const live = result.migrated.filter((entry) => entry.status === 'live')
  const pending = result.migrated.filter((entry) => entry.status === 'pending')
  const failed = result.migrated.filter((entry) => entry.status === 'failed')
  const unknown = result.migrated.filter((entry) => entry.status === 'unknown')
  if (live.length > 0) lines.push(`  已立即迁移（运行中的会话）: ${live.length} 个`)
  if (pending.length > 0) lines.push(`  下次打开时自动跟随: ${pending.length} 个`)
  if (unknown.length > 0) lines.push(`  找不到会话日志、已跳过: ${unknown.length} 个`)
  for (const entry of failed) lines.push(`  失败: ${entry.sessionId} — ${entry.reason}`)
  for (const warning of result.warnings) lines.push(`注意: ${warning}`)
  if (result.changed) lines.push(`还原：把该工作区的目录改回 ${result.oldPath}（旧目录必须存在）。`)
  return lines.join('\n')
}

/** Per-session view of whether opening it would move it onto its workspace. */
async function checkFollow(ctx, registry, workspace, target) {
  const rows = []
  for (const sessionId of recordedSessionIds(registry, workspace.id, [...workspace.sessionIds])) {
    const header = await sessionHeaderOf(ctx, sessionId)
    const cwd = header?.cwd
    const cwdResolves = typeof cwd === 'string' && isFullyQualified(cwd) && await isDirectory(cwd)
    const live = ctx.get('agents')?.get(sessionId) !== undefined
    const cwdKnown = typeof cwd === 'string' && isFullyQualified(cwd)
    rows.push({
      sessionId,
      cwd: typeof cwd === 'string' ? cwd : '(none)',
      cwdResolves,
      live,
      follow: !cwdResolves && cwdKnown && !samePath(workspace.path, cwd),
    })
  }
  const lines = [`工作区「${workspace.title}」→ ${target} 的会话跟随情况：`]
  if (rows.length === 0) lines.push('  （登记会话为空）')
  for (const row of rows) {
    const state = row.live
      ? (row.cwdResolves ? '运行中，目录仍存在，不动' : '运行中，立即迁移')
      : (row.follow ? '下次打开时自动跟随' : '目录仍存在，不会跟随')
    lines.push(`  ${row.sessionId} | cwd: ${row.cwd} | ${state}`)
  }
  return lines.join('\n')
}

/**
 * Move one on-disk folder into a new parent directory and record a follow entry
 * so the sessions that lived there follow the move when they are next opened.
 * The workspace record (when one exists) is re-pointed with the ordinary
 * relocateWorkspace flow.
 */
async function moveFolderTo(ctx, options) {
  const from = await canonicalDirectory(options.from)
  const into = await canonicalDirectory(options.into)
  if (directoryKey(into) === directoryKey(from)) throw new Error('来源和目标是同一个文件夹')
  if (directoryKey(into).startsWith(directoryKey(from) + (isWindows ? '\\' : '/'))) {
    throw new Error('不能把文件夹移动到它自己的子目录里')
  }
  const registry = ctx.get('workspaceRegistry')
  const baseName = pathApi.basename(from)
  let target = join(into, baseName)
  if (await isDirectory(target)) {
    throw new Error(`目标位置已存在同名文件夹：${target}`)
  }

  const workspace = registry.list().find((candidate) => samePath(candidate.path, from))
  if (workspace !== undefined && workspace.sessionIds.length > 0) {
    const sessions = [...workspace.sessionIds].map(String)
    const live = sessions.filter((id) => ctx.get('agents')?.get(id) !== undefined)
    if (live.length > 0) {
      throw new Error(`该文件夹名下有 ${live.length} 个会话正在运行；先停止它们再移动文件夹`)
    }
  }

  try {
    await rename(from, target)
  } catch (error) {
    throw new Error(`移动文件夹失败：${messageOf(error)}`)
  }

  await recordFollow(ctx, from, target)

  let relocated
  if (workspace !== undefined) {
    relocated = await relocateWorkspace(ctx, {
      workspace: String(workspace.id),
      path: target,
      migrateSessions: true,
      force: true,
      dryRun: false,
    })
  }

  return {
    moved: true,
    from,
    target,
    followRecorded: true,
    workspace: workspace === undefined
      ? { known: false }
      : {
          known: true,
          id: String(workspace.id),
          title: workspace.title,
          sessions: relocated?.sessions ?? recordedSessionIds(registry, workspace.id, [...workspace.sessionIds]).length,
          pending: relocated?.migrated?.filter?.((entry) => entry.status === 'pending').length ?? 0,
        },
  }
}

function formatMoveFolder(result) {
  const lines = [`已把文件夹移到：${result.target}`]
  lines.push(`  原位置: ${result.from}`)
  if (result.workspace.known) {
    lines.push(`  工作区「${result.workspace.title}」已指向新位置（登记会话 ${result.workspace.sessions} 个，其中 ${result.workspace.pending} 个下次打开时跟随）`)
  } else {
    lines.push('  该文件夹没有对应工作区；名下会话下次打开时按跟随记录移动')
  }
  lines.push('还原：把文件夹移回原位置即可（跟随记录仍指向原目录→新目录，重新移动会覆盖）。')
  return lines.join('\n')
}

const TOOL_DESCRIPTION = [
  'List the registered Harness workspaces, or point one of them at a different existing directory.',
  'Moving a workspace rewrites its durable record; sessions whose recorded directory no longer exists follow the',
  'workspace — a running session immediately, a stored one the next time it is opened, when its own log records the',
  'directory change. The moveFolder action relocates a folder into a registered workspace directory (its files are',
  'moved on disk) and records a follow entry so its sessions follow even when no workspace claims them.',
  'export writes a snapshot of every workspace registration plus the bytes of its session logs; import recreates the',
  'registrations, rebuilds deleted session logs from those bytes, re-attaches each session at its recorded position,',
  'and makes archived sessions visible again. delete removes one workspace registration and leaves its directory and',
  'sessions in place (they show up as ungrouped).',
  'Use action "list" first to find the workspace, and "check" to see which sessions would follow.',
].join(' ')

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'check', 'move', 'moveFolder', 'map', 'export', 'import', 'delete', 'refresh'],
      description: 'list: every workspace with its recorded directory; check: session follow-up state; move: re-point one workspace; moveFolder: move a folder on disk into a registered workspace and follow it; map: show the recorded old→new follow entries; export: snapshot workspaces and session logs; import: restore workspaces, session logs, membership and positions from a snapshot; delete: remove one workspace registration; refresh: rebuild the session/directory index.',
    },
    workspace: {
      type: 'string',
      description: 'Workspace to act on: its title, its workspace id, or its current directory path. For export, limits the snapshot to that one workspace.',
    },
    path: {
      type: 'string',
      description: 'New directory for the workspace; an existing, fully qualified directory path.',
    },
    from: {
      type: 'string',
      description: 'moveFolder: the existing directory to move.',
    },
    into: {
      type: 'string',
      description: 'moveFolder: an existing registered workspace directory to move it into.',
    },
    file: {
      type: 'string',
      description: 'export/import: absolute path of the snapshot JSON file. Omit for export to default to ~/workspaces-export.json. A content-bearing export also writes <file>.sessions/.',
    },
    includeContent: {
      type: 'boolean',
      description: 'export: also copy every session log next to the snapshot so a deleted session can be rebuilt. Defaults to true.',
    },
    restoreMembership: {
      type: 'boolean',
      description: 'import: re-attach the recorded sessions at their recorded positions. Defaults to true.',
    },
    restoreContent: {
      type: 'boolean',
      description: 'import: rebuild session logs that are missing locally from the snapshot bytes. Defaults to true.',
    },
    unarchive: {
      type: 'boolean',
      description: 'import: make sessions the snapshot recorded as archived visible again. Defaults to true.',
    },
    migrateSessions: {
      type: 'boolean',
      description: 'Let the workspace sessions follow the new directory. Defaults to true.',
    },
    force: {
      type: 'boolean',
      description: 'Move even when the old directory still exists and the workspace has sessions. Defaults to false.',
    },
    dryRun: {
      type: 'boolean',
      description: 'Validate and report the planned change without writing anything. Defaults to false.',
    },
  },
  required: ['action'],
  additionalProperties: false,
}

function tokenize(line) {
  const tokens = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = pattern.exec(line)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3])
  }
  return tokens
}

const COMMAND_FLAGS = new Map([
  ['--no-sessions', 'noSessions'],
  ['--sessions', 'sessions'],
  ['--force', 'force'],
  ['--dry-run', 'dryRun'],
  ['--no-content', 'noContent'],
  ['--no-membership', 'noMembership'],
  ['--keep-archived', 'keepArchived'],
  ['--check', 'check'],
])

function parseCommandLine(rawInput) {
  const tokens = tokenize(rawInput ?? '')
  const flags = new Set()
  const positional = []
  for (const token of tokens) {
    const flag = COMMAND_FLAGS.get(token.toLowerCase())
    if (flag !== undefined) flags.add(flag)
    else positional.push(token)
  }
  return { positional, flags }
}

/** Split `move <workspace…> <path…>` input: the workspace name may contain spaces. */
function resolveMoveTarget(registry, tokens) {
  let firstError
  for (let count = 1; count < tokens.length; count++) {
    const selector = tokens.slice(0, count).join(' ')
    const rest = tokens.slice(count).join(' ').trim()
    if (rest === '') continue
    try {
      findWorkspace(registry, selector)
      return { workspace: selector, path: rest }
    } catch (error) {
      firstError ??= error
    }
  }
  throw firstError ?? new Error('用法：/workspace-dir move <工作区标题|ID|当前路径> <新目录>')
}

export function apply(ctx) {
  /** Register the two entry points for as long as the required services exist. */
  ctx.inject(['tools', 'commands', 'workspaceRegistry'], (serviceCtx) => {
    const registry = serviceCtx.workspaceRegistry

    serviceCtx.tools.register({
      name: 'workspace_directory',
      description: TOOL_DESCRIPTION,
      parameters: TOOL_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const action = ['move', 'check', 'moveFolder', 'map', 'refresh', 'export', 'import', 'delete'].includes(args.action)
          ? args.action
          : 'list'
        if (action === 'list') return formatWorkspaceList(await readWorkspaces(registry))
        if (action === 'export') {
          return formatExport(await exportWorkspaces(ctx, {
            file: args.file,
            includeContent: args.includeContent,
            workspace: args.workspace,
          }))
        }
        if (action === 'import') {
          return formatImport(await importWorkspaces(ctx, {
            file: args.file,
            restoreMembership: args.restoreMembership,
            restoreContent: args.restoreContent,
            unarchive: args.unarchive,
            dryRun: args.dryRun,
          }))
        }
        if (action === 'delete') return formatDelete(await deleteWorkspace(ctx, args.workspace))
        if (action === 'refresh') {
          const ok = await refreshSessionIndex(ctx, undefined)
          if (!ok) return '无法刷新会话索引：工作区注册表缺少索引方法。'
          return `会话索引已刷新。\n${formatWorkspaceList(await readWorkspaces(registry))}`
        }
        if (action === 'check') {
          const workspace = findWorkspace(registry, args.workspace)
          return checkFollow(ctx, registry, workspace, workspace.path)
        }
        if (action === 'map') {
          const entries = await readFollowMap()
          const lines = [`跟随记录（${mapFilePath()}）：`]
          const rows = Object.entries(entries)
          if (rows.length === 0) lines.push('  （空）')
          for (const [from, value] of rows) lines.push(`  ${from} → ${value.target}`)
          return lines.join('\n')
        }
        if (action === 'moveFolder') {
          return formatMoveFolder(await moveFolderTo(ctx, { from: args.from, into: args.into }))
        }
        const result = await relocateWorkspace(ctx, {
          workspace: args.workspace,
          path: args.path,
          migrateSessions: args.migrateSessions,
          force: args.force,
          dryRun: args.dryRun,
        }, exec.signal)
        return formatRelocation(result)
      },
    })

    serviceCtx.commands.register({
      name: 'workspace-dir',
      description: '查看/修改工作区目录、导出导入工作区快照（含会话日志）',
      input: { hint: 'list | check <工作区> | move <工作区> <新目录> | export [文件] [--no-content] | import <文件> [--dry-run] [--no-membership] [--keep-archived] | delete <工作区> | map | refresh' },
      async handler({ rawInput }) {
        try {
          const { positional, flags } = parseCommandLine(rawInput)
          const action = (positional[0] ?? 'list').toLowerCase()
          if (action === 'list') return { kind: 'success', text: formatWorkspaceList(await readWorkspaces(registry)) }
          if (action === 'export') {
            return {
              kind: 'success',
              text: formatExport(await exportWorkspaces(ctx, {
                file: positional.slice(1).join(' '),
                includeContent: !flags.has('noContent'),
              })),
            }
          }
          if (action === 'import') {
            const file = positional.slice(1).join(' ').trim()
            if (file === '') return { kind: 'error', text: '用法：/workspace-dir import <导出文件路径> [--dry-run] [--no-membership] [--keep-archived]' }
            return {
              kind: 'success',
              text: formatImport(await importWorkspaces(ctx, {
                file,
                restoreMembership: !flags.has('noMembership'),
                restoreContent: !flags.has('noContent'),
                unarchive: !flags.has('keepArchived'),
                dryRun: flags.has('dryRun'),
              })),
            }
          }
          if (action === 'delete') {
            const target = positional.slice(1).join(' ').trim()
            if (target === '') return { kind: 'error', text: '用法：/workspace-dir delete <工作区标题|ID|路径>（只删登记，目录和会话都保留）' }
            return { kind: 'success', text: formatDelete(await deleteWorkspace(ctx, target)) }
          }
          if (action === 'map') {
            const entries = await readFollowMap()
            const lines = [`跟随记录（${mapFilePath()}）：`]
            const rows = Object.entries(entries)
            if (rows.length === 0) lines.push('  （空）')
            for (const [from, value] of rows) lines.push(`  ${from} → ${value.target}`)
            return { kind: 'success', text: lines.join('\n') }
          }
          if (action === 'refresh') {
            const ok = await refreshSessionIndex(ctx, undefined)
            return ok
              ? { kind: 'success', text: `会话索引已刷新。\n${formatWorkspaceList(await readWorkspaces(registry))}` }
              : { kind: 'error', text: '无法刷新会话索引：工作区注册表缺少索引方法。' }
          }
          if (action === 'check') {
            const workspace = findWorkspace(registry, positional.slice(1).join(' '))
            return { kind: 'success', text: await checkFollow(ctx, registry, workspace, workspace.path) }
          }
          if (action !== 'move' && action !== 'set' && action !== 'cd') {
            return { kind: 'error', text: '用法：/workspace-dir list | check <工作区> | move <工作区> <新目录>' }
          }
          const rest = positional.slice(1)
          if (rest.length < 2) {
            return { kind: 'error', text: '用法：/workspace-dir move <工作区标题|ID|当前路径> <新目录>' }
          }
          const resolved = resolveMoveTarget(registry, rest)
          const result = await relocateWorkspace(ctx, {
            workspace: resolved.workspace,
            path: resolved.path,
            migrateSessions: !flags.has('noSessions'),
            force: flags.has('force'),
            dryRun: flags.has('dryRun'),
          })
          return { kind: 'success', text: formatRelocation(result) }
        } catch (error) {
          return { kind: 'error', text: messageOf(error) }
        }
      },
    })
  })

  /**
   * A stored session whose recorded directory disappeared follows the one
   * workspace that claims it, at the moment DSH opens it. Changing the directory
   * this way appends `working-directory/change` to that session's own log.
   */
  ctx.on('agent/created', async ({ agent }) => {
    try {
      const found = await followTargetOf(ctx, requireService(ctx, 'workspaceRegistry'), agent.session)
      if (found === undefined) return
      const workingDirectory = ctx.get('workingDirectory')
      if (workingDirectory === undefined) return
      await workingDirectory.set(agent, found.target)
      if (found.mapKey !== undefined) await forgetFollow(agent.session.header?.cwd ?? '')
    } catch (error) {
      ctx.logger?.warn?.(`workspace-dir: could not move session "${agent.id}" onto its workspace: ${messageOf(error)}`)
    }
  })
}
