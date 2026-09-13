(() => {
  "use strict";
  const mount = document.getElementById("trendOnlyBlock");
  if (!mount) return;
  const DEFAULTS = {
    enabled: true, leverage: 10, allowWeekendOpen: false, weekendMode: "no_new_position", weekendExitHourUTC: 20,
    riskPerTrade: 0.01, maxPositionRatio: 0.1, maxDailyLossRatio: 0.03, maxConsecutiveLosses: 2,
    cooldownHoursAfterLossLimit: 12, atrPeriod: 14, adxPeriod: 14, chopPeriod: 14, emaFast: 20,
    emaMid: 50, emaSlow: 200, minAdxToTrade: 25, maxChopToTrade: 45, stopLossAtrMultiplier: 1.5,
    trailingAtrMultiplier: 2, breakEvenAtR: 1, trailStartAtR: 3, timeStopBars: 8,
    minProfitForTimeStopR: 0.5, breakoutLookback: 20, requireMultiTimeframeConfirm: true,
    entryTimeframe: "15m", trendTimeframe: "1h", higherTimeframe: "4h"
  };
  const labels = {
    enabled: "启用趋势策略", leverage: "杠杆（最高 10）", allowWeekendOpen: "允许周末开新仓", weekendMode: "周末保护模式",
    weekendExitHourUTC: "周五保护开始（UTC 小时）", riskPerTrade: "单笔风险比例（0.01=1%）", maxPositionRatio: "最大保证金比例",
    maxDailyLossRatio: "日亏损限制比例", maxConsecutiveLosses: "连续亏损次数", cooldownHoursAfterLossLimit: "亏损暂停小时",
    atrPeriod: "ATR 周期", adxPeriod: "ADX 周期", chopPeriod: "CHOP 周期", emaFast: "EMA 快线", emaMid: "EMA 中线",
    emaSlow: "EMA 慢线", minAdxToTrade: "最低 ADX", maxChopToTrade: "最高 CHOP", stopLossAtrMultiplier: "初始止损 ATR 倍数",
    trailingAtrMultiplier: "移动止盈 ATR 倍数", breakEvenAtR: "保本启动 R", trailStartAtR: "移动止盈启动 R",
    timeStopBars: "时间止损 K 线数", minProfitForTimeStopR: "时间止损最低 R", breakoutLookback: "突破回看 K 线数",
    requireMultiTimeframeConfirm: "要求多周期确认", entryTimeframe: "入场周期", trendTimeframe: "趋势周期", higherTimeframe: "高周期"
  };
  mount.innerHTML = `
    <div class="block-head">
      <div><div class="block-title">Trend Only V1 参数</div><div class="config-section-note">趋势过滤单仓 · 无 DCA · UTC 周末默认禁开</div></div>
      <button class="ghost" id="trendRestoreDefaults" type="button">恢复推荐参数</button>
    </div>
    <div class="config-section">
      <div class="config-section-head"><div class="config-section-title">行情、仓位与风控</div><div class="config-section-note">主配置页保存会同时保存以下参数。</div></div>
      <div class="smart-form-grid" id="trendOnlyFields"></div>
    </div>
    <div class="config-section">
      <div class="config-section-head"><div class="config-section-title">当前趋势状态</div><div class="config-section-note" id="trendOnlyStatusMessage">等待状态更新</div></div>
      <div class="data-list" id="trendOnlyStatus"></div>
      <div class="left-note" id="trendOnlyReasons">暂无信号原因</div>
    </div>
    <div class="sticky-buttons">
      <button class="save" id="trendOnlySave" type="button">保存并启用 Trend Only V1</button>
      <button class="start" id="trendOnlyConfirm" type="button">确认本次 Live 开仓</button>
      <button class="stop" id="trendOnlyClose" type="button">平掉趋势仓位</button>
    </div>`;
  const fieldRoot = document.getElementById("trendOnlyFields");
  const inputs = {};
  function setConfig(config = {}) {
    const merged = { ...DEFAULTS, ...config };
    fieldRoot.replaceChildren();
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      const label = document.createElement("label"); label.textContent = labels[key] || key;
      let input;
      if (key === "weekendMode" || key.endsWith("Timeframe")) {
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
  }
  function getConfig() {
    const result = {};
    for (const [key, input] of Object.entries(inputs)) result[key] = input.type === "checkbox" ? input.checked : input.type === "number" ? Number(input.value) : input.value;
    return result;
  }
  function setVisible(visible) { mount.hidden = !visible; }
  async function api(endpoint, body) {
    const response = await fetch(endpoint, body ? { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body) } : { credentials: "same-origin" });
    const data = await response.json(); if (!response.ok || !data.ok) throw Error(data.error || "请求失败"); return data;
  }
  function render(data) {
    const trend = data.state || {}, position = trend.position, indicators = trend.indicators || {}, signal = trend.signal || {};
    const view = window.StrategyView?.buildTrendView({ name: data.accountName, trendOnlyConfig: data.config }, { trendOnly: trend, lastAction: data.lastAction, updatedAt: "" });
    document.getElementById("trendOnlyStatusMessage").textContent = data.active ? (view?.nextAction || data.lastAction || "等待趋势") : "当前账户尚未启用 Trend Only V1";
    const pairs = [["市场状态", view?.market || "行情数据不足"], ["趋势方向", view?.direction || "无方向"], ["周末过滤", view?.weekend || "-"],
      ["CHOP", indicators.chop ?? "-"], ["ADX", indicators.adx ?? "-"], ["ATR", indicators.atr ?? "-"], ["趋势评分", signal.score ?? 0],
      ["当前 R", position?.rMultiple ?? "-"], ["当前止损价", position?.currentStopLossPrice ?? "-"], ["订单状态", trend.pendingOrder?.status || "无待确认订单"]];
    document.getElementById("trendOnlyStatus").innerHTML = pairs.map(([key, value]) => `<div class="data-row"><div class="data-k">${key}</div><div class="data-v">${value}</div></div>`).join("");
    document.getElementById("trendOnlyReasons").textContent = (signal.reasons || []).join("；") || "暂无信号原因";
    document.getElementById("trendOnlyConfirm").disabled = data.paper || !data.active || !trend.preview || !!trend.pendingOrder || !!position;
    document.getElementById("trendOnlyClose").disabled = !data.active || !position;
  }
  async function refresh() {
    const data = await api("/api/trend-only");
    if (!Object.keys(inputs).length) setConfig(window.__pendingTrendOnlyConfig || data.config);
    const selector = document.getElementById("strategyType");
    const visible = selector ? selector.value === "trend_only_v1" : data.active;
    setVisible(visible);
    if (visible) render(data);
    return data;
  }
  function report(error) { document.getElementById("trendOnlyStatusMessage").textContent = error.message || String(error); }
  document.getElementById("trendRestoreDefaults").onclick = () => setConfig(DEFAULTS);
  document.getElementById("trendOnlySave").onclick = () => document.getElementById("saveBtn")?.click();
  document.getElementById("trendOnlyConfirm").onclick = async () => {
    try {
      const data = await refresh(), preview = data.state.preview;
      if (!preview) throw Error("当前没有可确认的趋势信号");
      if (!window.confirm(`${data.accountName}：确认当前 Live 趋势信号开仓？数量 ${preview.qty}，风险预算 ${preview.riskAmount}。`)) return;
      await api("/api/trend-only/confirm", { accountId: data.accountId, signalTime: preview.signal.signalTime, configHash: preview.configHash, confirmLive: true }); await refresh();
    } catch (error) { report(error); }
  };
  document.getElementById("trendOnlyClose").onclick = async () => {
    try {
      const data = await refresh(); if (!data.state.position) throw Error("当前没有趋势仓位");
      if (!window.confirm(`确认平掉 ${data.accountName} 的全部趋势仓位？`)) return;
      await api("/api/trend-only/close", { accountId: data.accountId }); await refresh();
    } catch (error) { report(error); }
  };
  window.TrendOnlyPanel = { defaults: DEFAULTS, getConfig, setConfig, setVisible, refresh };
  setConfig(window.__pendingTrendOnlyConfig || DEFAULTS);
  setVisible(document.getElementById("strategyType")?.value === "trend_only_v1");
  refresh().catch(report);
  setInterval(() => { if (!document.hidden && !mount.hidden) refresh().catch(report); }, 5000);
  document.dispatchEvent(new CustomEvent("trend-only-panel-ready"));
})();
