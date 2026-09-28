#!/usr/bin/env node
/**
 * dsh-upgrade-guard.mjs — 让"升级 DSH 本体"不再把插件打崩
 * ---------------------------------------------------------------------------
 * 背景：2026-09-28 一天内三起故障（settingsScope 服务被移除 / 会话消息 v4
 *   source 契约被拒 / 宿主 primitives 图标改名致 React #130），以及此前
 *   deepread、pocket 等同类案例 —— 规律都是「宿主升级 = 契约变更，插件没跟上」。
 *   本工具把每次排障得到的判据固化成可复用检查，分三层：
 *
 *   scan       按「已知破坏性契约」目录扫描已装插件（离线、秒级）
 *   preflight  升级前盘点：每个插件声明的兼容范围 + npm 最新版 → 能不能升 + 停用清单
 *   smoke      （下一步）新版本先在 3099 起一次，抓启动摘要与 boot graph，通过才切 3080
 *
 * 用法：
 *   node tools/dsh-upgrade-guard.mjs scan                     # 扫当前已装插件 vs 当前宿主
 *   node tools/dsh-upgrade-guard.mjs scan --primitives <dir>  # 指定宿主的 ui-primitives 目录
 *   node tools/dsh-upgrade-guard.mjs preflight                # 目标 = npm 上的 latest
 *   node tools/dsh-upgrade-guard.mjs preflight --target 0.1.8-rc.1
 *   node tools/dsh-upgrade-guard.mjs preflight --only dshmarket,dsh-experience
 *
 * 常用参数：--profile <dir>（默认 ~/.dsh/profiles/web）· --report <file>（写中文报告）
 *          --no-network（preflight 跳过联网）· --only a,b（只查这些插件）· --json
 *
 * 约定：控制台只打英文/ASCII（cmd.exe 默认代码页 936 会把中文 UTF-8 显示成乱码），
 *       中文结论写进 --report 指定的文件（默认 tools/dsh-upgrade-guard.report.md）。
 *
 * 退出码：0 = 无 critical；1 = 有 warning；2 = 有 critical（升级前必须先处理）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- 已知破坏性契约目录（每次排障后往这里加一条）---------------------------
const KNOWN_RULES = [
  {
    id: 'removed-service',
    severity: 'critical',
    // 宿主已移除/改名的服务名（0.1.7 实测 settingsScope 归零；0.1.2 起 conversationEvents 归零）
    services: [
      { name: 'settingsScope', since: '0.1.7', alt: 'settingsSchema / configForms（client）、settingsController（host）' },
      { name: 'conversationEvents', since: '0.1.2', alt: '（当时全官方包 grep 为空）' },
    ],
    fix: '升级该插件到适配版；无适配版则停用（bundle → 从 dsh.profile.bundles 移除；patch → 删 cordis.patch.yml 的 insert 行）',
  },
  {
    id: 'session-source-v4',
    severity: 'critical',
    // 会话消息 source 旧写法：{ kind: 'plugin', plugin: 'x' }（0.1.7-rc.2 起被拒收）
    fix: '改成 { kind: \'<插件自有名>\' }（去掉 kind: plugin 包装）；本地 private 插件只能改源码并留 .bak',
    doc: 'experience/01-plugin-development/15-session-message-source-v4.md',
  },
  {
    id: 'missing-host-export',
    severity: 'critical',
    // 插件客户端 bundle 引用了宿主 primitives 导出表里不存在的名字
    // （2026-09-28 实例：0.1.7-alpha.1 把 IconXxx14/16 改成 IconXxxRegular/Medium，无别名 → React #130）
    fix: '升级该插件到适配版（上游通常加"新名优先、旧名回退"的解析器）；不要 alias 宿主导出或改插件 bundle',
    doc: 'experience/01-plugin-development/16-client-primitives-rename-react-130.md',
  },
  {
    id: 'pinned-exact',
    severity: 'warn',
    // profile 里对插件用精确版本（无 ^ / ~ / 范围）→ 它永远不会自己跟上宿主
    fix: '若无特殊理由，把精确版本改为 ^x.y.z，让插件能随宿主更新',
  },
]

const HOST_EXPORT_PKGS = ['@deepseek-ai/dsh-client-ui-primitives']

// --- 参数 -------------------------------------------------------------------
function parseArgs(argv) {
  const out = { cmd: null, profile: null, primitives: null, report: null, target: 'latest', network: true, only: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === 'scan' || a === 'preflight' || a === 'smoke') out.cmd = a
    else if (a === '--profile') out.profile = argv[++i]
    else if (a === '--primitives') out.primitives = argv[++i]
    else if (a === '--report') out.report = argv[++i]
    else if (a === '--target') out.target = argv[++i]
    else if (a === '--only') out.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--no-network') out.network = false
    else if (a === '--json') out.json = true
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0) }
    else { console.error(`unknown argument: ${a}`); printHelp(); process.exit(2) }
  }
  if (!out.cmd) { printHelp(); process.exit(2) }
  return out
}

function printHelp() {
  console.log(`dsh-upgrade-guard.mjs — keep DSH core upgrades from breaking plugins

  node tools/dsh-upgrade-guard.mjs scan      [--primitives <dir>] [--profile <dir>] [--report <file>]
  node tools/dsh-upgrade-guard.mjs preflight [--target <ver|latest>] [--no-network] [--only a,b]

  scan       offline: check installed plugins against the KNOWN breakage catalogue
  preflight  online: ask npm what each plugin declares / whether a newer version exists

  console output is English on purpose (cmd.exe CP936 garbles UTF-8 Chinese);
  the Chinese report goes to --report (default tools/dsh-upgrade-guard.report.md).`)
}

// --- 小工具 -----------------------------------------------------------------
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length
const jsonRead = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

function profileNodeModules(profile) {
  return path.join(profile, 'node_modules')
}

function listPluginDirs(profile) {
  const root = profileNodeModules(profile)
  const out = []
  let entries
  try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    if (e.name.startsWith('@')) {
      let subs
      try { subs = fs.readdirSync(path.join(root, e.name), { withFileTypes: true }) } catch { continue }
      for (const s of subs) if (s.isDirectory()) out.push(path.join(root, e.name, s.name))
    } else out.push(path.join(root, e.name))
  }
  return out
}

/** 判断 offset 处是否落在注释里（行注释 / 块注释 / JSDoc 续行）——注释里的提及不是代码引用 */
function isCommentContext(text, offset) {
  const lineStart = text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1
  const before = text.slice(lineStart, offset)
  if (before.includes('//')) return true
  if (/^\s*\*/.test(before)) return true
  const open = text.lastIndexOf('/*', offset)
  const close = text.lastIndexOf('*/', offset)
  return open > close
}

// --- 宿主导出表（用于 missing-host-export）----------------------------------
function readHostExportSet(primitivesDir) {
  const set = new Set()
  if (!primitivesDir || !fs.existsSync(primitivesDir)) return set
  const files = [
    path.join(primitivesDir, 'lib', 'types', 'index.d.ts'),
    path.join(primitivesDir, 'lib', 'types', 'icons', 'index.d.ts'),
  ]
  for (const f of files) {
    if (!fs.existsSync(f)) continue
    const t = fs.readFileSync(f, 'utf8')
    for (const m of t.matchAll(/export\s+(?:declare\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1])
    for (const m of t.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim()
        if (/^[A-Za-z_$][\w$]*$/.test(name)) set.add(name)
      }
    }
  }
  return set
}

function guessPrimitivesDir(profile) {
  const candidates = [
    path.join(profileNodeModules(profile), '@deepseek-ai', 'dsh-client-ui-primitives'),
    'D:\\deepseek_harness\\dsh-runtime\\node_modules\\@deepseek-ai\\dsh-client-ui-primitives',
    'D:\\deepseek_harness\\deepseek-harness\\node_modules\\@deepseek-ai\\dsh-client-ui-primitives',
  ]
  return candidates.find((c) => fs.existsSync(c)) || null
}

// --- 文件遍历 ---------------------------------------------------------------
const SCAN_EXTS = new Set(['.js', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', 'docs', 'examples', 'fixtures', 'locale', 'src'])

function walkFiles(dir, depth = 0, budget = { bytes: 0 }, maxDepth = 2, maxBytes = 40 * 1024 * 1024) {
  const out = []
  if (depth > maxDepth || budget.bytes > maxBytes) return out
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walkFiles(p, depth + 1, budget, maxDepth, maxBytes))
      continue
    }
    if (!SCAN_EXTS.has(path.extname(e.name))) continue
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (st.size > 8 * 1024 * 1024) continue
    budget.bytes += st.size
    out.push(p)
  }
  return out
}

// --- scan 规则实现 ----------------------------------------------------------
const RE_SOURCE_OLD = /source\s*:\s*\{[\s\S]{0,300}?kind\s*:\s*['"]plugin['"]/g

function scanPluginClientExports(file, text, hostExports) {
  const findings = []
  const aliases = new Set()
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:__toESM\(\s*)?require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (HOST_EXPORT_PKGS.includes(m[2])) aliases.add(m[1])
  }
  for (const m of text.matchAll(/import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g)) {
    if (HOST_EXPORT_PKGS.includes(m[2])) aliases.add(m[1])
  }
  for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    if (!HOST_EXPORT_PKGS.includes(m[2])) continue
    for (const raw of m[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue
      if (hostExports.size && !hostExports.has(name)) {
        findings.push({ line: lineOf(text, m.index), name, how: 'named import' })
      }
    }
  }
  for (const alias of aliases) {
    const re = new RegExp(`${alias.replace(/\$/g, '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g')
    const seen = new Set()
    for (const m of text.matchAll(re)) {
      const name = m[1]
      if (seen.has(name)) continue
      seen.add(name)
      if (hostExports.size && !hostExports.has(name)) findings.push({ line: lineOf(text, m.index), name, how: `${alias}.${name}` })
    }
  }
  return findings
}

function scanPlugin(dir) {
  const pkg = jsonRead(path.join(dir, 'package.json'))
  const plugin = { name: (pkg && pkg.name) || path.basename(dir), version: (pkg && pkg.version) || '?', dir, private: !!(pkg && pkg.private), findings: [] }
  const files = walkFiles(dir)
  for (const f of files) {
    let text
    try { text = fs.readFileSync(f, 'utf8') } catch { continue }
    const rel = path.relative(dir, f)

    for (const rule of KNOWN_RULES) {
      if (rule.id === 'removed-service') {
        for (const svc of rule.services) {
          const re = new RegExp(`\\b${svc.name}\\b`, 'g')
          let m
          while ((m = re.exec(text)) !== null) {
            // 注释里的提及不是代码引用（2026-09-29 实测：dsh-core-update 的注释里写
            // "…exports inject (e.g. ["slots","settingsScope"])" 被误报为 critical）
            if (isCommentContext(text, m.index)) { if (m[0].length === 0) re.lastIndex++; continue }
            // 该文件只要在 inject([...]) / inject: [...] / exports.inject = [...] 里声明过这个服务，
            // 就按"可选依赖"处理：服务不存在时插件会优雅跳过（实例：dsh-univer-office / dshmarket）→ warn。
            const declared = new Set()
            for (const inj of text.matchAll(/inject\s*[:=]?\s*\(\s*\[([^\]]*)\]|inject\s*[:=]\s*\[([^\]]*)\]/g)) {
              for (const q of (inj[1] || inj[2] || '').matchAll(/['"]([^'"]+)['"]/g)) declared.add(q[1])
            }
            const optional = declared.has(svc.name)
            plugin.findings.push({
              rule: rule.id,
              severity: optional ? 'warn' : rule.severity,
              file: rel,
              line: lineOf(text, m.index),
              detail: `引用${optional ? '（可选注入，缺失时优雅跳过）' : ''}已移除的服务 ${svc.name}（${svc.since} 起）→ 替代：${svc.alt}`,
              fix: rule.fix,
              doc: rule.doc,
            })
            if (m[0].length === 0) re.lastIndex++
          }
        }
      }
    }

    // 会话消息 source 旧写法
    RE_SOURCE_OLD.lastIndex = 0
    let m
    while ((m = RE_SOURCE_OLD.exec(text)) !== null) {
      const inner = m[0].match(/kind\s*:\s*['"]plugin['"]/)
      const off = m.index + m[0].lastIndexOf(inner[0])
      plugin.findings.push({ rule: 'session-source-v4', severity: 'critical', file: rel, line: lineOf(text, off), detail: "会话消息 source 用了旧写法 kind: 'plugin'（v4 拒收）", fix: KNOWN_RULES.find((r) => r.id === 'session-source-v4').fix, doc: KNOWN_RULES.find((r) => r.id === 'session-source-v4').doc })
      if (m[0].length === 0) RE_SOURCE_OLD.lastIndex++
    }
  }
  return plugin
}

// --- scan 主流程 ------------------------------------------------------------
function runScan(opt) {
  const profile = opt.profile || path.join(os.homedir(), '.dsh', 'profiles', 'web')
  const primitivesDir = opt.primitives || guessPrimitivesDir(profile)
  const hostExports = readHostExportSet(primitivesDir)
  const profilePkg = jsonRead(path.join(profile, 'package.json'))
  const bundles = new Set(((profilePkg && profilePkg.dsh && profilePkg.dsh.profile && profilePkg.dsh.profile.bundles) || []))
  const deps = (profilePkg && profilePkg.dependencies) || {}

  const allDirs = listPluginDirs(profile)
  const dirs = allDirs.filter((d) => {
    const pkg = jsonRead(path.join(d, 'package.json'))
    if (!pkg) return false
    if (opt.only) return opt.only.includes(pkg.name) || opt.only.includes(path.basename(d))
    // 只扫"真插件"：声明了 dsh 字段 / 在 bundles 里 / 本地 private / 名字是 dsh-*
    return !!pkg.dsh || bundles.has(pkg.name) || pkg.private === true || String(pkg.name || '').startsWith('dsh-')
  })
  console.log(`      packages in node_modules=${allDirs.length}  treated as plugins=${dirs.length}`)

  const results = []
  for (const dir of dirs) {
    const plugin = scanPlugin(dir)

    // 客户端 bundle vs 宿主导出表
    if (hostExports.size) {
      for (const f of walkFiles(dir, 0, { bytes: 0 }, 2)) {
        let text
        try { text = fs.readFileSync(f, 'utf8') } catch { continue }
        if (!HOST_EXPORT_PKGS.some((p) => text.includes(p))) continue
        for (const hit of scanPluginClientExports(f, text, hostExports)) {
          plugin.findings.push({
            rule: 'missing-host-export', severity: 'critical', file: path.relative(dir, f), line: hit.line,
            detail: `引用了宿主导出表里不存在的 primitives 成员 ${hit.name}（${hit.how}）→ 运行时为 undefined，渲染即 React #130`,
            fix: KNOWN_RULES.find((r) => r.id === 'missing-host-export').fix,
            doc: KNOWN_RULES.find((r) => r.id === 'missing-host-export').doc,
          })
        }
      }
    }

    // 精确锁版本（只报在 bundles 里的，避免噪声）
    if (bundles.has(plugin.name)) {
      const spec = deps[plugin.name]
      if (typeof spec === 'string' && /^\d/.test(spec)) {
        plugin.findings.push({
          rule: 'pinned-exact', severity: 'warn', file: 'package.json', line: 0,
          detail: `profile 里用精确版本 "${spec}" → 该插件永远不会随宿主更新（本次 dshmarket 1.47.0 就是这样落后 19 个版本）`,
          fix: KNOWN_RULES.find((r) => r.id === 'pinned-exact').fix,
        })
      }
    }

    if (plugin.findings.length) results.push(plugin)
  }

  const counts = { critical: 0, warn: 0 }
  for (const p of results) for (const f of p.findings) counts[f.severity] = (counts[f.severity] || 0) + 1

  // 控制台（英文）
  console.log(`scan  profile=${profile}`)
  console.log(`      host primitives=${primitivesDir || '(not found — export check skipped)'}  exports=${hostExports.size}`)
  console.log(`      plugins scanned=${dirs.length}  with findings=${results.length}  critical=${counts.critical || 0}  warn=${counts.warn || 0}`)
  for (const p of results) {
    console.log(`  - ${p.name}@${p.version}${p.private ? ' [private/local]' : ''}`)
    for (const f of p.findings) console.log(`      [${f.severity}] ${f.rule} ${f.file}:${f.line}  ${f.detail.slice(0, 110)}`)
  }

  writeScanReport(opt, { profile, primitivesDir, hostExports, results, counts, scanned: dirs.length })

  const code = counts.critical ? 2 : counts.warn ? 1 : 0
  console.log(`report -> ${reportPath(opt)}`)
  console.log(`exit=${code}`)
  if (opt.json) { console.log('---JSON---'); console.log(JSON.stringify({ kind: 'scan', counts, scanned: dirs.length, results }, null, 2)) }
  return code
}

function reportPath(opt, suffix = '') {
  return (opt && opt.report) || path.join('tools', `dsh-upgrade-guard${suffix}.report.md`)
}

function writeScanReport(opt, data) {
  const L = []
  L.push(`# DSH 升级守卫 · 契约扫描报告`)
  L.push('')
  L.push(`- 生成时间：${new Date().toISOString()}`)
  L.push(`- profile：\`${data.profile}\``)
  L.push(`- 宿主 primitives：\`${data.primitivesDir || '未找到（跳过"引用了不存在的导出"检查）'}\`（导出名 ${data.hostExports.size} 个）`)
  L.push(`- 扫描插件：${data.scanned} 个；有发现：${data.results.length} 个（critical ${data.counts.critical || 0} / warn ${data.counts.warn || 0}）`)
  L.push('')
  if (!data.results.length) {
    L.push('✅ **未发现已知破坏性契约**。注意：本工具只覆盖"已知"目录（见文末），不能替代真开一次页面的前端冒烟。')
  } else {
    L.push('| 插件 | 版本 | 级别 | 规则 | 位置 | 说明 |')
    L.push('| --- | --- | --- | --- | --- | --- |')
    for (const p of data.results) {
      for (const f of p.findings) {
        L.push(`| \`${p.name}\`${p.private ? ' 🏠' : ''} | ${p.version} | ${f.severity === 'critical' ? '⚠️ critical' : 'warn'} | \`${f.rule}\` | ${f.file}:${f.line} | ${f.detail.replace(/\|/g, '\\|')} |`)
      }
    }
    L.push('')
    L.push('## 处置建议（按规则）')
    const seen = new Set()
    for (const p of data.results) {
      for (const f of p.findings) {
        if (seen.has(f.rule)) continue
        seen.add(f.rule)
        L.push(`- **${f.rule}**：${f.fix}${f.doc ? `（依据：\`${f.doc}\`）` : ''}`)
      }
    }
    L.push('')
    L.push('## 停用清单（如需降级保平安）')
    L.push('')
    L.push('| 插件 | 版本 | 触发规则 | 停用方式 | 恢复条件 |')
    L.push('| --- | --- | --- | --- | --- |')
    for (const p of data.results) {
      const rules = [...new Set(p.findings.filter((f) => f.severity === 'critical').map((f) => f.rule))].join(', ')
      if (!rules) continue
      L.push(`| \`${p.name}\` | ${p.version} | ${rules} | bundle → 从 \`dsh.profile.bundles\` 移除（或 设置→插件→停用）；patch → 删 \`cordis.patch.yml\` 的 insert 行 | 作者适配后重新启用/升级 |`)
    }
  }
  L.push('')
  L.push('## 规则目录（每次排障后往 KNOWN_RULES 加一条）')
  L.push('')
  for (const r of KNOWN_RULES) L.push(`- \`${r.id}\`（${r.severity}）：${r.fix}`)
  L.push('')
  L.push('> 相关经验：`experience/01-plugin-development/15-session-message-source-v4.md`、`…/16-client-primitives-rename-react-130.md`、`experience/04-diagnosis-methodology/16-runtime-upgrade-plugin-incompat-critical.md`')
  L.push('')
  fs.mkdirSync(path.dirname(reportPath(opt)), { recursive: true })
  fs.writeFileSync(reportPath(opt), L.join('\n'), 'utf8')
}

// --- preflight（联网盘点）---------------------------------------------------
async function fetchJson(url, timeoutMs = 15000) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctl.signal })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return { json: await res.json() }
  } catch (e) {
    return { error: (e && e.message) || String(e) }
  } finally { clearTimeout(t) }
}

async function runPreflight(opt) {
  const profile = opt.profile || path.join(os.homedir(), '.dsh', 'profiles', 'web')
  const profilePkg = jsonRead(path.join(profile, 'package.json'))
  const deps = (profilePkg && profilePkg.dependencies) || {}
  const bundles = ((profilePkg && profilePkg.dsh && profilePkg.dsh.profile && profilePkg.dsh.profile.bundles) || [])

  let target = opt.target
  if (opt.network && target === 'latest') {
    const r = await fetchJson('https://registry.npmjs.org/@deepseek-ai/dsh')
    if (r.json && r.json['dist-tags']) {
      target = r.json['dist-tags'].latest
      console.log(`target resolved from npm: ${target}`)
    } else {
      console.log(`cannot resolve latest on npm (${r.error || 'no dist-tags'}) — falling back to "latest"`)
    }
  }

  const rows = []
  const names = (opt.only && opt.only.length ? opt.only : bundles)
  for (const name of names) {
    const dir = path.join(profileNodeModules(profile), ...name.split('/'))
    const pkg = jsonRead(path.join(dir, 'package.json'))
    const spec = deps[name]
    let kind = 'registry'
    if (String(name).startsWith('@deepseek-ai/')) kind = 'host-bundled'   // 官方包随宿主一起升，不单独盘
    else if (!pkg) kind = 'missing'
    else if (pkg.private === true) kind = 'local/private'
    else if (typeof spec === 'string' && !/^[\^~]?\d/.test(spec)) kind = 'git/url'
    const row = { name, installed: pkg ? pkg.version : '—', spec: spec || '—', kind, latest: '—', notes: [] }

    if (kind === 'host-bundled') row.notes.push('官方包：版本跟随宿主，不单独盘点')
    if (kind === 'local/private') row.notes.push('不在 npm 上：升级/重装都修不到它，只能改源码（并留 .bak / 重放脚本）')
    if (kind === 'git/url') row.notes.push('git/url 源：npm 版本无关，更新要重新拉源或等作者')

    if (opt.network && (kind === 'registry' || kind === 'git/url')) {
      const r = await fetchJson(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`)
      if (r.json && r.json.version) {
        row.latest = r.json.version
        const pd = (r.json.peerDependencies && r.json.peerDependencies['@deepseek-ai/dsh']) || null
        const sd = (r.json.peerDependencies && r.json.peerDependencies['@deepseek-ai/dsh-settings']) || null
        row.declared = pd || sd || '—'
        if (row.latest !== row.installed) row.notes.push(`有新版可升：${row.installed} → ${row.latest}`)
        if (target !== 'latest') {
          const tm = target.match(/(\d+\.\d+\.\d+)/)
          if (tm && pd && pd.includes(tm[1])) row.notes.push(`新版 peer 明确含 ${tm[1]}（作者已适配）`)
          if (tm && pd && !pd.includes(tm[1])) row.notes.push(`新版 peer 未明确含 ${tm[1]}（注意 rc 预发布不匹配的语义陷阱）`)
        }
      } else {
        row.notes.push(`npm 查询失败/未发布（${r.error || 'no version'}）`)
      }
    }
    rows.push(row)
  }

  const critical = rows.filter((r) => /未明确含/.test(r.notes.join(' ')) || r.kind === 'local/private')
  console.log(`preflight  target=${target}  profile=${profile}`)
  console.log(`           checked=${rows.length}  needs-attention=${critical.length}`)
  for (const r of rows) {
    console.log(`  - ${r.name}@${r.installed}  spec=${r.spec}  latest=${r.latest}  ${r.kind === 'registry' ? '' : '[' + r.kind + ']'}`)
    for (const n of r.notes) console.log(`      · ${n}`)
  }

  const L = [`# DSH 升级守卫 · 升级前盘点（preflight）`, '', `- 生成时间：${new Date().toISOString()}`, `- 目标版本：\`${target}\``, `- profile：\`${profile}\``, '', '| 插件 | 已装 | 声明 | 类型 | npm 最新 | 备注 |', '| --- | --- | --- | --- | --- | --- |']
  for (const r of rows) L.push(`| \`${r.name}\` | ${r.installed} | \`${r.spec}\` | ${r.kind} | ${r.latest} | ${r.notes.join('；').replace(/\|/g, '\\|')} |`)
  L.push('', '## 怎么用这份盘点', '', '1. 先跑 `scan`（离线契约扫描），把 critical 项处理掉；', '2. 再用本表决定"哪些插件该一起升级"（有新版且声明含目标版本）；', '3. 升级本体后**不要**直接切 3080：先按 `experience/05-runtime-and-process/04` 阶段 1/1b 在 3099 起一次并做前端冒烟；', '4. smoke 子命令（下一步实现）会把第 3 步自动化。', '')
  fs.mkdirSync(path.dirname(reportPath(opt)), { recursive: true })
  fs.writeFileSync(reportPath(opt), L.join('\n'), 'utf8')
  console.log(`report -> ${reportPath(opt)}`)
  if (opt.json) { console.log('---JSON---'); console.log(JSON.stringify({ kind: 'preflight', target, rows }, null, 2)) }
  return critical.length ? 1 : 0
}

// --- smoke：新版本先在测试端口起一次，通过才切 3080 ------------------------
// 配置走环境变量（避免与 parseArgs 的标志冲突）：
//   DSH_SMOKE_BIN   dsh 的 lib/bin.js（默认取 D:\deepseek_harness\dsh-runtime\...）
//   DSH_SMOKE_PORT  测试端口（默认 3099）
//   DSH_SMOKE_CWD   启动工作目录（默认 D:\deepseek_harness，与 launcher 一致）
//   DSH_SMOKE_TIMEOUT  等待就绪秒数（默认 120）
//   DSH_SMOKE_KEEP=1   跑完不杀进程（默认必杀）
async function runSmoke() {
  const { spawn, spawnSync } = await import('node:child_process')
  const bin = process.env.DSH_SMOKE_BIN || 'D:\\deepseek_harness\\dsh-runtime\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
  const port = Number(process.env.DSH_SMOKE_PORT || 3099)
  const cwd = process.env.DSH_SMOKE_CWD || 'D:\\deepseek_harness'
  const timeoutMs = Number(process.env.DSH_SMOKE_TIMEOUT || 120) * 1000
  const keep = process.env.DSH_SMOKE_KEEP === '1'
  const base = `http://127.0.0.1:${port}`

  if (!fs.existsSync(bin)) { console.log(`FAIL  dsh bin not found: ${bin}`); return 3 }
  console.log(`smoke  bin=${bin}`)
  console.log(`       port=${port} cwd=${cwd} timeout=${timeoutMs / 1000}s`)

  // 端口已被占用就别叠加第二个宿主
  try {
    await fetch(base + '/', { redirect: 'manual' })
    console.log(`FAIL  port ${port} is already serving something — abort (pick another DSH_SMOKE_PORT)`)
    return 3
  } catch { /* 连接被拒 = 端口空闲，符合预期 */ }

  const child = spawn(process.execPath, [bin, 'web', '--port', String(port), '--no-open'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { out += d.toString() })

  const tokenRe = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9._~-]+)/
  const started = Date.now()
  let url = null
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      const m = tokenRe.exec(out)
      if (m) { url = `http://127.0.0.1:${m[1]}/?token=${m[2]}`; clearInterval(iv); resolve() }
      else if (child.exitCode !== null) { clearInterval(iv); resolve() }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); resolve() }
    }, 500)
  })

  // 启动摘要通常在 token 行之后很快打完
  await new Promise((r) => setTimeout(r, 2500))

  const lines = out.split(/\r?\n/)
  // 启动摘要的格式随版本变过，所以放宽匹配，并把"疑似摘要行"整段留档
  const notActivatedRaw = (out.match(/(\d+)\s+entries did not activate/) || [])[1] || null
  const bootLines = lines.filter((l) => /web boot|did not activate|plugin tree|failed to (apply|import) loader entry/.test(l)).map((l) => l.trim())
  const pending = lines.filter((l) => /:\s*(pending|failed)\b/.test(l)).map((l) => l.trim())
  const treeFail = lines.filter((l) => /plugin tree failed to load|failed to apply loader entry|failed to import loader entry/.test(l)).map((l) => l.trim())
  // 宿主自带的 peer 兼容门：不兼容的插件会被"安全跳过"（可 dsh plugin allow-version 显式豁免）
  const skipped = []
  for (const l of lines) {
    const m = /dsh: skipping profile bundle "([^"]+)"[：:]?\s*(?:Error:\s*)?Plugin ([^@\s]+)@([^\s]+) is incompatible with dsh ([^\s:]+)[：:]?\s*peerDependencies (\{.*?\})/.exec(l)
    if (m) skipped.push({ name: m[1], version: m[3], reason: `peerDependencies ${m[5]}` })
  }
  // 插件里的功能降级（不致命但功能缺失，往往正是"契约变了"的第一现场）
  const degraded = lines.filter((l) => /namespace skipped|is not a function|without inject|is not declared/.test(l)).map((l) => l.trim())
  const errors = [...new Set(lines.filter((l) => /^\s*(Error|TypeError|ReferenceError|RangeError)\b/.test(l)).map((l) => l.trim()))].slice(0, 20)
  const bootTail = lines.filter((l) => l.trim()).slice(-30)

  const probes = []
  let htmlLen = 0
  let bootCandidates = 0
  if (url) {
    try {
      // ① 先用 token URL 换 cookie（这一步常常是 302，不要拿它的 body 当页面）
      const res = await fetch(url, { redirect: 'manual' })
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      const cookie = setCookies.map((c) => String(c).split(';')[0]).join('; ')
      // ② 再带着 cookie 取真正的页面（跟随跳转）
      const pageRes = await fetch(base + '/', { headers: cookie ? { cookie } : {} })
      const html = await pageRes.text()
      htmlLen = html.length
      const urls = new Set()
      // ③ 服务端 HTML 里直接出现的 /plugins/*/client.js
      for (const m of html.matchAll(/\/plugins\/[^"'\s<>]+client\.js[^"'\s<>]*/g)) urls.add(m[0])
      // ④ window.__DSH_BOOT__ 里的 "url":"…client.js…"（0.1.2+ 的 client 行是运行时插入的）
      for (const m of html.matchAll(/"url"\s*:\s*"([^"]*client\.js[^"]*)"/g)) urls.add(m[1].replace(/\\\//g, '/'))
      bootCandidates = urls.size
      for (const u of [...urls].slice(0, 15)) {
        try {
          const r = await fetch(new URL(u, base + '/').href, { headers: cookie ? { cookie } : {} })
          const text = await r.text()
          probes.push({ u, status: r.status, len: text.length, ok: r.ok && text.length > 50 })
        } catch (e) { probes.push({ u, status: 'ERR', len: 0, ok: false, err: e.message }) }
      }
    } catch (e) { probes.push({ u: url, status: 'ERR', len: 0, ok: false, err: e.message }) }
  }

  const booted = !!url
  const badProbes = probes.filter((p) => !p.ok)
  // 注意：被 peer 门"安全跳过"不算崩溃（是宿主在保护你），所以只警告不计 FAIL
  const pass = booted && !treeFail.length && !(notActivatedRaw && Number(notActivatedRaw) > 0) && !badProbes.length

  console.log(`       booted=${booted}  did-not-activate=${notActivatedRaw ?? '?'}  tree-failures=${treeFail.length}  skipped-by-peer=${skipped.length}  degraded=${degraded.length}  bundle-probes=${probes.length} (bad=${badProbes.length})`)
  for (const l of treeFail.slice(0, 8)) console.log(`  ROOT? ${l}`)
  for (const s of skipped.slice(0, 20)) console.log(`  SKIPPED ${s.name}@${s.version}  (${s.reason.slice(0, 90)})`)
  for (const l of degraded.slice(0, 10)) console.log(`  DEGRADED ${l.slice(0, 130)}`)
  for (const l of pending.slice(0, 20)) console.log(`  PENDING ${l}`)
  for (const p of badProbes.slice(0, 10)) console.log(`  BADBUNDLE ${p.status} len=${p.len} ${p.u.slice(0, 110)}`)
  for (const e of errors.slice(0, 8)) console.log(`  ERROR ${e}`)
  console.log(pass ? 'RESULT  PASS' : 'RESULT  FAIL')

  // 中文报告
  const L = []
  L.push('# DSH 升级守卫 · 冒烟结果（smoke）')
  L.push('')
  L.push(`- 时间：${new Date().toISOString()}`)
  L.push(`- 结论：${pass ? '✅ **PASS**（可以切到生产端口）' : '❌ **FAIL**（不要切换；先处理下列问题）'}`)
  L.push(`- 启动命令：\`node "${bin}" web --port ${port} --no-open\`（cwd: \`${cwd}\`）`)
  L.push(`- 就绪：${booted ? '拿到带 token 的 URL' : '**超时未拿到 token URL**'}；未激活条数：${notActivatedRaw ?? '未出现该行'}`)
  L.push('')
  L.push('## 插件树级故障（"真正 throw 的那条"，优先看这里）')
  if (treeFail.length) for (const l of treeFail) L.push(`- \`${l}\``)
  else L.push('- 无')
  L.push('')
  L.push('## pending / failed 明细（页面上的"N entries did not activate"就是这些）')
  if (pending.length) for (const l of pending) L.push(`- \`${l}\``)
  else L.push('- 无')
  L.push('')
  L.push('## 被宿主按 peerDependencies 拒绝的插件（安全跳过，不是崩溃）')
  if (skipped.length) {
    for (const s of skipped) L.push(`- \`${s.name}@${s.version}\` — ${s.reason}`)
    L.push('')
    L.push('  → 0.1.7 起宿主内置兼容门：不兼容就跳过并打印 `dsh: skipping profile bundle …`。**它其实在保护升级**，但该插件在新版本上不可用。')
    L.push('  → 要显式承担风险才装回来：按宿主提示用 `dsh plugin allow-version <插件>@<版本>` 授予豁免，然后重启。')
  } else L.push('- 无')
  L.push('')
  L.push('## 功能降级（不致命但功能缺失，往往是"契约变了"的第一现场）')
  if (degraded.length) for (const l of degraded) L.push(`- \`${l}\``)
  else L.push('- 无')
  L.push('')
  L.push(`## 客户端 bundle 可达性（探测 ${probes.length} 个，失败 ${badProbes.length} 个）`)
  if (probes.length) for (const p of probes) L.push(`- ${p.ok ? '✅' : '❌'} ${p.status} ${p.len}B \`${p.u.slice(0, 160)}\`${p.err ? ` — ${p.err}` : ''}`)
  else L.push('- 未探测（没有拿到 token URL 或页面里没有 /plugins/*/client.js 行）')
  L.push('')
  L.push(`## 启动输出留档（HTML ${htmlLen}B；boot JSON 里找到 ${bootCandidates} 个 client bundle 候选）`)
  if (bootLines.length) for (const l of bootLines) L.push(`- \`${l}\``)
  else L.push('- 没有匹配到启动摘要行（看下面"宿主原始输出"确认这台宿主的实际措辞）')
  L.push('')
  L.push('## 宿主原始输出（末 30 行，出问题时的第一现场）')
  L.push('')
  L.push('```text')
  for (const l of bootTail) L.push(l)
  L.push('```')
  L.push('')
  L.push('> ⚠ **局限**：smoke 只覆盖**启动期**（插件树加载、服务依赖、client bundle 可达性）。')
  L.push('> **渲染期**错误（例如宿主 primitives 改名导致的 `React #130`）不会在这里暴露，需要真开页面并点开对应面板；')
  L.push('> 这类风险先靠 `dsh-upgrade-guard.mjs scan` 兜住（见 `experience/01-plugin-development/16`）。')
  L.push('')
  L.push('## 其它错误行')
  if (errors.length) for (const e of errors) L.push(`- \`${e}\``)
  else L.push('- 无')
  L.push('')
  L.push('## 下一步')
  if (pass) L.push('- 可以改 launcher / restart 脚本的 `DSH_BIN` 指向新版本并重启（两处都要改），然后 Ctrl+F5 验证关键插件 UI **真的出现**。')
  else L.push('- **不要切 3080**。先按 [`experience/04-diagnosis-methodology/16`](../../experience/04-diagnosis-methodology/16-runtime-upgrade-plugin-incompat-critical.md) 判"插件报错 ≠ 插件问题"：')
  L.push('  1. 上面「插件树级故障」里的那条通常是真凶（其余 pending 是被连累的）；')
  L.push('  2. 用 `dsh-upgrade-guard.mjs scan` 看是不是已知契约（服务被移除 / v4 source / 宿主导出改名）；')
  L.push('  3. 有适配新版就升级该插件；没有就停用（bundle → 移除 bundles 项；patch → 删 insert 行）后重跑 smoke。')
  L.push('')
  fs.mkdirSync(path.dirname(reportPath({}, '.smoke')), { recursive: true })
  fs.writeFileSync(reportPath({}, '.smoke'), L.join('\n'), 'utf8')
  console.log(`report -> ${reportPath({}, '.smoke')}`)

  if (!keep) {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/F', '/PID', String(child.pid)], { stdio: 'ignore' }) } catch { /* ignore */ }
    console.log(`       test host on ${port} killed`)
  } else {
    console.log(`       keep=1 — test host on ${port} left running (PID ${child.pid})`)
  }
  return pass ? 0 : 2
}

// --- main -------------------------------------------------------------------
async function main() {
  const opt = parseArgs(process.argv.slice(2))
  if (opt.cmd === 'scan') return runScan(opt)
  if (opt.cmd === 'preflight') return runPreflight(opt)
  if (opt.cmd === 'smoke') return await runSmoke()
  printHelp()
  return 2
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(2) })
