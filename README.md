# dsh-upgrade-guard · DSH 升级守卫

> 让「更新 DeepSeek Harness 本体」不再变成「更新一次崩一次」。
> **升级前**盘点插件兼容性 → **升级后**扫描已知破坏性契约 → **切换端口前**先启动冒烟，不通过就别切。

[DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的插件生态很活跃，但**宿主每次升级都可能改契约**，跟在后面的插件就容易崩。真实案例（同一个坑反复出现）：

| 事故 | 根因 | 症状 |
| --- | --- | --- |
| 0.1.1 → 0.1.2 | client-modules 模块表变严 | 页面 `Failed to load plugins` |
| 0.1.2 → 0.1.5 | 服务访问契约变严（`inject` 缺失即崩） | 31 个插件连锁 pending |
| 0.1.6 → 0.1.7 | 服务 `settingsScope` 被移除/改名 | 26 个插件 pending（Console 只有 4 条真节点） |
| 0.1.7-alpha.1 | primitives 图标改名（`IconXxx14` → `IconXxxRegular`，无别名） | 插件面板 `Minified React error #130`（元素类型 undefined） |
| 0.1.7 | 会话消息 V4 `source` 契约 | 某轮对话跑完后失败：`format v4 message requires a producer-owned source kind` |

这些都是**运行库版本升级 → 底层契约变更 → 插件没跟上**。本插件把每次排障得到的判据固化成可复用检查。

## 三个动作

| 动作 | 什么时候用 | 做什么 |
| --- | --- | --- |
| **契约扫描**（离线，秒级） | 平时 / 升级后 | 按「已知破坏性契约」目录扫已装插件：被移除的服务名、会话消息旧 `source` 写法、引用了宿主导出表里不存在的 primitives 成员 |
| **联网盘点**（10–40 秒） | 升级**前** | 逐个插件看：声明了什么兼容范围、npm 上有没有新版、新版是否声明支持目标版本 → 产出「能不能升 + 哪些要一起升 + 停用清单」 |
| **启动冒烟**（30–90 秒） | 切换端口**前** | 在测试端口（默认 3099）起一次被检查的宿主 → 抓「被 peer 门跳过的插件 / 功能降级 / pending / 插件树真凶」+ 逐个探 client bundle 可达性 → PASS 才建议切换；结束必杀测试宿主 |

## 安装

三种方式，任选：

```powershell
# ① 直接从一个 GitHub 仓库装（pnpm 会拉取并安装到 profile）
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add github:wqx11235/dsh-upgrade-guard
# 然后把它加进 profile 的 dsh.profile.bundles：编辑 package.json 的 dsh.profile.bundles 数组，加入 "dsh-upgrade-guard"

# ② 手动放置（无网络依赖）
#   把本仓库整个目录复制到 %USERPROFILE%\.dsh\profiles\web\node_modules\dsh-upgrade-guard
#   同样把它加入 dsh.profile.bundles

# ③ 通过 dsh 插件市场安装（若已上架）
```

装完**重启宿主**（桌面快捷方式 / `restart-dsh-web.cmd`），浏览器 `Ctrl+F5`，然后进 **设置 → 通用 → 升级守卫**。

## 使用

### 在界面里

**设置 → 通用 → 升级守卫**，三个按钮：

- **契约扫描** → `⚠ 契约扫描：critical N / warn N（扫了 M 个插件）` + 明细
- **联网盘点** → `📋 联网盘点（目标 x.y.z）：N 个插件，K 个有新版` + 新版本清单
- **启动冒烟** → `✅ 启动冒烟：PASS` / `❌ FAIL` + 关键输出行（`ROOT?` / `PENDING` / `SKIPPED` / `DEGRADED` / `BADBUNDLE`）

### 命令行（同一份引擎）

```powershell
node lib/guard.mjs scan       --json --report report-scan.md
node lib/guard.mjs preflight  --json --report report-preflight.md --target 0.1.8-rc.1
node lib/guard.mjs smoke
```

`smoke` 用环境变量配置：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `DSH_SMOKE_BIN` | 要冒烟的 dsh 入口（`.../dsh/lib/bin.js`） | 当前安装 |
| `DSH_SMOKE_PORT` | 测试端口 | `3099` |
| `DSH_SMOKE_CWD` | 启动工作目录 | 当前目录 |
| `DSH_SMOKE_TIMEOUT` | 等待就绪秒数 | `120` |
| `DSH_SMOKE_KEEP=1` | 跑完不杀测试宿主（排障用） | 关 |

控制台输出刻意用英文/ASCII（Windows `cmd` 默认代码页 936 会把中文 UTF-8 显示成乱码）；**中文报告写进 `--report` 指定的文件**。

## 判据从哪来

`lib/guard.mjs` 里的 `KNOWN_RULES` 就是「已知破坏性契约」目录，目前包含：

1. **`removed-service`** —— 宿主已移除/改名的服务（`settingsScope`、`conversationEvents`…）。
   会区分**硬引用**（critical）与**可选注入** `inject([...])`（warn，服务缺失时插件优雅跳过），**并在注释里出现时跳过**——避免误报。
2. **`session-source-v4`** —— 会话消息 `source: { kind: 'plugin', plugin: 'x' }` 旧写法（0.1.7 起被拒收）。
3. **`missing-host-export`** —— 插件客户端引用了宿主 `@deepseek-ai/dsh-client-ui-primitives` 导出表里**不存在**的成员（例如 0.1.7-alpha.1 改掉的 `IconXxx14/16`）。渲染到才会抛 `React #130`，所以它是**静态提前预警**。
4. **`pinned-exact`** —— profile 里对插件用精确版本（`"x": "1.2.3"`）→ 它永远不会随宿主更新（真实案例：某插件被锁死，落后 19 个版本）。

**每排一次新坑，就往 `KNOWN_RULES` 加一条** —— 这是本插件唯一的"增长"方式，也是它越用越准的原因。

## 局限（重要，别当成万能）

- **冒烟只覆盖启动期**：插件树加载、服务依赖、client bundle 可达性。
  **渲染期**错误（例如 primitives 改名导致的 `React #130`）不会在冒烟里暴露，需要真开页面点开对应面板 —— 这类风险靠**契约扫描**提前兜住。
- **契约扫描只覆盖"已知"目录**：没进 `KNOWN_RULES` 的新式破坏它看不见。
- **联网盘点依赖 npm registry 可达**；git/url 源（`github:...`）的插件查不到"最新版"，会标注为 `git/url` 需人工。
- 被宿主 peer 兼容门**主动跳过**的插件（日志里的 `dsh: skipping profile bundle "X"`）**不算崩溃**，是宿主在保护你；冒烟会把它列成 `SKIPPED` 供你决策，要装回来需按提示用 `dsh plugin allow-version` 显式豁免。

## 数据结构（宿主路由）

`POST /api/dsh-upgrade-guard`

```jsonc
{ "action": "status" }                     // → { ok, paths: { profile, cli, bin, installRoot, primitives, reports } }
{ "action": "scan" }                       // → { ok, result: { criticalCount, warnCount, scanned, topFindings, reportPath } }
{ "action": "preflight", "target": "latest"}// → { ok, result: { target, rows, stale, reportPath } }
{ "action": "smoke", "port": 3099 }        // → { ok, result: { verdict, summary, tail, reportPath } }
```

## 许可

MIT © 2026 wqx11235
