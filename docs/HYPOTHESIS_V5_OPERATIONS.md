# V5 操作、测试与安全回滚

## 开发与运行前提

Node >=22.12，使用原 package-lock.json 安装。新代码不增加生产依赖，package-lock不变；本地使用官方npm执行 npm ci --ignore-scripts 后完整测试。

运行隔离服务：

```sh
node scripts/hypothesis_shadow.js /ABSOLUTE/NEW/RESEARCH/DIRECTORY 3311
```

只绑定127.0.0.1；服务默认没有账户，不自动下单或开始评估。认证文件在指定目录 research-access.json，含随机研究凭据，0600，不复制生产 auth/config/账本。只在本机工作台访问凭据输入框临时输入，不放URL、浏览器存储或日志。远程访问须另行配置安全SSH隧道，不直接开放公网。

打开 http://127.0.0.1:3311/ 。创建 ETH 或 BTC Shadow 实验，默认停止；明确点击启动后才开始公共行情评估。暂停停止新订单，已有持仓继续保护。无有效机会允许长期空仓。Research账户只由离线脚本创建，不混入Shadow账本。

主站兼容：/intelligent-trend.html 使用既有登录；/api/v5/* 必须认证。数据目录 .v5-research/integrated；与独立服务默认 .v5-research/standalone 区分。新系统不使用原账户列表的ID，不把研究账户塞进生产config.json。

## 受限API

- GET /api/v5/status：本研究域状态、最后50笔记录、前向指标，无凭据。
- GET /api/v5/research：固定默认参数的真实历史报告摘要，清楚标为历史回测。
- POST /api/v5/accounts：symbol、mode=Shadow、config、initialEquity；禁止真实账户/密钥字段。
- POST /api/v5/control：id、action=start或pause；无Live、解锁、删除、清空、重置资金或自动迁移。

配置不能通过前端修改正在运行的策略；界面另建独立实验并保存配置哈希。旧仓位继续按开仓快照管理。

## 数据与研究复现

```sh
python scripts/hypothesis_archive.py ETH 2024-01 2024-12 .audit/h01-eth-2024.json
python scripts/hypothesis_archive.py BTC 2024-01 2024-12 .audit/h01-btc-2024.json
node scripts/hypothesis_research.js --run .audit/h01-eth-2024.json .audit/research-eth
node scripts/hypothesis_research.js --run .audit/h01-btc-2024.json .audit/research-btc
node scripts/hypothesis_summary.js .audit
```

需网络可访问官方归档，Python标准库即可；不需API Key。原生REST可用时也可使用 --collect FILE ETH:365，它记录原生规格与实际资金费markPrice。下载冻结文件禁止覆盖；每次研究尝试、失败和结果按哈希链追加至experiments.jsonl。不能删除失败再宣称搜索无偏。

本机正式公共fapi访问失败，归档可用。所有运行输出已经保存到 .audit，不能把这些结果上传到Shadow前向账本充当交易成绩。

## 测试

交付实测：404通过、0失败、0跳过，另8项发布回滚测试通过；桌面与两个手机视口真实浏览器渲染通过。详见 [测试与视觉报告](HYPOTHESIS_V5_TEST_REPORT_20261107.md)。

npm test 包含全部既有回归和新增H01测试。另执行 python tests/deploy_release_test.py 验证原有代码部署恢复逻辑。最终实际数量以当前交付日志为准，核心新增覆盖：

- 未收盘/未来值忽略、缺口/对齐错误拒绝、原生零量数据保留但不入场；
- 趋势多空、异常波动、量能中位数、UTC周末边界；
- 风险限额、成本、最小规格、追价、窗口、组合相关敞口；
- 未成交不造仓、部分成交余单取消、响应超时UNKNOWN及撤单失败保留；
- 虚拟保护失败、硬止损优先、跳空、资金费在止损前计入、盈亏守恒；
- 跟踪只收紧、旧配置快照、暂停/锁定后保护、八小时冷却；
- 错账锁定、重启/多账户/审计失败事务、损坏文件不覆盖；
- 无真实下单客户端、Live被拒、密钥字段拒绝与递归脱敏；
- 独立本机HTTP认证、主站登录隔离、GET不改原账户/历史；
- 工作台textContent转义、无浏览器持久凭据、失联禁用操作；
- 原有V3、Short-Term、4H、账户迁移等全套回归。

已用独立headless Chrome完成1440×1000、390×844、375×812渲染及截图，scrollWidth未超过clientWidth，手机操作栏已精修。上线前仍需生产页面、实际手机触控、真实持仓详情和持续断流场景验收；隔离夹具截图不冒充生产验收。

## 部署与回滚方案（本轮未执行）

本轮不部署生产、不自动启动账户。若后续授权，仅从精确Git SHA构建干净发布，独立stage按锁文件安装依赖，npm test及回滚测试全过，完成所有旧Live原生持仓/委托/保护核验后才允许停机。

采用现有安全发布脚本：一致性完整备份，代码及依赖原子替换与校验，检查配置/认证哈希、账户数和历史完整性，再重启验证。发布白名单仅新增这份已提交的公开研究结果JSON，不允许生产状态或凭据进入包。

新增数据格式没有修改数据库或旧JSON结构，所有V5账本在独立目录schema1。回滚旧代码时停止V5服务；原有账户与账本继续保留。不能在有虚拟持仓时删V5目录；先留存该版本引擎用于保护/审查。不能将旧备份运行时覆盖新产生的订单/历史。

具体步骤：

1. 停止新增研究风险，仍保留持仓管理；保存研究目录完整快照。
2. 备份原应用代码、依赖、旧配置和财务文件，记录SHA与哈希。
3. stage检查API认证、权限、工作台和持久化，确认生产状态完全不变。
4. 发布失败恢复完整旧代码/依赖，清理新加代码；运行时和财务新数据不回退。
5. V5独立服务故障时可单独停止，不影响生产PM2；保留账本、证据和随机认证。

## 不得误解的权限

程序测试通过≠已证明收益优势；Shadow运行≠获得Live批准。H01原生保护单不在此版本启用；不得通过替换mode字符串、提高风险参数、复用旧账户密钥或AI指令绕过此边界。
