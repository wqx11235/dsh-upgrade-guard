// dsh-upgrade-guard — host half (lib/index.js)
//
// 让「更新 DSH 本体」不再打崩插件：升级前兼容盘点、升级后契约扫描、切换端口前启动冒烟。
//
// 设计约束（每条都是为了在更多 DSH 版本上活下来）：
//   1. **不 import 任何 @deepseek-ai/* 包** —— 只用 node 内置模块 + `webServer` 服务。
//      历史崩因里最大的一类就是「宿主改了包/服务契约，插件还在 import 旧东西」
//      （0.1.2 client-modules 模块表、0.1.7 settingsScope 移除）。零依赖 = 不会因它们而崩。
//   2. **不写死任何本机路径** —— profile 从本插件自身位置向上找，宿主 bin/安装根从
//      `process.argv[1]` 推导，primitives 目录多候选（profile → 共享 profiles/node_modules
//      → 宿主安装根 → 显式参数）。同一份代码适用于网页端（profiles/web）与桌面端（profiles/desktop）。
//   3. **Electron 感知** —— 桌面端宿主是 Electron，`process.execPath` 是 App 可执行文件，
//      直接 spawn 会再开一个 App 窗口；必须带 `ELECTRON_RUN_AS_NODE=1` 才会当 node 用。
//      打包进 app.asar 时子进程拿不到真实文件路径，此时冒烟要明确报「不支持」而不是静默失败。
//
// 重活都在 lib/guard.mjs（与本仓库 CLI 同一份文件），这里以子进程 + `--json` 方式调用它，
// 两边永远不会分叉。本文件只做：路径推导 + 路由 + 结果摘要。
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, realpathSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI = join(HERE, 'guard.mjs')
const DSH_PKG = '@deepseek-ai/dsh'
const PRIMITIVES = 'dsh-client-ui-primitives'

// --- 基础路径 ---------------------------------------------------------------

function dshHome() {
  const raw = process.env.DSH_HOME || join(homedir(), '.dsh')
  return String(raw).replace(/[\\/]+$/, '')
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 本插件所在的 profile 目录：从插件自身向上找带 dsh.profile 的 package.json */
function findProfile() {
  let dir = HERE
  for (let i = 0; i < 8; i += 1) {
    const pkg = readJsonSafe(join(dir, 'package.json'))
    if (pkg && pkg.dsh && pkg.dsh.profile) return dir
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return null
}

/**
 * profile 解析顺序：config.profile > DSH_PROFILE > 从插件自身位置向上找 dsh.profile > 兜底 web。
 * 一定要**带着兜底值**继续往下走：如果因为找不到 dsh.profile 就交给 null，
 * primitives 探测会跟着一起落空 —— 扫描里最值钱的"引用了不存在的导出"就静默失效了。
 */
function resolveProfile(cfg) {
  if (cfg.profile && existsSync(cfg.profile)) return { dir: cfg.profile, source: 'config' }
  if (process.env.DSH_PROFILE && existsSync(process.env.DSH_PROFILE)) return { dir: process.env.DSH_PROFILE, source: 'env' }
  const found = findProfile()
  if (found) return { dir: found, source: 'plugin-location' }
  return { dir: join(dshHome(), 'profiles', 'web'), source: 'fallback' }
}

/**
 * 运行中的宿主：入口 bin、安装根（node_modules 那层）、宿主的 ui-primitives 目录。
 * 全部从 `process.argv[1]` 推导，而不是写死某个安装目录。
 * 桌面端（Electron）的入口可能落在 app.asar 内，此时只标记 packaged，不假装拿到目录。
 */
function findHost() {
  const entry = process.argv[1] || null
  const info = {
    bin: entry,
    version: null,
    installRoot: null,
    primitives: null,
    packaged: Boolean(entry && /[\\/]app\.asar[\\/]/.test(entry)),
  }
  if (!entry) return info

  let dir
  try {
    dir = dirname(realpathSync(entry))
  } catch {
    dir = dirname(resolve(entry))
  }
  for (let i = 0; i < 12; i += 1) {
    const pkg = readJsonSafe(join(dir, 'package.json'))
    if (pkg && pkg.name === DSH_PKG) {
      info.version = pkg.version || null
      info.installRoot = resolve(dir, '..', '..')
      const prim = join(info.installRoot, '@deepseek-ai', PRIMITIVES)
      if (existsSync(prim)) info.primitives = prim
      return info
    }
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return info
}

/**
 * ui-primitives 目录的候选（顺序 = 可信度）。
 * 桌面端的 profile 是 `profiles/desktop`，依赖却在**兄弟目录** `profiles/node_modules`，
 * 所以"从 profile 向上找 node_modules"这一条是桌面端能用的关键。
 */
function primitivesCandidates(profile, host) {
  const out = []
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p)
  }
  if (process.env.DSH_PRIMITIVES) push(process.env.DSH_PRIMITIVES)
  if (host && host.primitives) push(host.primitives)
  if (host && host.installRoot) push(join(host.installRoot, '@deepseek-ai', PRIMITIVES))
  if (profile) {
    let dir = profile
    for (let i = 0; i < 6; i += 1) {
      push(join(dir, 'node_modules', '@deepseek-ai', PRIMITIVES))
      const up = resolve(dir, '..')
      if (up === dir) break
      dir = up
    }
  }
  return out
}

/** 选中的 primitives 目录 + 它的版本 + 来源标签（用于在 UI 上诚实标注"这份导出表是谁的"） */
function pickPrimitives(profile, host) {
  const candidates = primitivesCandidates(profile, host)
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    const pkg = readJsonSafe(join(dir, 'package.json'))
    let source = 'external'
    if (host && (dir === host.primitives || (host.installRoot && dir.startsWith(host.installRoot)))) source = 'host-install'
    else if (profile && dir.startsWith(profile)) source = 'profile'
    else if (dir.includes(`${join('profiles', 'node_modules')}`)) source = 'shared-tree'
    return { dir, version: (pkg && pkg.version) || null, source, candidates }
  }
  return { dir: null, version: null, source: null, candidates }
}

// --- 子进程调用（引擎）-------------------------------------------------------

/** Electron 的 process.execPath 是 App 可执行文件；不加这个会再开一个 App 窗口 */
function nodeSpawnEnv(extra) {
  const env = { ...process.env, ...(extra || {}) }
  if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function runCli(args, envExtra, timeoutMs = 600000) {
  return new Promise((resolvePromise) => {
    let out = ''
    let settled = false
    let child
    try {
      child = spawn(process.execPath, [CLI, ...args], {
        cwd: dshHome(),
        windowsHide: true,
        env: nodeSpawnEnv(envExtra),
      })
    } catch (e) {
      resolvePromise({ ok: false, code: null, output: `spawn failed: ${(e && e.message) || e}` })
      return
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      resolvePromise({ ok: false, code: null, output: out + `\n[timeout after ${Math.round(timeoutMs / 1000)}s]` })
    }, timeoutMs)
    const push = (chunk) => {
      out += chunk.toString()
      if (out.length > 200000) out = out.slice(-200000)
    }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: false, code: null, output: out + '\n' + String((e && e.message) || e) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, code, output: out })
    })
  })
}

function parseGuardJson(output) {
  const i = String(output || '').indexOf('---JSON---')
  if (i < 0) return null
  try {
    return JSON.parse(String(output).slice(i + '---JSON---'.length))
  } catch {
    return null
  }
}

function summariseScan(json) {
  let criticalCount = 0
  let warnCount = 0
  const topFindings = []
  for (const p of (json && json.results) || []) {
    for (const f of p.findings || []) {
      if (f.severity === 'critical') {
        criticalCount += 1
        if (topFindings.length < 8) topFindings.push(`${p.name}: ${f.rule} ${f.file}:${f.line}`)
      } else warnCount += 1
    }
  }
  return {
    criticalCount,
    warnCount,
    scanned: (json && (json.scanned || (json.results || []).length)) || 0,
    topFindings,
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// --- 插件本体 ---------------------------------------------------------------

export const name = 'dsh-upgrade-guard'
export const inject = ['webServer']

export function apply(ctx, config) {
  // 0.1.x 的服务代理允许 ctx.get；0.2.x 收紧后要直接取属性。两种都试，谁都不断。
  const webServer = (ctx && ctx.webServer) || (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  if (webServer === undefined) return

  const cfg = config && typeof config === 'object' ? config : {}
  const prof = resolveProfile(cfg)
  const profile = prof.dir
  const host = findHost()
  const prim = pickPrimitives(profile, host)
  const reports = cfg.reportDir || join(dshHome(), 'upgrade-guard')

  const paths = {
    profile,
    profileName: basename(profile),
    profileSource: prof.source,
    cli: CLI,
    engine: CLI,
    bin: host.bin,
    installRoot: host.installRoot,
    primitives: prim.dir,
    dshHome: dshHome(),
    reports,
  }

  const hostInfo = {
    version: host.version,
    runtime: process.versions && process.versions.electron ? 'desktop' : 'web',
    electron: (process.versions && process.versions.electron) || null,
    node: process.versions ? process.versions.node : null,
    packaged: host.packaged,
    bin: host.bin,
    installRoot: host.installRoot,
    primitives: prim.dir,
    primitivesVersion: prim.version,
    primitivesSource: prim.source,
    primitivesCandidates: prim.candidates,
  }

  const smokePort = Number(cfg.smokePort) > 0 ? Number(cfg.smokePort) : 3099
  const smokeTimeout = Number(cfg.smokeTimeout) > 0 ? Number(cfg.smokeTimeout) : 120

  /** 桌面端打包运行时：入口在 app.asar 内，子进程无法把它当脚本跑 —— 明确说明，不静默失败 */
  function smokeUnsupported() {
    if (!host.packaged) return null
    return {
      kind: 'smoke',
      ok: false,
      verdict: 'UNSUPPORTED',
      summary: 'packaged desktop runtime: the dsh entry lives inside app.asar',
      reportPath: null,
      tail: [
        '本宿主是打包 Electron 运行时，入口在 app.asar 内，无法再起一个测试进程。',
        '替代方案：① 桌面端「设置 → 通用 → 版本更新」先跑升级前检查；② 在网页端 profile（有真实 bin.js）跑启动冒烟。',
      ],
      error: 'smoke is not available inside a packaged app.asar runtime',
    }
  }

  async function runScan() {
    const reportPath = join(reports, `scan-${stamp()}.md`)
    const args = ['scan', '--json', '--report', reportPath, '--profile', paths.profile]
    if (prim.dir) args.push('--primitives', prim.dir)
    const res = await runCli(args, {}, 180000)
    const json = parseGuardJson(res.output)
    const out = { kind: 'scan', reportPath, ok: Boolean(json) }
    if (json) Object.assign(out, summariseScan(json))
    else out.error = `scan 未返回 JSON（exit ${res.code}）；输出末尾：${String(res.output).slice(-400)}`
    return out
  }

  async function runPreflight(target) {
    const reportPath = join(reports, `preflight-${stamp()}.md`)
    const res = await runCli([
      'preflight', '--json', '--report', reportPath,
      '--target', target || 'latest', '--profile', paths.profile,
    ], {}, 300000)
    const json = parseGuardJson(res.output)
    const out = { kind: 'preflight', reportPath, ok: Boolean(json) }
    if (json) {
      out.target = json.target
      out.rows = (json.rows || []).map((r) => ({
        name: r.name,
        installed: r.installed,
        spec: r.spec,
        kind: r.kind,
        latest: r.latest,
        notes: r.notes || [],
      }))
      out.stale = out.rows
        .filter((r) => /有新版可升/.test((r.notes || []).join(' ')))
        .map((r) => `${r.name} ${r.installed} → ${r.latest}`)
    } else {
      out.error = `preflight 未返回 JSON（exit ${res.code}）；输出末尾：${String(res.output).slice(-400)}`
    }
    return out
  }

  async function runSmoke(opts) {
    const unsupported = smokeUnsupported()
    if (unsupported) return unsupported
    const port = Number(opts.port) || smokePort
    const timeout = Number(opts.timeout) || smokeTimeout
    const reportPath = join(reports, `smoke-${stamp()}.md`)
    const args = ['smoke', '--report', reportPath, '--port', String(port), '--timeout', String(timeout)]
    const bin = opts.bin || paths.bin
    if (bin) args.push('--bin', bin)
    if (opts.cwd) args.push('--cwd', opts.cwd)
    if (paths.profile) args.push('--profile', paths.profile)
    const res = await runCli(args, {}, (timeout + 150) * 1000)
    const text = String(res.output || '')
    const json = parseGuardJson(text)
    if (json && json.kind === 'smoke') return { ...json, reportPath: json.reportPath || reportPath, ok: json.ok !== false }
    const verdict = /RESULT\s+(PASS|FAIL)/.exec(text)
    const summary = /booted=.*$/m.exec(text)
    return {
      kind: 'smoke',
      ok: Boolean(verdict && verdict[1] === 'PASS'),
      verdict: verdict ? verdict[1] : 'UNKNOWN',
      summary: summary ? summary[0].trim() : '',
      reportPath,
      tail: text.split(/\r?\n/).filter((l) => l.trim()).slice(-25),
    }
  }

  async function handle(body) {
    const action = String(body.action || 'status')
    if (action === 'status') return { ok: true, paths, host: hostInfo }
    if (action === 'scan') return { ok: true, result: await runScan(), paths, host: hostInfo }
    if (action === 'preflight') return { ok: true, result: await runPreflight(String(body.target || 'latest')), paths, host: hostInfo }
    if (action === 'smoke') {
      const r = await runSmoke({ bin: body.bin, cwd: body.cwd, port: body.port, timeout: body.timeout })
      return { ok: Boolean(r.ok), result: r, paths, host: hostInfo }
    }
    return { ok: false, error: `unknown action: ${action}`, paths, host: hostInfo }
  }

  function sendJson(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  }

  function readBody(req) {
    return new Promise((resolvePromise) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        try { resolvePromise(JSON.parse(raw || '{}')) } catch { resolvePromise({}) }
      })
    })
  }

  // 直接注册在 webServer 上：0.1.2+ 的浏览器会话认证只拦 API 网关那条链，
  // 直挂路由（/dsh-market/*、本路由）不需要 cookie，网页端与桌面端都能调。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-upgrade-guard',
    handler: async (req, res) => {
      try {
        const body = req.method === 'GET' ? { action: 'status' } : await readBody(req)
        return sendJson(res, 200, await handle(body))
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String((e && e.message) || e), paths, host: hostInfo })
      }
    },
  }))

  ctx.logger?.info?.(`upgrade-guard ready · profile=${paths.profile} · runtime=${hostInfo.runtime} · primitives=${prim.dir || 'none'}`)
}

export default { name, inject, apply }
