# deepseek-valley-gate

> **版本：v0.2.0**

DSH 低谷时段门禁插件：**仅在 DeepSeek 低谷时段允许 dsh 运行**，其余时段拦截一切模型调用并在 Web 界面显示全屏提示。

支持两种低谷时段来源（可在设置页切换，保存后实时生效）：
- **官方模式（默认）**：自动读取 [DeepSeek 官方定价文档](https://api-docs.deepseek.com/quick_start/pricing) 的峰谷规则（工作日 09:00–12:00 / 14:00–18:00 北京时间为高峰，周末全天低谷），每 6 小时自动同步，也可手动「重新读取」。
- **手动模式**：自定义低谷窗口（默认北京时间 00:30–08:30）。

所有时间显示为**北京时间（UTC+8）24 小时制**。

## 设置界面（独立页面）

插件在 DSH 设置界面的**侧边栏注册一个独立的「低谷门禁」入口**（`settings.section` slot），点击后内容区渲染一个简易设置页：

- **当前状态卡**：低谷/高峰实时状态、北京时间（24 小时制 HH:MM:SS）、当前模式、官方规则窗口/来源/最近同步时间、距下一低谷的倒计时（每秒刷新）。
- **配置卡**：
  - `enabled` 开关 —— 门禁总开关；关闭后 dsh 全天放行。
  - `mode` 选择 —— 官方峰谷规则 / 手动窗口。
  - （官方模式）「重新读取」按钮 —— 立即从官方文档同步峰谷时段。
  - （手动模式）`startMinute` / `endMinute` 数字 —— 低谷窗口（当日分钟数，30 = 00:30；`endMinute > 1440` 表示跨午夜，如 2140 = 次日 11:40）。
- 保存/放弃按钮：点「保存」写入插件自己的配置文件 `~/.dsh/deepseek-valley-gate.json`，立即生效。

## 工作原理

| 层级 | 机制 |
| --- | --- |
| 配置层 | 插件自己的 JSON 配置文件 `~/.dsh/deepseek-valley-gate.json`（原子写；缺失/损坏回退默认）。**不用 DSH settings namespace**：api-proxy 只对硬编码白名单内的 namespace 开放配置读写，第三方插件注册的 namespace 会被 `settings-not-exposed` 拒绝。 |
| 官方同步 | 启动时 + 每 6 小时 `fetch` 官方定价页，正则提取 `Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday`，解析成 UTC 高峰窗口 + 工作日限定，写入配置缓存；失败回退上次成功结果或内置默认。 |
| 主拦截（host plane） | 在全局 `llm/stream` waterfall 钩子上以 `prepend: true` 挂到最前，门禁开启且当前不在低谷时直接抛 `ValleyGateError`、不向下游转发。任何模型调用（主会话、subagent/fork、workflow、session 标题、web-search 摘要……）都在出网前被拦死。 |
| 设置 API + UI（web surface，可选） | `ctx.inject(["webServer"])` 延迟注册（等 webServer 就绪）：`GET/POST /deepseek-valley-gate/config` 供设置页读写配置（GET 附带 `now` 当前判定）；`/overlay.js` 全屏遮罩 + 倒计时；`tapIndex` 注入。headless/TUI 无 webServer 则整块跳过，仅保留拦截。 |

低谷判定：
- **官方模式**：当前 UTC 时间是否为工作日且落在官方高峰窗口内 → 是则高峰拦截，否则低谷放行（周末全天低谷）。
- **手动模式**：北京时区当日分钟数落在 `[startMinute, endMinute)` 区间；支持跨午夜（`endMinute ≥ 1440`）与全时段（`end - start ≥ 1440` 恒真）。

## 安装

```bash
dsh plugin --profile web add file:<本目录绝对路径>
```

`dsh plugin` 是 pnpm 转发器，把声明了 `dsh.bundle.patch` 的包自动 reconcile 进 `package.json` 的 `dsh.profile.bundles` 层栈；`dsh.client` 声明使浏览器侧（独立设置页面）随 `dsh-client-modules` 自动挂载。本包零运行时依赖（只用 Node 内置模块与全局 `fetch`）。

> 注意：本地开发请用 `file:`（复制安装）而非 `link:`——`link:` 的 junction 会让包内 `import` 在 realpath 后解析失败。每次修改源码后重新 `remove` + `add` 同步副本。

## 移除

```bash
dsh plugin --profile web remove deepseek-valley-gate
```

## 验证

安装后重启 `dsh web`。自检官方逻辑（在 web profile 目录下运行）：

```bash
node --input-type=module -e "
import { isOfficialValley, parseOfficialSchedule, readConfigFile } from './node_modules/deepseek-valley-gate/lib/index.js'
const sched = parseOfficialSchedule('Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday')
console.log(sched.peakWindows)            // [[1,4],[6,10]]
console.log(isOfficialValley(new Date('2026-08-26T02:30:00Z'), sched))  // false（工作日高峰）
console.log(isOfficialValley(new Date('2026-08-29T02:30:00Z'), sched))  // true（周末低谷）
console.log(readConfigFile())
"
```

设置 API 冒烟（web 实例启动后）：

```bash
curl http://127.0.0.1:<port>/deepseek-valley-gate/config
curl -X POST -H 'Content-Type: application/json' \
  -d '{"mode":"manual","startMinute":600,"endMinute":1000}' \
  http://127.0.0.1:<port>/deepseek-valley-gate/config
curl -X POST -H 'Content-Type: application/json' \
  -d '{"refreshOfficial":true}' \
  http://127.0.0.1:<port>/deepseek-valley-gate/config
```

- 低谷时段：所有调用正常放行。
- 高峰时段：任意发消息，模型调用会以 `ValleyGateError` 被拒绝，Web 页面显示遮罩与倒计时。

## 版本历史

| 版本 | 说明 |
| --- | --- |
| **v0.2.0** | 新增「读取 DeepSeek 官方峰谷时段」功能（自动同步官方定价文档的峰谷规则 + 手动重新读取 + 官方/手动双模式）；所有时间显示统一为北京时间 24 小时制；修复设置页「暂不可用」问题（改用插件自有配置 API + JSON 配置文件，绕开 DSH settings 白名单限制）。 |
| v0.1.0 | 初版：低谷时段门禁（手动窗口 00:30–08:30）、`llm/stream` 全局拦截、Web 全屏遮罩与倒计时、DSH 设置界面独立页面。 |

## 许可

MIT
