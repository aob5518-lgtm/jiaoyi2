# Trend Only V3 + Short-Term Engine

## 审计与边界

V3 仍通过 tickAccount → trendRuntime.tick → TrendOnlyV3 运行，不进入 DCA。已收盘数据、六项评分、三模式选择、结构止损、成本、空间、Grade、再入场及组合保护原有计算保留。没有通过降低 CHOP/ADX/Grade 或取消空间门槛增加次数。

审计时应分开统计 signalPermission、orderSubmitted、orderFilled 和最终持仓状态；不能仅用 finalDecision 是否仍等于 ORDER_FILLED 判断曾否成交。实际生产数据仅只读核验，不随代码公开上传，不据少量样本宣称漏掉的行情都可获利。

本轮修复：等待形态在执行评估中使用 WAITING 而非风控 BLOCK；统一决策保留已发生的成交事件；开仓计划实际执行日亏损、连亏冷却、pending 与已有仓位检查，不能仅在前端显示限制。阈值未变。

## 后端统一诊断

`strategy/trend_v3/decision.js` 输出时间、账户/币种、版本/实验/哈希、数据、方向/评分、形态/评分、Grade、CHOP/ADX、多周期、触发、空间/成本、风险/组合/执行、primaryBlocker、secondaryBlockers、nextAction。类别为 NO_SIGNAL / WAIT / BLOCKED / READY / ORDER_PENDING / ENTERED。每账户/币种/配置/信号 K 线一个 candidateId，更新记录不重复计数，首次阶段阻断时间不被轮询刷新。

管理状态附带 unifiedDecision、decisionStats24h、decisionStats72h。旧信号不补造新诊断；新统计会随运行积累。诊断过程不参与六项评分或后验调参。带实时保护条件时以前端直接读取的后端决策为准。

## 独立短周期 Shadow

模块：`strategy/short_term_v1/engine.js`；版本 short_term_v1；实验 SHORT_TERM_STD_20261018_A；修订 SHORT_TERM_20261023_SHADOW_A；配置哈希包含币种和平台，防止更换标的后串用账本。V3 原实验与修订不变。

当前架构一个真实持仓管理器，因此短周期只采用独立 Shadow 账本，不提交真实交易所订单，也不写入真实 Paper 成交历史。allowLive 固定 false、sampleType 固定 shadow、orderPermission 固定 false。不支持“改一个前端字段就开启 Live”。

5m 形成信号，15m 提供背景；只允许完整、连续、对齐且新鲜的已收盘 K 线。没有实现未经验证的 1m 主信号或 native/hybrid 数据切换。执行价偏离信号价超过 0.5 ATR 时等待，而非假设可以按参考价成交。

三种可独立启停的形态：

- 动量突破：收盘越过前 20 根边界，实体确认与压缩/扩张至少一项成立，限制追价。
- 短线回踩：存在方向、此前触及局部 EMA，未破坏原结构，当前同向收盘且越过前一根边界并收复 EMA；仅触及 EMA 不交易。
- 区间反转：低方向效率、15m 均线中性与斜率受限，价格拒绝边界后同向确认；强背景趋势或有效脱离区间时禁止。

评分七项实际参与：背景、形态、动量/波动、确认、净空间、成本、数据/执行质量。可信成交量缺失会降低数据评分，不补造 volume。A≥82，B≥74，分别使用 1 / 0.5 风险倍率；15m 中性另减半风险。这些是实验起点，不是最优参数。

## 风险、成本与路由

默认独立风险为账本权益 0.25%，可配置但不超过 0.5%；默认 5 倍杠杆、25% 仓位比例、2% 日净亏损、3 次连亏保护、6 根冷却、24 根最长持仓。有效风险同时预算价格止损、平台估算费率、滑点和资金费预留；成交滑点后数量再次缩减，不扩大预算。

成本沿用 trade_cost 平台配置及账户覆盖，明确标记 estimated，未知平台为 incomplete 而非零费用。资金费为可配置的保守预留，不声称来自真实结算。毛盈亏使用模拟实际进出价；净盈亏扣手续费和资金费，已包含在成交价中的滑点不重复扣减。净空间与成本 R 不合格则拒绝。

交易规格必须成功读取：Hyperliquid/Binance 使用已有 meta；Extended 使用真实 market tradingConfig，缺失时不模拟新开仓，不能依赖旧通用 fallback 精度。所有账本止损采用已有 paperStopFill，保留正常触发及跳空保守模型。止损仅在新的已收盘周期按阶段收紧，旧止损优先检查；1.5R 净保本、2.5R 锁利、3R 跟踪。

执行顺序：V3 先评估与管理 → Short-Term 读取客观数据 → 同账户/标的互斥、pending、V3 合格候选优先 → 读取自己的权益/亏损/冷却 → Portfolio Guard → 再按滑点后的真实虚拟风险复核 → Shadow 入场。

Short-Term 的组合检查包含同一资金身份下 V3 已有/待确认暴露和同名 Short-Term 账本暴露，对相关标的不抵扣反向仓位、不给予分散化折扣。由于它是 Shadow，虚拟风险不会反过来剥夺 V3 的真实执行权限，也不宣称两套真实 Paper 持仓已经并行。两者未来并行 Paper 需要另行验证统一执行管理器。

## 账本、API 与评估

账本位于现有 trend_only_runtime.json 的 shortTermBooks[configHash]，保存自己的权益、仓位、信号、冷却与退出；不复制或重标旧历史。配置、币种或平台变更遇到已有 Shadow 仓位/pending 会拒绝，包括普通配置保存路径。停止监控不能产生新的 Shadow 入场。

- GET `/api/trend-only/short-term?id=...&from=...&to=...&configHash=...`：需要登录，返回独立 Shadow 记录、三模式统计与最近 50 条信号。
- POST `/api/trend-only/short-term/config`：需要登录，body 为 `{id,config}`，不能启用 Live。
- 原 GET `/api/trend-only/analytics` 增加明确时间和样本范围，不把无时间旧记录强行放入指定时段。

按三种 Setup 分别统计候选、触发、评分通过、Shadow 平仓、净期望、PF、回撤、成本、持仓和每日次数。退出后 MFE、错过候选的 8/16/32 根审计只在完整未来窗口成熟后写入，后验数据绝不反哺入场。不把理论成交数量称为实际 Paper 交易数。样本不足或净期望负值必须明确显示，不能包装成已验证收益。

## 历史与 UI

历史页只在首屏保留 Net PnL / Net Expectancy R / PF / Max Drawdown（U），其余统计折叠。默认日期、账户、策略、方向、结果；高级筛选包括版本归属、成本/净 R、形态、退出和样本类型。50 条分页，手机卡片，历史模式移动端不让账户栏占据首屏。

public/history-model.js 是实际渲染与 CSV 共用的纯筛选/统计模型。跨版本、实验、修订、配置或 Shadow/Paper 混合范围不汇总成绩；无记录不伪造为零。默认当前范围严格匹配，旧记录仍可显式查看。CSV 使用全部当前筛选结果，而非仅当前页，防止公式注入。

Forward Test 深度诊断移至策略分析，所有历史样本统计遵循同一范围。Portfolio Risk 是当前安全快照，不是某时间段收益曲线。复盘详情保留费用、风险、MAE/MFE、评分、决策及止损变更；缺失时显示无记录。合成 UI 验证数据不是生产成绩。

本轮仅提交 GitHub，不自动部署，不修改生产配置或运行中的账户。
