# jiaoyi2

多账户交易策略服务，包含经典策略、智能趋势策略、兼容版 **Trend Only V1** 和推荐版 **Trend Only V2**。

Trend Only V2 保持单仓、风险仓位和无 DCA 约束，同时支持突破、EMA 回踩确认和 swing 结构延续入场。V1 保留供旧账户兼容，不会被自动删除。

## 安装

需要 Node.js 22，以及 Extended 平台使用的 Python 3 环境。

```bash
npm ci
cp config.example.json config.json
cp auth.example.json auth.json
npm test
npm start
```

浏览器访问 `http://服务器地址:3000`。

## 安全说明

- 示例配置默认使用 Paper 模式。
- 首次将账户切换为 Trend Only 时，服务会强制切到 Paper；新账户推荐使用 V2。
- Live 新开仓必须针对当前信号二次确认，确认不会持久化，且 60 秒后失效。
- 所有订单都使用 `clientOrderId`；超时后保留未知订单状态，并先向交易所查询，禁止直接重复提交。
- `config.json`、`auth.json`、运行态、成交历史和私钥文件已加入 `.gitignore`，不要提交这些文件。
- 停止趋势监控只会阻止新开仓；已有趋势仓位仍继续执行保护性退出。
- Live 前必须配置可用的交易所凭证；Hyperliquid/Binance 的 V2 仓位成交后会立即创建交易所原生保护止损，同步失败会进入 `risk_lock`。
- Extended Live 趋势下单暂未开放，请使用 Paper 或切换 Hyperliquid/Binance。

## Trend Only V2 推荐规则

- 支持 `breakout_entry`、`pullback_entry`、`continuation_entry`，默认混合使用。
- CHOP 使用分层判断：45 以下为优质趋势，45–52 为趋势过渡区，52–61.8 仅允许高质量回踩，61.8 以上禁止新开仓。
- ADX 达到高位且 DI 差值明确时，不要求 ADX 持续上升，仍可识别趋势延续。
- 多周期默认使用 `not_against`：1H 必须同向，4H 只要不明显反向即可继续判断。
- 回踩确认检查最近 K 线是否曾触碰 EMA20/EMA50，不要求确认 K 线仍贴近 EMA。
- 延续入场使用 swing high / swing low 序列，不使用简单区间前后半段极值。
- 趋势衰减先进入防守模式并收紧结构/ATR 止损，确认反转后才退出。
- 同一趋势退出后默认冷却 6 根 15m K 线；出现更新后的回踩或延续结构可再次入场。
- 页面提供最近 50 根已收盘 K 线的信号回放、阻断原因统计和筛选。

## Trend Only V1 兼容规则

- 10 倍杠杆，单笔风险上限为权益的 1%。
- 日亏损达到 3% 后停止新开仓。
- 连续亏损 2 次后暂停 12 小时。
- UTC 周六、周日禁止新开仓。
- V1 沿用旧版固定震荡过滤与 ADX 连续增强规则；新账户建议使用 V2 的分层判断。
- 15 分钟入场、1 小时趋势和 4 小时高周期方向必须一致。
- 1R 移动到保本，2R 锁定 1R，3R 启动 ATR 移动止盈。

## 验证

```bash
npm test
```

测试覆盖多空信号、周末限制、震荡过滤、风险仓位、全部退出原因、历史凭证、部分成交、未知订单恢复、Live 二次确认以及旧策略回归。
