(() => {
  "use strict";
  const mount = document.getElementById("trendOnlyBlock");
  if (!mount) return;
  const DEFAULTS = {
    enabled: true, leverage: 10, allowWeekendOpen: false, weekendMode: "no_new_position", weekendExitHourUTC: 20,
    riskPerTrade: 0.01, maxPositionRatio: 0.1, maxDailyLossRatio: 0.03, maxConsecutiveLosses: 2,
    cooldownHoursAfterLossLimit: 12, atrPeriod: 14, adxPeriod: 14, chopPeriod: 14, emaFast: 20,
    emaMid: 50, emaSlow: 200, minAdxToTrade: 25, stopLossAtrMultiplier: 1.5,
    trailingAtrMultiplier: 2, breakEvenAtR: 1, trailStartAtR: 3, timeStopBars: 8,
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
  const labels = {
    enabled: "启用趋势策略", leverage: "杠杆（最高 10）", allowWeekendOpen: "允许周末开新仓", weekendMode: "周末保护模式",
    weekendExitHourUTC: "周五保护开始（UTC 小时）", riskPerTrade: "单笔风险比例（0.01=1%）", maxPositionRatio: "最大保证金比例",
    maxDailyLossRatio: "日亏损限制比例", maxConsecutiveLosses: "连续亏损次数", cooldownHoursAfterLossLimit: "亏损暂停小时",
    atrPeriod: "ATR 周期", adxPeriod: "ADX 周期", chopPeriod: "CHOP 周期", emaFast: "EMA 快线", emaMid: "EMA 中线",
    emaSlow: "EMA 慢线", minAdxToTrade: "最低 ADX", stopLossAtrMultiplier: "初始止损 ATR 倍数",
    trailingAtrMultiplier: "移动止盈 ATR 倍数", breakEvenAtR: "保本启动 R", trailStartAtR: "移动止盈启动 R",
    timeStopBars: "时间止损 K 线数", minProfitForTimeStopR: "时间止损最低 R", breakoutLookback: "突破回看 K 线数",
    requireMultiTimeframeConfirm: "要求多周期确认", entryTimeframe: "入场周期", trendTimeframe: "趋势周期", higherTimeframe: "高周期",
    version: "策略版本", chopIdealMax: "CHOP 优质上限", chopTransitionMax: "CHOP 过渡上限", chopHardBlock: "CHOP 强阻断",
    adxTrendStart: "ADX 启动", adxTrendValid: "ADX 有效", adxStrong: "ADX 强趋势", adxVeryStrong: "ADX 极强趋势", minDiSpread: "最低 DI 差值",
    higherTimeframeMode: "多周期确认", entryModes: "入场模式", pullbackEmaBandAtr: "回踩 EMA 带宽 ATR", pullbackConfirmLookback: "回踩确认回看",
    pullbackInvalidationAtr: "回踩失效 ATR", continuationLookback: "延续结构回看", microBreakLookback: "微结构突破回看",
    maxEntryExtensionAtr: "最大追单距离 ATR", maxStopDistanceAtr: "最大止损距离 ATR", minStopDistanceAtr: "标准最小止损 ATR",
    breakoutMinStopAtr: "突破入场最小止损 ATR", pullbackMinStopAtr: "回踩入场最小止损 ATR", continuationMinStopAtr: "延续入场最小止损 ATR",
    structureBreakBufferAtr: "结构反转缓冲 ATR", structureReversalConfirmBars: "结构反转确认 K 线", softExitMinBars: "软退出最短观察 K 线",
    defensiveStructureBufferAtr: "防守结构止损缓冲 ATR", minDefensiveStopDistanceAtr: "防守止损最小距离 ATR",
    softBreakEvenAtR: "软保本启动 R", realBreakEvenAtR: "真实保本启动 R", lockProfitAtR: "锁定 1R 启动", defensiveTrailingAtrMultiplier: "防守移动止盈 ATR", reversalConfirmBars: "反转确认 K 线", reentryCooldownBars: "再入场冷却 K 线"
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
  function setConfig(config = {}) {
    const merged = { ...DEFAULTS, ...config };
    fieldRoot.replaceChildren();
    const simpleKeys = new Set(["version", "leverage", "riskPerTrade", "allowWeekendOpen", "entryModes"]);
    const v2Only = new Set(["version", "chopIdealMax", "chopTransitionMax", "chopHardBlock", "adxTrendStart", "adxTrendValid", "adxStrong", "adxVeryStrong", "minDiSpread", "higherTimeframeMode", "entryModes", "pullbackEmaBandAtr", "pullbackConfirmLookback", "pullbackInvalidationAtr", "continuationLookback", "microBreakLookback", "maxEntryExtensionAtr", "maxStopDistanceAtr", "minStopDistanceAtr", "breakoutMinStopAtr", "pullbackMinStopAtr", "continuationMinStopAtr", "structureBreakBufferAtr", "structureReversalConfirmBars", "softExitMinBars", "defensiveStructureBufferAtr", "minDefensiveStopDistanceAtr", "softBreakEvenAtR", "realBreakEvenAtR", "lockProfitAtR", "defensiveTrailingAtrMultiplier", "reversalConfirmBars", "reentryCooldownBars"]);
    const selectedV2 = document.getElementById("strategyType")?.value === "trend_only_v2";
    document.getElementById("trendOnlyPanelTitle").textContent = selectedV2 ? "Trend Only V2 参数" : "Trend Only V1 参数";
    document.getElementById("trendV1Warning").hidden = selectedV2;
    document.getElementById("trendStrictnessWrap").hidden = !selectedV2;
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const label = document.createElement("label"); label.textContent = labels[key] || key;
      if (!simpleKeys.has(key)) label.classList.add("trend-advanced-field");
      if (v2Only.has(key) && !selectedV2) label.hidden = true;
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
        input = document.createElement("input"); input.type = "text"; input.value = selectedV2 ? "Trend Only V2" : "Trend Only V1"; input.disabled = true;
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
    const presetName = Object.entries(STRICTNESS_PRESETS).find(([, preset]) => Object.entries(preset).every(([key, value]) => merged[key] === value))?.[0] || "custom";
    document.getElementById("trendStrictness").value = presetName;
  }
  function getConfig() {
    const result = {};
    for (const [key, input] of Object.entries(inputs)) {
      if (key === "entryModes") result[key] = input.value === "hybrid" ? ["breakout_entry", "pullback_entry", "continuation_entry"] : [input.value];
      else if (key === "version") result[key] = document.getElementById("strategyType")?.value === "trend_only_v2" ? "v2" : "v1";
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
      ["当前 R", position?.rMultiple ?? "-"], ["当前止损价", position?.currentStopLossPrice ?? "-"], ["订单状态", trend.pendingOrder?.status || "无待确认订单"]];
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
    if (!Object.keys(inputs).length) setConfig(window.__pendingTrendOnlyConfig || data.config);
    const selector = document.getElementById("strategyType");
    const visible = selector ? ["trend_only_v1", "trend_only_v2"].includes(selector.value) : data.active;
    setVisible(visible);
    if (visible) render(data);
    return data;
  }
  function report(error) { document.getElementById("trendOnlyStatusMessage").textContent = error.message || String(error); }
  document.getElementById("trendRestoreDefaults").onclick = () => setConfig(DEFAULTS);
  document.getElementById("trendStrictness").onchange = event => {
    const name = event.target.value, preset = STRICTNESS_PRESETS[name];
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
      if (data.running) {
        if (!window.confirm("需要先停止趋势监控才能升级。是否停止监控并继续升级？")) return;
        await api("/api/stop", {});
      }
      const selector = document.getElementById("strategyType"); if (selector) selector.value = "trend_only_v2";
      setConfig({ ...DEFAULTS, ...(data.config || {}), version: "v2", leverage: 10 });
      await api("/api/trend-only/config", { accountId: data.accountId, strategyType: "trend_only_v2", config: getConfig() });
      document.dispatchEvent(new Event("trend-only-upgraded"));
      location.reload();
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
  window.TrendOnlyPanel = { defaults: DEFAULTS, getConfig, setConfig, setVisible, refresh, confirmLive, closePosition };
  setConfig(window.__pendingTrendOnlyConfig || DEFAULTS);
  setVisible(["trend_only_v1", "trend_only_v2"].includes(document.getElementById("strategyType")?.value));
  refresh().catch(report);
  setInterval(() => { if (!document.hidden && !mount.hidden) refresh().catch(report); }, 5000);
  document.dispatchEvent(new CustomEvent("trend-only-panel-ready"));
})();
