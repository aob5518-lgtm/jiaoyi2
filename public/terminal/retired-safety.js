(function (A) {
 "use strict";
 const renderOverview = A.renderOverview;
 const control = A.control;

 // This console only presents risk handling for previously-created accounts.
 A.newAccount = () => A.error("旧策略已退出创建入口，请返回研究台。");
 A.setupCreation = () => {};
 A.control = action => {
  if (!["pause", "close", "cancel_pending"].includes(action)) {
   A.error("历史账户仅保留暂停、核对与安全退出操作。");
   return Promise.resolve();
  }
  return control(action);
 };
 A.renderOverview = () => {
  renderOverview();
  const actions = A.$("primaryActions");
  actions.replaceChildren(
   A.button("暂停旧账户新增风险", () => A.control("pause")),
   A.button("只读查看持仓与订单", () => A.detail("已有持仓与订单", {
    position: A.state.data.overview.position, orders: A.state.data.overview.orders
   }))
  );
 };
 A.renderStrategies = () => {
  A.$("strategyCards").replaceChildren();
  const box = A.$("strategySettings");
  box.replaceChildren(A.el("h2", "已有账户风险处理"), A.el("p", "此处仅处理历史账户的现有风险。新研究请返回研究台。"));
  A.rows(box, {
   "账户": A.state.data.account.name,
   "监控状态": A.state.data.overview.health.running ? "仍在运行" : "已停止",
   "当前持仓": A.state.data.overview.position ? "需核对保护" : "本地显示空仓",
   "未完成委托": A.state.data.overview.orders.length
  });
  box.append(A.button("暂停新增风险，保留既有保护", () => A.control("pause")));
 };
 A.renderSettings = () => {
  const data = A.state.data;
  const box = A.$("systemSettings");
  box.replaceChildren(A.el("h2", "只读风险核对"));
  A.rows(box, {
   "账户": data.account.name, "平台": data.account.platform,
   "风险锁": data.overview.health.riskLocked ? "锁定" : "未锁定",
   "当前异常": data.overview.health.error || "无",
   "历史错误": data.overview.health.lastError || "无"
  });
  box.append(A.button("读取订单与资金核对证据", async () => {
   const result = await A.api("/api/v4/legacy-diagnostics?id=" + encodeURIComponent(A.state.id));
   A.detail("只读核对结果", result);
  }));
 };
})(window.SA);
