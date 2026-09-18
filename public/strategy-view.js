(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StrategyView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const value = (input, digits = 3) => Number.isFinite(Number(input)) ? Number(input).toFixed(digits) : "-";
  const replayBlockers = item => [item?.executionBlocker, ...(item?.blockers || [])].filter(Boolean).join("；");
  function replayFilterMatch(item, filter = "all") {
    const signalPermission = item?.signalPermission || item?.entryPermission || "blocked", decision = item?.finalDecision;
    return ({
      all: true, signal_allowed: signalPermission === "allowed", executable: item?.executionPermission === "allowed",
      strategy_blocked: signalPermission !== "allowed", execution_blocked: item?.executionPermission === "blocked",
      wait_pullback: signalPermission === "wait_pullback" || decision === "WAIT_PULLBACK",
      wait_breakout: signalPermission === "wait_breakout" || decision === "WAIT_BREAKOUT",
      wait_continuation: signalPermission === "wait_continuation" || decision === "WAIT_CONTINUATION",
      live_confirm: decision === "WAIT_LIVE_CONFIRM", account_conflict: decision === "ACCOUNT_CONFLICT",
      open_order: decision === "OPEN_ORDER_BLOCK", reentry: decision === "REENTRY_COOLDOWN",
      risk_lock: ["RISK_LOCK", "POST_FILL_RISK_LOCK"].includes(decision), unsupported: decision === "PLATFORM_UNSUPPORTED"
    })[filter] === true;
  }
  function summarizeReplay(items) {
    const all = Array.isArray(items) ? items.slice(0, 50) : [];
    const matches = (item, pattern) => pattern.test(replayBlockers(item));
    return {
      signalOpportunities: all.filter(item => item.signalPermission === "allowed" || item.entryPermission === "allowed").length,
      executable: all.filter(item => item.executionPermission === "allowed").length,
      submitted: all.filter(item => item.orderSubmitted || item.finalDecision === "ORDER_SUBMITTED").length,
      filled: all.filter(item => item.orderFilled || item.finalDecision === "ORDER_FILLED").length,
      allowed: all.filter(item => item.signalPermission === "allowed" || item.entryPermission === "allowed").length,
      pullback: all.filter(item => item.entryPermission === "wait_pullback").length,
      breakout: all.filter(item => item.entryPermission === "wait_breakout").length,
      continuation: all.filter(item => item.entryPermission === "wait_continuation").length,
      extended: all.filter(item => matches(item, /远离 EMA20|不追单/)).length,
      chop: all.filter(item => matches(item, /CHOP/)).length,
      higher: all.filter(item => matches(item, /高周期|4H/)).length,
      risk: all.filter(item => matches(item, /risk_lock|风控|日亏损|连续亏损|暂停|仓位|pendingOrder|订单结果未知/i)).length
    };
  }
  function summarizeReplayWindow(items, hours, now = Date.now()) {
    const cutoff = now - Number(hours) * 3600000;
    const all = (Array.isArray(items) ? items : []).filter(item => Number(item.time) >= cutoff && Number(item.time) <= now);
    const blockers = item => replayBlockers(item);
    const modes = {};
    for (const mode of ["breakout_entry", "pullback_entry", "continuation_entry"]) {
      const rows = all.filter(item => item.entryMode === mode), exits = rows.filter(item => Number.isFinite(Number(item.realizedPnl)));
      modes[mode] = { signals: rows.length, executed: rows.filter(item => item.executionPermission === "allowed").length, filled: rows.filter(item => item.orderFilled || item.finalDecision === "ORDER_FILLED").length, wins: exits.filter(item => Number(item.realizedPnl) > 0).length, losses: exits.filter(item => Number(item.realizedPnl) < 0).length, avgR: exits.length ? exits.reduce((sum, item) => sum + Number(item.realizedR || 0), 0) / exits.length : 0, totalPnl: exits.reduce((sum, item) => sum + Number(item.realizedPnl || 0), 0) };
    }
    const exits = all.filter(item => Number.isFinite(Number(item.realizedPnl)));
    return {
      total: all.length,
      directionEstablished: all.filter(item => ["long", "short"].includes(item.directionRaw)).length,
      signalOpportunities: all.filter(item => item.signalPermission === "allowed" || item.entryPermission === "allowed").length,
      executable: all.filter(item => item.executionPermission === "allowed").length,
      submitted: all.filter(item => item.orderSubmitted || item.finalDecision === "ORDER_SUBMITTED").length,
      filled: all.filter(item => item.orderFilled || item.finalDecision === "ORDER_FILLED").length,
      profitableExits: exits.filter(item => Number(item.realizedPnl) > 0).length,
      losingExits: exits.filter(item => Number(item.realizedPnl) < 0).length,
      allowed: all.filter(item => item.signalPermission === "allowed" || item.entryPermission === "allowed").length,
      pullback: all.filter(item => item.entryPermission === "wait_pullback").length,
      breakout: all.filter(item => item.entryPermission === "wait_breakout").length,
      continuation: all.filter(item => item.entryPermission === "wait_continuation").length,
      chop: all.filter(item => /CHOP|震荡/.test(blockers(item))).length,
      adx: all.filter(item => /ADX|趋势强度/.test(blockers(item))).length,
      higher: all.filter(item => /高周期|4H|多周期/.test(blockers(item))).length,
      extended: all.filter(item => /远离 EMA20|不追单/.test(blockers(item))).length,
      risk: all.filter(item => /risk_lock|风控|日亏损|连续亏损|暂停|仓位|pendingOrder|订单结果未知/i.test(blockers(item))).length,
      modes
    };
  }
  function strictnessWarnings(items, now = Date.now()) {
    const all = Array.isArray(items) ? items : [], cutoff = now - 48 * 3600000;
    if (!all.length || Math.min(...all.map(item => Number(item.time) || now)) > cutoff) return [];
    const stats = summarizeReplayWindow(all, 48, now);
    if (!stats.total || stats.signalOpportunities > 0) return [];
    const warnings = ["过去 48 小时没有出现可开仓信号。请查看信号统计，可能是市场震荡，也可能是策略过滤过严。"];
    if (stats.adx / stats.total > 0.7) warnings.push("主要原因：趋势强度不足。");
    if (stats.chop / stats.total > 0.7) warnings.push("主要原因：震荡过滤过严或市场震荡。");
    if (stats.higher / stats.total > 0.5) warnings.push("主要原因：高周期确认过严。");
    if (stats.extended / stats.total > 0.5) warnings.push("主要原因：趋势已走远，系统等待回踩，不追单。");
    return warnings;
  }
  const yesNo = passed => passed ? "通过" : "未通过";
  function marketLabel(trend) {
    if (trend.weekendBlocked) return "周末禁止新开仓";
    return ({ trend: "趋势行情", strong_trend: "强趋势", trend_continuation: "趋势延续", trend_pullback: "趋势回踩", trend_breakout: "趋势启动", extended_no_chase: "趋势已走远，等待回踩", chop: "震荡过滤", unclear: "不明确行情", data_insufficient: "行情数据不足" })[trend.signal?.regime] || "行情数据不足";
  }
  function directionLabel(direction) {
    return ({ long: "做多趋势", short: "做空趋势", none: "无方向" })[direction] || "无方向";
  }
  function nextAction(trend, lastAction = "") {
    const pending = trend.pendingOrder;
    const position = trend.position;
    const executionActions = { MONITOR_STOPPED: "启动趋势监控后再判断", ACCOUNT_CONFLICT: "解除同账户合约冲突", OPEN_ORDER_BLOCK: "等待交易所挂单结束", REENTRY_COOLDOWN: "等待再入场冷却结束", WAIT_LIVE_CONFIRM: "等待本次 Live 开仓确认", WAIT_ENTRY_ALIGNMENT: "等待 15m 入场周期重新确认", RISK_LOCK: "解除风控锁定后再开仓", POST_FILL_RISK_LOCK: "成交后实际风险超限，已锁定新开仓", PLATFORM_UNSUPPORTED: "切换 Paper 或 Hyperliquid/Binance", READY_TO_OPEN: "执行条件已通过，准备开仓", ORDER_SUBMITTED: "订单已提交，等待交易所确认", ORDER_FILLED: "订单已成交，进入持仓保护", POSITION_MANAGED: "管理现有仓位与止损" };
    if (executionActions[trend.executionState]) return executionActions[trend.executionState];
    if (pending?.status === "unknown_order_state") return "订单结果未知，禁止重复下单";
    if (pending) return "订单处理中，等待交易所确认";
    if (position?.defensiveMode) return "防守模式";
    if (position?.trailingActive) return "移动止盈中";
    if (position?.breakEvenActivated) return "已保本，等待趋势延续";
    if (position) return "已开仓，等待 1R";
    if (trend.weekendBlocked) return "周末禁止新开仓";
    if (trend.signal?.entryPermission === "allowed") return "可以开仓";
    if (trend.signal?.entryPermission === "wait_pullback") return "等待回踩";
    if (trend.signal?.entryPermission === "wait_continuation") return "等待延续确认";
    if (trend.signal?.entryPermission === "wait_breakout") return "等待突破";
    if (/Live.*确认|二次确认/.test(lastAction)) return "Live 本次信号等待确认";
    if (/突破/.test((trend.signal?.reasons || []).join(" "))) return "等待突破";
    return "等待趋势";
  }
  function opportunityStatus(trend) {
    const signal = trend.signal || {}, d = signal.diagnostics || {};
    const executionLabels = {
      NO_SIGNAL: "无机会", WAIT_PULLBACK: "等待回踩", WAIT_BREAKOUT: "等待突破", WAIT_CONTINUATION: "等待延续",
      MONITOR_STOPPED: "监控已停止", ACCOUNT_CONFLICT: "账户冲突", OPEN_ORDER_BLOCK: "挂单阻断", REENTRY_COOLDOWN: "再入场冷却",
      WAIT_LIVE_CONFIRM: "等待 Live 确认", WAIT_ENTRY_ALIGNMENT: "等待 15m 重新确认", RISK_LOCK: "风控禁止", POST_FILL_RISK_LOCK: "成交后风险锁定", PLATFORM_UNSUPPORTED: "平台暂不支持", ORDER_SUBMITTED: "订单已提交",
      ORDER_FILLED: "订单已成交", POSITION_MANAGED: "持仓保护中", READY_TO_OPEN: "可执行开仓"
    };
    if (executionLabels[trend.executionState]) return executionLabels[trend.executionState];
    if (trend.riskLock || trend.pendingOrder || trend.weekendBlocked || Number(trend.pauseUntil) > Date.now() || trend.dailyLossLimitReached) return "风控禁止";
    if (signal.entryPermission === "allowed" || signal.regime === "trend") return "可开仓";
    if (signal.regime === "extended_no_chase") return "等待回踩";
    const causes = [];
    if (d.chop?.state === "BLOCK" || (d.chop && d.chop.state === undefined && !d.chop.passed)) causes.push("震荡");
    if (d.adx && !d.adx.passed) causes.push("ADX 弱");
    if (d.direction && d.direction.timeframePassed === false) causes.push("方向冲突");
    if (causes.length) return `无机会：${causes.join(" / ")}`;
    if (["long", "short"].includes(d.direction?.trendDirection) && !["long", "short"].includes(d.direction?.entryDirection)) return "观察中：1H 有方向，但 15m 未确认";
    if (signal.entryPermission === "wait_pullback") return "等待回踩";
    if (signal.entryPermission === "wait_breakout" || d.breakout?.passed === false) return "等待突破";
    if (signal.entryPermission === "wait_continuation") return "等待延续";
    return "无机会";
  }
  function diagnosticSummary(trend) {
    const signal = trend.signal || {}, d = signal.diagnostics || {}, blockers = d.finalBlockers || signal.blockers || signal.reasons || [];
    const trendDirection = d.direction?.trendDirection;
    if (["long", "short"].includes(trendDirection) && d.adx?.passed === false && d.chop?.label && /震荡|过渡/.test(d.chop.label)) {
      const chopZone = /过渡/.test(d.chop.label) ? "偏震荡" : d.chop.label.replace(/，.*$/, "").replace(/禁止交易$/, "");
      return `1H 出现${trendDirection === "long" ? "做多" : "做空"}趋势，但当前 ADX=${value(d.adx.value, 2)} 低于趋势强度阈值 ${value(d.adx.threshold, 0)}，且 CHOP=${value(d.chop.value, 2)} 处于${chopZone}区，未形成可交易信号。当前不属于系统故障，而是策略过滤导致不开仓。`;
    }
    if (!blockers.length) return signal.entryPermission === "allowed" || signal.regime === "trend" ? "全部条件通过，当前存在可执行机会。" : "策略正在等待新的已收盘 K 线。";
    return `不开仓原因：${blockers.join("；")}`;
  }
  function diagnosticRows(trend) {
    const signal = trend.signal || {}, d = signal.diagnostics || {}, entry = d.entry || {};
    const chopThreshold = typeof d.chop?.threshold === "object"
      ? `理想 < ${d.chop.threshold.ideal} / 过渡 < ${d.chop.threshold.transition} / 阻断 ≥ ${d.chop.threshold.hardBlock}`
      : `< ${d.chop?.threshold ?? "-"}`;
    const chopResult = d.chop?.state === "CONDITIONAL" ? "条件通过" : d.chop?.state === "BLOCK" ? "阻断" : yesNo(d.chop?.passed);
    return [
      ["机会状态", opportunityStatus(trend)],
      ["执行层状态", `${trend.executionState || "NO_SIGNAL"}｜${trend.executionReason || "等待执行判断"}`, ["RISK_LOCK", "PLATFORM_UNSUPPORTED", "ACCOUNT_CONFLICT"].includes(trend.executionState) ? "red" : ""],
      ["CHOP 判断", `当前 ${value(d.chop?.value, 2)}｜阈值 ${chopThreshold}｜${chopResult}｜${d.chop?.label || "数据不足"}`, d.chop?.state === "PASS" || (d.chop?.state === undefined && d.chop?.passed) ? "green" : "orange"],
      ["ADX 判断", `当前 ${value(d.adx?.value, 2)}｜阈值 ≥ ${value(d.adx?.threshold, 0)}｜${yesNo(d.adx?.passed)}｜${d.adx?.label || "数据不足"}`, d.adx?.passed ? "green" : "orange"],
      ["方向判断", `15m ${directionLabel(d.direction?.entryDirection)}｜1H ${directionLabel(d.direction?.trendDirection)}｜4H ${directionLabel(d.direction?.higherDirection)}｜${d.direction?.conflict || d.direction?.passed === false ? "存在冲突或未确认" : "方向通过"}`],
      ["入场条件", `突破 ${entry.breakout ? "是" : "否"}｜回踩确认 ${entry.pullback ? "是" : "否"}｜延续结构 ${entry.continuation ? "是" : "否"}｜远离 EMA20 ${entry.extended ? "是" : "否"}`],
      ["风控条件", `周末 ${trend.weekendBlocked ? "禁止" : "通过"}｜pendingOrder ${trend.pendingOrder ? "有" : "无"}｜risk_lock ${trend.riskLock ? "是" : "否"}｜连亏冷却 ${Number(trend.pauseUntil) > Date.now() ? "是" : "否"}｜日亏损限制 ${trend.dailyLossLimitReached ? "触发" : "未触发"}`]
    ];
  }
  function buildTrendView(cfg, st) {
    const trend = st.trendOnly || {};
    const signal = trend.signal || {};
    const indicators = trend.indicators || {};
    const position = trend.position;
    const pending = trend.pendingOrder;
    const blockers = signal.blockers?.length ? signal.blockers : (signal.reasons || []);
    const market = marketLabel(trend);
    const direction = directionLabel(position?.side || signal.directionRaw || signal.direction);
    const tradeDirection = signal.tradeDirection === "long" ? "准备做多" : signal.tradeDirection === "short" ? "准备做空" : "暂不交易";
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
      ["防守模式", position.defensiveMode ? "趋势衰减，进入防守模式" : "未启用", position.defensiveMode ? "orange" : ""],
      ["保护止损单状态", trend.stopSyncStatus || "not_required", trend.riskLock ? "red" : trend.stopSyncStatus === "synced" ? "green" : "orange"],
      ["保护止损健康", trend.stopProtectionHealth || "NOT_REQUIRED", trend.stopProtectionHealth === "HEALTHY" || trend.stopProtectionHealth === "NOT_REQUIRED" ? "green" : trend.stopProtectionHealth === "FAILED" ? "red" : "orange"],
      ["残留保护单", trend.orphanStopOrderCount ? `存在未确认撤销保护单：${trend.orphanStopOrderCount}` : "无", trend.orphanStopOrderCount ? "orange" : "green"],
      ["stopOrderId", trend.stopOrderId || "-"], ["保护止损价", value(trend.stopOrderPrice)], ["stopSyncStatus", trend.stopSyncStatus || "not_required", trend.riskLock ? "red" : ""],
      ["最近同步时间", (trend.stopLastSyncAt || trend.stopLastSyncedAt) ? new Date(trend.stopLastSyncAt || trend.stopLastSyncedAt).toLocaleString("zh-CN") : "-"],
      ["最高价 / 最低价", `${value(position.highestPriceSinceEntry)} / ${value(position.lowestPriceSinceEntry)}`]
    ] : [["趋势仓位", "无"], ["当前价格", value(st.currentPrice)], ["当前盈亏", `${value(st.pnl)} U`], ["收益率", `${value(st.roi)}%`]];
    const strategyRows = [
      ["策略", cfg.strategyType === "trend_only_v2" ? "Trend Only V2（突破 + 回踩 + 延续）" : "Trend Only V1（趋势过滤单仓）"],
      ["机会状态", opportunityStatus(trend)], ["市场阶段", market], ["原始趋势方向", direction], ["交易方向", tradeDirection], ["当前阻断原因", blockers.join("；") || "无"], ["周末过滤", weekend],
      ["CHOP", value(indicators.chop)], ["ADX", value(indicators.adx)], ["ATR", value(indicators.atr)], ["趋势评分", value(signal.score, 0)],
      ["1H 方向", directionLabel(indicators.trendDirection)], ["4H 方向", directionLabel(indicators.higherDirection)],
      ["入场模式", ({ breakout_entry: "突破", pullback_entry: "回踩", continuation_entry: "延续" })[signal.entryMode] || "等待"],
      ["趋势阶段记忆", trend.trendContext?.regime || "-"], ["订单状态", orderState, orderClass], ["clientOrderId", pending?.clientOrderId || "-", orderClass], ["当前建议动作", nextAction(trend, st.lastAction), orderClass]
    ];
    const rightStatusRows = [
      ["账户名称", cfg.name || "-"], ["当前价格", value(st.currentPrice)], ["策略", cfg.strategyType === "trend_only_v2" ? "Trend Only V2" : "Trend Only V1"], ["市场状态", market],
      ["趋势方向", direction], ["周末过滤", weekend], ["更新时间", st.updatedAt || "-"]
    ];
    const c = cfg.trendOnlyConfig || {};
    const rightRiskRows = [
      ["账户余额", st.balance ?? "-"], ["可用余额", st.available ?? "-"], ["单笔风险比例", `${value(Number(c.riskPerTrade) * 100, 2)}%`],
      ["日亏损限制", `${value(Number(c.maxDailyLossRatio) * 100, 2)}%`], ["连续亏损次数", trend.consecutiveLosses || 0],
      ["暂停至", pauseUntil], ["当前止损价", position ? value(position.currentStopLossPrice) : "-"],
      ["保护止损", trend.stopProtectionHealth || trend.stopSyncStatus || "NOT_REQUIRED", trend.riskLock ? "red" : ""], ["残留保护单", trend.orphanStopOrderCount ? `存在未确认撤销保护单：${trend.orphanStopOrderCount}` : "无", trend.orphanStopOrderCount ? "orange" : "green"], ["risk_lock", trend.riskLock ? trend.riskLockReason || "已锁定" : "未锁定", trend.riskLock ? "red" : "green"],
      ["pendingOrder", orderState, orderClass], ["错误信息", st.lastError || "-", st.lastError ? "red" : "muted"]
    ];
    return { market, direction, weekend, opportunityStatus: opportunityStatus(trend), diagnosticRows: diagnosticRows(trend), diagnosticSummary: diagnosticSummary(trend), nextAction: nextAction(trend, st.lastAction), positionRows, strategyRows, rightStatusRows, rightRiskRows };
  }
  return { marketLabel, directionLabel, nextAction, opportunityStatus, diagnosticSummary, diagnosticRows, summarizeReplay, summarizeReplayWindow, strictnessWarnings, replayFilterMatch, buildTrendView };
});
