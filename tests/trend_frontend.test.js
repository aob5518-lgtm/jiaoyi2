const test=require("node:test"),assert=require("node:assert/strict"),fs=require("fs"),path=require("path"),vm=require("vm");
const base=path.resolve(__dirname,".."),read=file=>fs.readFileSync(path.join(base,file),"utf8");
const html=read("public/index.html"),moduleText=fs.readdirSync(path.join(base,"public/terminal")).filter(f=>f.endsWith(".js")).map(f=>read("public/terminal/"+f)).join("\n"),css=read("public/terminal/terminal.css");
function pure(){const window={};vm.runInNewContext(read("public/terminal/core.js"),{window,location:{search:"",hash:""},URLSearchParams,URL,Number});vm.runInNewContext(read("public/terminal/layout.js"),{window});return window.SA;}

test("信号回放统计正确区分等待、追单、CHOP、高周期与风控阻断", () => {
  const view = require("../public/strategy-view.js");
  const counts = view.summarizeReplay([
    { entryPermission: "allowed", blockers: [] },
    { entryPermission: "wait_pullback", blockers: ["趋势有效，但价格已远离 EMA20，不追单"] },
    { entryPermission: "wait_breakout", blockers: ["等待突破确认"] },
    { entryPermission: "wait_continuation", blockers: ["高周期方向明显反向"] },
    { entryPermission: "blocked", blockers: ["CHOP 强震荡，禁止新开仓"] },
    { entryPermission: "blocked", blockers: ["risk_lock：保护止损单未确认"] }
  ]);
  assert.deepEqual(counts, { signalOpportunities: 1, executable: 0, submitted: 0, filled: 0, allowed: 1, pullback: 1, breakout: 1, continuation: 1, extended: 1, chop: 1, higher: 1, risk: 1 });
});

test("signal allowed 但 execution blocked 会进入执行阻断筛选", () => {
  const view = require("../public/strategy-view.js"), item = { signalPermission: "allowed", executionPermission: "blocked", finalDecision: "WAIT_LIVE_CONFIRM" };
  assert.equal(view.replayFilterMatch(item, "signal_allowed"), true);
  assert.equal(view.replayFilterMatch(item, "execution_blocked"), true);
  assert.equal(view.replayFilterMatch(item, "strategy_blocked"), false);
  assert.equal(view.replayFilterMatch(item, "live_confirm"), true);
});

test("24/72 小时统计包含 ADX、CHOP、多周期与追单阻断", () => {
  const view = require("../public/strategy-view.js"), now = Date.parse("2026-09-18T12:00:00Z");
  const items = [
    { time: now - 3600000, entryPermission: "blocked", blockers: ["ADX=17，趋势强度不足"] },
    { time: now - 2 * 3600000, entryPermission: "blocked", blockers: ["CHOP 强震荡"] },
    { time: now - 3 * 3600000, entryPermission: "blocked", blockers: ["高周期方向明显反向"] },
    { time: now - 4 * 3600000, entryPermission: "wait_pullback", blockers: ["价格已远离 EMA20，不追单"] }
  ];
  const stats = view.summarizeReplayWindow(items, 24, now);
  assert.equal(stats.total, 4); assert.equal(stats.adx, 1); assert.equal(stats.chop, 1); assert.equal(stats.higher, 1); assert.equal(stats.extended, 1);
});

test("连续 48 小时无 allowed 信号时显示参数过严提醒", () => {
  const view = require("../public/strategy-view.js"), now = Date.parse("2026-09-18T12:00:00Z");
  const items = Array.from({ length: 50 }, (_, index) => ({ time: now - index * 3600000, entryPermission: "blocked", blockers: ["ADX 趋势强度不足"] }));
  const warnings = view.strictnessWarnings(items, now);
  assert.match(warnings.join(" "), /过去 48 小时没有出现可开仓信号/); assert.match(warnings.join(" "), /主要原因：趋势强度不足/);
});

test("截图场景明确说明是策略过滤而非系统故障", () => {
  const view = require("../public/strategy-view.js");
  const trend = { signal: { entryPermission: "blocked", diagnostics: {
    chop: { value: 52.8, threshold: { ideal: 45, transition: 55, hardBlock: 61.8 }, passed: true, label: "过渡" },
    adx: { value: 17.65, threshold: 22, passed: false, label: "趋势强度不足" },
    direction: { entryDirection: "none", trendDirection: "long", higherDirection: "none", passed: false, timeframePassed: true },
    finalBlockers: ["ADX 趋势强度不足"]
  } } };
  const text = view.diagnosticSummary(trend);
  assert.match(text, /1H 出现做多趋势/); assert.match(text, /ADX=17\.65/); assert.match(text, /CHOP=52\.80 处于偏震荡区/); assert.match(text, /不属于系统故障/);
  assert.equal(view.opportunityStatus(trend), "无机会：ADX 弱");
});

test("机会状态优先采用 executionState，而不是信号 allowed", () => {
  const view = require("../public/strategy-view.js");
  assert.equal(view.opportunityStatus({ executionState: "MONITOR_STOPPED", signal: { entryPermission: "allowed" } }), "监控已停止");
  assert.equal(view.opportunityStatus({ executionState: "WAIT_LIVE_CONFIRM", signal: { entryPermission: "allowed" } }), "等待 Live 确认");
  assert.equal(view.opportunityStatus({ executionState: "ACCOUNT_CONFLICT", signal: { entryPermission: "allowed" } }), "账户冲突");
});

test("README 与示例配置启用 Trend Only V3 Paper 并保留 V2 稳定对照", () => {
  const readme = read("README.md"), config = JSON.parse(read("config.example.json"));
  assert.match(readme, /Trend Only V3 Paper 实验/); assert.match(readme, /V2 保持稳定对照/); assert.match(readme, /Extended Live 趋势下单暂未开放/);
  assert.equal(config.accounts[0].strategyType, "trend_only_v3"); assert.equal(config.accounts[0].trendOnlyConfig.version, "v3"); assert.equal(config.accounts[0].tradeMode, "simulation"); assert.equal(config.accounts[0].trendOnlyConfig.allowLive, false);
});

test("mobile_view.html 是公开只读页，不加载趋势管理面板", () => {
  const html = read("public/mobile_view.html");
  assert.match(html, /\/api\/public\/status/);
  assert.doesNotMatch(html, /\/api\/trend-only/);
  assert.doesNotMatch(html, /trend-only-panel\.js/);
  assert.doesNotMatch(html, /保存参数|确认本次 Live 开仓|平掉趋势仓位|管理按钮/);
});

test("移动端历史使用交易卡片和查看复盘，不渲染宽表", () => {
  const html = read("public/mobile_view.html");
  assert.match(html, /历史交易/); assert.match(html, /查看复盘/); assert.match(html, /净盈亏/);
  assert.doesNotMatch(html, /<table|初始 \/ 最终止损|17列/);
});

test("V4固定五导航且无独立4H工作台入口",()=>{assert.deepEqual([...html.matchAll(/data-tab="([^"]+)"/g)].map(m=>m[1]),["overview","strategies","history","analysis","settings"]);assert.doesNotMatch(html,/CORE ONLINE|href="\/compound.html"/);});
test("普通新账户菜单只允许当前可执行策略，Short-Term能力明确",()=>{const menu=html.match(/id="createStrategy"[\s\S]*?<\/select>/)[0];assert.match(menu,/trend_only_v3/);assert.match(menu,/compound_4h_v1/);assert.doesNotMatch(menu,/classic|smart_regime_v1|trend_only_v1|trend_only_v2/);assert.match(read("terminal/policy.js"),/暂不支持实际Paper下单/);});
test("旧V1升级V2入口及旧策略参数表单已退役",()=>{assert.doesNotMatch(html+moduleText,/overviewUpgradeV2Btn|一键升级到 Trend Only V2|经典补仓策略|id="baseAmount"|confirmLive/);assert.equal(fs.existsSync(path.join(base,"public/trend-only-panel.js")),false);});
test("统一终端主文件只负责语义结构，业务脚本全部外置",()=>{assert.equal((html.match(/<style/g)||[]).length,0);assert.equal((html.match(/<script>(?!<)/g)||[]).length,0);for(const name of ["core","layout","forms","history","overview","strategies","analysis","app"])assert.ok(html.includes("/terminal/"+name+".js"));});
test("所有V4脚本均可解析，渲染只用DOM与textContent",()=>{for(const f of fs.readdirSync(path.join(base,"public/terminal")).filter(f=>f.endsWith(".js")))new vm.Script(read("public/terminal/"+f));assert.doesNotMatch(moduleText,/innerHTML|insertAdjacentHTML/);assert.match(moduleText,/textContent/);});
test("账户搜索按名称策略状态生效，手机和桌面使用同一账户控制器",()=>{const A=pure(),a={name:"ETH研究",strategyType:"trend_only_v3",running:true,symbol:"ETH",policy:{status:"SUPPORTED"}};assert.equal(A.accountMatches(a,"研究","","running"),true);assert.equal(A.accountMatches(a,"btc","","all"),false);assert.equal(A.accountMatches(a,"","compound_4h_v1","all"),false);assert.match(moduleText,/accountSwitcher.*selectAccount/s);});
test("历史错误不作为当前健康错误；状态分开显示",()=>{assert.match(read("terminal/model.js"),/error:st.activeError/);assert.match(html,/modeBadge/);assert.match(html,/runBadge/);assert.match(html,/healthBadge/);assert.doesNotMatch(read("terminal/model.js"),/error:st.lastError/);});
test("当前决策只展示人话，专业漏斗在策略分析",()=>{assert.match(read("public/terminal/overview.js"),/当前策略决策/);assert.doesNotMatch(read("public/terminal/overview.js"),/decisions24h|decisions72h|v3DecisionFunnel/);assert.match(read("public/terminal/analysis.js"),/24小时执行漏斗/);});
test("历史主表仍为九列，点击时间查看完整复盘",()=>{const head=html.match(/<thead>([\s\S]*?)<\/thead>/)[1];assert.equal((head.match(/<th>/g)||[]).length,9);assert.match(read("public/terminal/history.js"),/交易复盘 · 原始归属保留/);assert.match(moduleText,/detailBody.*JSON.stringify/s);});
test("历史旧归属不改为V3，缺失净收益不伪造为零",()=>{const M=require("../terminal/model"),rows=M.historyRows([{pnl:10},{strategyVersion:"classic",netPnl:3}]);assert.equal(rows[0].strategyVersion,"legacy_unclassified");assert.equal(rows[0].netPnl,null);assert.equal(rows[1].strategyVersion,"classic");assert.equal(rows[0].original.pnl,10);});
test("保护退出负净收益文案和净值统计正确",()=>{const A=pure();assert.equal(A.reason({closeReason:"trend_tp",netPnl:-1}),"保护退出（净亏损）");assert.equal(A.reason({closeReason:"trend_tp",netPnl:1}),"移动止盈/保护止盈");const M=require("../public/history-model");assert.equal(M.summary([{netPnl:-1},{netPnl:1}]).winRate,.5);});
test("缺失价格或风险显示暂无数据而非0",()=>{const A=pure();for(const v of [null,undefined,"",NaN])assert.equal(A.fmt(v),"暂无数据");assert.equal(A.fmt(0),"0");});
test("移动端不是宽表缩放，有独立卡片和下拉账户",()=>{assert.match(css,/@media\(max-width:800px\)/);assert.match(css,/#historyMobile\{display:block/);assert.match(css,/\.table-wrap\{display:none/);assert.match(html,/id="accountSwitcher"/);assert.match(css,/minmax\(0,1fr\)/);});
test("侧栏支持折叠，不存在常驻右侧冗余三栏",()=>{assert.match(css,/sidebar-collapsed/);assert.doesNotMatch(html,/id="rightPanel"/);assert.match(moduleText,/drawer-open/);});
test("4H已融入统一总览，四层状态未激活与等待成交明确区分",()=>{assert.match(read("public/terminal/overview.js"),/renderLayers/);assert.match(read("public/terminal/core.js"),/DORMANT:"未激活"/);assert.match(read("public/terminal/overview.js"),/riskBudget/);assert.equal(fs.existsSync(path.join(base,"public/compound.js")),false);});
test("4H基础高级参数可视化，原始JSON仅在开发者折叠工具中",()=>{const f=read("public/terminal/forms.js");for(const key of ["layerNotionalPct","maxAdds","atrPeriod","zoneAtr","layerSpacingAtr","stopBufferAtr","maxDailyLossRatio"])assert.ok(f.includes(key));assert.match(f,/后端normalize\(\)/);assert.match(read("public/terminal/strategies.js"),/高级管理与开发者工具/);});
test("主操作仅启动暂停设置，危险退出有前后端二次确认",()=>{assert.match(moduleText,/启动策略/);assert.match(moduleText,/暂停新交易/);assert.match(moduleText,/策略设置/);assert.match(read("public/terminal/core.js"),/action==="close"&&!confirm/);assert.match(read("terminal/api.js"),/input.confirm!==true/);});
test("暂停文案准确，不伪装成平仓",()=>{assert.match(moduleText,/停止新开与补仓，已有持仓继续接受风险保护/);assert.match(read("terminal/api.js"),/已有持仓继续接受风险保护/);});
test("未保存草稿不得启动，服务器策略变化会拒绝旧页面操作",()=>{assert.match(read("public/terminal/core.js"),/action==="start"&&A.state.dirty/);assert.match(read("terminal/api.js"),/服务器策略已变更/);assert.match(moduleText,/configurationLocked/);});
test("账户切换使用请求代号防串号，刷新和切换标签不发启动订单",()=>{assert.match(moduleText,/ticket!==A.state.epoch/);assert.match(read("public/terminal/layout.js"),/\/api\/account\/select/);assert.doesNotMatch(read("public/terminal/app.js"),/action:"start"/);});
test("历史分页、筛选保持及CSV使用当前全部筛选结果",()=>{const h=read("public/terminal/history.js");assert.match(h,/historyOffset/);assert.match(h,/export:"true"/);assert.match(h,/window.HistoryModel.csv/);assert.match(moduleText,/sessionStorage/);});

function accountDOM(){
 const A=pure(),nodes={};class Element{constructor(tag,text="",cls=""){this.tagName=tag;this.textContent=text;this.className=cls;this.children=[];this.scrollTop=123;}append(...values){this.children.push(...values);}replaceChildren(...values){this.children=values;}setAttribute(k,v){this[k]=v;}}
 for(const id of ["accountList","accountSwitcher","accountSearch","accountStrategy","accountStatus"])nodes[id]=new Element("div");nodes.accountSearch.value="";nodes.accountStrategy.value="";nodes.accountStatus.value="all";A.$=id=>nodes[id];A.el=(...args)=>new Element(...args);A.button=(text,fn,cls)=>{const e=A.el("button",text,cls);e.onclick=fn;return e;};return{A,nodes};
}
for(const count of [63,100,150])test("生产规模账户DOM回归："+count+"账户三行、不丢卡、可切换、保留滚动",async()=>{
 const {A,nodes}=accountDOM(),{accounts}=require("./terminal_ui_fixture"),rows=accounts(count);A.state.id=rows[0].id;A.state.data={accounts:rows};let selected;A.selectAccount=async id=>{selected=id;};A.renderAccounts();assert.equal(nodes.accountList.children.length,count);assert.equal(nodes.accountSwitcher.children.length,count);assert.equal(nodes.accountList.scrollTop,123);
 for(const c of nodes.accountList.children){assert.equal(c.children.length,3);assert.equal(c.children[0].children.length,2);assert.equal(c.children[1].className,"account-card-pair");assert.equal(c.children[2].className,"account-card-net");}
 assert.equal(nodes.accountList.children[1].children[0].children[0].title,rows[1].name);assert.match(nodes.accountList.children[0].children[2].children[1].className,/profit/);assert.match(nodes.accountList.children[1].children[2].children[1].className,/loss/);assert.equal(nodes.accountList.children[2].children[0].children[1].textContent,"受限");await nodes.accountList.children[count-1].onclick();assert.equal(selected,rows[count-1].id);
});
test("账户卡必须不可压缩且固定最小高度，列表独立滚动并预留滚动条",()=>{assert.match(css,/\.account-card\{flex:0 0 auto;flex-shrink:0;height:92px;min-height:92px/);assert.match(css,/scrollbar-gutter:stable/);assert.match(css,/#sidebar>:not\(\.account-list\)\{flex-shrink:0/);assert.match(css,/\.account-card-head strong\{[^}]*text-overflow:ellipsis/);assert.match(css,/\.account-card-pair\{[^}]*text-overflow:ellipsis/);assert.match(css,/account-card-net[^}]*tabular-nums/);});
test("手机抽屉可显式关闭，PC折叠后转手机仍可打开",()=>{assert.match(html,/id="closeAccounts"/);assert.match(read("public/terminal/app.js"),/closeAccounts.*classList.remove\("drawer-open"\)/);assert.match(css,/body.sidebar-collapsed #sidebar.drawer-open\{display:flex/);});
test("运行、交易、持仓状态分别展示且不改变交易字段",()=>{assert.match(read("public/terminal/layout.js"),/运行 RUNNING/);assert.match(read("public/terminal/layout.js"),/暂停 PAUSED/);assert.match(read("public/terminal/overview.js"),/交易状态/);assert.match(read("public/terminal/overview.js"),/FLAT · 无持仓/);assert.match(read("public/terminal/core.js"),/NO_SIGNAL:/);});
