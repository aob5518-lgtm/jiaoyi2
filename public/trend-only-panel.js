(() => {
  "use strict";
  const mount = document.getElementById("trendOnlyBlock");
  if (!mount) return;
  const DEFAULTS = {
    enabled: true, leverage: 10, allowWeekendOpen: false, weekendMode: "no_new_position", weekendExitHourUTC: 20,
    riskPerTrade: 0.01, maxPositionRatio: 0.1, maxDailyLossRatio: 0.03, maxConsecutiveLosses: 2,
    cooldownHoursAfterLossLimit: 12, atrPeriod: 14, adxPeriod: 14, chopPeriod: 14, emaFast: 20,
    emaMid: 50, emaSlow: 200, minAdxToTrade: 25, stopLossAtrMultiplier: 1.5,
    trailingAtrMultiplier: 2, breakEvenAtR: 1, trailStartAtR: 3, timeStopBars: 8, paperStopSlippageBps: 5,
    minProfitForTimeStopR: 0.5, breakoutLookback: 20, requireMultiTimeframeConfirm: true,
    entryTimeframe: "15m", trendTimeframe: "1h", higherTimeframe: "4h", version: "v2",
    chopIdealMax: 45, chopTransitionMax: 55, chopHardBlock: 61.8, adxTrendStart: 22, adxTrendValid: 28,
    adxStrong: 32, adxVeryStrong: 40, minDiSpread: 8, higherTimeframeMode: "not_against",
    entryModes: ["breakout_entry", "pullback_entry", "continuation_entry"], pullbackEmaBandAtr: 0.5,
    pullbackConfirmLookback: 5, pullbackInvalidationAtr: 0.2, continuationLookback: 8, microBreakLookback: 5,
    maxEntryExtensionAtr: 1.5, maxStopDistanceAtr: 2.2, minStopDistanceAtr: 1.2,
    breakoutMinStopAtr: 1.3, pullbackMinStopAtr: 1.0, continuationMinStopAtr: 1.2,
    structureBreakBufferAtr: 0.25, structureReversalConfirmBars: 2, softExitMinBars: 2,
    defensiveStructureBufferAtr: 0.25, minDefensiveStopDistanceAtr: 0.5, softBreakEvenAtR: 1,
    realBreakEvenAtR: 1.5, lockProfitAtR: 2.5, defensiveTrailingAtrMultiplier: 1.2, reversalConfirmBars: 2, reentryCooldownBars: 6
  };
  const STRICTNESS_PRESETS = {
    conservative: { chopIdealMax: 45, chopTransitionMax: 52, chopHardBlock: 61.8, adxTrendStart: 25, adxTrendValid: 30, adxStrong: 35, higherTimeframeMode: "strict_align", maxEntryExtensionAtr: 1.2, riskPerTrade: 0.01 },
    standard: { chopIdealMax: 45, chopTransitionMax: 55, chopHardBlock: 61.8, adxTrendStart: 22, adxTrendValid: 28, adxStrong: 32, higherTimeframeMode: "not_against", maxEntryExtensionAtr: 1.5, minStopDistanceAtr: 1.2, riskPerTrade: 0.01 },
    sensitive: { chopIdealMax: 48, chopTransitionMax: 58, chopHardBlock: 65, adxTrendStart: 20, adxTrendValid: 25, adxStrong: 30, higherTimeframeMode: "not_against", maxEntryExtensionAtr: 1.8, riskPerTrade: 0.005 }
  };
  const V3_DEFAULTS = {
    experimentId: "V3_STD_20260922_A", gradeAThreshold: 82, gradeBThreshold: 74,
    gradeARiskMultiplier: 1, gradeBRiskMultiplier: 0.5, htfStrongAdx: 30, htfMildPenalty: 5,
    highQualityPullbackScore: 15, breakoutCompressionBars: 6, continuationCompressionBars: 5,
    pullbackStopBuffer: 0.5, minimumEffectiveStopAtr: 1, minimumEffectiveStopBps: 20,
    netBreakEvenAtR: 1.5, lockProfitR: 0.8, minTrailingDistanceAtr: 0.8,
    maxAllowedCostR: 0.15, minimumPotentialR: 1.8, maxEntriesPerTrend: 2,
    reentryMinBars: 3, reentryMaxBars: 6, shadowComparison: true
  };
  const V3_PRESETS = {
    conservative: { gradeAThreshold: 86, gradeBThreshold: 78, gradeBRiskMultiplier: 0.4, htfMildPenalty: 8, highQualityPullbackScore: 17, minimumPotentialR: 2, maxAllowedCostR: 0.12, riskPerTrade: 0.01 },
    standard: { gradeAThreshold: 82, gradeBThreshold: 74, gradeBRiskMultiplier: 0.5, htfMildPenalty: 5, highQualityPullbackScore: 15, minimumPotentialR: 1.8, maxAllowedCostR: 0.15, riskPerTrade: 0.01 },
    sensitive: { gradeAThreshold: 78, gradeBThreshold: 70, gradeBRiskMultiplier: 0.4, htfMildPenalty: 3, highQualityPullbackScore: 13, minimumPotentialR: 1.5, maxAllowedCostR: 0.12, riskPerTrade: 0.005 }
  };
  const V3_EFFECTIVE_KEYS = new Set([
    "leverage", "allowWeekendOpen", "riskPerTrade", "maxPositionRatio", "maxDailyLossRatio", "maxConsecutiveLosses", "cooldownHoursAfterLossLimit",
    "atrPeriod", "adxPeriod", "chopPeriod", "emaFast", "emaMid", "emaSlow", "stopLossAtrMultiplier", "trailingAtrMultiplier", "trailStartAtR", "paperStopSlippageBps", "breakoutLookback",
    "entryTimeframe", "trendTimeframe", "higherTimeframe", "chopIdealMax", "chopTransitionMax", "chopHardBlock", "adxTrendStart", "adxTrendValid", "adxStrong", "adxVeryStrong", "minDiSpread",
    "higherTimeframeMode", "entryModes", "pullbackEmaBandAtr", "pullbackConfirmLookback", "pullbackInvalidationAtr", "continuationLookback", "microBreakLookback", "maxEntryExtensionAtr",
    "maxStopDistanceAtr", "minStopDistanceAtr", "breakoutMinStopAtr", "pullbackMinStopAtr", "continuationMinStopAtr", "structureBreakBufferAtr", "structureReversalConfirmBars", "softExitMinBars",
    "defensiveStructureBufferAtr", "minDefensiveStopDistanceAtr", "lockProfitAtR", "defensiveTrailingAtrMultiplier", "reversalConfirmBars",
    ...Object.keys(V3_DEFAULTS)
  ]);
  const labels = {
    enabled: "启用趋势策略", leverage: "杠杆（最高 10）", allowWeekendOpen: "允许周末开新仓", weekendMode: "周末保护模式",
    weekendExitHourUTC: "周五保护开始（UTC 小时）", riskPerTrade: "单笔风险比例（0.01=1%）", maxPositionRatio: "最大保证金比例",
    maxDailyLossRatio: "日亏损限制比例", maxConsecutiveLosses: "连续亏损次数", cooldownHoursAfterLossLimit: "亏损暂停小时",
    atrPeriod: "ATR 周期", adxPeriod: "ADX 周期", chopPeriod: "CHOP 周期", emaFast: "EMA 快线", emaMid: "EMA 中线",
    emaSlow: "EMA 慢线", minAdxToTrade: "最低 ADX", stopLossAtrMultiplier: "初始止损 ATR 倍数",
    trailingAtrMultiplier: "移动止盈 ATR 倍数", breakEvenAtR: "保本启动 R", trailStartAtR: "移动止盈启动 R",
    timeStopBars: "时间止损 K 线数", minProfitForTimeStopR: "时间止损最低 R", breakoutLookback: "突破回看 K 线数", paperStopSlippageBps: "Paper 止损滑点 (bps)",
    requireMultiTimeframeConfirm: "要求多周期确认", entryTimeframe: "入场周期", trendTimeframe: "趋势周期", higherTimeframe: "高周期",
    version: "策略版本", chopIdealMax: "CHOP 优质上限", chopTransitionMax: "CHOP 过渡上限", chopHardBlock: "CHOP 强阻断",
    adxTrendStart: "ADX 启动", adxTrendValid: "ADX 有效", adxStrong: "ADX 强趋势", adxVeryStrong: "ADX 极强趋势", minDiSpread: "最低 DI 差值",
    higherTimeframeMode: "多周期确认", entryModes: "入场模式", pullbackEmaBandAtr: "回踩 EMA 带宽 ATR", pullbackConfirmLookback: "回踩确认回看",
    pullbackInvalidationAtr: "回踩失效 ATR", continuationLookback: "延续结构回看", microBreakLookback: "微结构突破回看",
    maxEntryExtensionAtr: "最大追单距离 ATR", maxStopDistanceAtr: "最大止损距离 ATR", minStopDistanceAtr: "标准最小止损 ATR",
    breakoutMinStopAtr: "突破入场最小止损 ATR", pullbackMinStopAtr: "回踩入场最小止损 ATR", continuationMinStopAtr: "延续入场最小止损 ATR",
    structureBreakBufferAtr: "结构反转缓冲 ATR", structureReversalConfirmBars: "结构反转确认 K 线", softExitMinBars: "软退出最短观察 K 线",
    defensiveStructureBufferAtr: "防守结构止损缓冲 ATR", minDefensiveStopDistanceAtr: "防守止损最小距离 ATR",
    softBreakEvenAtR: "软保本启动 R", realBreakEvenAtR: "真实保本启动 R", lockProfitAtR: "锁定盈利启动 R", defensiveTrailingAtrMultiplier: "防守移动止盈 ATR", reversalConfirmBars: "反转确认 K 线", reentryCooldownBars: "再入场冷却 K 线",
    experimentId: "实验 ID", gradeAThreshold: "Grade A 分数", gradeBThreshold: "Grade B 分数", gradeARiskMultiplier: "A 级风险倍率", gradeBRiskMultiplier: "B 级风险倍率",
    htfStrongAdx: "4H 强趋势 ADX", htfMildPenalty: "4H 轻微反向扣分", highQualityPullbackScore: "高质量回踩分", breakoutCompressionBars: "突破压缩 K 线", continuationCompressionBars: "延续压缩 K 线",
    pullbackStopBuffer: "回踩止损缓冲 ATR", minimumEffectiveStopAtr: "最小有效止损 ATR", minimumEffectiveStopBps: "最小有效止损 bps", netBreakEvenAtR: "净保本启动 R", lockProfitR: "锁定利润 R", minTrailingDistanceAtr: "Trailing 最小距离 ATR",
    maxAllowedCostR: "最大允许 Cost R", minimumPotentialR: "最小 Potential R", maxEntriesPerTrend: "单趋势最多入场", reentryMinBars: "再入场最少等待 K 线", reentryMaxBars: "再入场观察上限 K 线", shadowComparison: "启用 V2 Shadow 对照"
  };
  mount.innerHTML = `
    <div class="block-head">
      <div><div class="block-title" id="trendOnlyPanelTitle">Trend Only 参数</div><div class="config-section-note">趋势过滤单仓 · 无 DCA · UTC 周末默认禁开</div></div>
      <div><button class="ghost" id="trendRestoreDefaults" type="button">恢复推荐参数</button></div>
    </div>
    <div class="strategy-context" id="trendV1Warning" style="margin-bottom:12px;">
      <span>当前账户正在使用 Trend Only V1。V1 过滤更严格，容易长时间不开仓。建议切换到 Trend Only V2，V2 支持回踩入场、延续入场和信号回放。<small id="trendUpgradeStatus" style="display:block;margin-top:6px;"></small></span>
      <button class="ghost" id="trendUpgradeV2" type="button">一键升级到 Trend Only V2</button>
    </div>
    <div class="config-section">
      <div class="config-section-head"><div class="config-section-title">行情、仓位与风控</div><div class="config-section-note">主配置页保存会同时保存以下参数。</div></div>
      <label id="trendStrictnessWrap">策略严格度
        <select id="trendStrictness"><option value="conservative">稳健模式</option><option value="standard">标准模式</option><option value="sensitive">灵敏模式（Paper 推荐）</option><option value="custom">自定义</option></select>
      </label>
      <div class="smart-form-grid" id="trendOnlyFields"></div>
    </div>
    <div class="config-section">
      <div class="config-section-head"><div class="config-section-title">当前趋势状态</div><div class="config-section-note" id="trendOnlyStatusMessage">等待状态更新</div></div>
      <div class="data-list" id="trendOnlyStatus"></div>
      <div class="left-note" id="trendOnlyReasons">暂无信号原因</div>
    </div>
    <div class="left-note" id="trendOnlyActionHint">趋势操作已合并到底部操作栏。</div>`;
  const fieldRoot = document.getElementById("trendOnlyFields");
  const inputs = {};
  let activeStrategyType = "classic";
  let draftStrategyType = document.getElementById("strategyType")?.value || "classic";
  function setStrategyContext(activeType, draftType = document.getElementById("strategyType")?.value) {
    activeStrategyType = activeType || activeStrategyType;
    draftStrategyType = draftType || draftStrategyType;
    const pending = activeStrategyType !== draftStrategyType;
    const title = document.getElementById("trendOnlyPanelTitle");
    if (title && ["trend_only_v1", "trend_only_v2", "trend_only_v3"].includes(draftStrategyType)) {
      const name = draftStrategyType === "trend_only_v3" ? "Trend Only V3" : draftStrategyType === "trend_only_v2" ? "Trend Only V2" : "Trend Only V1";
      title.textContent = `${name} 参数（${pending ? "待保存" : "当前生效"}）`;
    }
    const warning = document.getElementById("trendV1Warning");
    if (warning) warning.hidden = activeStrategyType !== "trend_only_v1";
  }
  function setConfig(config = {}) {
    const selectedType = draftStrategyType = document.getElementById("strategyType")?.value || draftStrategyType;
    const selectedV2 = selectedType === "trend_only_v2", selectedV3 = selectedType === "trend_only_v3";
    const activeDefaults = selectedV3 ? { ...DEFAULTS, ...V3_DEFAULTS, version: "v3" } : DEFAULTS;
    const merged = { ...activeDefaults, ...config };
    fieldRoot.replaceChildren();
    for (const key of Object.keys(inputs)) delete inputs[key];
    const simpleKeys = new Set(selectedV3
      ? ["version", "leverage", "riskPerTrade", "allowWeekendOpen", "shadowComparison"]
      : ["version", "leverage", "riskPerTrade", "allowWeekendOpen", "entryModes"]);
    const v2Only = new Set(["version", "chopIdealMax", "chopTransitionMax", "chopHardBlock", "adxTrendStart", "adxTrendValid", "adxStrong", "adxVeryStrong", "minDiSpread", "higherTimeframeMode", "entryModes", "pullbackEmaBandAtr", "pullbackConfirmLookback", "pullbackInvalidationAtr", "continuationLookback", "microBreakLookback", "maxEntryExtensionAtr", "maxStopDistanceAtr", "minStopDistanceAtr", "breakoutMinStopAtr", "pullbackMinStopAtr", "continuationMinStopAtr", "structureBreakBufferAtr", "structureReversalConfirmBars", "softExitMinBars", "defensiveStructureBufferAtr", "minDefensiveStopDistanceAtr", "softBreakEvenAtR", "realBreakEvenAtR", "lockProfitAtR", "defensiveTrailingAtrMultiplier", "reversalConfirmBars", "reentryCooldownBars"]);
    const v3Only = new Set(Object.keys(V3_DEFAULTS));
    setStrategyContext(activeStrategyType, selectedType);
    document.getElementById("trendStrictnessWrap").hidden = !(selectedV2 || selectedV3);
    for (const [key, fallback] of Object.entries(activeDefaults)) {
      if (selectedV3 && key !== "version" && !V3_EFFECTIVE_KEYS.has(key)) continue;
      const label = document.createElement("label"); label.textContent = labels[key] || key;
      if (!simpleKeys.has(key)) label.classList.add("trend-advanced-field");
      if (v2Only.has(key) && !(selectedV2 || selectedV3)) label.hidden = true;
      if (v3Only.has(key) && !selectedV3) label.hidden = true;
      let input;
      if (key === "entryModes") {
        input = document.createElement("select");
        for (const [value, text] of [["hybrid", "混合（突破 / 回踩 / 延续）"], ["breakout_entry", "仅突破"], ["pullback_entry", "仅回踩"], ["continuation_entry", "仅延续"]]) {
          const option = document.createElement("option"); option.value = value; option.textContent = text; input.append(option);
        }
        input.value = Array.isArray(merged[key]) && merged[key].length === 3 ? "hybrid" : merged[key]?.[0] || "hybrid";
      } else if (key === "higherTimeframeMode") {
        input = document.createElement("select");
        for (const [value, text] of [["not_against", "高周期不反向（推荐）"], ["strict_align", "三周期严格同向"], ["off", "关闭（仅 Paper）"]]) { const option = document.createElement("option"); option.value = value; option.textContent = text; input.append(option); }
        input.value = merged[key];
      } else if (key === "version") {
        input = document.createElement("input"); input.type = "text"; input.value = selectedV3 ? "Trend Only V3" : selectedV2 ? "Trend Only V2" : "Trend Only V1"; input.disabled = true;
      } else if (typeof fallback === "string" && key !== "weekendMode" && !key.endsWith("Timeframe")) {
        input = document.createElement("input"); input.type = "text"; input.value = merged[key];
      } else if (key === "weekendMode" || key.endsWith("Timeframe")) {
        input = document.createElement("select");
        const options = key === "weekendMode" ? ["no_new_position", "force_flat_before_weekend"] : ["1m", "5m", "15m", "1h", "4h", "1d"];
        for (const item of options) {
          const option = document.createElement("option"); option.value = item;
          option.textContent = item === "no_new_position" ? "周末只管理已有仓位" : item === "force_flat_before_weekend" ? "周五进入平仓保护" : item;
          input.append(option);
        }
        input.value = merged[key];
      } else {
        input = document.createElement("input"); input.type = typeof fallback === "boolean" ? "checkbox" : "number";
        if (input.type === "checkbox") input.checked = !!merged[key];
        else { input.step = "any"; input.value = merged[key]; if (key === "leverage") { input.min = "1"; input.max = "10"; } }
      }
      input.id = `trendOnly_${key}`; inputs[key] = input; label.append(input); fieldRoot.append(label);
    }
    const presets = selectedV3 ? V3_PRESETS : STRICTNESS_PRESETS;
    const presetName = Object.entries(presets).find(([, preset]) => Object.entries(preset).every(([key, value]) => merged[key] === value))?.[0] || "custom";
    document.getElementById("trendStrictness").value = presetName;
  }
  function getConfig() {
    const result = {};
    for (const [key, input] of Object.entries(inputs)) {
      if (key === "entryModes") result[key] = input.value === "hybrid" ? ["breakout_entry", "pullback_entry", "continuation_entry"] : [input.value];
      else if (key === "version") result[key] = draftStrategyType === "trend_only_v3" ? "v3" : draftStrategyType === "trend_only_v2" ? "v2" : "v1";
      else result[key] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
    }
    return result;
  }
  function setVisible(visible) { mount.hidden = !visible; }
  async function api(endpoint, body) {
    const response = await fetch(endpoint, body ? { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) } : { credentials: "same-origin" });
    const data = await response.json(); if (!response.ok || !data.ok) throw Error(data.error || "请求失败"); return data;
  }
  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
  function render(data) {
    const trend = data.state || {}, position = trend.position, indicators = trend.indicators || {}, signal = trend.signal || {};
    const view = window.StrategyView?.buildTrendView({ name: data.accountName, strategyType: data.strategyType, trendOnlyConfig: data.config }, { trendOnly: trend, lastAction: data.lastAction, updatedAt: "" });
    document.getElementById("trendOnlyStatusMessage").textContent = data.active ? (view?.nextAction || data.lastAction || "等待趋势") : "当前账户尚未启用 Trend Only";
    const pairs = [["市场阶段", view?.market || "行情数据不足"], ["原始趋势方向", view?.direction || "无方向"], ["交易方向", signal.tradeDirection === "long" ? "准备做多" : signal.tradeDirection === "short" ? "准备做空" : "暂不交易"], ["周末过滤", view?.weekend || "-"],
      ["CHOP", indicators.chop ?? "-"], ["ADX", indicators.adx ?? "-"], ["ATR", indicators.atr ?? "-"], ["趋势评分", signal.score ?? 0],
      ["当前 Net R", position?.floatingNetR ?? position?.netR ?? "-"], ["当前止损价", position?.currentStopLossPrice ?? "-"], ["订单状态", trend.pendingOrder?.status || "无待确认订单"]];
    document.getElementById("trendOnlyStatus").innerHTML = pairs.map(([key, value]) => `<div class="data-row"><div class="data-k">${esc(key)}</div><div class="data-v">${esc(value)}</div></div>`).join("");
    document.getElementById("trendOnlyReasons").textContent = (signal.reasons || []).join("；") || "暂无信号原因";
    const upgradeButton = document.getElementById("trendUpgradeV2"), upgradeStatus = document.getElementById("trendUpgradeStatus");
    if (data.strategyType === "trend_only_v1") {
      upgradeButton.disabled = !!(position || trend.pendingOrder);
      upgradeStatus.textContent = position ? "当前有趋势仓位，平仓后才能升级。" : trend.pendingOrder ? "订单尚未确认，暂不能升级。" : data.running ? "需要先停止趋势监控才能升级；点击后可确认停止并继续升级。" : "当前可以安全升级。";
    }
  }
  async function refresh() {
    const data = await api("/api/trend-only");
    const selector = document.getElementById("strategyType");
    setStrategyContext(data.strategyType, selector?.value || data.strategyType);
    if (!Object.keys(inputs).length) setConfig(window.__pendingTrendOnlyConfig || data.config);
    const visible = selector ? ["trend_only_v1", "trend_only_v2", "trend_only_v3"].includes(selector.value) : data.active;
    setVisible(visible);
    if (visible) render(data);
    return data;
  }
  function report(error) { document.getElementById("trendOnlyStatusMessage").textContent = error.message || String(error); }
  document.getElementById("trendRestoreDefaults").onclick = () => setConfig(draftStrategyType === "trend_only_v3" ? { ...DEFAULTS, ...V3_DEFAULTS, version: "v3" } : DEFAULTS);
  document.getElementById("trendStrictness").onchange = event => {
    const name = event.target.value, preset = (draftStrategyType === "trend_only_v3" ? V3_PRESETS : STRICTNESS_PRESETS)[name];
    if (!preset) return;
    if (name === "sensitive" && document.getElementById("tradeMode")?.value === "live" && !window.confirm("灵敏模式会放宽过滤。Live 使用前需要再次确认，是否继续？")) {
      event.target.value = "custom"; return;
    }
    for (const [key, value] of Object.entries(preset)) {
      const input = inputs[key]; if (!input) continue;
      if (input.type === "checkbox") input.checked = !!value; else input.value = value;
    }
  };
  document.getElementById("trendUpgradeV2").onclick = async () => {
    try {
      const data = await refresh();
      if (data.state?.position) throw Error("当前有趋势仓位，平仓后才能升级。");
      if (data.state?.pendingOrder) throw Error("订单尚未确认，暂不能升级。");
      const selector = document.getElementById("strategyType"); if (selector) selector.value = "trend_only_v2";
      setConfig({ ...DEFAULTS, ...(data.config || {}), version: "v2", leverage: 10 });
      if (typeof window.switchTrendStrategy !== "function") throw Error("策略切换模块尚未就绪，请刷新页面后重试");
      await window.switchTrendStrategy("trend_only_v2");
    } catch (error) { report(error); }
  };
  async function confirmLive() {
    try {
      const data = await refresh(), preview = data.state.preview;
      if (!preview) throw Error("当前没有可确认的趋势信号");
      if (!window.confirm(`${data.accountName}：确认当前 Live 趋势信号开仓？数量 ${preview.qty}，风险预算 ${preview.riskAmount}。`)) return;
      await api("/api/trend-only/confirm", { accountId: data.accountId, signalTime: preview.signal.signalTime, configHash: preview.configHash, confirmLive: true }); await refresh();
    } catch (error) { report(error); }
  }
  async function closePosition() {
    try {
      const data = await refresh(); if (!data.state.position) throw Error("当前没有趋势仓位");
      if (!window.confirm(`确认平掉 ${data.accountName} 的全部趋势仓位？`)) return;
      await api("/api/trend-only/close", { accountId: data.accountId }); await refresh();
    } catch (error) { report(error); }
  }
  window.TrendOnlyPanel = { defaults: DEFAULTS, getConfig, setConfig, setVisible, setStrategyContext, refresh, confirmLive, closePosition };
  setConfig(window.__pendingTrendOnlyConfig || DEFAULTS);
  setVisible(["trend_only_v1", "trend_only_v2", "trend_only_v3"].includes(document.getElementById("strategyType")?.value));
  refresh().catch(report);
  setInterval(() => { if (!document.hidden && !mount.hidden) refresh().catch(report); }, 5000);
  document.dispatchEvent(new CustomEvent("trend-only-panel-ready"));
})();
