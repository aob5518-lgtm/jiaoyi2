# Forward Test 复盘口径

## 实验隔离

默认范围为 strategyVersion、experimentId、strategyRevision、configHash 四项同时匹配。当前实验为 `V3_STD_20261015_C`，修订为 `V3_20261015_CONFIRM_COST`。旧成交不重标、不重算；缺失修订显示 unknown，不根据日期猜测。跨范围比较必须显式选择，不能拿旧实验样本评价新配置。

## 止损后与入场后观察

硬止损后观察 8/16/32 根完整、连续、已收盘 K 线。退出所在的未完整 K 线不算入窗口；缺口或未成熟窗口不进入该窗口统计分母。有效风险单位来自已记录的初始有效风险除以仓位数量，不用账户预算冒充真实风险。

分类阈值：MFE 至少 1.5R 且 MAE 不超过 0.5R 为 STOP_TOO_TIGHT；MAE 至少 1.5R 且 MFE 小于 0.5R 为 ENTRY_WRONG；MAE 至少 1R 且 MFE 小于 1.5R 为 STOP_CORRECT；其余为 AMBIGUOUS。分类是事后标签，不是实时退出指令，也不证明止损后可以实际获利。

入场后 4/8/16 根观察同样要求完整窗口，可能延伸至真实退出之后，不能当作实际持仓期间 MAE/MFE。实际持仓 MFE_R/MAE_R 与基于有效风险的 effectiveMFE_R/effectiveMAE_R 分别保留。exitCaptureRatio 使用 netR / 原始 MFE_R；有效风险版本另列。未采集或无法可靠推导的数据为空，不伪造为零。

NeverWorkedRate 使用持仓 MFE 小于 0.5R 且止损的成熟样本；WorkedThenFailedRate 使用持仓 MFE 至少 1R 后净亏或止损的样本。缺少持仓表现数据的旧记录不计入相应分母。

## 入场来源与漏斗

回踩细分为 EMA20_SHALLOW、EMA50_DEEP、BREAKOUT_RETEST、STRUCTURE_RETEST、MIXED_RETEST。仅使用当时可观察的历史 EMA 触碰及先前已确认结构来源；无法确认则 UNKNOWN。确认方式与 DI 是否恢复分别记录。单模式诊断采用状态副本，不消耗真实再入场次数。

Candidate → Triggered → StopPassed → ScorePassed → CostPassed → PotentialRPassed → RiskPassed → ExecutionReady → Submitted → Filled 为分模式漏斗。诊断候选不等于订单；原始日志缺少新字段时记为未知，不制造历史机会或成交。

## 成本与 Shadow

总成本包含手续费、显式独立滑点成本并扣除资金费收益。已体现在成交价格中的止损滑点不再次扣减。成本分档为重叠阈值，不能相加作为总数；真实费用优先，估算来源单独标识。

cost-tight 与 weekday/weekend Shadow 使用独立模拟账本、权益、仓位和冷却，无交易所下单或真实成交写入权限。cost-tight 只改变成本门槛，周末对照按 UTC 判断新开仓；不改变主策略参数。它们使用采样报价和估算成本，不复制逐笔盘口、资金费或真实成交。

独立 Shadow 从启动后积累；同笔成交的门槛筛选统计仅是 matched-trade 对照，不是完整反事实回测。未平虚拟仓位不能标记为错过收益。配置切换后旧账本保留但不继续推进，未平部分视为未完成样本。

## 跨场所与组合风险

信号参考 Binance futures 时与 Extended 执行价格分别保存。基差使用成对请求的采样报价，basisExecutionPrice 不替换计划价格或实际成交价；采样时间不保证交易所同时刻。25bps/0.25ATR 仅作诊断，不新增基差硬过滤，不提供未经验证的 native/hybrid 切换。

共享资金身份以平台、交易模式和显式资金组或凭证身份生成哈希，不返回原凭证。共享权益取已观察正权益的保守最小值，不重复相加。组合风险包含剩余仓位及待成交开仓预留；存在未知风险或缺少权益时拒绝新增风险。默认上限 2.5%，同步预留防止并发开仓越限。候选排序仅作诊断，不实施 Top N。跨账户总 R 不是资金收益率。

## 使用边界

先积累完整的新实验样本，再评估入场质量、成本及退出表现；历史不足明确显示数据不足。本轮维持 1R 里程碑、1.5R 净保本、2.5R 锁利、3R 追踪，以及现有 CHOP/ADX、等级和风险配置。V3 仍为 Paper-only，主策略默认允许周末交易。
