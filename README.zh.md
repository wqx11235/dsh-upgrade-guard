# dsh-upgrade-guard · DSH 升级守卫

> 让「更新 DeepSeek Harness 本体」不再变成「更新一次崩一次」。
> **升级前**盘点插件兼容性 → **升级后**扫描已知破坏性契约 → **切换端口前**先启动冒烟，不通过就别切。
> English: [README.md](README.md)

[DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的插件生态很活跃，但**宿主每次升级都可能改契约**，跟在后面的插件就容易崩。真实案例（同一个坑反复出现）：

| 事故 | 根因 | 症状 |
| --- | --- | --- |
| 0.1.1 → 0.1.2 | `client-modules` 模块表变严 | 页面 `Failed to load plugins` |
| 0.1.2 → 0.1.5 | 服务访问契约变严（缺 `inject` 即崩） | 31 个插件连锁 pending |
| 0.1.6 → 0.1.7 | 服务 `settingsScope` 被移除/改名 | 26 个插件 pending |
| 0.1.7-alpha.1 | `ui-primitives` 图标改名（`IconXxx14` → `IconXxxRegular`，无别名） | `Minified React error #130` |
| 0.1.7 | 会话消息 v4 `source` 契约 | 某轮跑完后失败：`format v4 message requires a producer-owned source kind` |

本插件把每次排障得到的判据固化成可复用检查。

## 三个动作

| 动作 | 什么时候用 | 做什么 |
| --- | --- | --- |
| **契约扫描**（离线，秒级） | 平时 / 升级后 | 按「已知破坏性契约」目录扫已装插件：被移除的服务名、会话消息旧 `source` 写法、引用了 `ui-primitives` 导出表里不存在的成员 |
| **联网盘点**（10–40 秒） | 升级**前** | 逐个插件看：声明了什么兼容范围、npm 上有没有新版、新版是否声明支持目标版本 → 产出「能不能升 + 哪些要一起升 + 停用清单」 |
| **启动冒烟**（30–90 秒） | 切换端口**前** | 在测试端口起一次被检查的宿主 → 抓「被 peer 门跳过的插件 / 功能降级 / pending / 插件树真凶」+ 逐个探 client bundle 可达性 → PASS 才建议切换；结束必杀测试宿主 |

## 适配性（为什么网页端和桌面端都能用）

这版是照着「跨 0.1.x / 0.2.x、跨网页端 / 官方桌面端」重写的：

- **不 import 任何 `@deepseek-ai/*` 包**。宿主半只用 node 内置模块 + `webServer` 服务。历史崩因里最大的一类就是「宿主改了包/服务契约，插件还在 import 旧东西」，本插件从结构上避开了它。
- **不写死任何本机路径**。profile 从插件自身位置向上找，宿主 bin / 安装根从 `process.argv[1]` 推导，`ui-primitives` 多候选探测。同一份文件在 `profiles/web` 与 `profiles/desktop` 上原样可跑。
- **`peerDependencies` 全部声明为 `*` 且 `optional`**。dsh 0.1.7+ 有 peer 兼容门，会把声明了窄范围的插件**静默跳过**（实例：`browser-skill-dsh-plugin@0.3.1` 要求 `^0.1.5-rc.3`，在 0.2.0-rc.2 上直接被跳过）。`*` + optional 是能过这道门的声明形态。
- **客户端半遵循 0.1.2+ 契约**：声明 `exports.inject = ['slots']`，并用 `ctx.slots` 取值（保留 `ctx.get('slots')` 回退），新旧两代受限代理都能跑；只 `require('react')`（平台内置词），所以模块表收紧打不到它。
- **Electron 感知**：桌面端 `process.execPath` 是 App 可执行文件，冒烟会带 `ELECTRON_RUN_AS_NODE=1` 启动，避免再开一个 App 窗口；打包进 `app.asar` 时冒烟明确回 `UNSUPPORTED` 并给替代方案，而不是神秘失败。
- **对导出表保持诚实**：磁盘上找到的 `ui-primitives` 版本与在跑的宿主不一致时，界面会直接标出来——因为「某导出不存在」这个结论只跟那份副本一样可靠。

## 安装

```powershell
# ① 从 GitHub 装（会被装进 profile）
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add github:wqx11235/dsh-upgrade-guard
# 再把 "dsh-upgrade-guard" 加进该 profile package.json 的 dsh.profile.bundles

# ② 手动放置（无网络依赖）
#   把本仓库复制到 %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-upgrade-guard
#   同样加进 dsh.profile.bundles

# ③ 桌面端：同上，但 profile 换 %USERPROFILE%\.dsh\profiles\desktop
```

装完**重启宿主**，硬刷新页面，然后进 **设置 → 通用 → 升级守卫**。

## 使用

### 在界面里

**设置 → 通用 → 升级守卫**，三个按钮，底部会标出这份结果来自哪个宿主 / 运行时 / primitives：

- **契约扫描** → `⚠ critical N / warn N（扫了 M 个插件）` + 明细
- **联网盘点** → `📋 目标 x.y.z：N 个插件，K 个有新版` + 清单
- **启动冒烟** → `✅ PASS` / `❌ FAIL` + 关键输出行（`ROOT?` / `PENDING` / `SKIPPED` / `DEGRADED` / `BADBUNDLE`）

### 命令行（同一份引擎）

```powershell
node lib/guard.mjs scan      --json --report scan.md [--profile <dir>] [--primitives <dir>]
node lib/guard.mjs preflight --json --report preflight.md --target 0.1.8-rc.1 [--no-network]
node lib/guard.mjs smoke     --bin <.../dsh/lib/bin.js> --cwd <dir> --port 3099 --timeout 120 [--keep]
```

环境变量兜底：`DSH_HOME`（默认 `~/.dsh`）、`DSH_PROFILE`、`DSH_PRIMITIVES`、`DSH_SMOKE_BIN`、`DSH_SMOKE_PORT`、`DSH_SMOKE_CWD`、`DSH_SMOKE_TIMEOUT`、`DSH_SMOKE_KEEP=1`。

控制台输出刻意用英文/ASCII（Windows `cmd` 默认代码页 936 会把中文 UTF-8 显示成乱码）；**中文报告写进 `--report` 指定的文件**（默认 `$DSH_HOME/upgrade-guard/`）。

## 判据从哪来

`lib/guard.mjs` 里的 `KNOWN_RULES` 就是「已知破坏性契约」目录：

1. **`removed-service`** —— 宿主已移除/改名的服务（`settingsScope`、`conversationEvents`…）。硬引用记 `critical`，可选注入 `inject([...])` 记 `warn`（服务缺失时插件优雅跳过），注释里的提及直接跳过（避免误报）。
2. **`session-source-v4`** —— 会话消息 `source: { kind: 'plugin', plugin: 'x' }` 旧写法（0.1.7 起被拒收）。
3. **`missing-host-export`** —— 插件客户端引用了宿主 `ui-primitives` 导出表里不存在的成员（如 0.1.7-alpha.1 改掉的 `IconXxx14/16`）。渲染到才会抛 `React #130`，所以它是**静态提前预警**。
4. **`pinned-exact`** —— profile 里对插件用精确版本（`"x": "1.2.3"`）→ 它永远不会随宿主更新（真实案例：某插件被锁死，落后 19 个版本）。

**每排一次新坑，就往 `KNOWN_RULES` 加一条** —— 这是本插件唯一的"增长"方式，也是它越用越准的原因。

## 局限（重要，别当成万能）

- **冒烟只覆盖启动期**：插件树加载、服务依赖、client bundle 可达性。**渲染期**错误（例如 primitives 改名导致的 `React #130`、订阅者风暴）不会在冒烟里暴露，需要真开页面点开对应面板 —— 这类风险靠**契约扫描**提前兜住。
- **契约扫描只覆盖"已知"目录**：没进 `KNOWN_RULES` 的新式破坏它看不见。
- **联网盘点依赖 npm registry 可达**；git/url 源（`github:...`）的插件查不到"最新版"，会标注为 `git/url` 需人工。
- 被宿主 peer 兼容门**主动跳过**的插件（日志里的 `dsh: skipping profile bundle "X"`）**不算崩溃**，是宿主在保护你；冒烟会把它列成 `SKIPPED` 供你决策，要装回来需按提示用 `dsh plugin allow-version` 显式豁免。
- **打包桌面运行时**（入口在 `app.asar` 内）无法起测试宿主，冒烟返回 `UNSUPPORTED`。

## 宿主路由

`POST /api/dsh-upgrade-guard`

```jsonc
{ "action": "status" }                       // → { ok, paths: {...}, host: { version, runtime, primitivesSource, ... } }
{ "action": "scan" }                         // → { ok, result: { criticalCount, warnCount, scanned, topFindings, reportPath } }
{ "action": "preflight", "target": "latest"} // → { ok, result: { target, rows, stale, reportPath } }
{ "action": "smoke", "port": 3099 }          // → { ok, result: { verdict, summary, tail, reportPath } }
```

## 文件结构

```
package.json          dsh.bundle.patch + dsh.client 声明
dsh.plugin.json       插件清单（name / entry / client）
cordis.patch.yml      把它挂载进 profile 的那条 insert
lib/index.js          宿主半：profile/宿主探测、webServer 路由、调引擎
lib/client.js         客户端半：设置 → 通用 里的那一行
lib/guard.mjs         引擎：scan / preflight / smoke（也能当独立 CLI 用）
```

## 许可

MIT © 2026 wqx11235
