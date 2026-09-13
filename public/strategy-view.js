(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StrategyView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const value = (input, digits = 3) => Number.isFinite(Number(input)) ? Number(input).toFixed(digits) : "-";
  function marketLabel(trend) {
    if (trend.weekendBlocked) return "周末禁止新开仓";
    return ({ trend: "趋势行情", chop: "震荡行情", unclear: "不明确行情", data_insufficient: "行情数据不足" })[trend.signal?.regime] || "行情数据不足";
  }
  function directionLabel(direction) {
    return ({ long: "做多趋势", short: "做空趋势", none: "无方向" })[direction] || "无方向";
  }
  function nextAction(trend, lastAction = "") {
    const pending = trend.pendingOrder;
    const position = trend.position;
    if (pending?.status === "unknown_order_state") return "订单结果未知，禁止重复下单";
    if (pending) return "订单处理中，等待交易所确认";
    if (position?.trailingActive) return "移动止盈中";
    if (position?.breakEvenActivated) return "已保本，等待趋势延续";
    if (position) return "已开仓，等待 1R";
    if (trend.weekendBlocked) return "周末禁止新开仓";
    if (/Live.*确认|二次确认/.test(lastAction)) return "Live 本次信号等待确认";
    if (/突破/.test((trend.signal?.reasons || []).join(" "))) return "等待突破";
    return "等待趋势";
  }
  function buildTrendView(cfg, st) {
    const trend = st.trendOnly || {};
    const signal = trend.signal || {};
    const indicators = trend.indicators || {};
    const position = trend.position;
    const pending = trend.pendingOrder;
    const market = marketLabel(trend);
    const direction = directionLabel(position?.side || signal.direction);
    const weekend = trend.weekendBlocked ? "周末禁止新开仓" : "当前允许交易";
    const orderState = pending?.status || "无待确认订单";
    const orderClass = pending?.status === "unknown_order_state" ? "red" : "";
    const pauseUntil = Number(trend.pauseUntil) > Date.now() ? new Date(trend.pauseUntil).toLocaleString("zh-CN") : "-";
    const positionRows = position ? [
      ["趋势仓位", "有"], ["方向", direction], ["入场价", value(position.entryPrice)],
      ["仓位数量", value(position.positionSize, 6)], ["仓位价值", `${value(position.positionValue)} U`],
      ["杠杆", `${position.leverage || cfg.leverage || 10} 倍`], ["当前 R", value(position.rMultiple)],
      ["初始止损价", value(position.initialStopLossPrice)], ["当前止损价", value(position.currentStopLossPrice)],
      ["保本状态", position.breakEvenActivated ? "已保本" : "未保本"], ["移动止盈", position.trailingActive ? "已启动" : "未启动"],
      ["最高价 / 最低价", `${value(position.highestPriceSinceEntry)} / ${value(position.lowestPriceSinceEntry)}`]
    ] : [["趋势仓位", "无"], ["当前价格", value(st.currentPrice)], ["当前盈亏", `${value(st.pnl)} U`], ["收益率", `${value(st.roi)}%`]];
    const strategyRows = [
      ["策略", "Trend Only V1（趋势过滤单仓）"], ["市场状态", market], ["趋势方向", direction], ["周末过滤", weekend],
      ["CHOP", value(indicators.chop)], ["ADX", value(indicators.adx)], ["ATR", value(indicators.atr)], ["趋势评分", value(signal.score, 0)],
      ["1H 方向", directionLabel(indicators.trendDirection)], ["4H 方向", directionLabel(indicators.higherDirection)],
      ["订单状态", orderState, orderClass], ["clientOrderId", pending?.clientOrderId || "-", orderClass], ["下一步动作", nextAction(trend, st.lastAction), orderClass]
    ];
    const rightStatusRows = [
      ["账户名称", cfg.name || "-"], ["当前价格", value(st.currentPrice)], ["策略", "Trend Only V1"], ["市场状态", market],
      ["趋势方向", direction], ["周末过滤", weekend], ["更新时间", st.updatedAt || "-"]
    ];
    const c = cfg.trendOnlyConfig || {};
    const rightRiskRows = [
      ["账户余额", st.balance ?? "-"], ["可用余额", st.available ?? "-"], ["单笔风险比例", `${value(Number(c.riskPerTrade) * 100, 2)}%`],
      ["日亏损限制", `${value(Number(c.maxDailyLossRatio) * 100, 2)}%`], ["连续亏损次数", trend.consecutiveLosses || 0],
      ["暂停至", pauseUntil], ["当前止损价", position ? value(position.currentStopLossPrice) : "-"],
      ["pendingOrder", orderState, orderClass], ["错误信息", st.lastError || "-", st.lastError ? "red" : "muted"]
    ];
    return { market, direction, weekend, nextAction: nextAction(trend, st.lastAction), positionRows, strategyRows, rightStatusRows, rightRiskRows };
  }
  return { marketLabel, directionLabel, nextAction, buildTrendView };
});
