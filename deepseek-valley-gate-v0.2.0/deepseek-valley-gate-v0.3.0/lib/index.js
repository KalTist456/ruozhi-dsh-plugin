// deepseek-valley-gate — DSH 低谷时段门禁（独立配置文件 + 自注册设置 API）
//
// 目标：仅在 DeepSeek 低谷时段（默认北京时间 00:30–08:30）允许 dsh 真正运行；
// 用户可在 DSH 设置界面（「低谷门禁」独立页面）里开关本门禁并调整低谷窗口。
//
// 为什么不用 settings namespace：
//   DSH 的 api-proxy 对配置客户端只暴露硬编码白名单内的 namespace
//   （WEB_SETTINGS_NAMESPACES / PRODUCT_SETTINGS_NAMESPACES），第三方插件注册的
//   namespace 会被 settings.describe 过滤、写入被 settings-not-exposed 拒绝。
//   因此本插件改为 dsh-better-sidebar 同款方案：自己的 JSON 配置文件 +
//   自注册 HTTP 路由（webServer.register），客户端直接 fetch 读写。
//
// 实现分三层：
// 1) 配置层：`~/.dsh/deepseek-valley-gate.json`（原子写，缺失/损坏回退默认）。
//    - enabled: boolean（默认 true）
//    - startMinute / endMinute: 低谷窗口（当日分钟，默认 30 / 510；end>1440 跨午夜）
// 2) 主拦截（host plane）：全局 `llm/stream` waterfall 钩子 prepend，门禁开启且
//    不在窗口内时抛 ValleyGateError，任何模型调用都被拦死。
// 3) 设置 API + UI 覆盖层（web surface，可选）：webServer 路由
//    GET/POST /deepseek-valley-gate/config 供设置页读写；/overlay.js 全屏遮罩。

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import path from "node:path";

// 组合默认。
const DEFAULT_CONFIG = {
	enabled: true,
	mode: "official",   // "official" = 读取 DeepSeek 官方峰谷规则；"manual" = 手动窗口
	startMinute: 30,    // manual 模式：00:30
	endMinute: 510,     // manual 模式：08:30
	official: null      // 官方规则缓存（内存），见 fetchOfficialSchedule
};

// 内置官方默认规则：官方文档（api-docs.deepseek.com/quick_start/pricing）声明
// "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday
// (all other hours are off-peak)"。即工作日 09:00–12:00 / 14:00–18:00（北京）高峰。
const FALLBACK_OFFICIAL = {
	peakWindows: [[1, 4], [6, 10]],  // UTC 小时 [start, end)
	weekdaysOnly: true,
	source: "builtin-fallback",
	fetchedAt: 0,
	raw: "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday"
};

// 官方定价文档 URL（同步来源）。
const OFFICIAL_PRICING_URL = "https://api-docs.deepseek.com/quick_start/pricing";
// 重抓间隔：6 小时。
const OFFICIAL_REFRESH_MS = 6 * 60 * 60 * 1000;

// 配置文件位置（与 whale-widget 一致：DSH_HOME 优先，否则用户主目录 .dsh）。
function configPath() {
	const home = process.env.DSH_HOME || join(os.homedir(), ".dsh");
	return join(home, "deepseek-valley-gate.json");
}

// 校验并规范化一段配置（宽松合并：缺失字段回退默认，非法值回退默认）。
function normalizeConfig(input) {
	const src = input && typeof input === "object" ? input : {};
	return {
		enabled: typeof src.enabled === "boolean" ? src.enabled : DEFAULT_CONFIG.enabled,
		mode: src.mode === "manual" ? "manual" : "official",
		startMinute: Number.isFinite(src.startMinute) ? Math.max(0, Math.min(2880, Math.floor(src.startMinute))) : DEFAULT_CONFIG.startMinute,
		endMinute: Number.isFinite(src.endMinute) ? Math.max(0, Math.min(2880, Math.floor(src.endMinute))) : DEFAULT_CONFIG.endMinute,
		official: normalizeOfficial(src.official)
	};
}

// 规范化官方规则对象。
function normalizeOfficial(src) {
	if (!src || typeof src !== "object") return null;
	const windows = Array.isArray(src.peakWindows)
		? src.peakWindows
			.filter((w) => Array.isArray(w) && w.length === 2 && w.every((n) => Number.isFinite(n)))
			.map((w) => [Math.max(0, Math.min(24, Math.floor(w[0]))), Math.max(0, Math.min(24, Math.floor(w[1])))])
		: null;
	if (!windows || windows.length === 0) return null;
	return {
		peakWindows: windows,
		weekdaysOnly: src.weekdaysOnly !== false,
		source: typeof src.source === "string" ? src.source : "unknown",
		fetchedAt: Number.isFinite(src.fetchedAt) ? src.fetchedAt : 0,
		raw: typeof src.raw === "string" ? src.raw : ""
	};
}

// 读配置：文件缺失/损坏回退默认。
function readConfigFile() {
	try {
		const file = configPath();
		if (!existsSync(file)) return { ...DEFAULT_CONFIG, official: null };
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return normalizeConfig(parsed);
	} catch (_e) {
		return { ...DEFAULT_CONFIG, official: null };
	}
}

// 写配置：先写临时文件，再替换目标（尽量原子；失败则直接写兜底）。
function writeConfigFile(config) {
	const file = configPath();
	const next = normalizeConfig(config);
	const text = JSON.stringify(next, null, 2) + "\n";
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = file + ".tmp";
	try {
		writeFileSync(tmp, text, "utf8");
		writeFileSync(file, text, "utf8");
		try { rmSync(tmp, { force: true }); } catch (_e) {}
	} catch (_e) {
		// 兜底：直接写目标文件。
		try { writeFileSync(file, text, "utf8"); } catch (_e2) { /* 无可挽回 */ }
	}
	return next;
}

// —— 官方峰谷时段读取 ——

// 从官方定价文档 HTML 提取峰谷规则。
// 期望句式（英文版）："Off-peak rates are half of the peak rates. Peak hours
// are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday (all other
// hours are off-peak)."
function parseOfficialSchedule(html) {
	const m = /Peak hours are\s+([0-2]?\d:\d{2})\s*-\s*([0-2]?\d:\d{2})(?:\s+and\s+([0-2]?\d:\d{2})\s*-\s*([0-2]?\d:\d{2}))?\s*UTC([^.<)]*)/i.exec(html);
	if (!m) return null;
	const toH = (t) => {
		const [hh, mm] = t.split(":").map(Number);
		return hh + (mm >= 30 ? 0.5 : 0); // 半小时窗口按小时向上取整到整点判断
	};
	const windows = [];
	const push = (a, b) => {
		const s = toH(a), e = toH(b);
		if (Number.isFinite(s) && Number.isFinite(e) && e > s) windows.push([Math.floor(s), Math.ceil(e)]);
	};
	push(m[1], m[2]);
	if (m[3] && m[4]) push(m[3], m[4]);
	if (windows.length === 0) return null;
	const weekdaysOnly = /monday|weekday/i.test(m[5] || "");
	return {
		peakWindows: windows,
		weekdaysOnly,
		source: OFFICIAL_PRICING_URL,
		fetchedAt: Date.now(),
		raw: m[0].replace(/\s+/g, " ").trim()
	};
}

// 抓取并解析官方峰谷规则。失败返回 null（调用方回退缓存/内置）。
async function fetchOfficialSchedule() {
	try {
		const res = await fetch(OFFICIAL_PRICING_URL, {
			headers: { "User-Agent": "deepseek-valley-gate/0.1.0" },
			signal: AbortSignal.timeout(15000)
		});
		if (!res.ok) return null;
		const html = await res.text();
		return parseOfficialSchedule(html);
	} catch (_e) {
		return null;
	}
}

// 判断 UTC 时间（Date）是否为工作日（周一=1..周五=5）。
function isUtcWeekday(date) {
	const dow = date.getUTCDay();
	return dow >= 1 && dow <= 5;
}

// 官方规则判定：返回 true 表示「当前是低谷时段」。
// 官方规则语义：工作日高峰窗口内 = 高峰；其余（含周末全天）= 低谷。
function isOfficialValley(date, official) {
	const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60;
	const peak = official || FALLBACK_OFFICIAL;
	if (peak.weekdaysOnly && !isUtcWeekday(date)) return true; // 周末全天低谷
	for (const [s, e] of peak.peakWindows) {
		if (utcHour >= s && utcHour < e) return false; // 高峰窗口内
	}
	return true;
}

// 计算当前北京时间（UTC+8）当日分钟数。
function beijingMinutesNow() {
	const d = new Date();
	return ((d.getUTCHours() + 8) * 60 + d.getUTCMinutes()) % 1440;
}

// 判断 minute 是否落在窗口 [start, end)。end>=1440 表示跨午夜；span>=1440 全时段。
function inWindow(minute, startMinute, endMinute) {
	const span = endMinute - startMinute;
	if (span >= 1440) return true;
	const offset = ((minute - startMinute) % 1440 + 1440) % 1440;
	return offset < span;
}

// 距下一次窗口开始还有多少毫秒。
function msUntilWindow(startMinute) {
	const minute = beijingMinutesNow();
	const target = minute < startMinute ? startMinute : startMinute + 1440;
	const mins = target - minute;
	const d = new Date();
	return mins * 60_000 - d.getUTCSeconds() * 1000 - d.getUTCMilliseconds();
}

function fmtCountdown(ms) {
	const h = Math.floor(ms / 3_600_000);
	const m = Math.floor((ms % 3_600_000) / 60_000);
	const s = Math.floor((ms % 60_000) / 1000);
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function describeWindow(startMinute, endMinute) {
	const fmt = (min) => {
		const mm = ((min % 1440) + 1440) % 1440;
		return `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
	};
	return `${fmt(startMinute)}–${fmt(endMinute)}`;
}

// 官方规则的人类可读描述（北京时间）。
function describeOfficial(official) {
	const peak = official || FALLBACK_OFFICIAL;
	const fmtUtc = (h) => String(Math.floor(h)).padStart(2, "0") + ":00";
	const windows = peak.peakWindows.map(([s, e]) => `${fmtUtc(s + 8)}–${fmtUtc(e + 8)}`).join(" / ");
	const days = peak.weekdaysOnly ? "周一至周五" : "每天";
	return `官方规则（${days} ${windows} 高峰，北京时间）`;
}

function blockMessage(cfg) {
	if (cfg.mode === "official") {
		const peak = cfg.official || FALLBACK_OFFICIAL;
		return (
			'[DSH 低谷门禁] 当前不在低谷时段。' +
			`${describeOfficial(peak)}。` +
			'为节省费用，高峰时段已禁用 dsh 运行。'
		);
	}
	const cd = fmtCountdown(msUntilWindow(cfg.startMinute));
	return (
		'[DSH 低谷门禁] 当前不在低谷时段（手动窗口 ' +
		`${describeWindow(cfg.startMinute, cfg.endMinute)}）。` +
		`距下一低谷开始还有 ${cd}。为节省费用，本时段已禁用 dsh 运行。`
	);
}

class ValleyGateError extends Error {
	constructor(message) {
		super(message);
		this.name = "ValleyGateError";
	}
}

// 全屏遮罩脚本：加载后先 fetch 配置，只有 enabled=true 且当前不在低谷（高峰）才显示。
// 这样「关闭门禁」后即使页面刷新，遮罩也会读到 enabled=false 而不再弹出。
function overlayJs() {
	return `(function () {
	if (window.__dshValleyGate) return
	window.__dshValleyGate = true
	var CONFIG = null
	var el = null
	var disabling = false

	function loadConfig() {
		return fetch('/deepseek-valley-gate/config').then(function (r) { return r.json() }).then(function (j) {
			return (j && j.ok && j.config) ? j.config : null
		}).catch(function () { return null })
	}

	function inPeak(d, cfg) {
		var dow = d.getUTCDay()
		var wd = !cfg.official || cfg.official.weekdaysOnly !== false
		if (wd && !(dow >= 1 && dow <= 5)) return false
		var h = d.getUTCHours() + d.getUTCMinutes() / 60
		var peaks = (cfg.official && cfg.official.peakWindows) || [[1, 4], [6, 10]]
		for (var i = 0; i < peaks.length; i++) {
			if (h >= peaks[i][0] && h < peaks[i][1]) return true
		}
		return false
	}
	function inManualWindow(d, cfg) {
		var m = ((d.getUTCHours() + 8) * 60 + d.getUTCMinutes()) % 1440
		var span = cfg.endMinute - cfg.startMinute
		if (span >= 1440) return true
		var offset = ((m - cfg.startMinute) % 1440 + 1440) % 1440
		return offset < span
	}
	// 是否显示遮罩：门禁开启 + 当前不在低谷（高峰）。
	function shouldShow(d, cfg) {
		if (!cfg || cfg.enabled === false) return false
		if (cfg.mode === 'manual') return !inManualWindow(d, cfg)
		return inPeak(d, cfg)
	}
	function pad(n) { return (n < 10 ? '0' : '') + n }
	function until(d, startMinute) {
		var m = ((d.getUTCHours() + 8) * 60 + d.getUTCMinutes()) % 1440
		var target = m < startMinute ? startMinute : startMinute + 1440
		var mins = target - m
		return mins * 60000 - d.getUTCSeconds() * 1000 - d.getUTCMilliseconds()
	}
	function fmt(ms) {
		var t = Math.max(0, ms)
		var h = Math.floor(t / 3600000)
		var m = Math.floor((t % 3600000) / 60000)
		var s = Math.floor((t % 60000) / 1000)
		return pad(h) + ':' + pad(m) + ':' + pad(s)
	}
	function render() {
		if (!CONFIG) return
		var on = shouldShow(new Date(), CONFIG)
		if (on && !el) { el = build() }
		if (el) {
			el.style.display = on ? 'flex' : 'none'
			if (on) {
				var c = el.querySelector('[data-countdown]')
				var l = el.querySelector('[data-countdown-label]')
				if (CONFIG.mode === 'manual') {
					if (c) c.textContent = fmt(until(new Date(), CONFIG.startMinute))
					if (l) l.textContent = '距离低谷开始'
				} else {
					if (c) c.textContent = ''
					if (l) l.textContent = '官方高峰时段，详见「设置 → 低谷门禁」'
				}
			}
		}
	}
	function disableGate() {
		if (disabling) return
		disabling = true
		var btn = el && el.querySelector('[data-disable]')
		if (btn) { btn.disabled = true; btn.textContent = '正在关闭…' }
		fetch('/deepseek-valley-gate/config', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled: false })
		}).then(function (r) { return r.json() }).then(function (j) {
			if (j && j.ok) {
				if (el && el.parentNode) el.parentNode.removeChild(el)
				el = null
				window.__dshValleyGate = false
				try { location.reload() } catch (e) {}
			} else {
				disabling = false
				if (btn) { btn.disabled = false; btn.textContent = '关闭门禁并继续使用' }
				alert('关闭失败，请到「设置 → 低谷门禁」手动关闭。')
			}
		}).catch(function () {
			disabling = false
			if (btn) { btn.disabled = false; btn.textContent = '关闭门禁并继续使用' }
			alert('关闭失败，请到「设置 → 低谷门禁」手动关闭。')
		})
	}
	function build() {
		var o = document.createElement('div')
		o.setAttribute('data-dsh-valley-gate', '')
		o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0b0e14;color:#e6edf3;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px;text-align:center'
		var h = document.createElement('div')
		h.style.cssText = 'font-size:20px;font-weight:600;letter-spacing:.5px'
		h.textContent = '当前不在 DeepSeek 低谷时段'
		var p = document.createElement('div')
		p.style.cssText = 'font-size:14px;color:#9aa4b2;max-width:520px;line-height:1.6'
		p.textContent = '本 DSH 已开启低谷时段门禁：仅低谷时段允许运行，以节省费用。你可点下方按钮临时关闭门禁，或到「设置 → 低谷门禁」调整。'
		var c = document.createElement('div')
		c.setAttribute('data-countdown', '')
		c.style.cssText = 'font-size:32px;font-weight:700;font-variant-numeric:tabular-nums;color:#58a6ff;min-height:38px'
		c.textContent = '--:--:--'
		var t = document.createElement('div')
		t.setAttribute('data-countdown-label', '')
		t.style.cssText = 'font-size:12px;color:#697077'
		t.textContent = '距离低谷开始'
		var btn = document.createElement('button')
		btn.setAttribute('data-disable', '')
		btn.type = 'button'
		btn.style.cssText = 'margin-top:8px;appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;color:#fff;background:#2f81f7;border-radius:8px;padding:9px 22px;font-size:14px;font-weight:600'
		btn.textContent = '关闭门禁并继续使用'
		btn.addEventListener('click', disableGate)
		var note = document.createElement('div')
		note.style.cssText = 'font-size:12px;color:#697077;max-width:420px;line-height:1.6'
		note.textContent = '关闭后 dsh 全天放行；可随时到「设置 → 低谷门禁」重新开启。'
		o.appendChild(h)
		o.appendChild(p)
		o.appendChild(c)
		o.appendChild(t)
		o.appendChild(btn)
		o.appendChild(note)
		document.body.appendChild(o)
		return o
	}

	loadConfig().then(function (cfg) {
		CONFIG = cfg
		render()
		setInterval(render, 1000)
		// 每 30 秒刷新配置，响应用户在设置页切换 enabled / 模式。
		setInterval(function () {
			loadConfig().then(function (c) { if (c) { CONFIG = c; render() } })
		}, 30000)
	})
})()`
}

const name = "deepseek-valley-gate";
// 主拦截不硬依赖服务；webServer 用 ctx.get 可选读取。
const inject = [];

function apply(ctx) {
	const disposers = [];
	let config = readConfigFile();
	// 官方规则缓存：优先用配置文件里存的上次成功结果，否则内置默认。
	let official = config.official || FALLBACK_OFFICIAL;
	let refreshing = null;

	// 刷新官方规则：拉取成功则更新内存 + 配置文件；失败保留旧值。
	async function refreshOfficial() {
		if (refreshing) return refreshing;
		refreshing = (async () => {
			try {
				const fetched = await fetchOfficialSchedule();
				if (fetched) {
					official = fetched;
					config = { ...config, official: fetched };
					writeConfigFile(config);
				}
			} catch (_e) {
				// 保留旧值
			} finally {
				refreshing = null;
			}
		})();
		return refreshing;
	}

	// 门禁判定：official 模式用官方规则；manual 模式用手动窗口。
	function isAllowed() {
		if (config.enabled === false) return true;
		if (config.mode === "official") return isOfficialValley(new Date(), official);
		return inWindow(beijingMinutesNow(), config.startMinute, config.endMinute);
	}

	// 启动即抓取一次官方规则（失败静默回退内置/缓存）。
	refreshOfficial();

	// 每 6 小时重抓一次。
	const timer = setInterval(() => { refreshOfficial(); }, OFFICIAL_REFRESH_MS);
	if (timer.unref) timer.unref();

	// 主拦截：prepend 挂到 llm/stream 最前。
	disposers.push(ctx.on("llm/stream", (options, next) => {
		if (!isAllowed()) {
			throw new ValleyGateError(blockMessage({ ...config, official }));
		}
		return next();
	}, { prepend: true, global: true }));

	// UI 覆盖层 + 设置 API：webServer 服务可能晚于本插件就绪，用 ctx.inject
	// 延迟注册（web profile 有 webServer；headless/TUI 无则整块跳过，仅保留拦截）。
	ctx.inject(["webServer"], (webCtx) => {
		const webServer = webCtx.webServer;
		disposers.push(webServer.tapIndex((html) => {
			if (html.indexOf("data-dsh-valley-gate") !== -1) return html;
			const tag = `<script defer src="/deepseek-valley-gate/overlay.js"></script>`;
			if (html.indexOf("</body>") !== -1) return html.replace("</body>", tag + "</body>");
			return html + tag;
		}));

		disposers.push(webServer.register({
			kind: "exact",
			path: "/deepseek-valley-gate/overlay.js",
			handler: (req, res) => {
				try {
					res.writeHead(200, {
						"Content-Type": "application/javascript; charset=utf-8",
						"Cache-Control": "no-store"
					});
					res.end(overlayJs());
				} catch (_e) {
					res.writeHead(500);
					res.end("/* overlay error */");
				}
			}
		}));

		// 设置 API：GET 读配置（含官方规则 + 同步时间），POST 写配置。
		disposers.push(webServer.register({
			kind: "exact",
			path: "/deepseek-valley-gate/config",
			handler: (req, res) => {
				const json = (status, payload) => {
					res.writeHead(status, {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store",
						"Access-Control-Allow-Origin": "*"
					});
					res.end(JSON.stringify(payload));
				};
				const method = String(req.method || "GET").toUpperCase();
				if (method === "GET") {
					config = readConfigFile();
					if (config.official) official = config.official;
					return json(200, {
						ok: true,
						config: { ...config, official },
						now: {
							utc: new Date().toISOString(),
							beijingMinute: beijingMinutesNow(),
							// 纯时间判定（不含 enabled 开关），供 UI 展示「当前是否低谷」。
							valley: config.mode === "official"
								? isOfficialValley(new Date(), official)
								: inWindow(beijingMinutesNow(), config.startMinute, config.endMinute)
						}
					});
				}
				if (method === "POST") {
					let body = "";
					req.on("data", (chunk) => {
						body += chunk;
						if (body.length > 8192) req.destroy();
					});
					req.on("end", async () => {
						try {
							const parsed = JSON.parse(body || "{}");
							const next = normalizeConfig({ ...config, ...parsed });
							config = writeConfigFile(next);
							if (config.official) official = config.official;
							// 显式请求刷新官方规则。
							if (parsed.refreshOfficial === true) {
								await refreshOfficial();
								config = { ...config, official };
								writeConfigFile(config);
							}
							json(200, { ok: true, config: { ...config, official } });
						} catch (e) {
							json(400, { ok: false, error: String((e && e.message) || e) });
						}
					});
					req.on("error", () => json(500, { ok: false, error: "request aborted" }));
					return;
				}
				json(405, { ok: false, error: "method not allowed" });
			}
		}));
	});

	ctx.effect(() => () => {
		clearInterval(timer);
		for (const d of disposers) {
			try { d(); } catch (_err) {}
		}
	});
}

export {
	name, inject, apply,
	DEFAULT_CONFIG, FALLBACK_OFFICIAL, normalizeConfig, normalizeOfficial,
	inWindow, beijingMinutesNow, isOfficialValley, parseOfficialSchedule, fetchOfficialSchedule,
	readConfigFile, writeConfigFile, describeOfficial
};
