// deepseek-valley-gate client half — 浏览器侧独立设置界面。
//
// 在 DSH 设置界面的侧边栏注册一个独立 section（「低谷门禁」），内容区渲染
// 一个完整的简易设置页：
//   - 当前状态卡：低谷/高峰状态、北京时间（24 小时制）、距下一低谷的倒计时
//   - 模式：官方（读取 DeepSeek 官方峰谷规则）/ 手动（自定义窗口）
//   - 官方规则信息：同步到的官方窗口 + 来源 + 最近同步时间
//   - 开关：enabled（门禁总开关）
//   - 手动模式数字：startMinute / endMinute（当日分钟）
//
// 配置读写走插件自注册的 HTTP API（/deepseek-valley-gate/config），
// 因为 DSH 的 settings RPC 只对白名单 namespace 开放，第三方插件无法通过
// settingsScope 读写自己的配置。
//
// 这是零构建的手写浏览器 bundle：通过 window.__ModuleLoader__.load 注册，
// React / cordis 均来自模块加载器的 require（与 dsh-plugins-store 同款契约）。

window.__ModuleLoader__.load({
	id: "deepseek-valley-gate",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const react = require("react");
		const h = react.createElement;
		const useState = react.useState;
		const useEffect = react.useEffect;

		// 依赖的 client 服务：slots（注册 section）、locale（文案双语）。
		const inject = ["slots", "locale"];

		// 插件配置 API（与 host 侧路由一致）。
		const CONFIG_URL = "/deepseek-valley-gate/config";

		// —— 北京时间工具（与 host 侧同一套 UTC+8 换算）——
		function bjMinutesOf(date) {
			return ((date.getUTCHours() + 8) * 60 + date.getUTCMinutes()) % 1440;
		}
		// 24 小时制 HH:MM（补零）。min 可为负/>=1440（跨午夜次日）。
		function fmtClock(min) {
			const mm = ((min % 1440) + 1440) % 1440;
			return String(Math.floor(mm / 60)).padStart(2, "0") + ":" + String(mm % 60).padStart(2, "0");
		}
		// 24 小时制 HH:MM:SS（带秒）。
		function fmtClockSeconds(date) {
			const m = bjMinutesOf(date);
			const hh = Math.floor(m / 60);
			const mm = m % 60;
			const ss = date.getUTCSeconds();
			return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0");
		}
		function inWindow(minute, startMinute, endMinute) {
			const span = endMinute - startMinute;
			if (span >= 1440) return true;
			const offset = ((minute - startMinute) % 1440 + 1440) % 1440;
			return offset < span;
		}
		// 官方规则判定：工作日 UTC 高峰窗口内 = 高峰；其余（含周末）= 低谷。
		function isOfficialValley(date, peakWindows, weekdaysOnly) {
			const dow = date.getUTCDay();
			if (weekdaysOnly !== false && !(dow >= 1 && dow <= 5)) return true;
			const h = date.getUTCHours() + date.getUTCMinutes() / 60;
			for (const [s, e] of (peakWindows || [])) {
				if (h >= s && h < e) return false;
			}
			return true;
		}
		function msUntilWindow(date, startMinute) {
			const minute = bjMinutesOf(date);
			const target = minute < startMinute ? startMinute : startMinute + 1440;
			const mins = target - minute;
			return mins * 60000 - date.getUTCSeconds() * 1000 - date.getUTCMilliseconds();
		}
		function fmtCountdown(ms) {
			const t = Math.max(0, ms);
			const hh = Math.floor(t / 3600000);
			const m = Math.floor((t % 3600000) / 60000);
			const s = Math.floor((t % 60000) / 1000);
			return String(hh).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
		}
		function clampMinute(text) {
			const n = Number(String(text == null ? "" : text).trim());
			return Number.isFinite(n) ? Math.max(0, Math.min(2880, Math.floor(n))) : 0;
		}
		// 官方窗口描述（北京时间 24 小时制）。
		function describeOfficial(peakWindows, weekdaysOnly) {
			const fmt = (h) => String(Math.floor(h)).padStart(2, "0") + ":00";
			const windows = (peakWindows || []).map(([s, e]) => fmt(s + 8) + " – " + fmt(e + 8)).join(" / ");
			const days = weekdaysOnly !== false ? "周一至周五" : "每天";
			return days + " " + windows + " 为高峰";
		}
		function fmtSyncTime(ts) {
			if (!ts) return "—";
			const d = new Date(ts);
			const p = (n) => String(n).padStart(2, "0");
			return p(d.getUTCHours() + 8 > 23 ? (d.getUTCHours() + 8 - 24) : d.getUTCHours() + 8) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds());
		}

		// —— 独立设置页面组件 ——
		function ValleyGateSection(props) {
			const { t } = props;
			const [config, setConfig] = useState(null);       // null = 加载中/失败
			const [draft, setDraft] = useState(null);         // 未保存草稿
			const [saving, setSaving] = useState(false);
			const [failed, setFailed] = useState(false);
			const [now, setNow] = useState(() => new Date());
			const [official, setOfficial] = useState(null);   // 官方规则信息

			// 每秒刷新当前时间（倒计时/状态）。
			useEffect(() => {
				const id = setInterval(() => setNow(new Date()), 1000);
				return () => clearInterval(id);
			}, []);

			// 挂载时读一次配置。
			useEffect(() => {
				let cancelled = false;
				fetch(CONFIG_URL)
					.then((r) => r.json())
					.then((j) => {
						if (!cancelled && j && j.ok) {
							setConfig(j.config);
							if (j.config.official) setOfficial(j.config.official);
						}
					})
					.catch(() => { if (!cancelled) setConfig(null); });
				return () => { cancelled = true; };
			}, []);

			if (config === null) {
				return h("p", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", margin: "0" } }, t("unavailable"));
			}

			const val = draft === null ? config : draft;
			const enabled = val.enabled !== false;
			const mode = val.mode === "manual" ? "manual" : "official";
			// 判定：official 用官方规则；manual 用窗口。
			const active = enabled && (mode === "official"
				? isOfficialValley(now, official ? official.peakWindows : null, official ? official.weekdaysOnly : true)
				: inWindow(bjMinutesOf(now), val.startMinute, val.endMinute));
			const statusText = !enabled ? t("statusDisabled") : active ? t("statusInWindow") : t("statusOutOfWindow");
			const statusColor = !enabled
				? "var(--dsw-alias-label-tertiary)"
				: active
					? "var(--dsw-alias-state-success-primary, #3fb950)"
					: "var(--dsw-alias-label-error, #f85149)";
			const countdown = enabled && !active && mode === "manual"
				? fmtCountdown(msUntilWindow(now, val.startMinute))
				: null;
			const dirty = draft !== null;

			const edit = (patch) => setDraft({ ...val, ...patch });
			const discard = () => { setDraft(null); setFailed(false); };
			const save = () => {
				if (draft === null || saving) return;
				setSaving(true);
				setFailed(false);
				fetch(CONFIG_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(draft)
				})
					.then((r) => r.json())
					.then((j) => {
						if (j && j.ok) {
							setConfig(j.config);
							if (j.config.official) setOfficial(j.config.official);
							setDraft(null);
						} else {
							setFailed(true);
						}
					})
					.catch(() => setFailed(true))
					.finally(() => setSaving(false));
			};
			const refreshOfficial = () => {
				if (saving) return;
				setSaving(true);
				fetch(CONFIG_URL, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ refreshOfficial: true })
				})
					.then((r) => r.json())
					.then((j) => { if (j && j.ok) { setConfig(j.config); if (j.config.official) setOfficial(j.config.official); } })
					.catch(() => setFailed(true))
					.finally(() => setSaving(false));
			};

			return h("div", { style: SECTION_STYLE }, [
				h("p", { key: "intro", style: INTRO_STYLE }, t("intro")),

				// 当前状态卡
				h("div", { key: "status", style: CARD_STYLE }, [
					h("div", { key: "statusRow", style: STATUS_ROW_STYLE }, [
						h("span", { key: "dot", style: { ...STATUS_DOT_STYLE, background: statusColor } }),
						h("span", { key: "text", style: { ...STATUS_TEXT_STYLE, color: statusColor } }, statusText)
					]),
					h("div", { key: "now", style: STATUS_DETAIL_STYLE }, [
						h("span", { key: "l", style: DETAIL_LABEL_STYLE }, t("nowLabel")),
						h("span", { key: "v", style: DETAIL_VALUE_STYLE }, fmtClockSeconds(now) + "（北京时间 24 小时制）")
					]),
					h("div", { key: "mode", style: STATUS_DETAIL_STYLE }, [
						h("span", { key: "l", style: DETAIL_LABEL_STYLE }, t("modeLabel")),
						h("span", { key: "v", style: DETAIL_VALUE_STYLE }, mode === "official" ? t("modeOfficial") : t("modeManual"))
					]),
					// official 模式：官方窗口信息
					mode === "official" && h("div", { key: "officialWin", style: STATUS_DETAIL_STYLE }, [
						h("span", { key: "l", style: DETAIL_LABEL_STYLE }, t("officialWindowLabel")),
						h("span", { key: "v", style: DETAIL_VALUE_STYLE }, describeOfficial(
							official ? official.peakWindows : null,
							official ? official.weekdaysOnly : true
						))
					]),
					mode === "official" && h("div", { key: "officialSrc", style: STATUS_DETAIL_STYLE }, [
						h("span", { key: "l", style: DETAIL_LABEL_STYLE }, t("officialSourceLabel")),
						h("span", { key: "v", style: DETAIL_VALUE_STYLE },
							(official ? official.source : "—") + " · " + t("officialSyncLabel") + " " + fmtSyncTime(official ? official.fetchedAt : 0))
					]),
					// manual 模式：手动窗口
					mode === "manual" && h("div", { key: "win", style: STATUS_DETAIL_STYLE }, [
						h("span", { key: "l", style: DETAIL_LABEL_STYLE }, t("windowLabel")),
						h("span", { key: "v", style: DETAIL_VALUE_STYLE },
							fmtClock(val.startMinute) + (val.endMinute >= 1440 ? "（次日）" : "") + " – " + fmtClock(val.endMinute))
					]),
					countdown !== null && h("div", { key: "countdown", style: STATUS_DETAIL_STYLE }, [
						h("span", { key: "l", style: DETAIL_LABEL_STYLE }, t("countdownLabel")),
						h("span", { key: "v", style: { ...DETAIL_VALUE_STYLE, fontVariantNumeric: "tabular-nums", color: statusColor } }, countdown)
					])
				]),

				// 配置卡
				h("div", { key: "config", style: CARD_STYLE }, [
					// 开关行
					h("div", { key: "enabled", style: ROW_STYLE }, [
						h("div", { key: "text", style: COL_STYLE }, [
							h("div", { key: "t", style: LABEL_STYLE }, t("enabledLabel")),
							h("div", { key: "h", style: HINT_STYLE }, t("enabledHint"))
						]),
						h("button", {
							key: "sw",
							type: "button",
							role: "switch",
							"aria-checked": enabled ? "true" : "false",
							disabled: saving,
							onClick: () => edit({ enabled: !enabled }),
							style: { ...SWITCH_STYLE, background: enabled ? "var(--dsw-alias-state-business-primary, #2f81f7)" : "var(--dsw-alias-bg-module-platform, #24292f)" }
						}, h("span", { key: "knob", style: { ...KNOB_STYLE, transform: enabled ? "translateX(18px)" : "translateX(0)" } }))
					]),
					h("div", { key: "h1", style: HAIRLINE_STYLE }),

					// 模式选择行
					h("div", { key: "mode", style: ROW_STYLE }, [
						h("div", { key: "text", style: COL_STYLE }, [
							h("div", { key: "t", style: LABEL_STYLE }, t("modeSelectLabel")),
							h("div", { key: "h", style: HINT_STYLE }, t("modeSelectHint"))
						]),
						h("select", {
							key: "sel",
							disabled: saving,
							value: mode,
							onChange: (e) => edit({ mode: e.target.value }),
							style: INPUT_STYLE
						}, [
							h("option", { key: "o", value: "official" }, t("modeOfficial")),
							h("option", { key: "m", value: "manual" }, t("modeManual"))
						])
					]),
					h("div", { key: "h2", style: HAIRLINE_STYLE }),

					// 手动窗口（仅 manual 模式显示）
					mode === "manual" && h("div", { key: "start", style: ROW_STYLE }, [
						h("div", { key: "text", style: COL_STYLE }, [
							h("div", { key: "t", style: LABEL_STYLE }, t("startLabel")),
							h("div", { key: "h", style: HINT_STYLE }, t("startHint"))
						]),
						h("input", {
							key: "in",
							type: "number",
							min: 0,
							max: 1440,
							disabled: saving,
							value: val.startMinute,
							onChange: (e) => edit({ startMinute: clampMinute(e.target.value) }),
							style: INPUT_STYLE
						}),
						h("span", { key: "clock", style: CLOCK_STYLE }, fmtClock(val.startMinute))
					]),
					mode === "manual" && h("div", { key: "h3", style: HAIRLINE_STYLE }),

					// 结束时刻行
					mode === "manual" && h("div", { key: "end", style: ROW_STYLE }, [
						h("div", { key: "text", style: COL_STYLE }, [
							h("div", { key: "t", style: LABEL_STYLE }, t("endLabel")),
							h("div", { key: "h", style: HINT_STYLE }, t("endHint"))
						]),
						h("input", {
							key: "in",
							type: "number",
							min: 0,
							max: 2880,
							disabled: saving,
							value: val.endMinute,
							onChange: (e) => edit({ endMinute: clampMinute(e.target.value) }),
							style: INPUT_STYLE
						}),
						h("span", { key: "clock", style: CLOCK_STYLE }, fmtClock(val.endMinute))
					]),

					// official 模式：刷新官方规则按钮
					mode === "official" && h("div", { key: "refresh", style: ROW_STYLE }, [
						h("div", { key: "text", style: COL_STYLE }, [
							h("div", { key: "t", style: LABEL_STYLE }, t("refreshLabel")),
							h("div", { key: "h", style: HINT_STYLE }, t("refreshHint"))
						]),
						h("button", {
							key: "btn",
							type: "button",
							disabled: saving,
							onClick: refreshOfficial,
							style: GHOST_BTN_STYLE
						}, saving ? t("refreshing") : t("refresh"))
					]),

					// 底部操作
					h("div", { key: "footer", style: FOOTER_STYLE }, [
						failed ? h("span", { key: "err", style: { color: "var(--dsw-alias-label-error, #f85149)", flex: "1", fontSize: "12px" } }, t("saveFailed")) : null,
						h("button", {
							key: "discard",
							type: "button",
							disabled: !dirty || saving,
							onClick: discard,
							style: GHOST_BTN_STYLE
						}, t("discard")),
						h("button", {
							key: "save",
							type: "button",
							disabled: !dirty || saving,
							onClick: save,
							style: PRIMARY_BTN_STYLE
						}, saving ? t("saving") : t("save"))
					])
				]),

				// 提示
				h("p", { key: "footnote", style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "1.6", margin: "4px 2px 0" } }, t("footnote"))
			]);
		}

		// 内联样式（用 DSW alias CSS 变量，跟随主题）。
		const SECTION_STYLE = { maxWidth: "760px", display: "flex", flexDirection: "column", gap: "14px", color: "var(--dsw-alias-label-primary)" };
		const INTRO_STYLE = { color: "var(--dsw-alias-label-tertiary)", margin: "0", fontSize: "13px", lineHeight: "1.6" };
		const CARD_STYLE = {
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-3)",
			borderRadius: "16px",
			padding: "16px",
			display: "flex",
			flexDirection: "column",
			gap: "12px"
		};
		const STATUS_ROW_STYLE = { display: "flex", alignItems: "center", gap: "8px" };
		const STATUS_DOT_STYLE = { width: "10px", height: "10px", borderRadius: "50%", flex: "none" };
		const STATUS_TEXT_STYLE = { fontSize: "16px", fontWeight: "600", lineHeight: "1.4" };
		const STATUS_DETAIL_STYLE = { display: "flex", alignItems: "center", gap: "10px", fontSize: "13px" };
		const DETAIL_LABEL_STYLE = { color: "var(--dsw-alias-label-tertiary)", minWidth: "110px" };
		const DETAIL_VALUE_STYLE = { color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" };
		const ROW_STYLE = { display: "flex", alignItems: "center", gap: "12px" };
		const COL_STYLE = { display: "flex", flexDirection: "column", gap: "3px", flex: "1", minWidth: "0" };
		const LABEL_STYLE = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: "600", lineHeight: "1.4" };
		const HINT_STYLE = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "1.5" };
		const HAIRLINE_STYLE = { height: "1px", background: "var(--dsw-alias-border-l2)" };
		const SWITCH_STYLE = {
			position: "relative", width: "40px", height: "22px", borderRadius: "999px",
			border: "0", cursor: "pointer", flex: "none", transition: "background .16s", padding: "0"
		};
		const KNOB_STYLE = {
			position: "absolute", top: "2px", left: "2px", width: "18px", height: "18px",
			borderRadius: "50%", background: "#fff", transition: "transform .16s", display: "block"
		};
		const INPUT_STYLE = {
			width: "120px", flex: "none", padding: "5px 8px", fontSize: "13px",
			color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-layer-2)",
			border: "1px solid var(--dsw-alias-border-l2)", borderRadius: "8px"
		};
		const CLOCK_STYLE = { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", flex: "none", width: "52px", fontVariantNumeric: "tabular-nums" };
		const FOOTER_STYLE = { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "8px", borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: "12px", marginTop: "2px" };
		const GHOST_BTN_STYLE = {
			appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)",
			color: "var(--dsw-alias-label-secondary)", background: "transparent", borderRadius: "8px", padding: "5px 14px", fontSize: "13px"
		};
		const PRIMARY_BTN_STYLE = {
			appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid transparent",
			color: "#fff", background: "var(--dsw-alias-state-business-primary, #2f81f7)", borderRadius: "8px", padding: "5px 14px", fontSize: "13px"
		};

		// 文案双语。
		const zh = {
			nav: "低谷门禁",
			intro: "让 dsh 只在 DeepSeek 低谷时段运行，高峰时段拦截一切模型调用，节省费用。可读取 DeepSeek 官方峰谷规则，也可自定义窗口。",
			unavailable: "低谷门禁配置读取失败，请稍后重试。",
			statusDisabled: "门禁已关闭，dsh 全天放行",
			statusInWindow: "当前处于低谷时段，正常运行",
			statusOutOfWindow: "当前不在低谷时段，已拦截",
			nowLabel: "当前时间",
			modeLabel: "模式",
			modeOfficial: "官方峰谷规则",
			modeManual: "手动窗口",
			officialWindowLabel: "官方高峰窗口",
			officialSourceLabel: "规则来源",
			officialSyncLabel: "同步于",
			windowLabel: "低谷窗口",
			countdownLabel: "距低谷开始",
			enabledLabel: "启用低谷时段门禁",
			enabledHint: "关闭后 dsh 全天放行，不受低谷窗口限制。",
			modeSelectLabel: "低谷时段来源",
			modeSelectHint: "官方 = 自动读取 DeepSeek 官方峰谷规则（工作日 09:00–12:00 / 14:00–18:00 高峰，周末全天低谷）；手动 = 自定义窗口。",
			startLabel: "低谷开始时刻",
			startHint: "当日分钟数（如 30 = 00:30，600 = 10:00）。",
			endLabel: "低谷结束时刻",
			endHint: "当日分钟数（如 510 = 08:30；>1440 表示跨午夜，如 2140 = 次日 11:40）。",
			refreshLabel: "官方规则",
			refreshHint: "从 DeepSeek 官方定价文档重新读取峰谷时段。",
			refresh: "重新读取",
			refreshing: "读取中…",
			save: "保存",
			saving: "保存中…",
			discard: "放弃修改",
			saveFailed: "保存失败，请重试。",
			footnote: "提示：时间为北京时间（UTC+8）24 小时制。官方规则来自 api-docs.deepseek.com 定价页（Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday），每 6 小时自动同步；同步失败时使用上次成功结果或内置默认。"
		};
		const en = {
			nav: "Valley Gate",
			intro: "Let dsh run only during DeepSeek off-peak hours; all model calls are blocked outside the window to save cost. Reads DeepSeek's official peak/off-peak schedule, or use a custom window.",
			unavailable: "Failed to read valley gate config, please retry later.",
			statusDisabled: "Gate off — dsh runs all day",
			statusInWindow: "In valley window — running normally",
			statusOutOfWindow: "Outside valley window — blocked",
			nowLabel: "Now",
			modeLabel: "Mode",
			modeOfficial: "Official schedule",
			modeManual: "Manual window",
			officialWindowLabel: "Official peak window",
			officialSourceLabel: "Source",
			officialSyncLabel: "synced at",
			windowLabel: "Valley window",
			countdownLabel: "To next valley",
			enabledLabel: "Enable valley gate",
			enabledHint: "When off, DSH runs all day regardless of the valley window.",
			modeSelectLabel: "Valley source",
			modeSelectHint: "Official = auto-read DeepSeek's official peak/off-peak schedule (workdays 09:00–12:00 / 14:00–18:00 peak, weekends all valley); Manual = custom window.",
			startLabel: "Valley start",
			startHint: "Minutes of day (e.g. 30 = 00:30, 600 = 10:00).",
			endLabel: "Valley end",
			endHint: "Minutes of day (e.g. 510 = 08:30; >1440 means past midnight, e.g. 2140 = next 11:40).",
			refreshLabel: "Official schedule",
			refreshHint: "Re-read peak/off-peak hours from DeepSeek's official pricing doc.",
			refresh: "Re-read",
			refreshing: "Reading…",
			save: "Save",
			saving: "Saving…",
			discard: "Discard",
			saveFailed: "Save failed, please retry.",
			footnote: "Note: times are Beijing time (UTC+8), 24-hour clock. Official schedule is from the api-docs.deepseek.com pricing page (Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday), auto-synced every 6 hours; on failure the last successful result or the built-in default is used."
		};

		function apply(ctx) {
			const t = ctx.locale.bind("deepseek-valley-gate");
			ctx.effect(() => ctx.locale.register("deepseek-valley-gate", { zh, en }), "deepseek-valley-gate: locale");

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "deepseek-valley-gate",
				order: 40,
				label: () => t("nav"),
				locale: "deepseek-valley-gate"
			}, ValleyGateSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
