const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const TrendOnly = require("./trend_only");
const TrendOnlyV2 = require("./trend_only_v2");
const { createTrendRuntime } = require("./trend_runtime");
const STRATEGY_TYPES = new Set(["classic", "smart_regime_v1", "trend_only_v1", "trend_only_v2"]);
function getStrategyType(acc = {}) {
  const explicit = String(acc?.strategyType || "").trim();
  if (explicit) return STRATEGY_TYPES.has(explicit) ? explicit : "classic";
  const legacyMode = String(acc?.strategyMode || "").trim();
  if (legacyMode === "Trend Only V1") return "trend_only_v1";
  if (legacyMode === "Trend Only V2") return "trend_only_v2";
  if (legacyMode === "智能V1" || legacyMode === "趋势模式") return "smart_regime_v1";
  return "classic";
}
function getStrategyLabel(acc = {}) {
  const type = getStrategyType(acc);
  if (type === "trend_only_v1") return "Trend Only V1";
  if (type === "trend_only_v2") return "Trend Only V2（趋势过滤 + 回踩入场 + 延续入场）";
  if (type === "smart_regime_v1") return "智能趋势策略 V1";
  return "经典补仓策略";
}
function getStrategyMode(acc = {}) {
  const type = getStrategyType(acc);
  return type === "trend_only_v2" ? "Trend Only V2" : type === "trend_only_v1" ? "Trend Only V1" : type === "smart_regime_v1" ? "智能V1" : "DCA基础模式";
}
function isTrendOnly(acc) { return ["trend_only_v1", "trend_only_v2"].includes(getStrategyType(acc)); }
function isTrendOnlyV2(acc) { return getStrategyType(acc) === "trend_only_v2"; }
function trendEngine(accOrType) { return (typeof accOrType === "string" ? accOrType : getStrategyType(accOrType)) === "trend_only_v2" ? TrendOnlyV2 : TrendOnly; }
const zlib = require("zlib");
const { spawn } = require("child_process");
const {
  SMART_STRATEGY_DEFAULTS,
  normalizeSmartConfig,
  calculateSmartAddPlan,
  calculateSmartTrailingPrice,
  calculateSmartMinimumProfitDistance,
  tightenSmartTrailingPrice,
  isSmartDailyLossLocked,
  canEnterSmartSignal,
  advanceSmartExitConfirmation,
  analyzeSmartStrategy
} = require("./smart_strategy");
const {
  DEFAULT_TAKER_FEE_RATE,
  extractOrderId,
  buildVoucherDedupeKey,
  dedupeVouchers,
  summarizeHyperliquidCycle
} = require("./trade_accounting");
const {
  classifyTradingError,
  calculateMarketableLimitPrice,
  formatHyperliquidPrice,
  isBelowMinimumCloseNotional,
  formatBinanceOrderQuantity
} = require("./trading_safety");
const {
  normalizeInstrumentSymbol,
  listInstruments,
  getInstrument,
  isInstrumentAllowed,
  getInstrumentGroups
} = require("./instrument_catalog");

let ExchangeClient;
let HttpTransport;
let privateKeyToAccount;

let hlTransport;

async function initSdk() {
  const hyperliquidModule = await import("@nktkas/hyperliquid");
  const viemAccountsModule = await import("viem/accounts");

  ExchangeClient = hyperliquidModule.ExchangeClient;
  HttpTransport = hyperliquidModule.HttpTransport;
  privateKeyToAccount = viemAccountsModule.privateKeyToAccount;

  hlTransport = new HttpTransport();
}

const PORT = 3000;
const CONFIG_PATH = path.join(__dirname, "config.json");
const PUBLIC_DIR = path.resolve(__dirname, "public");
const HISTORY_PATH = path.join(__dirname, "profit_history.json");
const AUTH_PATH = path.join(__dirname, "auth.json");
const SIM_ORDERS_PATH = path.join(__dirname, "simulation_orders.json");
const SMART_RUNTIME_PATH = path.join(__dirname, "smart_runtime.json");
const TRADE_LOCK_DIR = path.join(__dirname, ".trade-locks");
const EXTENDED_BASE_URL = "https://api.starknet.extended.exchange";
const EXTENDED_PY_FILE = path.join(__dirname, "extended_order.py");
const PUBLIC_API_TOKEN = "superflow_public_123456";

// ====== 多账户扩容配置：不改变策略逻辑，只优化调度与操作默认值 ======
const DEFAULT_ACCOUNT_INTERVAL_MS = 15000;
const MIN_ACCOUNT_INTERVAL_MS = 15000;
const HYPERLIQUID_MIN_ORDER_NOTIONAL_U = 10;
const SMART_MIN_ORDER_BUFFER_U = 0.25;
const SMART_DUST_POSITION_NOTIONAL_U = 10;
const DEFAULT_SCHEDULER_CONCURRENCY = 3;
const MAX_SCHEDULER_CONCURRENCY = 5;
const PRICE_CACHE_TTL_MS = 5000;
const ACCOUNT_START_SYNC_CONCURRENCY = 2;
const MARKET_KLINE_CACHE_TTL_MS = 12000;
const HL_META_CACHE_TTL_MS = 15000;
const HL_META_STALE_MAX_MS = 5 * 60 * 1000;
const HL_META_FAILURE_BACKOFF_MS = 30000;
const SIMULATION_STATS_CACHE_TTL_MS = 10000;
const PUBLIC_VOUCHER_CACHE_TTL_MS = 5000;
const BINANCE_EXCHANGE_INFO_TTL_MS = 10 * 60 * 1000;
const BINANCE_EXCHANGE_INFO_STALE_MAX_MS = 6 * 60 * 60 * 1000;
const PERSIST_DEBOUNCE_MS = 250;
const MARKET_KLINE_INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]);
const marketKlineCache = new Map();
const marketKlineInFlight = new Map();
const marketContextCache = new Map();
let binanceExchangeInfoCache = { ts: 0, data: null };
let binanceExchangeInfoInFlight = null;
let simulationStatsCache = {
  ts: 0,
  value: null
};
let configRevision = 0;

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSmartMinimumOrderNotional(acc) {
  if (!isSimulationAccount(acc) && acc?.platform === "hyperliquid") {
    return HYPERLIQUID_MIN_ORDER_NOTIONAL_U + SMART_MIN_ORDER_BUFFER_U;
  }
  return 1;
}

function isUntrackedSmartDust(acc, st, positionNotionalU) {
  if (!isSmartStrategy(acc) || isSimulationAccount(acc)) return false;
  const orderIds = Array.isArray(st.smartOrderIds) ? st.smartOrderIds.filter(Boolean) : [];
  const hasTrackedCycle =
    Number(st.smartOpenedAt || 0) > 0 ||
    Number(st.smartTradedNotionalU || 0) > 0 ||
    orderIds.length > 0;
  return !hasTrackedCycle &&
    Number(positionNotionalU) > 0 &&
    Number(positionNotionalU) < SMART_DUST_POSITION_NOTIONAL_U;
}

function ensureTradeLockDir() {
  if (!fs.existsSync(TRADE_LOCK_DIR)) fs.mkdirSync(TRADE_LOCK_DIR, { recursive: true });
}

function acquireAccountTradeLock(accountId, staleMs = 5 * 60 * 1000) {
  ensureTradeLockDir();
  const safeId = String(accountId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const lockPath = path.join(TRADE_LOCK_DIR, `${safeId}.lock`);
  const tryOpen = () => {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), "utf-8");
    return { fd, lockPath };
  };

  try {
    return tryOpen();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs <= staleMs) return null;
      fs.unlinkSync(lockPath);
      return tryOpen();
    } catch (retryError) {
      if (retryError?.code === "ENOENT") {
        try { return tryOpen(); } catch (_) { return null; }
      }
      return null;
    }
  }
}

function releaseAccountTradeLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch (_) {}
  try { fs.unlinkSync(lock.lockPath); } catch (_) {}
}

async function fetchJsonWithRetry(url, options = {}, label = "外部请求", retries = 2, timeoutMs = 10000) {
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`${label} HTTP ${res.status}`);
      }

      return await res.json();
    } catch (e) {
      clearTimeout(timer);

      const baseMsg =
        e?.name === "AbortError"
          ? `${label}超时`
          : `${label}失败: ${e?.message || e}`;

      lastErr = new Error(baseMsg);

      if (i < retries) {
        await sleepMs(1200);
      }
    }
  }

  throw lastErr || new Error(`${label}失败`);
}

function normalizeMarketKlineRow(row) {
  if (!Array.isArray(row) || row.length < 6) return null;
  const item = {
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5])
  };
  return Object.values(item).every(Number.isFinite) && item.time > 0 ? item : null;
}

function normalizeHyperliquidCandleRow(row) {
  if (!row || typeof row !== "object") return null;
  const item = {
    time: Number(row.t),
    open: Number(row.o),
    high: Number(row.h),
    low: Number(row.l),
    close: Number(row.c),
    volume: Number(row.v)
  };
  return Object.values(item).every(Number.isFinite) && item.time > 0 ? item : null;
}

function marketKlineIntervalMs(interval) {
  return ({
    "1m": 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000,
    "1w": 7 * 24 * 60 * 60 * 1000,
    "1M": 30 * 24 * 60 * 60 * 1000
  })[interval] || 60 * 60 * 1000;
}

async function getPublicMarketKlines(symbol, interval, limit, platform = "") {
  const base = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(USDT|USDC|USD)$/, "");
  const safeInterval = MARKET_KLINE_INTERVALS.has(interval) ? interval : "1h";
  const safeLimit = Math.min(Math.max(Number(limit || 260), 80), 300);
  const normalizedPlatform = String(platform || "").toLowerCase();
  const platformInstrument = getInstrument(normalizedPlatform, base);
  const binanceTradFi = normalizedPlatform === "binance" && platformInstrument?.group === "tradfi";
  if (!base || base.length > 10) throw new Error("Invalid market symbol");

  const cacheKey = `${normalizedPlatform || "public"}:${base}:${safeInterval}:${safeLimit}`;
  const cached = marketKlineCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < MARKET_KLINE_CACHE_TTL_MS) return cached.value;
  const existingRequest = marketKlineInFlight.get(cacheKey);
  if (existingRequest) return await existingRequest;

  const request = (async () => {
    const providers = [
    ...(normalizedPlatform === "hyperliquid" ? [{
      name: "hyperliquid",
      url: "https://api.hyperliquid.xyz/info",
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "candleSnapshot",
          req: {
            coin: base,
            interval: safeInterval,
            startTime: Date.now() - marketKlineIntervalMs(safeInterval) * (safeLimit + 5),
            endTime: Date.now()
          }
        })
      },
      parse(data) {
        return Array.isArray(data) ? data.map(normalizeHyperliquidCandleRow).filter(Boolean) : [];
      }
    }] : []),
    {
      name: "futures",
      url: `https://fapi.binance.com/fapi/v1/klines?symbol=${base}USDT&interval=${safeInterval}&limit=${safeLimit}`,
      parse(data) {
        return Array.isArray(data) ? data.map(normalizeMarketKlineRow).filter(Boolean) : [];
      }
    },
    ...(!binanceTradFi ? [{
      name: "spot",
      url: `https://api.binance.com/api/v3/klines?symbol=${base}USDT&interval=${safeInterval}&limit=${safeLimit}`,
      parse(data) {
        return Array.isArray(data) ? data.map(normalizeMarketKlineRow).filter(Boolean) : [];
      }
    },
    {
      name: "market-reference",
      url: `https://www.okx.com/api/v5/market/candles?instId=${base}-USDT&bar=${({
        "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H",
        "4h": "4H", "1d": "1Dutc", "1w": "1Wutc", "1M": "1Mutc"
      })[safeInterval]}&limit=${safeLimit}`,
      parse(data) {
        const rows = Array.isArray(data?.data) ? data.data : [];
        return rows.map(normalizeMarketKlineRow).filter(Boolean).sort((a, b) => a.time - b.time);
      }
    }] : [])
    ];

    let lastError = null;
    for (const provider of providers) {
      try {
        const raw = await fetchJsonWithRetry(provider.url, provider.options || {}, `${provider.name} K线`, 0, 6500);
        const candles = provider.parse(raw).sort((a, b) => a.time - b.time);
        if (candles.length < 20) throw new Error("K线数据不足");
        const expectedProvider = normalizedPlatform === "hyperliquid"
          ? "hyperliquid"
          : normalizedPlatform === "binance"
            ? "futures"
            : "";
        const crossVenueFallback = !!expectedProvider && provider.name !== expectedProvider;
        const value = {
          ok: true,
          symbol: `${base}USDT`,
          interval: safeInterval,
          source: provider.name,
          stale: crossVenueFallback,
          warning: crossVenueFallback ? `${normalizedPlatform} candles unavailable; entries are blocked on cross-venue fallback data` : "",
          updatedAt: Date.now(),
          candles
        };
        marketKlineCache.set(cacheKey, { ts: Date.now(), value });
        return value;
      } catch (e) {
        lastError = e;
      }
    }

    if (cached?.value?.candles?.length) {
      return { ...cached.value, stale: true, warning: lastError?.message || "Market data temporarily unavailable" };
    }
    throw lastError || new Error("Market K-line data is unavailable");
  })();

  marketKlineInFlight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (marketKlineInFlight.get(cacheKey) === request) marketKlineInFlight.delete(cacheKey);
  }
}

async function runTradingActionWithRetry(accountId, label, task, retries = 2, delayMs = 2500) {
  let lastErr = null;

  for (let i = 0; i <= retries; i++) {
    try {
      return await task();
    } catch (e) {
      lastErr = e;
      const policy = classifyTradingError(e);
      const text = `${label}失败，第 ${i + 1}/${retries + 1} 次：${e?.message || e}`;
      addLog(accountId, text);
      console.error(text);

      if (!policy.retryable) break;
      if (i < retries) {
        await sleepMs(delayMs);
      }
    }
  }

  throw lastErr || new Error(`${label}失败`);
}


const marketPriceCache = new Map();

function normalizeIntervalMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ACCOUNT_INTERVAL_MS;
  return Math.max(Math.floor(n), MIN_ACCOUNT_INTERVAL_MS);
}

function getSchedulerConcurrency(cfg) {
  const raw = Number(cfg?.schedulerConcurrency || DEFAULT_SCHEDULER_CONCURRENCY);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SCHEDULER_CONCURRENCY;
  return Math.min(Math.max(Math.floor(raw), 1), MAX_SCHEDULER_CONCURRENCY);
}

async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const size = Math.min(Math.max(Number(limit || 1), 1), Math.max(list.length, 1));
  let cursor = 0;

  async function runner() {
    while (cursor < list.length) {
      const idx = cursor++;
      await worker(list[idx], idx);
    }
  }

  const workers = [];
  for (let i = 0; i < size; i++) workers.push(runner());
  await Promise.all(workers);
}


let hlMetaCache = {
  ts: 0,
  data: null
};
let hlMetaInFlight = null;
let hlMetaFailureUntil = 0;

function ensureFileExists(filePath, fallbackContent) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, fallbackContent, "utf-8");
  }
}

const IS_PRODUCTION = process.env.NODE_ENV === "production";
const HTTPS_PROXY_TRUSTED = [process.env.TRUST_PROXY, process.env.HTTPS_PROXY_ENABLED, process.env.BEHIND_HTTPS_PROXY]
  .some(value => /^(1|true|yes)$/i.test(String(value || "")));
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map();

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const digest = crypto.scryptSync(String(password || ""), salt, 64).toString("hex");
  return `scrypt$${salt}$${digest}`;
}

function verifyPassword(password, encoded) {
  const [scheme, salt, expectedHex] = String(encoded || "").split("$");
  if (scheme !== "scrypt" || !salt || !/^[a-f0-9]{128}$/i.test(expectedHex || "")) return false;
  const actual = crypto.scryptSync(String(password || ""), salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function saveAuthConfig(auth) {
  const tempPath = `${AUTH_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(auth, null, 2), "utf-8");
  fs.renameSync(tempPath, AUTH_PATH);
}

function sessionCookie(sid, maxAge) {
  return `sid=${encodeURIComponent(sid || "")}; Path=/; HttpOnly; SameSite=Lax${IS_PRODUCTION ? "; Secure" : ""}; Max-Age=${maxAge}`;
}

function loginKey(req, username) {
  const forwarded = HTTPS_PROXY_TRUSTED ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  const ip = forwarded || req.socket?.remoteAddress || "unknown";
  return `${ip}:${String(username || "").toLowerCase()}`;
}

function loginRateState(key, now = Date.now()) {
  const current = loginFailures.get(key);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    const fresh = { count: 0, startedAt: now };
    loginFailures.set(key, fresh);
    return fresh;
  }
  return current;
}

ensureFileExists(HISTORY_PATH, "{}");
ensureFileExists(SIM_ORDERS_PATH, "{}");
ensureFileExists(SMART_RUNTIME_PATH, "{}");
ensureFileExists(
  AUTH_PATH,
  JSON.stringify(
    {
      adminUsername: "admin",
      passwordHash: hashPassword("admin123456")
    },
    null,
    2
  )
);

if (IS_PRODUCTION && !HTTPS_PROXY_TRUSTED) {
  console.error("[SECURITY][HIGH] NODE_ENV=production 但未声明可信 HTTPS 反向代理。请启用 HTTPS，并设置 TRUST_PROXY=true（或 HTTPS_PROXY_ENABLED=true）。");
}
try {
  const authAtStartup = JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
  if (authAtStartup.adminPassword && !authAtStartup.passwordHash) {
    console.warn("[SECURITY] auth.json 仍使用明文管理员密码；下次成功登录后将自动迁移为 scrypt passwordHash。");
  }
} catch (_) {}

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
  configRevision += 1;
}

function persistAccountRunning(accountId, running) {
  const cfg = loadConfig();
  const target = (cfg.accounts || []).find(a => a.id === accountId);
  if (!target) return;
  target.running = !!running;
  saveConfig(cfg);
  config = cfg;
}

function loadHistoryMap() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf-8"));
  } catch (e) {
    return {};
  }
}

function saveHistoryMap(historyMap) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(historyMap, null, 2), "utf-8");
}

function loadSimulationOrdersMap() {
  try {
    return JSON.parse(fs.readFileSync(SIM_ORDERS_PATH, "utf-8"));
  } catch (e) {
    return {};
  }
}

function saveSimulationOrdersMap(ordersMap) {
  fs.writeFileSync(SIM_ORDERS_PATH, JSON.stringify(ordersMap, null, 2), "utf-8");
}

function loadSmartRuntimeMap() {
  try {
    return JSON.parse(fs.readFileSync(SMART_RUNTIME_PATH, "utf-8"));
  } catch (e) {
    return {};
  }
}

function saveSmartRuntimeMap(runtimeMap) {
  fs.writeFileSync(SMART_RUNTIME_PATH, JSON.stringify(runtimeMap, null, 2), "utf-8");
}

function createDebouncedAtomicWriter(filePath, getValue, label) {
  let timer = null;
  let chain = Promise.resolve();
  let revision = 0;

  const schedule = () => {
    revision += 1;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const writeRevision = revision;
      const payload = JSON.stringify(getValue(), null, 2);
      const tempPath = `${filePath}.tmp-${process.pid}-${writeRevision}`;

      chain = chain
        .then(async () => {
          await fs.promises.writeFile(tempPath, payload, "utf-8");
          await fs.promises.rename(tempPath, filePath);
        })
        .catch((error) => {
          console.error(`${label} async save failed:`, error?.message || error);
          try {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
          } catch (_) {}
        });
    }, PERSIST_DEBOUNCE_MS);
  };

  const flushSync = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fs.writeFileSync(filePath, JSON.stringify(getValue(), null, 2), "utf-8");
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await chain;
    const payload = JSON.stringify(getValue(), null, 2);
    const tempPath = `${filePath}.tmp-${process.pid}-flush`;
    await fs.promises.writeFile(tempPath, payload, "utf-8");
    await fs.promises.rename(tempPath, filePath);
  };

  return { schedule, flush, flushSync };
}

const SMART_RUNTIME_KEYS = [
  "entryPrice", "positionQty", "positionValueU", "marginUsedU", "marginRatio",
  "nextAddPrice", "nextAddAmountU", "nextAddNotionalU", "nextTakeProfitPrice",
  "nextTakeProfitTargetU", "pnl", "roi", "addCount", "cycleCount",
  "lastActionPrice", "lastOrderTs", "lastAddTs", "simInitialBalance", "simBalance",
  "simRealizedPnl", "smartSide", "smartRegime", "smartScore", "smartLongScore",
  "smartShortScore", "smartAtr", "smartVolatilityPercentile", "smartRiskOff",
  "smartReduceRisk", "smartSignalUpdatedAt", "smartStopPrice",
  "smartTakeProfitPrice", "smartTrailingPrice", "smartTrailingActive",
  "smartPeakPrice", "smartInitialNotional", "smartOpenedAt", "smartPauseUntil",
  "smartEntrySignalTime", "smartLastClosedSignalTime", "smartOrderBackoffUntil",
  "smartExitSignalTime", "smartExitSignalCount", "smartLossLockedUntil",
  "smartDailyDate", "smartDailyPnl", "smartDayStartEquity",
  "smartConsecutiveLosses", "smartLastCloseReason", "smartOrderIds",
  "smartTradedNotionalU"
];

function refreshSmartRuntimeFromDisk(account, st) {
  if (!isSmartStrategy(account) || !st) return;
  const diskMap = loadSmartRuntimeMap();
  const saved = diskMap?.[account.id];
  if (!saved || typeof saved !== "object") return;
  for (const key of SMART_RUNTIME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) {
      st[key] = Array.isArray(saved[key]) ? [...saved[key]] : saved[key];
    }
  }
}

function loadAuthConfig() {
  return JSON.parse(fs.readFileSync(AUTH_PATH, "utf-8"));
}

function sign(query, secret) {
  return crypto.createHmac("sha256", secret).update(query).digest("hex");
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach(part => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function makeSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

const sessions = new Map();

function createSession(username) {
  const sid = makeSessionId();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  sessions.set(sid, { username, expiresAt });
  return sid;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  const sid = cookies.sid;
  if (!sid) return false;

  const session = sessions.get(sid);
  if (!session) return false;

  if (Date.now() > session.expiresAt) {
    sessions.delete(sid);
    return false;
  }

  return true;
}

function clearExpiredSessions() {
  const now = Date.now();
  for (const [sid, session] of sessions.entries()) {
    if (now > session.expiresAt) {
      sessions.delete(sid);
    }
  }
}

setInterval(clearExpiredSessions, 60 * 1000);

let config = loadConfig();
let historyMap = loadHistoryMap();
let simulationOrdersMap = loadSimulationOrdersMap();
let smartRuntimeMap = loadSmartRuntimeMap();
const trendRuntime = createTrendRuntime({
  directory: __dirname, isPaper: isSimulationAccount, log: addLog, history: addProfitHistory,
  conflictingAccount: acc => !isSimulationAccount(acc) && config.accounts.some(other => other.id !== acc.id && !isSimulationAccount(other) && other.platform === acc.platform && other.symbol === acc.symbol &&
    (acc.platform === "hyperliquid" ? String(other.address).toLowerCase() === String(acc.address).toLowerCase() : other.apiKey === acc.apiKey) &&
    (stateMap[other.id]?.running || Number(stateMap[other.id]?.positionQty) > 0 || (isTrendOnly(other) && trendRuntime.busy(other)))),
  price: getFreshMarketPrice, candles: getPublicMarketKlines,
  hyperAccount: getHyperAccount, hyperMeta: getHlAssetMeta, binanceMeta: getBinanceSymbolMeta,
  hyperOrder: placeHyperliquidOrder, hyperStop: placeHyperliquidProtectiveStop, hyperCancel: cancelHyperliquidOrder, hyperLeverage: syncHyperliquidLeverage,
  request: (u, o) => fetchJsonWithRetry(u, o, "趋势交易所请求", 0, 10000)
});
let stateMap = {};
let historyRevision = 0;
const historyWriter = createDebouncedAtomicWriter(HISTORY_PATH, () => historyMap, "profit history");
const simulationOrdersWriter = createDebouncedAtomicWriter(
  SIM_ORDERS_PATH,
  () => simulationOrdersMap,
  "simulation orders"
);
const smartRuntimeWriter = createDebouncedAtomicWriter(
  SMART_RUNTIME_PATH,
  () => smartRuntimeMap,
  "smart runtime"
);
let publicVoucherCache = {
  revision: -1,
  configRevision: -1,
  builtAt: 0,
  items: [],
  payloads: new Map()
};

function createAccountState(account) {
  const simulationBalance = getSimulationInitialBalance(account);
  const baseState = {
    running: !!account.running,
    mode: "实盘版",
    symbol: account.symbol,
    currentPrice: 0,
    entryPrice: 0,
    positionQty: 0,
    positionValueU: 0,
    marginUsedU: 0,
    nextAddPrice: 0,
    nextAddAmountU: 0,
    nextAddNotionalU: 0,
    nextTakeProfitPrice: 0,
    nextTakeProfitTargetU: 0,
    pnl: 0,
    roi: 0,
    addCount: 0,
    cycleCount: 0,
    lastAction: "未启动",
    lastActionPrice: 0,
    lastError: "",
    updatedAt: "",
    logs: [],
    profitHistory: Array.isArray(historyMap?.[account.id]) ? historyMap[account.id] : [],
    lastTickTs: 0,
    nextTickAt: 0,
    tickRunning: false,
    lastOrderTs: 0,
    lastAddTs: 0,
    placingOrder: false,
    balance: 0,
    available: 0,
    marginRatio: 0,
    realEntryPrice: "-",
    realUnrealizedPnl: "-",
    realPositionSize: "-",
    simInitialBalance: simulationBalance,
    simBalance: simulationBalance,
    simRealizedPnl: 0,
    smartSide: "",
    smartRegime: "WAITING",
    smartScore: 0,
    smartLongScore: 0,
    smartShortScore: 0,
    smartAtr: 0,
    smartVolatilityPercentile: 0,
    smartRiskOff: false,
    smartReduceRisk: false,
    smartSignalUpdatedAt: "",
    smartStopPrice: 0,
    smartTakeProfitPrice: 0,
    smartTrailingPrice: 0,
    smartTrailingActive: false,
    smartPeakPrice: 0,
    smartInitialNotional: 0,
    smartOpenedAt: 0,
    smartPauseUntil: 0,
    smartEntrySignalTime: 0,
    smartLastClosedSignalTime: 0,
    smartOrderBackoffUntil: 0,
    smartExitSignalTime: 0,
    smartExitSignalCount: 0,
    smartLossLockedUntil: 0,
    smartDailyDate: "",
    smartDailyPnl: 0,
    smartDayStartEquity: 0,
    smartConsecutiveLosses: 0,
    smartLastCloseReason: "",
    smartOrderIds: [],
    smartTradedNotionalU: 0
  };
  const saved = isSmartStrategy(account) && smartRuntimeMap[account.id]
    ? smartRuntimeMap[account.id]
    : {};
  return {
    ...baseState,
    ...saved,
    running: !!account.running,
    symbol: account.symbol,
    tickRunning: false
  };
}

function isSimulationAccount(account) {
  return account?.simulationEnabled === true || account?.tradeMode === "simulation";
}

function isSmartStrategy(account) {
  return getStrategyType(account) === "smart_regime_v1";
}

function persistSmartRuntime(account, st) {
  if (!isSmartStrategy(account) || !st) return;
  smartRuntimeMap[account.id] = Object.fromEntries(
    SMART_RUNTIME_KEYS.map(key => [key, Array.isArray(st[key]) ? [...st[key]] : st[key]])
  );
  smartRuntimeWriter.schedule();
}

function clearSmartRuntime(accountId) {
  if (!smartRuntimeMap[accountId]) return;
  delete smartRuntimeMap[accountId];
  smartRuntimeWriter.schedule();
}

function getSimulationInitialBalance(account) {
  const n = Number(account?.simulationBalance);
  return Number.isFinite(n) && n > 0 ? n : 10000;
}

function ensureSimulationState(st, acc) {
  if (!st) return;

  const configuredBalance = getSimulationInitialBalance(acc);
  if (!Number.isFinite(Number(st.simInitialBalance))) {
    st.simInitialBalance = configuredBalance;
  }
  if (!Number.isFinite(Number(st.simBalance))) {
    st.simBalance = configuredBalance;
  }
  if (!Number.isFinite(Number(st.simRealizedPnl))) {
    st.simRealizedPnl = 0;
  }

  if (!st.running && !st.positionQty && Number(st.simInitialBalance) !== configuredBalance) {
    st.simInitialBalance = configuredBalance;
    st.simBalance = configuredBalance;
    st.simRealizedPnl = 0;
  }
}

function getSimulatedFillPrice(acc, side, refPrice) {
  const base = Number(refPrice);
  if (!Number.isFinite(base) || base <= 0) {
    throw new Error("模拟交易价格无效");
  }

  const slippageBps = Number(acc.simulationSlippageBps || 0);
  const boundedBps = Number.isFinite(slippageBps) ? Math.max(0, Math.min(slippageBps, 1000)) : 0;
  const factor = side === "buy" ? (1 + boundedBps / 10000) : (1 - boundedBps / 10000);
  return Number((base * factor).toFixed(6));
}

function normalizeDisplayOrderId(value) {
  const id = String(value || "").trim();
  if (!id) return "";
  return /^sim[-_]?/i.test(id)
    ? "AGT-" + id.replace(/^sim[-_]?/i, "")
    : id;
}

function buildSimulationOrder({ acc, side, size, price, reduceOnly }) {
  const id = "AGT-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex");
  const order = {
    price: Number(price),
    size: Number(size),
    side,
    reduceOnly: !!reduceOnly,
    platformOrderId: id,
    result: {
      simulation: true,
      orderId: id,
      platform: acc.platform,
      symbol: acc.symbol,
      side,
      size: Number(size),
      price: Number(price),
      reduceOnly: !!reduceOnly
    }
  };
  appendSimulationOrder(acc, order);
  return order;
}

function appendSimulationOrder(acc, order) {
  try {
    const accountId = acc.id || "unknown";
    const items = Array.isArray(simulationOrdersMap[accountId])
      ? simulationOrdersMap[accountId]
      : [];
    const notional = Number((Number(order.price || 0) * Number(order.size || 0)).toFixed(4));

    items.unshift({
      id: order.platformOrderId || order.result?.orderId || ("AGT-" + Date.now()),
      time: new Date().toLocaleString("zh-CN"),
      ts: Date.now(),
      accountId,
      accountName: acc.name || "",
      platform: acc.platform || "",
      symbol: acc.symbol || "",
      quoteAsset: acc.quoteAsset || (acc.platform === "extended" ? "USD" : "USDT"),
      positionSide: normalizeSideText(acc.side),
      orderSide: order.side || "",
      reduceOnly: !!order.reduceOnly,
      orderType: order.reduceOnly ? "close" : "open",
      price: Number(order.price || 0),
      size: Number(order.size || 0),
      notional,
      status: "FILLED",
      source: "simulation"
    });

    simulationOrdersMap[accountId] = items.slice(0, 1000);
    simulationStatsCache = { ts: 0, value: null };
    simulationOrdersWriter.schedule();
  } catch (e) {
    console.error("save simulation order failed:", e?.message || e);
  }
}

function assertSimulationMarginAvailable(st, acc, notionalValue) {
  const leverage = Number(acc.leverage || 1);
  const requiredMargin = Number(notionalValue) / Math.max(leverage, 1);
  const available = Number(st.available);

  if (
    Number.isFinite(requiredMargin) &&
    Number.isFinite(available) &&
    requiredMargin > available
  ) {
    throw new Error(`模拟账户保证金不足：需要=${requiredMargin.toFixed(4)}，可用=${available.toFixed(4)}`);
  }
}

function syncSimulationAccountView(st, acc) {
  ensureSimulationState(st, acc);
  const effectiveSide = isSmartStrategy(acc) ? (st.smartSide || acc.side) : acc.side;

  const currentPnl =
    st.positionQty > 0 && st.entryPrice > 0 && st.currentPrice > 0
      ? (st.currentPrice - st.entryPrice) * st.positionQty * (effectiveSide === "long" ? 1 : -1)
      : 0;
  const equity = Number((Number(st.simBalance || 0) + currentPnl).toFixed(4));
  const marginUsed = st.positionQty > 0 && st.currentPrice > 0
    ? Number(((st.positionQty * st.currentPrice) / Number(acc.leverage || 1)).toFixed(4))
    : 0;
  const available = Number((equity - marginUsed).toFixed(4));

  st.mode = "simulation";
  st.balance = equity.toFixed(2);
  st.available = available.toFixed(2);
  st.realEntryPrice = st.entryPrice ? Number(st.entryPrice).toFixed(2) : "-";
  st.realUnrealizedPnl = Number(currentPnl).toFixed(4);
  st.realPositionSize = st.positionQty ? Number(st.positionQty).toFixed(6) : "-";
}

function ensureAccountStates() {
  for (const acc of config.accounts) {
    if (!stateMap[acc.id]) {
      stateMap[acc.id] = createAccountState(acc);
    } else {
      if (!Array.isArray(stateMap[acc.id].profitHistory)) {
        stateMap[acc.id].profitHistory = Array.isArray(historyMap?.[acc.id]) ? historyMap[acc.id] : [];
      }
      if (typeof acc.running === "boolean") {
        stateMap[acc.id].running = acc.running;
      }
    }
    ensureSimulationState(stateMap[acc.id], acc);
  }

  for (const key of Object.keys(stateMap)) {
    if (!config.accounts.find(a => a.id === key)) {
      delete stateMap[key];
    }
  }
}

ensureAccountStates();

function normalizeExistingAccountIntervals() {
  let changed = false;

  for (const acc of config.accounts || []) {
    const fixed = normalizeIntervalMs(acc.interval);
    if (Number(acc.interval) !== fixed) {
      acc.interval = fixed;
      changed = true;
    }
  }

  if (changed) {
    saveConfig(config);
  }
}

normalizeExistingAccountIntervals();

function normalizeExistingSimulationDefaults() {
  config = loadConfig();
  let changed = false;

  for (const acc of config.accounts || []) {
    const migratedType = getStrategyType(acc);
    if (acc.strategyType !== migratedType) {
      acc.strategyType = migratedType;
      changed = true;
    }
    const tc = trendEngine(acc).normalizeConfig(acc.trendOnlyConfig);
    const mode = getStrategyMode(acc);
    if (JSON.stringify(acc.trendOnlyConfig) !== JSON.stringify(tc) || acc.strategyMode !== mode) { acc.trendOnlyConfig = tc; acc.strategyMode = mode; changed = true; }
    if (acc.strategyType === "smart_regime_v1") {
      const normalizedSmart = normalizeSmartConfig(acc);
      if (JSON.stringify(acc.smartStrategy || {}) !== JSON.stringify(normalizedSmart)) {
        acc.smartStrategy = normalizedSmart;
        changed = true;
      }
    }
    if (!acc.tradeMode) {
      acc.tradeMode = acc.simulationEnabled ? "simulation" : "live";
      changed = true;
    }
    if (acc.simulationEnabled === undefined) {
      acc.simulationEnabled = acc.tradeMode === "simulation";
      changed = true;
    }
    if (!Number.isFinite(Number(acc.simulationBalance)) || Number(acc.simulationBalance) <= 0) {
      acc.simulationBalance = 10000;
      changed = true;
    }
    if (!Number.isFinite(Number(acc.simulationSlippageBps)) || Number(acc.simulationSlippageBps) < 0) {
      acc.simulationSlippageBps = 0;
      changed = true;
    }
  }

  if (changed) {
    saveConfig(config);
  }
}

normalizeExistingSimulationDefaults();


function getCurrentAccount() {
  return config.accounts.find(a => a.id === config.currentAccountId) || config.accounts[0];
}

function getAccountById(id) {
  return config.accounts.find(a => a.id === id) || null;
}

function addLog(accountId, text) {
  const st = stateMap[accountId];
  if (!st) return;
  const time = new Date().toLocaleTimeString("zh-CN");
  st.logs.unshift(`${time} - ${text}`);
  if (st.logs.length > 50) {
    st.logs = st.logs.slice(0, 50);
  }
}

function addProfitHistory(accountId, item) {
  const st = stateMap[accountId];
  if (!st) return false;

  item = normalizeProfitVoucher(item, accountId);
  const latest = Array.isArray(historyMap[accountId]) ? historyMap[accountId] : [];
  const alreadyExists = item.dedupeKey && latest.some(existing => existing?.dedupeKey === item.dedupeKey);
  if (alreadyExists) {
    st.profitHistory = dedupeVouchers(latest, 200);
    return false;
  }

  st.profitHistory = dedupeVouchers([item, ...latest], 200);
  historyMap[accountId] = st.profitHistory;
  historyRevision += 1;
  historyWriter.schedule();
  return true;
}


function deepFindFirst(obj, keys) {
  const wanted = new Set(keys.map(k => String(k).toLowerCase()));
  const seen = new Set();

  function walk(value) {
    if (!value || typeof value !== "object") return "";
    if (seen.has(value)) return "";
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = walk(item);
        if (found) return found;
      }
      return "";
    }

    for (const [k, v] of Object.entries(value)) {
      if (wanted.has(String(k).toLowerCase()) && v !== undefined && v !== null && String(v) !== "") {
        return String(v);
      }
    }

    for (const v of Object.values(value)) {
      const found = walk(v);
      if (found) return found;
    }
    return "";
  }

  return walk(obj);
}

function buildExplorerUrl(platform, value, address = "") {
  const v = value ? String(value) : "";
  const addr = address ? String(address) : "";

  if (platform === "hyperliquid") {
    if (addr) return `https://app.hyperliquid.xyz/explorer/address/${encodeURIComponent(addr)}`;
    if (v) return `https://app.hyperliquid.xyz/explorer/address/${encodeURIComponent(v)}`;
    return "";
  }

  if (!v) return "";

  if (platform === "binance") return `https://www.binance.com/en/futures/${encodeURIComponent(v)}`;
  if (platform === "extended") return `https://app.extended.exchange/trade`;
  return "";
}

function normalizeSideText(value, fallback = "") {
  const raw = String(value || fallback || "").trim().toLowerCase();
  if (raw === "long" || raw === "buy" || raw === "做多" || raw.includes("多")) return "long";
  if (raw === "short" || raw === "sell" || raw === "做空" || raw.includes("空")) return "short";
  return raw || "";
}

function buildProfitVoucher({
  acc,
  order,
  entryPrice,
  exitPrice,
  closeQty,
  marginUsed,
  realizedPnl,
  realizedRoi,
  addCount,
  closeReason = "",
  openedAt = 0,
  grossPnl = realizedPnl,
  tradingFee = 0,
  fundingPnl = 0,
  costSource = "legacy",
  fundingIncluded = false
}) {
  const raw = order?.result || order || {};
  const platformOrderId =
    deepFindFirst(raw, ["orderId", "order_id", "oid", "id", "clientOrderId", "client_order_id"]) ||
    deepFindFirst(order, ["orderId", "order_id", "oid", "id", "clientOrderId", "client_order_id"]);
  const platformTradeId = deepFindFirst(raw, ["tradeId", "trade_id", "tid", "fillId", "fill_id", "executionId", "execution_id"]);
  const txHash = deepFindFirst(raw, ["txHash", "transactionHash", "hash"]);
  const primaryTraceValue = txHash || platformOrderId || platformTradeId;
  const dedupeKey = buildVoucherDedupeKey({
    accountId: acc.id,
    platform: acc.platform,
    platformOrderId,
    platformTradeId,
    txHash,
    openedAt,
    entryPrice,
    closeQty
  });

  return {
    voucherId: crypto.randomBytes(10).toString("hex"),
    time: new Date().toLocaleString("zh-CN"),
    accountName: acc.name,
    platform: acc.platform,
    address: acc.address,
    symbol: acc.symbol,
    quoteAsset: acc.quoteAsset || (acc.platform === "binance" ? "USDT" : (acc.platform === "extended" ? "USD" : "USDC")),
    side: normalizeSideText(acc.side),
    leverage: acc.leverage,
    entryPrice,
    exitPrice,
    closeQty,
    marginUsed,
    pnl: Number(Number(realizedPnl || 0).toFixed(4)),
    roi: realizedRoi,
    grossPnl: Number(Number(grossPnl || 0).toFixed(4)),
    tradingFee: Number(Number(tradingFee || 0).toFixed(4)),
    fundingPnl: Number(Number(fundingPnl || 0).toFixed(4)),
    netPnl: Number(Number(realizedPnl || 0).toFixed(4)),
    costSource,
    fundingIncluded: !!fundingIncluded,
    dedupeKey,
    openedAt: Number(openedAt || 0),
    addCount,
    closeReason: closeReason || (raw.simulation ? "策略止盈" : "策略止盈触发"),
    simulation: !!raw.simulation,
    platformOrderId: normalizeDisplayOrderId(platformOrderId),
    platformTradeId: platformTradeId || "",
    txHash: txHash || "",
    explorerUrl: raw.simulation ? "" : buildExplorerUrl(acc.platform, primaryTraceValue, acc.address),
    rawOrderSummary: raw
  };
}

function normalizeProfitVoucher(item, accountId) {
  const acc = getAccountById(accountId) || {};
  const platform = item.platform || acc.platform || "-";
  const trace = item.txHash || item.platformOrderId || item.platformTradeId || "";
const address = item.address || acc.address || "";
const oldExplorerUrl = item.explorerUrl || "";
const needRebuildExplorerUrl =
  !oldExplorerUrl ||
  (platform === "hyperliquid" && oldExplorerUrl.includes("/explorer/order/"));
  const captured = value => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  const entryTimeMs = Number(item.entryTime) || Date.parse(item.entryTime || "");
  const exitTimeMs = Number(item.exitTime) || Date.parse(item.exitTime || item.time || "");
  const derivedHoldingDuration = captured(item.holdingDurationMs)
    ? Number(item.holdingDurationMs)
    : (Number.isFinite(entryTimeMs) && Number.isFinite(exitTimeMs) && exitTimeMs >= entryTimeMs ? exitTimeMs - entryTimeMs : null);
  const legacyRecord = item.legacyRecord === true || !item.entryMode || !captured(item.atrAtEntry) ||
    !captured(item.initialStopLossPrice) || !captured(item.actualRiskAmount) ||
    !captured(item.maximumAdverseExcursion) || !captured(item.maximumFavorableExcursion);
  return {
    ...item,
    accountName: item.accountName || acc.name || "-",
    platform,
    side: normalizeSideText(item.side, acc.side),
    quoteAsset: item.quoteAsset || acc.quoteAsset || (platform === "binance" ? "USDT" : (platform === "extended" ? "USD" : "USDC")),
    grossPnl: Number.isFinite(Number(item.grossPnl)) ? Number(item.grossPnl) : Number(item.pnl || 0),
    tradingFee: Number.isFinite(Number(item.tradingFee)) ? Number(item.tradingFee) : 0,
    fundingPnl: Number.isFinite(Number(item.fundingPnl)) ? Number(item.fundingPnl) : 0,
    netPnl: Number.isFinite(Number(item.netPnl)) ? Number(item.netPnl) : Number(item.pnl || 0),
    costSource: item.costSource || "legacy-unadjusted",
    fundingIncluded: item.fundingIncluded === true,
    holdingDurationMs: derivedHoldingDuration,
    legacyRecord,
    closeReason: /simulation/i.test(String(item.closeReason || ""))
      ? "策略止盈"
      : (item.closeReason || "策略止盈触发"),
    platformOrderId: normalizeDisplayOrderId(item.platformOrderId),
    platformTradeId: item.platformTradeId || "",
    txHash: item.txHash || "",
    explorerUrl: item.simulation
      ? ""
      : (needRebuildExplorerUrl
        ? buildExplorerUrl(platform, trace, address)
        : oldExplorerUrl),
    voucherId: item.voucherId || "legacy-" + crypto.createHash("sha1").update(JSON.stringify(item)).digest("hex").slice(0, 12)
  };
}

function sanitizePublicVoucher(item) {
  return {
    voucherId: item.voucherId || "",
    time: item.time || "",
    accountName: item.accountName || "",
    platform: item.platform || "",
    symbol: item.symbol || "",
    quoteAsset: item.quoteAsset || "",
    side: normalizeSideText(item.side),
    leverage: item.leverage || "",
    entryPrice: item.entryPrice || 0,
    exitPrice: item.exitPrice || 0,
    closeQty: item.closeQty || 0,
    marginUsed: item.marginUsed || 0,
    pnl: item.pnl || 0,
    roi: item.roi || 0,
    grossPnl: item.grossPnl || 0,
    tradingFee: item.tradingFee || 0,
    fundingPnl: item.fundingPnl || 0,
    netPnl: Number.isFinite(Number(item.netPnl)) ? Number(item.netPnl) : Number(item.pnl || 0),
    costSource: item.costSource || "legacy-unadjusted",
    fundingIncluded: item.fundingIncluded === true,
    addCount: item.addCount || 0,
    closeReason: item.closeReason || "",
    entryMode: item.entryMode || "",
    holdingDurationMs: item.holdingDurationMs ?? null,
    legacyRecord: item.legacyRecord === true,
    rMultiple: item.rMultiple ?? null,
    maximumAdverseExcursion: item.maximumAdverseExcursion ?? null,
    maximumFavorableExcursion: item.maximumFavorableExcursion ?? null,
    MAE_R: item.MAE_R ?? null,
    MFE_R: item.MFE_R ?? null,
    stopTriggerPrice: item.stopTriggerPrice ?? null,
    stopExecutionPrice: item.stopExecutionPrice ?? null,
    stopSlippageBps: item.stopSlippageBps ?? null,
    stopSlippageAmount: item.stopSlippageAmount ?? null,
    stopExecutionMode: item.stopExecutionMode || "",
    simulation: !!item.simulation,
    platformOrderId: item.platformOrderId || "",
    platformTradeId: item.platformTradeId || "",
    txHash: item.txHash || "",
    explorerUrl: item.explorerUrl || ""
  };
}

function isPublicApiAuthorized(req) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "").trim();
  return token === PUBLIC_API_TOKEN;
}

function getAllSimulationVouchers() {
  const items = [];

  for (const acc of config.accounts || []) {
    const st = stateMap[acc.id];
    const history = Array.isArray(st?.profitHistory)
      ? st.profitHistory
      : (Array.isArray(historyMap?.[acc.id]) ? historyMap[acc.id] : []);

    for (const rawItem of history) {
      const item = normalizeProfitVoucher(rawItem, acc.id);
      const rawSummary = item.rawOrderSummary || rawItem.rawOrderSummary || {};
      const isSimulation =
        !!item.simulation ||
        !!rawItem.simulation ||
        !!rawSummary.simulation ||
        String(item.platformOrderId || rawItem.platformOrderId || "").startsWith("sim-") ||
        String(item.closeReason || rawItem.closeReason || "").toLowerCase().includes("simulation") ||
        isSimulationAccount(acc);

      if (!isSimulation) continue;
      items.push({
        ...item,
        simulation: true,
        accountId: acc.id,
        accountName: item.accountName || acc.name || "",
        platform: item.platform || acc.platform || "",
        symbol: item.symbol || acc.symbol || "",
        quoteAsset: item.quoteAsset || acc.quoteAsset || ""
      });
    }
  }

  return items;
}

function getSimulationVoucherNotional(item) {
  const qty = Math.abs(Number(item.closeQty || 0));
  const entryPrice = Math.abs(Number(item.entryPrice || 0));
  const exitPrice = Math.abs(Number(item.exitPrice || 0));
  if (!Number.isFinite(qty) || !Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) return 0;
  return Number(((entryPrice * qty) + (exitPrice * qty)).toFixed(4));
}

function getSimulationVoucherOrderCount(item) {
  const addCount = Math.max(0, Math.floor(Number(item.addCount || 0)));
  return 2 + addCount;
}

function buildSimulationStatsSnapshot() {
  const items = getAllSimulationVouchers();
  const byPlatform = {};
  let orderCount = 0;
  let roiTotal = 0;
  let roiCount = 0;

  for (const item of items) {
    const platform = String(item.platform || "unknown").toLowerCase();
    if (!byPlatform[platform]) {
      byPlatform[platform] = {
        platform,
        orderCount: 0,
        closedCycleCount: 0,
        totalTradeAmount: 0,
        totalPnl: 0
      };
    }
    const itemOrderCount = getSimulationVoucherOrderCount(item);
    byPlatform[platform].orderCount += itemOrderCount;
    byPlatform[platform].closedCycleCount += 1;
    byPlatform[platform].totalTradeAmount += getSimulationVoucherNotional(item);
    byPlatform[platform].totalPnl += Number(item.pnl || 0);
    orderCount += itemOrderCount;

    const roi = Number(item.roi || 0);
    if (Number.isFinite(roi)) {
      roiTotal += roi;
      roiCount += 1;
    }
  }

  for (const value of Object.values(byPlatform)) {
    value.totalTradeAmount = Number(value.totalTradeAmount.toFixed(4));
    value.totalPnl = Number(value.totalPnl.toFixed(4));
  }

  return {
    platforms: byPlatform,
    orderCount: {
      ok: true,
      tradeMode: "simulation",
      orderCount,
      closedCycleCount: items.length,
      byPlatform: Object.values(byPlatform).map(value => ({
        platform: value.platform,
        orderCount: value.orderCount,
        closedCycleCount: value.closedCycleCount,
        totalTradeAmount: value.totalTradeAmount
      }))
    },
    averageRoi: {
      ok: true,
      tradeMode: "simulation",
      averageRoi: Number((roiCount ? roiTotal / roiCount : 0).toFixed(4)),
      closedCycleCount: items.length
    }
  };
}

function getSimulationStatsSnapshot() {
  const now = Date.now();
  if (
    simulationStatsCache.value &&
    now - simulationStatsCache.ts < SIMULATION_STATS_CACHE_TTL_MS
  ) {
    return simulationStatsCache;
  }

  simulationStatsCache = {
    ts: now,
    value: buildSimulationStatsSnapshot()
  };
  return simulationStatsCache;
}

function buildSimulationPlatformStats(platform) {
  const normalizedPlatform = String(platform || "").toLowerCase();
  const snapshot = getSimulationStatsSnapshot().value;
  const stats = snapshot.platforms[normalizedPlatform] || {
    platform: normalizedPlatform,
    totalTradeAmount: 0,
    orderCount: 0,
    closedCycleCount: 0,
    totalPnl: 0
  };

  return {
    ok: true,
    tradeMode: "simulation",
    ...stats
  };
}

function buildSimulationOrderCountStats() {
  return getSimulationStatsSnapshot().value.orderCount;
}

function buildSimulationAverageRoiStats() {
  return getSimulationStatsSnapshot().value.averageRoi;
}

function buildSimulationSummary() {
  const snapshot = getSimulationStatsSnapshot();
  const platformStats = platform => ({
    ok: true,
    tradeMode: "simulation",
    ...(snapshot.value.platforms[platform] || {
      platform,
      totalTradeAmount: 0,
      orderCount: 0,
      closedCycleCount: 0,
      totalPnl: 0
    })
  });

  return {
    ok: true,
    tradeMode: "simulation",
    cachedAt: snapshot.ts,
    cacheTtlMs: SIMULATION_STATS_CACHE_TTL_MS,
    binance: platformStats("binance"),
    extended: platformStats("extended"),
    orderCount: snapshot.value.orderCount,
    averageRoi: snapshot.value.averageRoi
  };
}

function getAllSimulationOrders() {
  const items = [];

  for (const acc of config.accounts || []) {
    const accountOrders = Array.isArray(simulationOrdersMap[acc.id])
      ? simulationOrdersMap[acc.id]
      : [];
    for (const item of accountOrders) {
      items.push({
        ...item,
        id: normalizeDisplayOrderId(item.id),
        accountName: item.accountName || acc.name || "",
        platform: item.platform || acc.platform || "",
        symbol: item.symbol || acc.symbol || "",
        quoteAsset: item.quoteAsset || acc.quoteAsset || "",
        positionSide: normalizeSideText(item.positionSide, acc.side)
      });
    }
  }

  return items.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
}

function buildSyntheticOrderBook(price) {
  const mid = Number(price || 0);
  if (!Number.isFinite(mid) || mid <= 0) return { bids: [], asks: [] };

  const asks = [];
  const bids = [];
  for (let i = 1; i <= 12; i++) {
    asks.push({
      price: Number((mid + i * 0.01).toFixed(2)),
      size: Number((50 + i * 17.35).toFixed(3)),
      total: Number((50 + i * 31.2).toFixed(3))
    });
    bids.push({
      price: Number((mid - i * 0.01).toFixed(2)),
      size: Number((46 + i * 15.85).toFixed(3)),
      total: Number((46 + i * 28.4).toFixed(3))
    });
  }
  return { asks, bids };
}

function buildExchangeDisplayData(accountId = "") {
  const requestedAccountId = String(accountId || "").trim();
  const orders = getAllSimulationOrders()
    .filter(item => !requestedAccountId || item.accountId === requestedAccountId);
  const vouchers = getAllSimulationVouchers()
    .filter(item => !requestedAccountId || item.accountId === requestedAccountId)
    .sort((a, b) => Date.parse(String(b.time || "").replace(/\//g, "-")) - Date.parse(String(a.time || "").replace(/\//g, "-")));

  const accounts = [];
  const positions = [];

  for (const acc of config.accounts || []) {
    if (!isSimulationAccount(acc)) continue;
    if (requestedAccountId && acc.id !== requestedAccountId) continue;
    const st = stateMap[acc.id] || {};
    const effectiveSide = isSmartStrategy(acc) ? (st.smartSide || acc.side) : acc.side;
    const account = {
      id: acc.id,
      name: acc.name || "",
      platform: acc.platform || "",
      symbol: acc.symbol || "",
      quoteAsset: acc.quoteAsset || (acc.platform === "extended" ? "USD" : "USDT"),
      side: normalizeSideText(effectiveSide),
      leverage: Number(acc.leverage || 0),
      running: !!st.running,
      currentPrice: Number(st.currentPrice || 0),
      balance: Number(st.balance || 0),
      available: Number(st.available || 0),
      pnl: Number(st.pnl || 0),
      roi: Number(st.roi || 0),
      updatedAt: st.updatedAt || "",
      orderBook: buildSyntheticOrderBook(st.currentPrice)
    };
    accounts.push(account);

    if (Number(st.positionQty || 0) > 0) {
      positions.push({
        accountId: acc.id,
        accountName: acc.name || "",
        platform: acc.platform || "",
        symbol: acc.symbol || "",
        quoteAsset: account.quoteAsset,
        side: normalizeSideText(effectiveSide),
        leverage: Number(acc.leverage || 0),
        entryPrice: Number(st.entryPrice || 0),
        markPrice: Number(st.currentPrice || 0),
        liquidationPrice: Number(
          (effectiveSide === "long"
            ? Number(st.entryPrice || 0) * (1 - 1 / Math.max(Number(acc.leverage || 1), 1))
            : Number(st.entryPrice || 0) * (1 + 1 / Math.max(Number(acc.leverage || 1), 1))
          ).toFixed(2)
        ),
        size: Number(st.positionQty || 0),
        notional: Number(st.positionValueU || 0),
        margin: Number(st.marginUsedU || 0),
        marginRatio: Number(st.marginRatio || 0),
        pnl: Number(st.pnl || 0),
        roi: Number(st.roi || 0),
        addCount: Number(st.addCount || 0),
        nextAddPrice: Number(st.nextAddPrice || 0),
        nextAddNotionalU: Number(st.nextAddNotionalU || 0),
        nextAddAmountU: Number(st.nextAddAmountU || 0),
        nextTakeProfitPrice: Number(st.nextTakeProfitPrice || 0),
        strategyType: acc.strategyType || "classic",
        smartTakeProfitPrice: Number(st.smartTakeProfitPrice || 0),
        smartTrailingPrice: Number(st.smartTrailingPrice || 0),
        smartTrailingActive: !!st.smartTrailingActive,
        smartStopPrice: Number(st.smartStopPrice || 0),
        updatedAt: st.updatedAt || ""
      });
    }
  }

  return {
    ok: true,
    tradeMode: "simulation",
    updatedAt: new Date().toLocaleString("zh-CN"),
    accounts,
    positions,
    openOrders: [],
    orderHistory: orders,
    tradeHistory: orders,
    positionHistory: vouchers,
    stats: {
      binance: buildSimulationPlatformStats("binance"),
      extended: buildSimulationPlatformStats("extended"),
      orders: buildSimulationOrderCountStats(),
      averageRoi: buildSimulationAverageRoiStats()
    }
  };
}

function assertFiniteNumber(value, name, { min = null, max = null, allowZero = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是有效数字`);
  if (!allowZero && n <= 0) throw new Error(`${name} 必须大于 0`);
  if (allowZero && n < 0) throw new Error(`${name} 不能小于 0`);
  if (min !== null && n < min) throw new Error(`${name} 不能小于 ${min}`);
  if (max !== null && n > max) throw new Error(`${name} 不能大于 ${max}`);
  return n;
}

function validateAccountConfigPayload(next) {
  const modes = { "DCA基础模式": "classic", "智能V1": "smart_regime_v1", "趋势模式": "smart_regime_v1", "Trend Only V1": "trend_only_v1", "Trend Only V2": "trend_only_v2" };
  if (next.strategyMode !== undefined) {
    if (!modes[next.strategyMode]) throw new Error("策略模式无效");
    if (next.strategyType && modes[next.strategyMode] !== next.strategyType) throw new Error("策略模式字段冲突");
    next.strategyType = modes[next.strategyMode];
  }
  if (next.trendOnlyConfig !== undefined) next.trendOnlyConfig = trendEngine(next.strategyType || next.strategyMode).normalizeConfig(next.trendOnlyConfig);
  if (["trend_only_v1", "trend_only_v2"].includes(next.strategyType)) {
    next.strategyMode = next.strategyType === "trend_only_v2" ? "Trend Only V2" : "Trend Only V1";
    if (next.trendOnlyConfig) next.leverage = next.trendOnlyConfig.leverage;
    next.maxAdds = 0;
  }
  delete next.confirmLive;
  const allowedPlatforms = new Set(["hyperliquid", "binance", "extended"]);
  const allowedSides = new Set(["long", "short"]);
  const allowedTradeModes = new Set(["live", "simulation"]);
  const allowedStrategyTypes = STRATEGY_TYPES;
  if (next.platform && !allowedPlatforms.has(next.platform)) throw new Error("平台类型无效");
  if (next.side && !allowedSides.has(next.side)) throw new Error("方向无效");
  if (next.symbol) {
    next.symbol = normalizeInstrumentSymbol(next.symbol);
    const symbolAllowed = next.platform
      ? isInstrumentAllowed(next.platform, next.symbol)
      : ["hyperliquid", "binance", "extended"].some(platform => isInstrumentAllowed(platform, next.symbol));
    if (!symbolAllowed) throw new Error("当前平台不支持该交易品种");
  }

  if (next.tradeMode && !allowedTradeModes.has(next.tradeMode)) throw new Error("tradeMode is invalid");
  if (next.strategyType && !allowedStrategyTypes.has(next.strategyType)) throw new Error("strategyType is invalid");
  if (next.simulationEnabled !== undefined) next.simulationEnabled = !!next.simulationEnabled;
  if (next.smartStrategy !== undefined) {
    if (!next.smartStrategy || typeof next.smartStrategy !== "object" || Array.isArray(next.smartStrategy)) {
      throw new Error("smartStrategy is invalid");
    }
    next.smartStrategy = normalizeSmartConfig({ smartStrategy: next.smartStrategy });
  }

  const numericRules = {
    leverage: { min: 1, max: 125 },
    baseAmount: { min: 1 },
    addAmount: { min: 1 },
    takeProfit: { min: 0.0001, max: 1 },
    addTrigger: { min: 0.0001, max: 1 },
    maxAdds: { min: 0, max: 100, allowZero: true },
    interval: { min: 500 },
    simulationBalance: { min: 1 },
    simulationSlippageBps: { min: 0, max: 1000, allowZero: true }
  };
  for (const [key, rule] of Object.entries(numericRules)) {
    if (next[key] !== undefined && next[key] !== "") next[key] = assertFiniteNumber(next[key], key, rule);
  }
  if (next.platform === "binance" && next.symbol && next.leverage !== undefined) {
    const instrument = getInstrument(next.platform, next.symbol);
    const maxLeverage = Number(instrument?.maxLeverage || 0);
    if (instrument?.group === "tradfi" && maxLeverage > 0 && Number(next.leverage) > maxLeverage) {
      throw new Error(`${next.symbol} 股票永续合约杠杆不能高于 ${maxLeverage} 倍`);
    }
  }
  if (next.maxAdds !== undefined) next.maxAdds = Math.floor(next.maxAdds);
  if (next.interval !== undefined) next.interval = normalizeIntervalMs(next.interval);
  return next;
}

async function getHlMetaSnapshot() {
  const now = Date.now();
  const cacheAge = hlMetaCache.data ? now - hlMetaCache.ts : Infinity;
  if (hlMetaCache.data && cacheAge < HL_META_CACHE_TTL_MS) {
    return { data: hlMetaCache.data, stale: false, warning: "" };
  }

  if (hlMetaCache.data && now < hlMetaFailureUntil && cacheAge <= HL_META_STALE_MAX_MS) {
    return { data: hlMetaCache.data, stale: true, warning: "Hyperliquid metadata circuit breaker is active" };
  }
  if (hlMetaInFlight) return await hlMetaInFlight;

  hlMetaInFlight = (async () => {
    try {
      const data = await fetchJsonWithRetry(
        "https://api.hyperliquid.xyz/info",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs" })
        },
        "Hyper行情元数据请求",
        1,
        6500
      );

      hlMetaCache = { ts: Date.now(), data };
      hlMetaFailureUntil = 0;
      return { data, stale: false, warning: "" };
    } catch (error) {
      hlMetaFailureUntil = Date.now() + HL_META_FAILURE_BACKOFF_MS;
      const staleAge = hlMetaCache.data ? Date.now() - hlMetaCache.ts : Infinity;
      if (hlMetaCache.data && staleAge <= HL_META_STALE_MAX_MS) {
        return { data: hlMetaCache.data, stale: true, warning: error?.message || "Hyperliquid metadata unavailable" };
      }
      throw error;
    }
  })();

  try {
    return await hlMetaInFlight;
  } finally {
    hlMetaInFlight = null;
  }
}

async function getHlMeta() {
  const snapshot = await getHlMetaSnapshot();
  return snapshot.data;
}

async function getHlAssetMeta(symbol) {
  const data = await getHlMeta();
  const meta = data[0];
  const idx = meta.universe.findIndex(x => x.name === symbol);

  if (idx === -1) {
    throw new Error("Hyperliquid 找不到交易对: " + symbol);
  }

  return {
    asset: idx,
    meta: meta.universe[idx]
  };
}

async function getHlL2Book(symbol) {
  return await fetchJsonWithRetry(
    "https://api.hyperliquid.xyz/info",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "l2Book", coin: symbol })
    },
    `Hyper盘口请求(${symbol})`,
    2,
    10000
  );
}

async function getExecutablePrice(symbol, side, slippageBps = 12) {
  const book = await getHlL2Book(symbol);
  const levels = Array.isArray(book?.levels) ? book.levels : [];
  const bids = Array.isArray(levels[0]) ? levels[0] : [];
  const asks = Array.isArray(levels[1]) ? levels[1] : [];

  return calculateMarketableLimitPrice({
    side,
    bestBid: bids[0]?.px,
    bestAsk: asks[0]?.px,
    slippageBps
  });
}

function floorToDecimals(num, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.floor(Number(num) * factor) / factor;
}

function formatSizeByDecimals(size, decimals) {
  const fixed = floorToDecimals(size, decimals);
  return fixed.toFixed(decimals).replace(/\.?0+$/, "");
}

function formatPrice(price, szDecimals = 4) {
  return formatHyperliquidPrice(price, szDecimals);
}

function parseHyperliquidFillResult(result, fallbackPrice, fallbackSize) {
  const statuses =
    result?.response?.data?.statuses ||
    result?.data?.statuses ||
    result?.statuses ||
    [];

  const first = Array.isArray(statuses) ? (statuses[0] || {}) : {};

  if (first.error) {
    throw new Error(`Hyper下单失败：${first.error}`);
  }

  if (first.filled) {
    return {
      price: Number(first.filled.avgPx || first.filled.price || fallbackPrice),
      size: Number(first.filled.totalSz || first.filled.sz || fallbackSize),
      oid: first.filled.oid || first.filled.orderId || ""
    };
  }

  if (first.resting) {
    throw new Error("Hyper订单未立即成交，已阻止本地记录为已成交");
  }

  if (String(result?.status || "").toLowerCase() === "ok") {
    throw new Error("Hyper下单返回 ok，但未解析到 filled 成交明细，已阻止本地虚假加仓");
  }

  throw new Error("Hyper下单返回异常，未确认成交");
}

function createHlExchangeClient(privateKey) {
  if (!privateKey) {
    throw new Error("账户未配置 privateKey");
  }
  if (!ExchangeClient || !HttpTransport || !privateKeyToAccount || !hlTransport) {
    throw new Error("Hyperliquid SDK 尚未就绪，已阻止下单");
  }

  const pk = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const wallet = privateKeyToAccount(pk);

  return new ExchangeClient({
    transport: hlTransport,
    wallet
  });
}

async function placeHyperliquidOrder({
  account,
  symbol,
  side,
  size,
  price,
  reduceOnly = false,
  tif = "Ioc",
  slippageBps = 12,
  clientOrderId
}) {
  const { asset, meta } = await getHlAssetMeta(symbol);
  const exchange = createHlExchangeClient(account.privateKey);

  const finalPrice = price || await getExecutablePrice(symbol, side, slippageBps);

  const sizeDecimals = Number(meta?.szDecimals ?? 4);
  const finalSize = formatSizeByDecimals(size, sizeDecimals);
  const finalPriceStr = formatPrice(finalPrice, sizeDecimals);

  if (!finalSize || Number(finalSize) <= 0) {
    throw new Error(`下单数量无效，格式化后 size=${finalSize}`);
  }

  let result;
  try {
    result = await exchange.order({
      orders: [{
        a: asset,
        ...(clientOrderId ? { c: clientOrderId } : {}),
        b: side === "buy",
        p: finalPriceStr,
        s: finalSize,
        r: !!reduceOnly,
        t: { limit: { tif } }
      }],
      grouping: "na"
    });
  } catch (e) {
    throw new Error("Hyper下单请求失败: " + (e?.message || e));
  }

  const fill = parseHyperliquidFillResult(result, finalPriceStr, finalSize);

  if (!fill.size || fill.size <= 0) {
    throw new Error("Hyper订单未成交，size=0");
  }

  return {
    asset,
    price: Number(fill.price),
    size: Number(fill.size),
    side,
    reduceOnly,
    oid: fill.oid || "",
    result
  };
}

async function placeHyperliquidProtectiveStop({ account, symbol, side, size, stopPrice, clientOrderId }) {
  const { asset, meta } = await getHlAssetMeta(symbol);
  const exchange = createHlExchangeClient(account.privateKey);
  const sizeDecimals = Number(meta?.szDecimals ?? 4);
  const finalSize = formatSizeByDecimals(size, sizeDecimals);
  const triggerPx = formatPrice(stopPrice, sizeDecimals);
  // Hyperliquid market TP/SL executes as an aggressive trigger-limit order with a 10% market-slippage envelope.
  const limitPx = formatPrice(Number(stopPrice) * (side === "sell" ? 0.90 : 1.10), sizeDecimals);
  if (!(Number(finalSize) > 0 && Number(triggerPx) > 0)) throw new Error("Hyper 保护止损参数无效");
  let result;
  try {
    result = await exchange.order({
      orders: [{ a: asset, ...(clientOrderId ? { c: clientOrderId } : {}), b: side === "buy", p: limitPx, s: finalSize, r: true,
        t: { trigger: { isMarket: true, triggerPx, tpsl: "sl" } } }],
      grouping: "na"
    });
  } catch (error) { throw new Error("Hyper 保护止损单提交失败: " + (error?.message || error)); }
  const statuses = result?.response?.data?.statuses || result?.data?.statuses || result?.statuses || [];
  const first = statuses[0] || {};
  const orderId = first.resting?.oid || first.resting?.orderId || first.oid || first.orderId;
  if (!orderId) throw new Error("Hyper 保护止损单未返回可确认 orderId");
  return { orderId: String(orderId), clientOrderId, stopPrice: Number(triggerPx), result };
}

async function cancelHyperliquidOrder({ account, symbol, orderId }) {
  const { asset } = await getHlAssetMeta(symbol);
  const exchange = createHlExchangeClient(account.privateKey);
  try { return await exchange.cancel({ cancels: [{ a: asset, o: Number(orderId) }] }); }
  catch (error) { throw new Error("Hyper 旧保护止损撤销失败: " + (error?.message || error)); }
}

async function syncHyperliquidLeverage(account) {
  const { asset } = await getHlAssetMeta(account.symbol);
  const exchange = createHlExchangeClient(account.privateKey);

  await exchange.updateLeverage({
    asset,
    isCross: true,
    leverage: Number(account.leverage)
  });
}

async function getHyperPrice(symbol) {
  const data = await getHlMeta();
  const meta = data[0];
  const ctxs = data[1];

  const idx = meta.universe.findIndex(x => x.name === symbol);
  if (idx === -1) {
    throw new Error("Hyperliquid 找不到交易对: " + symbol);
  }

  const assetCtx = ctxs[idx];
  if (!assetCtx || !assetCtx.markPx) {
    throw new Error("Hyperliquid 拿不到价格数据: " + symbol);
  }

  return parseFloat(assetCtx.markPx);
}

async function getHyperAccount(address, symbol) {
  const perpData = await fetchJsonWithRetry(
    "https://api.hyperliquid.xyz/info",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "clearinghouseState",
        user: address
      })
    },
    `Hyper永续账户读取(${symbol})`,
    2,
    10000
  );

  const spotData = await fetchJsonWithRetry(
    "https://api.hyperliquid.xyz/info",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "spotClearinghouseState",
        user: address
      })
    },
    `Hyper现货余额读取(${symbol})`,
    2,
    10000
  );

  const positions = Array.isArray(perpData?.assetPositions) ? perpData.assetPositions : [];

  let currentPos = null;
  for (const item of positions) {
    const pos = item.position || item;
    const coin = pos.coin || pos.asset || "";
    if (coin === symbol) {
      currentPos = pos;
      break;
    }
  }

  const balances = Array.isArray(spotData?.balances) ? spotData.balances : [];
  const usdcBalance = balances.find(x => x.coin === "USDC");

  const balance =
    usdcBalance?.total ??
    spotData?.balance ??
    perpData?.marginSummary?.accountValue ??
    perpData?.crossMarginSummary?.accountValue ??
    perpData?.withdrawable ??
    0;

  const available =
    usdcBalance
      ? (Number(usdcBalance.total || 0) - Number(usdcBalance.hold || 0))
      : (
          spotData?.available ??
          perpData?.withdrawable ??
          perpData?.marginSummary?.withdrawable ??
          perpData?.marginSummary?.availableMargin ??
          0
        );

  return {
    rawPerp: perpData,
    rawSpot: spotData,
    balance: Number(balance),
    available: Number(available),
    positions,
    currentPos
  };
}

async function getBinanceFuturesPrice(symbol) {
  const base = normalizeInstrumentSymbol(symbol);
  const data = await fetchJsonWithRetry(
    `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${base}USDT`,
    {},
    `Binance Futures price (${base})`,
    1,
    6500
  );
  if (!data || !Number.isFinite(Number(data.price)) || Number(data.price) <= 0) {
    throw new Error("Binance Futures 拿不到价格数据: " + symbol);
  }
  return Number(data.price);
}

async function getBinanceExchangeInfo() {
  const now = Date.now();
  const age = binanceExchangeInfoCache.data ? now - binanceExchangeInfoCache.ts : Infinity;
  if (binanceExchangeInfoCache.data && age < BINANCE_EXCHANGE_INFO_TTL_MS) {
    return binanceExchangeInfoCache.data;
  }
  if (binanceExchangeInfoInFlight) return await binanceExchangeInfoInFlight;

  binanceExchangeInfoInFlight = (async () => {
    try {
      const data = await fetchJsonWithRetry(
        "https://fapi.binance.com/fapi/v1/exchangeInfo",
        {},
        "Binance contract metadata",
        1,
        10000
      );
      if (!Array.isArray(data?.symbols)) throw new Error("Binance contract metadata is malformed");
      binanceExchangeInfoCache = { ts: Date.now(), data };
      return data;
    } catch (error) {
      const staleAge = binanceExchangeInfoCache.data
        ? Date.now() - binanceExchangeInfoCache.ts
        : Infinity;
      if (binanceExchangeInfoCache.data && staleAge <= BINANCE_EXCHANGE_INFO_STALE_MAX_MS) {
        return binanceExchangeInfoCache.data;
      }
      throw error;
    }
  })();

  try {
    return await binanceExchangeInfoInFlight;
  } finally {
    binanceExchangeInfoInFlight = null;
  }
}

function isBinanceSupportedPerpetual(meta) {
  return meta?.status === "TRADING"
    && ["PERPETUAL", "TRADIFI_PERPETUAL"].includes(meta?.contractType);
}

async function getBinanceSymbolMeta(symbol) {
  const base = normalizeInstrumentSymbol(symbol);
  const contractSymbol = `${base}USDT`;
  const exchangeInfo = await getBinanceExchangeInfo();
  const meta = exchangeInfo.symbols.find(item => item?.symbol === contractSymbol);
  if (!meta) throw new Error(`Binance USD-M contract does not exist: ${contractSymbol}`);
  if (!isBinanceSupportedPerpetual(meta)) {
    throw new Error(`Binance contract is not currently tradable: ${contractSymbol}`);
  }
  return meta;
}

function getBinanceMarketLotFilter(meta) {
  const filters = Array.isArray(meta?.filters) ? meta.filters : [];
  const marketLot = filters.find(filter => filter?.filterType === "MARKET_LOT_SIZE");
  const regularLot = filters.find(filter => filter?.filterType === "LOT_SIZE");
  if (Number(marketLot?.stepSize) > 0) return marketLot;
  if (Number(regularLot?.stepSize) > 0) return regularLot;
  throw new Error(`Binance quantity rules are unavailable for ${meta?.symbol || "contract"}`);
}

async function getBinanceAccount(account) {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = sign(query, account.apiSecret);

  const url = `https://fapi.binance.com/fapi/v2/account?${query}&signature=${signature}`;

  const res = await fetch(url, {
    headers: { "X-MBX-APIKEY": account.apiKey }
  });

  const data = await res.json();

  if (data?.code) {
    throw new Error(data.msg || "Binance账户读取失败");
  }

  return {
    balance: Number(data.totalWalletBalance || 0),
    available: Number(data.availableBalance || 0),
    positions: Array.isArray(data.positions) ? data.positions : []
  };
}

async function placeBinanceOrder({ account, side, qty, reduceOnly = false }) {
  const timestamp = Date.now();
  const orderSide = side === "buy" ? "BUY" : "SELL";
  const positionSide = account.side === "long" ? "LONG" : "SHORT";
  const meta = await getBinanceSymbolMeta(account.symbol);
  const contractSymbol = meta.symbol;
  const quantity = formatBinanceOrderQuantity(qty, getBinanceMarketLotFilter(meta));

  let query =
    `symbol=${contractSymbol}` +
    `&side=${orderSide}` +
    `&positionSide=${positionSide}` +
    `&type=MARKET` +
    `&quantity=${quantity}` +
    `&timestamp=${timestamp}`;

  const signature = sign(query, account.apiSecret);
  const url = `https://fapi.binance.com/fapi/v1/order?${query}&signature=${signature}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "X-MBX-APIKEY": account.apiKey }
  });

  const data = await res.json();

  if (data?.code) {
    throw new Error(data.msg || "Binance下单失败");
  }

  return {
    price: Number(data.avgPrice || 0),
    size: Number(data.executedQty || 0),
    result: data
  };
}

async function syncBinanceLeverage(account) {
  const timestamp = Date.now();
  const base = normalizeInstrumentSymbol(account.symbol);
  const instrument = getInstrument("binance", base);
  const configuredLeverage = Math.max(1, Math.floor(Number(account.leverage || 1)));
  const safeLeverage = instrument?.group === "tradfi"
    ? Math.min(configuredLeverage, Number(instrument.maxLeverage || 10))
    : configuredLeverage;
  const query = `symbol=${base}USDT&leverage=${safeLeverage}&timestamp=${timestamp}`;
  const signature = sign(query, account.apiSecret);

  const res = await fetch(`https://fapi.binance.com/fapi/v1/leverage?${query}&signature=${signature}`, {
    method: "POST",
    headers: { "X-MBX-APIKEY": account.apiKey }
  });

  const data = await res.json();
  if (data?.code) {
    throw new Error(data.msg || "Binance设置杠杆失败");
  }
  return data;
}

async function extendedRequest(pathname, { method = "GET", apiKey, body } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "my-trading-bot/1.0"
  };

  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }

  const res = await fetch(`${EXTENDED_BASE_URL}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || String(data?.status || "").toUpperCase() === "ERROR") {
    throw new Error(data?.error?.message || data?.message || `Extended 请求失败: ${res.status}`);
  }

  return data;
}

async function getExtendedMarkets(symbol) {
  const market = `${symbol}-USD`;
  const data = await extendedRequest(`/api/v1/info/markets?market=${encodeURIComponent(market)}`);
  const list = Array.isArray(data?.data) ? data.data : [];
  const found = list.find(x => x.name === market);
  if (!found) {
    throw new Error(`Extended 找不到市场: ${market}`);
  }
  return found;
}

async function getExtendedPrice(symbol) {
  const market = await getExtendedMarkets(symbol);
  const price =
    market?.marketStats?.markPrice ??
    market?.marketStats?.lastPrice ??
    market?.marketStats?.askPrice ??
    market?.marketStats?.bidPrice;

  if (!price) {
    throw new Error(`Extended 拿不到价格: ${symbol}-USD`);
  }

  return Number(price);
}

async function getExtendedAccount(account) {
  const balanceResp = await extendedRequest("/api/v1/user/balance", {
    method: "GET",
    apiKey: account.apiKey
  });

  const positionsResp = await extendedRequest("/api/v1/user/positions", {
    method: "GET",
    apiKey: account.apiKey
  });

  const balanceData = balanceResp?.data || balanceResp || {};
  const positions = Array.isArray(positionsResp?.data) ? positionsResp.data : [];

  const market = `${account.symbol}-USD`;
  const currentPos = positions.find(p => p.market === market) || null;

  return {
    balance: Number(balanceData.equity ?? balanceData.balance ?? 0),
    available: Number(balanceData.availableForTrade ?? balanceData.availableBalance ?? 0),
    currentPos,
    positions
  };
}

async function getExtendedOpenOrders(account) {
  const res = await extendedRequest("/api/v1/user/orders", {
    method: "GET",
    apiKey: account.apiKey
  });

  const orders = Array.isArray(res?.data) ? res.data : [];
  const market = `${account.symbol}-USD`;

  return orders.filter(o =>
    o.market === market &&
    ["NEW", "PARTIALLY_FILLED", "OPEN"].includes(String(o.status || "").toUpperCase())
  );
}

function runExtendedPython(payload) {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", [EXTENDED_PY_FILE], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    py.stdout.on("data", d => stdout += d.toString());
    py.stderr.on("data", d => stderr += d.toString());

    py.on("close", code => {
      if (code !== 0) {
        return reject(new Error(stderr || stdout || `Extended Python helper 退出码: ${code}`));
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        if (!parsed.ok) {
          return reject(new Error(parsed.error || "Extended Python helper 下单失败"));
        }
        resolve(parsed);
      } catch (e) {
        reject(new Error(stdout || stderr || e.message));
      }
    });

    py.stdin.write(JSON.stringify(payload));
    py.stdin.end();
  });
}

async function placeExtendedOrder({
  account,
  symbol,
  side,
  size,
  price,
  reduceOnly = false
}) {
  if (!account.apiKey) throw new Error("Extended 缺少 apiKey");
  if (!account.starkPrivateKey) throw new Error("Extended 缺少 starkPrivateKey");
  if (!account.publicKey) throw new Error("Extended 缺少 publicKey");
  if (account.vault === undefined || account.vault === null || account.vault === "") {
    throw new Error("Extended 缺少 vault");
  }

  const marketInfo = await getExtendedMarkets(symbol);
  const step = Number(marketInfo?.tradingConfig?.minOrderSizeChange || marketInfo?.tradingConfig?.minOrderSize || "0.001");
  const minOrderSize = Number(marketInfo?.tradingConfig?.minOrderSize || "0.001");

  let finalSize = Number(size);
  if (step > 0) {
    finalSize = Math.floor(finalSize / step) * step;
  }
  finalSize = Number(finalSize.toFixed(3));

  if (!finalSize || finalSize < minOrderSize) {
    throw new Error(`Extended 下单数量过小，size=${finalSize}, minOrderSize=${minOrderSize}`);
  }

  let finalPrice = Number(price);
  if (side === "buy") {
    finalPrice = Number((finalPrice * 1.01).toFixed(1));
  } else {
    finalPrice = Number((finalPrice * 0.99).toFixed(1));
  }

  const result = await runExtendedPython({
    apiKey: account.apiKey,
    publicKey: account.publicKey,
    starkPrivateKey: account.starkPrivateKey,
    vault: Number(account.vault),
    market: `${symbol}-USD`,
    price: finalPrice,
    size: finalSize,
    side,
    reduceOnly
  });

  return {
    price: finalPrice,
    size: finalSize,
    result
  };
}

async function syncExtendedLeverage(account) {
  await extendedRequest(`/api/v1/user/leverage?market=${encodeURIComponent(`${account.symbol}-USD`)}`, {
    method: "PATCH",
    apiKey: account.apiKey,
    body: {
      leverage: Number(account.leverage)
    }
  });
}

async function getFreshMarketPrice(account) {
  if (account.platform === "hyperliquid") {
    return getHyperPrice(account.symbol);
  }
  if (account.platform === "binance") {
    return getBinanceFuturesPrice(account.symbol);
  }
  if (account.platform === "extended") {
    return getExtendedPrice(account.symbol);
  }
  throw new Error("不支持的平台: " + account.platform);
}

async function getSimulationMarketPrice(account, cached) {
  const errors = [];
  const sources = [];

  if (account.platform === "hyperliquid") sources.push(["hyperliquid", () => getHyperPrice(account.symbol)]);
  if (account.platform === "binance") sources.push(["binance", () => getBinanceFuturesPrice(account.symbol)]);
  if (account.platform === "extended") sources.push(["extended", () => getExtendedPrice(account.symbol)]);

  sources.push(["binance", () => getBinanceFuturesPrice(account.symbol)]);
  sources.push(["hyperliquid", () => getHyperPrice(account.symbol)]);
  sources.push(["extended", () => getExtendedPrice(account.symbol)]);

  const seen = new Set();
  for (const [name, loader] of sources) {
    if (seen.has(name)) continue;
    seen.add(name);
    try {
      const price = Number(await loader());
      if (Number.isFinite(price) && price > 0) {
        return price;
      }
      errors.push(`${name}: invalid price`);
    } catch (e) {
      errors.push(`${name}: ${e?.message || e}`);
    }
  }

  if (cached && Number.isFinite(Number(cached.price))) {
    return Number(cached.price);
  }

  throw new Error("模拟行情价格不可用：" + errors.join("; "));
}

async function getMarketPrice(account) {
  const cacheKey = `${account.platform}:${account.symbol}`;
  const now = Date.now();
  const cached = marketPriceCache.get(cacheKey);

  if (
    cached &&
    now - cached.ts <= PRICE_CACHE_TTL_MS &&
    Number.isFinite(Number(cached.price))
  ) {
    return Number(cached.price);
  }

  const price = isSimulationAccount(account)
    ? await getSimulationMarketPrice(account, cached)
    : await getFreshMarketPrice(account);
  marketPriceCache.set(cacheKey, { ts: now, price: Number(price) });
  return Number(price);
}

function updateDerivedTargets(st, acc) {
  if (!st.entryPrice || !st.positionValueU || !st.positionQty) {
    st.positionValueU = 0;
    st.marginUsedU = 0;
    st.marginRatio = 0;
    st.nextAddPrice = 0;
    st.nextTakeProfitPrice = 0;
    st.nextAddNotionalU = Number(acc.addAmount || 0);
    st.nextAddAmountU = Number((acc.addAmount / acc.leverage).toFixed(4));
    st.nextTakeProfitTargetU = 0;
    return;
  }

  st.marginUsedU = Number((st.positionValueU / acc.leverage).toFixed(4));
  st.nextAddNotionalU = Number(acc.addAmount || 0);
  st.nextAddAmountU = Number((acc.addAmount / acc.leverage).toFixed(4));

  const takeProfitTargetU = st.marginUsedU * acc.takeProfit;
  st.nextTakeProfitTargetU = Number(takeProfitTargetU.toFixed(4));

  const baseAddPrice = st.lastActionPrice > 0 ? st.lastActionPrice : st.entryPrice;

  if (acc.side === "long") {
    st.nextTakeProfitPrice = Number(
      (st.entryPrice + takeProfitTargetU / st.positionQty).toFixed(2)
    );
    st.nextAddPrice = Number((baseAddPrice * (1 - acc.addTrigger)).toFixed(2));
  } else {
    st.nextTakeProfitPrice = Number(
      (st.entryPrice - takeProfitTargetU / st.positionQty).toFixed(2)
    );
    st.nextAddPrice = Number((baseAddPrice * (1 + acc.addTrigger)).toFixed(2));
  }
// ====== 保证金占比率（新增）======
if (
  st.balance &&
  Number(st.balance) > 0 &&
  st.marginUsedU >= 0
) {
  st.marginRatio = Number(
    ((st.marginUsedU / Number(st.balance)) * 100).toFixed(2)
  );
} else {
  st.marginRatio = 0;
}
}

async function getSmartMarketContext(symbol, platform = "") {
  const base = String(symbol || "").toUpperCase();
  const normalizedPlatform = String(platform || "").toLowerCase();
  const cacheKey = `${normalizedPlatform || "public"}:${base}`;
  const cached = marketContextCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 30000) return cached.value;

  try {
    if (normalizedPlatform === "hyperliquid") {
      const metaSnapshot = await getHlMetaSnapshot();
      const data = metaSnapshot.data;
      const universe = Array.isArray(data?.[0]?.universe) ? data[0].universe : [];
      const contexts = Array.isArray(data?.[1]) ? data[1] : [];
      const assetIndex = universe.findIndex(item => item?.name === base);
      if (assetIndex < 0 || !contexts[assetIndex]) throw new Error(`Hyperliquid market context unavailable for ${base}`);

      const context = contexts[assetIndex];
      const markPrice = Number(context?.markPx);
      const indexPrice = Number(context?.oraclePx);
      const value = {
        fundingRate: Number(context?.funding),
        markPrice,
        indexPrice,
        basisPct: indexPrice > 0 ? (markPrice - indexPrice) / indexPrice * 100 : null,
        stale: !!metaSnapshot.stale,
        contextWarning: metaSnapshot.warning || "",
        source: "hyperliquid"
      };
      marketContextCache.set(cacheKey, { ts: Date.now(), value });
      return value;
    }

    const data = await fetchJsonWithRetry(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${base}USDT`,
      {},
      "智能策略市场上下文",
      0,
      6500
    );
    const markPrice = Number(data?.markPrice);
    const indexPrice = Number(data?.indexPrice);
    const value = {
      fundingRate: Number(data?.lastFundingRate),
      markPrice,
      indexPrice,
      basisPct: indexPrice > 0 ? (markPrice - indexPrice) / indexPrice * 100 : null,
      stale: false
    };
    marketContextCache.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (error) {
    if (cached?.value) return { ...cached.value, stale: true, contextWarning: true };
    return { fundingRate: null, basisPct: null, stale: true, contextWarning: true };
  }
}

async function getSmartCycleAccounting(acc, st, order, fallbackGrossPnl, exitPrice, closeQty) {
  const closeOrderId = extractOrderId(order);
  const orderIds = Array.isArray(st.smartOrderIds) ? [...st.smartOrderIds] : [];
  const startTime = Math.max(0, Number(st.smartOpenedAt || Date.now()) - 60 * 1000);
  const endTime = Date.now() + 5 * 1000;
  const totalTradedNotional = Number(st.smartTradedNotionalU || 0) + Number(exitPrice || 0) * Number(closeQty || 0);
  const configuredFeePct = Number(acc?.smartStrategy?.estimatedTakerFeePct);
  const simulationFeeBps = Number(acc?.simulationFeeBps);
  const estimatedFeeRate = isSimulationAccount(acc) && Number.isFinite(simulationFeeBps)
    ? Math.max(0, simulationFeeBps) / 10000
    : (Number.isFinite(configuredFeePct) && configuredFeePct >= 0
      ? configuredFeePct / 100
      : DEFAULT_TAKER_FEE_RATE);

  if (acc.platform !== "hyperliquid" || isSimulationAccount(acc) || !acc.address) {
    return summarizeHyperliquidCycle({
      symbol: acc.symbol,
      orderIds,
      closeOrderId,
      startTime,
      endTime,
      fallbackGrossPnl,
      tradedNotionalU: totalTradedNotional,
      estimatedFeeRate,
      fundingAvailable: false
    });
  }

  await sleepMs(500);
  const requestInfo = (body, label) => fetchJsonWithRetry(
    "https://api.hyperliquid.xyz/info",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    },
    label,
    1,
    6500
  );
  const [fillsResult, fundingResult] = await Promise.allSettled([
    requestInfo({
      type: "userFillsByTime",
      user: acc.address,
      startTime,
      endTime,
      aggregateByTime: true
    }, "Hyperliquid fills accounting"),
    requestInfo({
      type: "userFunding",
      user: acc.address,
      startTime,
      endTime
    }, "Hyperliquid funding accounting")
  ]);

  return summarizeHyperliquidCycle({
    fills: fillsResult.status === "fulfilled" ? fillsResult.value : [],
    funding: fundingResult.status === "fulfilled" ? fundingResult.value : [],
    symbol: acc.symbol,
    orderIds,
    closeOrderId,
    startTime,
    endTime,
    fallbackGrossPnl,
    tradedNotionalU: totalTradedNotional,
    estimatedFeeRate,
    fundingAvailable: fundingResult.status === "fulfilled",
    cycleTrackingComplete: orderIds.length > 0 && Number(st.smartTradedNotionalU || 0) > 0
  });
}

async function evaluateSmartAccount(acc, st) {
  const smart = normalizeSmartConfig(acc);
  const [entry, trend, regime, marketContext] = await Promise.all([
    getPublicMarketKlines(acc.symbol, smart.entryTimeframe, 300, acc.platform),
    getPublicMarketKlines(acc.symbol, smart.trendTimeframe, 300, acc.platform),
    getPublicMarketKlines(acc.symbol, smart.regimeTimeframe, 300, acc.platform),
    getSmartMarketContext(acc.symbol, acc.platform)
  ]);
  const decision = analyzeSmartStrategy({
    entryCandles: entry.candles,
    trendCandles: trend.candles,
    regimeCandles: regime.candles,
    marketContext: {
      ...marketContext,
      stale: !!(entry.stale || trend.stale || regime.stale || marketContext.stale)
    },
    account: acc,
    activeSide: st.positionQty > 0 ? (st.smartSide || acc.side) : ""
  });

  st.smartRegime = decision.regime;
  st.smartScore = decision.selectedScore;
  st.smartLongScore = decision.longScore;
  st.smartShortScore = decision.shortScore;
  st.smartAtr = decision.atr;
  st.smartVolatilityPercentile = decision.volatilityPercentile;
  st.smartRiskOff = decision.riskOff;
  st.smartReduceRisk = decision.reduceRisk;
  st.smartSignalUpdatedAt = new Date().toLocaleString("zh-CN");
  return decision;
}

function getSmartEffectiveAccount(acc, st, side = "") {
  return {
    ...acc,
    side: side || st.smartSide || acc.side,
    smartStrategy: normalizeSmartConfig(acc)
  };
}

async function executeSmartOrder(acc, st, { side, qty, reduceOnly }) {
  const effectiveAcc = getSmartEffectiveAccount(acc, st);
  const referencePrice = Number(st.currentPrice);

  if (isSimulationAccount(effectiveAcc)) {
    const fillPrice = getSimulatedFillPrice(effectiveAcc, side, referencePrice);
    if (!reduceOnly) assertSimulationMarginAvailable(st, effectiveAcc, qty * fillPrice);
    return buildSimulationOrder({
      acc: effectiveAcc,
      side,
      size: qty,
      price: fillPrice,
      reduceOnly
    });
  }

  if (effectiveAcc.platform === "hyperliquid") {
    return runTradingActionWithRetry(
      effectiveAcc.id,
      `智能策略${reduceOnly ? "平仓" : "下单"}`,
      () => placeHyperliquidOrder({
        account: effectiveAcc,
        symbol: effectiveAcc.symbol,
        side,
        size: qty,
        tif: "Ioc",
        reduceOnly,
        slippageBps: reduceOnly ? 18 : 12
      }),
      1,
      300
    );
  }

  if (effectiveAcc.platform === "binance") {
    const order = await placeBinanceOrder({
      account: effectiveAcc,
      side,
      qty,
      reduceOnly
    });
    return {
      ...order,
      price: Number(order.price || referencePrice),
      size: Number(order.size || qty)
    };
  }

  if (effectiveAcc.platform === "extended") {
    if (!reduceOnly) {
      const openOrders = await getExtendedOpenOrders(effectiveAcc);
      if (openOrders.length) throw new Error("Extended 存在未成交挂单，智能策略暂缓下单");
    }
    if (st.placingOrder) throw new Error("Extended 正在处理上一笔订单");
    st.placingOrder = true;
    try {
      const order = await placeExtendedOrder({
        account: effectiveAcc,
        symbol: effectiveAcc.symbol,
        side,
        size: qty,
        price: referencePrice,
        reduceOnly
      });
      return {
        ...order,
        price: Number(reduceOnly ? referencePrice : (order.price || referencePrice)),
        size: Number(order.size || qty)
      };
    } finally {
      st.placingOrder = false;
    }
  }

  throw new Error("智能策略不支持当前交易平台");
}

function smartEquity(st, acc) {
  const balance = Number(st.balance);
  if (Number.isFinite(balance) && balance > 0) return balance;
  if (isSimulationAccount(acc)) return Number(st.simBalance || getSimulationInitialBalance(acc));
  return 0;
}

function calculateSmartEntryNotional(acc, st, decision) {
  const smart = decision.config;
  const equity = smartEquity(st, acc);
  const currentPrice = Number(st.currentPrice);
  const stopDistancePct = currentPrice > 0 ? smart.stopAtr * decision.atr / currentPrice : 0;
  if (!(equity > 0) || !(stopDistancePct > 0)) return 0;

  const riskSized = equity * (smart.riskPerTradePct / 100) / stopDistancePct;
  const configuredCap = Number(acc.baseAmount) > 0 ? Number(acc.baseAmount) : riskSized;
  const marginCap = equity * (smart.maxMarginPct / 100) * Number(acc.leverage || 1);
  const available = Number(st.available);
  const availableCap = Number.isFinite(available) && available > 0
    ? available * Number(acc.leverage || 1) * 0.95
    : marginCap;
  const reduction = decision.reduceRisk ? 0.5 : 1;
  return Math.max(0, Math.min(riskSized, configuredCap, marginCap, availableCap) * reduction);
}

function getSmartTakerFeeRate(acc, smart) {
  const simulationFeeBps = Number(acc?.simulationFeeBps);
  if (isSimulationAccount(acc) && Number.isFinite(simulationFeeBps) && simulationFeeBps >= 0) {
    return simulationFeeBps / 10000;
  }
  const configuredFeePct = Number(smart?.estimatedTakerFeePct);
  return Number.isFinite(configuredFeePct) && configuredFeePct >= 0
    ? configuredFeePct / 100
    : DEFAULT_TAKER_FEE_RATE;
}

function getSmartMinimumProfitDistance(acc, st, smart, atrValue) {
  return calculateSmartMinimumProfitDistance({
    entryPrice: st.entryPrice,
    atrValue,
    takerFeeRate: getSmartTakerFeeRate(acc, smart),
    slippageBufferBps: smart.exitSlippageBufferBps,
    atrBuffer: smart.exitAtrBuffer
  });
}

function updateSmartPositionMetrics(acc, st, decision = null) {
  const smart = decision?.config || normalizeSmartConfig(acc);
  const side = st.smartSide || acc.side;
  const factor = side === "long" ? 1 : -1;
  const currentPrice = Number(st.currentPrice || 0);

  if (!(st.positionQty > 0) || !(st.entryPrice > 0)) {
    st.positionValueU = 0;
    st.marginUsedU = 0;
    st.marginRatio = 0;
    st.pnl = 0;
    st.roi = 0;
    st.nextAddPrice = 0;
    st.nextAddAmountU = 0;
    st.nextAddNotionalU = 0;
    st.nextTakeProfitPrice = 0;
    st.nextTakeProfitTargetU = 0;
    return;
  }

  st.positionValueU = Number((st.positionQty * currentPrice).toFixed(4));
  st.marginUsedU = Number((st.positionValueU / Number(acc.leverage || 1)).toFixed(4));
  st.pnl = Number(((currentPrice - st.entryPrice) * st.positionQty * factor).toFixed(4));
  st.roi = st.marginUsedU > 0 ? Number((st.pnl / st.marginUsedU * 100).toFixed(2)) : 0;
  const equity = smartEquity(st, acc);
  st.marginRatio = equity > 0 ? Number((st.marginUsedU / equity * 100).toFixed(2)) : 0;
  const addPlan = calculateSmartAddPlan({
    equity,
    leverage: acc.leverage,
    maxMarginPct: smart.maxMarginPct,
    positionValueU: st.positionValueU,
    initialNotional: st.smartInitialNotional,
    addCount: st.addCount,
    maxAdds: smart.maxAdds,
    addMultipliers: smart.addMultipliers
  });
  st.nextAddNotionalU = addPlan.addNotionalU;
  st.nextAddAmountU = addPlan.addMarginU;

  const atrValue = Number(decision?.atr || st.smartAtr || 0);
  if (atrValue > 0) {
    if (addPlan.addNotionalU > 0) {
      const addIndex = Math.min(st.addCount, smart.addAtrMultipliers.length - 1);
      const basePrice = Number(st.lastActionPrice || st.entryPrice);
      const addDistance = atrValue * smart.addAtrMultipliers[addIndex];
      st.nextAddPrice = Number((basePrice + (side === "long" ? -addDistance : addDistance)).toFixed(2));
    } else {
      st.nextAddPrice = 0;
    }
    const minimumProfitDistance = getSmartMinimumProfitDistance(acc, st, smart, atrValue);
    const takeProfitDistance = Math.max(atrValue * smart.takeProfitAtr, minimumProfitDistance);
    st.smartTakeProfitPrice = Number((
      st.entryPrice + (side === "long" ? 1 : -1) * takeProfitDistance
    ).toFixed(2));
    st.nextTakeProfitPrice = st.smartTrailingActive && st.smartTrailingPrice > 0
      ? st.smartTrailingPrice
      : 0;
    st.nextTakeProfitTargetU = Number(
      (Math.abs(st.smartTakeProfitPrice - st.entryPrice) * st.positionQty).toFixed(4)
    );
  }
}

function resetSmartPosition(st) {
  st.entryPrice = 0;
  st.positionQty = 0;
  st.positionValueU = 0;
  st.marginUsedU = 0;
  st.marginRatio = 0;
  st.nextAddPrice = 0;
  st.nextAddAmountU = 0;
  st.nextAddNotionalU = 0;
  st.nextTakeProfitPrice = 0;
  st.nextTakeProfitTargetU = 0;
  st.pnl = 0;
  st.roi = 0;
  st.addCount = 0;
  st.lastActionPrice = 0;
  st.smartStopPrice = 0;
  st.smartTakeProfitPrice = 0;
  st.smartTrailingPrice = 0;
  st.smartTrailingActive = false;
  st.smartPeakPrice = 0;
  st.smartInitialNotional = 0;
  st.smartOpenedAt = 0;
  st.smartEntrySignalTime = 0;
  st.smartExitSignalTime = 0;
  st.smartExitSignalCount = 0;
  st.smartSide = "";
  st.smartOrderIds = [];
  st.smartTradedNotionalU = 0;
}

function nextUtcDayStart(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

function refreshSmartDailyRisk(st, acc) {
  const today = new Date().toISOString().slice(0, 10);
  if (st.smartDailyDate !== today) {
    st.smartDailyDate = today;
    st.smartDailyPnl = 0;
    st.smartDayStartEquity = smartEquity(st, acc);
    st.smartConsecutiveLosses = 0;
    st.smartLossLockedUntil = 0;
  }
}

async function closeSmartPosition(acc, st, reason, closeSignalTime = 0) {
  const side = st.smartSide || acc.side;
  const effectiveAcc = getSmartEffectiveAccount(acc, st, side);
  const closeSide = side === "long" ? "sell" : "buy";
  const entryPrice = Number(st.entryPrice);
  const closeQty = Number(st.positionQty);
  const marginUsed = Number(st.marginUsedU);
  const addCount = Number(st.addCount || 0);
  const openedAt = Number(st.smartOpenedAt || 0);
  const entrySignalTime = Number(st.smartEntrySignalTime || 0);
  const order = await executeSmartOrder(effectiveAcc, st, {
    side: closeSide,
    qty: closeQty,
    reduceOnly: true
  });
  const exitPrice = Number(order.price || st.currentPrice);
  const grossPnl = (exitPrice - entryPrice) * closeQty * (side === "long" ? 1 : -1);
  const accounting = await getSmartCycleAccounting(
    effectiveAcc,
    st,
    order,
    grossPnl,
    exitPrice,
    closeQty
  );
  const realizedPnl = Number(accounting.netPnl);
  const realizedRoi = marginUsed > 0 ? Number((realizedPnl / marginUsed * 100).toFixed(2)) : 0;

  if (isSimulationAccount(effectiveAcc)) {
    st.simBalance = Number((Number(st.simBalance || getSimulationInitialBalance(acc)) + realizedPnl).toFixed(4));
    st.simRealizedPnl = Number((Number(st.simRealizedPnl || 0) + realizedPnl).toFixed(4));
  }

  st.cycleCount += 1;
  st.smartDailyPnl = Number((Number(st.smartDailyPnl || 0) + realizedPnl).toFixed(4));
  st.smartConsecutiveLosses = realizedPnl < 0 ? Number(st.smartConsecutiveLosses || 0) + 1 : 0;
  st.smartLastCloseReason = reason;
  addProfitHistory(acc.id, buildProfitVoucher({
    acc: effectiveAcc,
    order,
    entryPrice,
    exitPrice,
    closeQty,
    marginUsed,
    realizedPnl,
    realizedRoi,
    addCount,
    closeReason: reason,
    openedAt,
    grossPnl: accounting.grossPnl,
    tradingFee: accounting.tradingFee,
    fundingPnl: accounting.fundingPnl,
    costSource: accounting.costSource,
    fundingIncluded: accounting.fundingIncluded
  }));

  const smart = normalizeSmartConfig(acc);
  const dailyLimit = Math.max(0, Number(st.smartDayStartEquity || smartEquity(st, acc))) * smart.dailyLossPct / 100;
  if (realizedPnl < 0 && smart.lossCooldownMinutes > 0) {
    st.smartPauseUntil = Math.max(
      Number(st.smartPauseUntil || 0),
      Date.now() + smart.lossCooldownMinutes * 60 * 1000
    );
  }
  if (st.smartConsecutiveLosses >= smart.consecutiveLossLimit || st.smartDailyPnl <= -dailyLimit) {
    st.smartPauseUntil = Math.max(
      Number(st.smartPauseUntil || 0),
      Date.now() + smart.pauseHours * 60 * 60 * 1000
    );
  }
  if (st.smartConsecutiveLosses >= smart.consecutiveLossLimit) {
    st.smartLossLockedUntil = Math.max(
      Number(st.smartLossLockedUntil || 0),
      nextUtcDayStart()
    );
  }

  st.lastOrderTs = Date.now();
  st.lastAction = `智能策略平仓：${reason}`;
  addLog(acc.id, `智能策略平仓 ${acc.symbol} ${side} ${closeQty} @ ${exitPrice}，毛盈亏 ${Number(accounting.grossPnl).toFixed(4)} U，手续费 ${Number(accounting.tradingFee).toFixed(4)} U，资金费 ${Number(accounting.fundingPnl).toFixed(4)} U，净盈亏 ${realizedPnl.toFixed(4)} U，原因：${reason}`);
  resetSmartPosition(st);
  st.smartLastClosedSignalTime = Math.max(
    Number(st.smartLastClosedSignalTime || 0),
    entrySignalTime,
    Number(closeSignalTime || 0)
  );
  if (isSimulationAccount(effectiveAcc)) syncSimulationAccountView(st, effectiveAcc);
}

async function tickSmartStrategy(acc, st) {
  refreshSmartDailyRisk(st, acc);
  const decision = await evaluateSmartAccount(acc, st);
  const smart = decision.config;
  const now = Date.now();

  if (Number(st.smartOrderBackoffUntil || 0) > now) {
    updateSmartPositionMetrics(acc, st, decision);
    st.lastAction = `交易所下单退避至 ${new Date(st.smartOrderBackoffUntil).toLocaleString("zh-CN")}`;
    return;
  }
  if (Number(st.smartOrderBackoffUntil || 0) > 0) st.smartOrderBackoffUntil = 0;

  if (st.positionQty <= 0) {
    updateSmartPositionMetrics(acc, st, decision);
    if (Number(st.smartConsecutiveLosses || 0) >= smart.consecutiveLossLimit &&
        Number(st.smartLossLockedUntil || 0) <= now) {
      st.smartLossLockedUntil = nextUtcDayStart(now);
    }
    if (isSmartDailyLossLocked({
      dailyPnl: st.smartDailyPnl,
      dayStartEquity: st.smartDayStartEquity,
      dailyLossPct: smart.dailyLossPct
    })) {
      st.lastAction = "智能策略已达到单日亏损上限，等待下一个 UTC 交易日";
      return;
    }
    if (Number(st.smartLossLockedUntil || 0) > now) {
      st.lastAction = `智能策略连续亏损锁定至 ${new Date(st.smartLossLockedUntil).toLocaleString("zh-CN")}`;
      return;
    }
    if (st.smartPauseUntil > now) {
      st.lastAction = `智能策略风控暂停至 ${new Date(st.smartPauseUntil).toLocaleString("zh-CN")}`;
      return;
    }
    if (!decision.entryAllowed) {
      st.lastAction = decision.riskOff
        ? "智能策略风险规避，等待波动恢复"
        : `智能策略等待入场，当前评分 ${decision.selectedScore}/${decision.selectedEntryThreshold}`;
      return;
    }
    if (!canEnterSmartSignal({
      signalTime: decision.signalTime,
      lastClosedSignalTime: st.smartLastClosedSignalTime
    })) {
      st.lastAction = "智能策略等待新的已收盘 K 线信号，避免同一信号重复入场";
      return;
    }
    if (now - Number(st.lastOrderTs || 0) < Math.max(60000, Number(acc.interval || 15000) * 3)) {
      st.lastAction = "智能策略入场冷却中";
      return;
    }

    st.smartSide = decision.selectedSide;
    const effectiveAcc = getSmartEffectiveAccount(acc, st);
    const notional = calculateSmartEntryNotional(effectiveAcc, st, decision);
    const minimumNotional = getSmartMinimumOrderNotional(effectiveAcc);
    if (notional < minimumNotional) {
      st.lastAction = `智能策略风险仓位不足 ${minimumNotional.toFixed(2)} U，暂不下单`;
      return;
    }
    const orderSide = st.smartSide === "long" ? "buy" : "sell";
    const qty = notional / Number(st.currentPrice);
    st.lastOrderTs = now;
    const order = await executeSmartOrder(effectiveAcc, st, {
      side: orderSide,
      qty,
      reduceOnly: false
    });
    const fillPrice = Number(order.price || st.currentPrice);
    const fillSize = Number(order.size || qty);
    st.entryPrice = fillPrice;
    st.positionQty = fillSize;
    st.positionValueU = Number((fillPrice * fillSize).toFixed(4));
    st.addCount = 0;
    st.lastActionPrice = fillPrice;
    st.smartInitialNotional = st.positionValueU;
    st.smartOpenedAt = now;
    st.smartEntrySignalTime = Number(decision.signalTime || 0);
    st.smartExitSignalTime = 0;
    st.smartExitSignalCount = 0;
    st.smartOrderIds = extractOrderId(order) ? [extractOrderId(order)] : [];
    st.smartTradedNotionalU = Number((fillPrice * fillSize).toFixed(4));
    st.smartPeakPrice = fillPrice;
    st.smartStopPrice = Number((
      fillPrice + (st.smartSide === "long" ? -1 : 1) * decision.atr * smart.stopAtr
    ).toFixed(2));
    st.smartTrailingActive = false;
    st.lastAction = `智能策略开仓 ${st.smartSide}，评分 ${decision.selectedScore}`;
    if (isSimulationAccount(effectiveAcc)) syncSimulationAccountView(st, effectiveAcc);
    updateSmartPositionMetrics(effectiveAcc, st, decision);
    addLog(acc.id, `智能策略开仓 ${acc.symbol} ${st.smartSide} ${fillSize} @ ${fillPrice}，评分 ${decision.selectedScore}`);
    return;
  }

  const side = st.smartSide || acc.side;
  st.smartSide = side;
  if (!(st.smartOpenedAt > 0)) st.smartOpenedAt = now;
  const effectiveAcc = getSmartEffectiveAccount(acc, st, side);
  updateSmartPositionMetrics(effectiveAcc, st, decision);
  const atrValue = Number(decision.atr || st.smartAtr);
  if (!(st.smartStopPrice > 0)) {
    st.smartStopPrice = Number((
      st.entryPrice + (side === "long" ? -1 : 1) * atrValue * smart.stopAtr
    ).toFixed(2));
  }

  const favorableMove = (st.currentPrice - st.entryPrice) * (side === "long" ? 1 : -1);
  const minimumProfitDistance = getSmartMinimumProfitDistance(effectiveAcc, st, smart, atrValue);
  const trailingActivationDistance = Math.max(atrValue * smart.takeProfitAtr, minimumProfitDistance);
  if (favorableMove >= trailingActivationDistance) st.smartTrailingActive = true;
  if (st.smartTrailingActive) {
    if (side === "long") {
      st.smartPeakPrice = Math.max(Number(st.smartPeakPrice || st.entryPrice), Number(st.currentPrice));
    } else {
      st.smartPeakPrice = Math.min(Number(st.smartPeakPrice || st.entryPrice), Number(st.currentPrice));
    }
    const candidateTrailingPrice = calculateSmartTrailingPrice({
      side,
      entryPrice: st.entryPrice,
      peakPrice: st.smartPeakPrice,
      atrValue,
      trailingAtr: smart.trailingAtr,
      takeProfitAtr: smart.takeProfitAtr,
      minimumProfitDistance
    });
    st.smartTrailingPrice = tightenSmartTrailingPrice({
      side,
      previousPrice: st.smartTrailingPrice,
      candidatePrice: candidateTrailingPrice
    });
    st.nextTakeProfitPrice = st.smartTrailingPrice;
  } else {
    st.nextTakeProfitPrice = 0;
  }

  const hitHardStop = side === "long"
    ? st.currentPrice <= st.smartStopPrice
    : st.currentPrice >= st.smartStopPrice;
  const hitTrailing = st.smartTrailingActive && (side === "long"
    ? st.currentPrice <= st.smartTrailingPrice
    : st.currentPrice >= st.smartTrailingPrice);
  const exitConfirmation = advanceSmartExitConfirmation({
    exitSuggested: decision.exitSuggested,
    signalTime: decision.signalTime,
    previousSignalTime: st.smartExitSignalTime,
    previousCount: st.smartExitSignalCount
  });
  st.smartExitSignalTime = exitConfirmation.signalTime;
  st.smartExitSignalCount = exitConfirmation.count;
  const scoreExit =
    now - Number(st.smartOpenedAt || now) >= smart.minHoldMinutes * 60 * 1000 &&
    Number(st.smartExitSignalCount || 0) >= smart.exitConfirmationBars;

  if (hitHardStop || hitTrailing || scoreExit) {
    const reason = hitHardStop
      ? "ATR 风险止损"
      : hitTrailing
        ? "成本保护移动止盈"
        : decision.volatilityRiskOff
          ? "极端波动确认退出"
          : "趋势评分确认退出";
    if (isBelowMinimumCloseNotional({
      liveHyperliquid: !isSimulationAccount(effectiveAcc) && effectiveAcc.platform === "hyperliquid",
      quantity: st.positionQty,
      price: st.currentPrice,
      minimumNotional: HYPERLIQUID_MIN_ORDER_NOTIONAL_U
    })) {
      const dustNotional = Number(st.positionQty || 0) * Number(st.currentPrice || 0);
      const message = `检测到 ${dustNotional.toFixed(4)} U 尘埃仓位，低于交易所 ${HYPERLIQUID_MIN_ORDER_NOTIONAL_U.toFixed(2)} U 最小平仓额，已停止重复下单`;
      if (st.lastAction !== message) addLog(acc.id, message);
      st.lastAction = message;
      return;
    }
    await closeSmartPosition(effectiveAcc, st, reason, decision.signalTime);
    return;
  }

  if (st.addCount >= smart.maxAdds || !decision.addAllowed) {
    st.lastAction = `智能策略持仓管理，主动评分 ${decision.activeScore}`;
    return;
  }
  const addIndex = Math.min(st.addCount, smart.addAtrMultipliers.length - 1);
  const triggerDistance = atrValue * smart.addAtrMultipliers[addIndex];
  const triggerBase = Number(st.lastActionPrice || st.entryPrice);
  const triggerPrice = triggerBase + (side === "long" ? -triggerDistance : triggerDistance);
  const reachedAdd = side === "long"
    ? st.currentPrice <= triggerPrice
    : st.currentPrice >= triggerPrice;
  const addCooldown = Math.max(15 * 60 * 1000, Number(acc.addCooldownMs || 0));
  if (!reachedAdd || now - Number(st.lastAddTs || 0) < addCooldown) return;

  const addPlan = calculateSmartAddPlan({
    equity: smartEquity(st, effectiveAcc),
    leverage: acc.leverage,
    maxMarginPct: smart.maxMarginPct,
    positionValueU: st.positionValueU,
    initialNotional: st.smartInitialNotional,
    addCount: st.addCount,
    maxAdds: smart.maxAdds,
    addMultipliers: smart.addMultipliers
  });
  const addNotional = addPlan.addNotionalU;
  const minimumAddNotional = getSmartMinimumOrderNotional(effectiveAcc);
  if (addNotional < minimumAddNotional) {
    st.lastAction = addNotional > 0
      ? `智能策略补仓金额不足 ${minimumAddNotional.toFixed(2)} U，取消补仓`
      : "智能策略已达到保证金风险上限，取消补仓";
    return;
  }

  st.lastAddTs = now;
  st.lastOrderTs = now;
  const order = await executeSmartOrder(effectiveAcc, st, {
    side: side === "long" ? "buy" : "sell",
    qty: addNotional / st.currentPrice,
    reduceOnly: false
  });
  const fillPrice = Number(order.price || st.currentPrice);
  const fillSize = Number(order.size || addNotional / st.currentPrice);
  const oldCost = st.entryPrice * st.positionQty;
  st.positionQty = Number((st.positionQty + fillSize).toFixed(8));
  st.entryPrice = Number(((oldCost + fillPrice * fillSize) / st.positionQty).toFixed(8));
  const addOrderId = extractOrderId(order);
  st.smartOrderIds = Array.isArray(st.smartOrderIds) ? st.smartOrderIds : [];
  if (addOrderId && !st.smartOrderIds.includes(addOrderId)) st.smartOrderIds.push(addOrderId);
  st.smartTradedNotionalU = Number((Number(st.smartTradedNotionalU || 0) + fillPrice * fillSize).toFixed(4));
  st.addCount += 1;
  st.lastActionPrice = fillPrice;
  st.lastAction = `智能策略条件补仓 #${st.addCount}`;
  if (isSimulationAccount(effectiveAcc)) syncSimulationAccountView(st, effectiveAcc);
  updateSmartPositionMetrics(effectiveAcc, st, decision);
  addLog(acc.id, `智能策略条件补仓 #${st.addCount} ${acc.symbol} ${fillSize} @ ${fillPrice}`);
}

async function tickAccount(acc) {
  const st = stateMap[acc.id];
  if (!st) return;
  if (st.tickRunning) return;
  const activeStrategyType = getStrategyType(acc);
  const tradeLock = activeStrategyType !== "classic" ? acquireAccountTradeLock(acc.id) : null;
  if (activeStrategyType !== "classic" && !tradeLock) return;
  st.tickRunning = true;
  let accountSyncOk = true;

  try {
    if (["trend_only_v1", "trend_only_v2"].includes(activeStrategyType)) { await trendRuntime.tick(acc, st); return; }
    st.symbol = acc.symbol;
    st.currentPrice = await getMarketPrice(acc);
    st.updatedAt = new Date().toLocaleString("zh-CN");
    // 当前轮基础请求恢复正常后，清除上一轮遗留的瞬时错误状态
    st.lastError = "";

    if (isSimulationAccount(acc)) {
      syncSimulationAccountView(st, acc);
    } else {
    if (acc.platform === "hyperliquid" && acc.address) {
      try {
        const accountInfo = await getHyperAccount(acc.address, acc.symbol);

        st.balance = isFinite(Number(accountInfo.balance)) ? Number(accountInfo.balance).toFixed(2) : "-";
        st.available = isFinite(Number(accountInfo.available)) ? Number(accountInfo.available).toFixed(2) : "-";

        const pos = accountInfo.currentPos;
        if (pos) {
          const realEntry = Number(pos.entryPx || pos.entryPrice || 0);
          const rawSize = Number(pos.szi || pos.size || pos.positionSize || 0);
          const realSize = Math.abs(rawSize);
          const realNotionalU = realSize * Number(st.currentPrice || realEntry || 0);
          const ignoreSmartDust = isUntrackedSmartDust(acc, st, realNotionalU);
          if (isSmartStrategy(acc) && rawSize !== 0 && !ignoreSmartDust) {
            st.smartSide = rawSize > 0 ? "long" : "short";
          }
          const sideMatched =
            isSmartStrategy(acc) ||
            (acc.side === "long" && rawSize > 0) ||
            (acc.side === "short" && rawSize < 0);

          if (!sideMatched) {
            st.realEntryPrice = realEntry ? realEntry.toFixed(2) : "-";
            st.realUnrealizedPnl = Number(pos.unrealizedPnl || pos.unrealizedPnL || 0).toFixed(4);
            st.realPositionSize = realSize.toFixed(6);
            st.entryPrice = 0;
            st.positionQty = 0;
            st.positionValueU = 0;
            st.running = false;
            persistAccountRunning(acc.id, false);
            st.lastAction = "检测到真实持仓方向与账户方向不一致，已自动停机";
            st.lastError = `真实持仓方向冲突：rawSize=${rawSize}, 当前账户方向=${acc.side}`;
            addLog(acc.id, st.lastError);
            updateDerivedTargets(st, acc);
            return;
          }

          st.realEntryPrice = realEntry.toFixed(2);
          st.realUnrealizedPnl = Number(pos.unrealizedPnl || pos.unrealizedPnL || 0).toFixed(4);
          st.realPositionSize = realSize.toFixed(6);

          if (ignoreSmartDust) {
            resetSmartPosition(st);
            st.lastAction = `忽略交易所尘埃仓位 ${realSize.toFixed(6)} ${acc.symbol}（${realNotionalU.toFixed(4)} U）`;
          } else {
            st.entryPrice = realEntry || 0;
            st.positionQty = realSize || 0;
            st.positionValueU = Number(realNotionalU.toFixed(2));
          }
        } else {
          st.realEntryPrice = "-";
          st.realUnrealizedPnl = "-";
          st.realPositionSize = "-";
          st.entryPrice = 0;
          st.positionQty = 0;
          st.positionValueU = 0;
        }
      } catch (e) {
        st.balance = "-";
        st.available = "-";
        st.realEntryPrice = "-";
        st.realUnrealizedPnl = "-";
        st.realPositionSize = "-";
        st.lastError = "Hyper账户读取失败: " + e.message;
        addLog(acc.id, "Hyper账户读取失败: " + e.message);
        accountSyncOk = false;
      }
    }

    if (acc.platform === "binance" && acc.apiKey) {
      try {
        const accountInfo = await getBinanceAccount(acc);

        st.balance = isFinite(Number(accountInfo.balance)) ? Number(accountInfo.balance).toFixed(2) : "-";
        st.available = isFinite(Number(accountInfo.available)) ? Number(accountInfo.available).toFixed(2) : "-";

        const symbolPositions = accountInfo.positions.filter(
          p => p.symbol === `${acc.symbol}USDT` && Math.abs(Number(p.positionAmt || 0)) > 0
        );
        if (isSmartStrategy(acc) && symbolPositions.length > 1) {
          throw new Error("智能策略检测到同品种多空双持仓，已停止自动处理");
        }
        const wantedPositionSide = acc.side === "long" ? "LONG" : "SHORT";
        const pos = isSmartStrategy(acc)
          ? symbolPositions[0]
          : symbolPositions.find(p => p.positionSide === wantedPositionSide);

        if (pos) {
          const entry = Number(pos.entryPrice || 0);
          const size = Math.abs(Number(pos.positionAmt || 0));
          if (isSmartStrategy(acc)) {
            st.smartSide = String(pos.positionSide || "").toUpperCase() === "SHORT" ||
              Number(pos.positionAmt || 0) < 0
              ? "short"
              : "long";
          }

          st.realEntryPrice = entry.toFixed(2);
          st.realUnrealizedPnl = Number(pos.unrealizedProfit || 0).toFixed(4);
          st.realPositionSize = size.toFixed(6);

          st.entryPrice = entry || 0;
          st.positionQty = size || 0;
          st.positionValueU = Number((size * st.currentPrice).toFixed(2));
        } else {
          st.realEntryPrice = "-";
          st.realUnrealizedPnl = "-";
          st.realPositionSize = "-";
          st.entryPrice = 0;
          st.positionQty = 0;
          st.positionValueU = 0;
        }
      } catch (e) {
        st.balance = "-";
        st.available = "-";
        st.realEntryPrice = "-";
        st.realUnrealizedPnl = "-";
        st.realPositionSize = "-";
        st.lastError = "Binance账户读取失败: " + e.message;
        addLog(acc.id, "Binance账户读取失败: " + e.message);
        accountSyncOk = false;
      }
    }

    if (acc.platform === "extended" && acc.apiKey) {
      try {
        const accountInfo = await getExtendedAccount(acc);

        st.balance = isFinite(Number(accountInfo.balance)) ? Number(accountInfo.balance).toFixed(2) : "-";
        st.available = isFinite(Number(accountInfo.available)) ? Number(accountInfo.available).toFixed(2) : "-";

        const pos = accountInfo.currentPos;
        if (pos) {
          const realEntry = Number(pos.open_price || pos.openPrice || 0);
          const rawSize = Number(pos.size || pos.positionSize || 0);
          const realSize = Math.abs(rawSize);
          if (isSmartStrategy(acc)) {
            const rawSide = String(pos.side || pos.positionSide || "").toLowerCase();
            st.smartSide = rawSide.includes("short") || rawSide.includes("sell") || rawSize < 0
              ? "short"
              : "long";
          }

          st.realEntryPrice = realEntry ? realEntry.toFixed(2) : "-";
          st.realUnrealizedPnl = Number(pos.unrealised_pnl || pos.unrealisedPnl || pos.unrealizedPnl || 0).toFixed(4);
          st.realPositionSize = realSize ? realSize.toFixed(6) : "-";

          st.entryPrice = realEntry || 0;
          st.positionQty = realSize || 0;
          st.positionValueU = Number((realSize * st.currentPrice).toFixed(2));
        } else {
          st.realEntryPrice = "-";
          st.realUnrealizedPnl = "-";
          st.realPositionSize = "-";
          st.entryPrice = 0;
          st.positionQty = 0;
          st.positionValueU = 0;
        }
      } catch (e) {
        st.balance = "-";
        st.available = "-";
        st.realEntryPrice = "-";
        st.realUnrealizedPnl = "-";
        st.realPositionSize = "-";
        st.lastError = "Extended账户读取失败: " + e.message;
        addLog(acc.id, "Extended账户读取失败: " + e.message);
        accountSyncOk = false;
      }
    }

    }

    if (!accountSyncOk) {
      st.lastAction = "账户同步失败，跳过本轮交易";
      if (isSmartStrategy(acc)) updateSmartPositionMetrics(acc, st);
      else updateDerivedTargets(st, acc);
      return;
    }

    if (!st.running) {
      if (isSmartStrategy(acc)) updateSmartPositionMetrics(acc, st);
      else updateDerivedTargets(st, acc);
      return;
    }

    if (activeStrategyType === "smart_regime_v1") {
      await tickSmartStrategy(acc, st);
      return;
    }

    if (st.positionQty === 0) {
      const openCooldownMs = Math.max(30000, Number(acc.interval || 3000) * 3);
      if (Date.now() - (st.lastOrderTs || 0) < openCooldownMs) {
        st.lastAction = "刚下过开仓单，等待交易所同步";
        updateDerivedTargets(st, acc);
        return;
      }
      st.lastOrderTs = Date.now();

      const side = acc.side === "long" ? "buy" : "sell";
      const qty = Number(acc.baseAmount / st.currentPrice);

      if (isSimulationAccount(acc)) {
        const fillPrice = getSimulatedFillPrice(acc, side, st.currentPrice);
        assertSimulationMarginAvailable(st, acc, qty * fillPrice);
        const order = buildSimulationOrder({
          acc,
          side,
          size: qty,
          price: fillPrice,
          reduceOnly: false
        });

        st.entryPrice = Number(order.price);
        st.positionQty = Number(order.size);
        st.positionValueU = Number((Number(order.size) * Number(order.price)).toFixed(2));
        st.addCount = 0;
        st.lastAction = "simulation open";
        st.lastActionPrice = Number(order.price);
        st.lastError = "";

        syncSimulationAccountView(st, acc);
        updateDerivedTargets(st, acc);
        addLog(acc.id, `模拟开仓 ${acc.symbol} ${side} ${order.size} @ ${order.price}`);
        return;
      }

      if (acc.platform === "hyperliquid") {
        const order = await placeHyperliquidOrder({
          account: acc,
          symbol: acc.symbol,
          side,
          size: qty,
          tif: "Ioc",
          reduceOnly: false
        });

        st.entryPrice = Number(order.price);
        st.positionQty = Number(order.size);
        st.positionValueU = Number((Number(order.size) * Number(order.price)).toFixed(2));
        st.addCount = 0;
        st.lastAction = "真实开仓";
        st.lastActionPrice = Number(order.price);
        st.lastError = "";

        updateDerivedTargets(st, acc);
        addLog(acc.id, `Hyper真实开仓，价格 ${order.price}，数量 ${order.size}，名义仓位 ${st.positionValueU}U`);
        return;
      }

      if (acc.platform === "binance") {
        const order = await placeBinanceOrder({
          account: acc,
          side,
          qty,
          reduceOnly: false
        });

        st.entryPrice = Number(order.price || st.currentPrice);
        st.positionQty = Number(order.size || qty);
        st.positionValueU = Number((st.positionQty * st.entryPrice).toFixed(2));
        st.addCount = 0;
        st.lastAction = "真实开仓";
        st.lastActionPrice = Number(st.entryPrice);
        st.lastError = "";

        updateDerivedTargets(st, acc);
        addLog(acc.id, `Binance真实开仓，价格 ${st.entryPrice}，数量 ${st.positionQty}，名义仓位 ${st.positionValueU}U`);
        return;
      }

      if (acc.platform === "extended") {
        const openOrders = await getExtendedOpenOrders(acc);
        if (openOrders.length > 0) {
          st.lastAction = "存在未成交挂单，等待中";
          return;
        }

        if (st.placingOrder) {
          st.lastAction = "Extended下单中";
          return;
        }

        st.placingOrder = true;
        try {
          const refPrice = Number(st.currentPrice);

          const order = await placeExtendedOrder({
            account: acc,
            symbol: acc.symbol,
            side,
            size: qty,
            price: refPrice,
            reduceOnly: false
          });

          try {
            const latestAccountInfo = await getExtendedAccount(acc);
            const pos = latestAccountInfo.currentPos;

            if (pos) {
              const realEntry = Number(pos.open_price || pos.openPrice || 0);
              const realSize = Math.abs(Number(pos.size || 0));

              st.entryPrice = realEntry || refPrice;
              st.positionQty = realSize || Number(order.size);
              st.positionValueU = Number((st.positionQty * st.currentPrice).toFixed(2));
            } else {
              st.entryPrice = refPrice;
              st.positionQty = Number(order.size);
              st.positionValueU = Number((Number(order.size) * st.currentPrice).toFixed(2));
            }
          } catch (e) {
            st.entryPrice = refPrice;
            st.positionQty = Number(order.size);
            st.positionValueU = Number((Number(order.size) * st.currentPrice).toFixed(2));
            addLog(acc.id, `Extended开仓后读取真实持仓失败，已回退参考价记录: ${e.message}`);
          }

          st.addCount = 0;
          st.lastAction = "真实开仓";
          st.lastActionPrice = refPrice;
          st.lastError = "";

          updateDerivedTargets(st, acc);
          addLog(acc.id, `Extended真实开仓，参考价 ${refPrice}，数量 ${st.positionQty}，名义仓位 ${st.positionValueU}U`);
          return;
        } finally {
          st.placingOrder = false;
        }
      }

      return;
    }

    const sideFactor = acc.side === "long" ? 1 : -1;
    const pnl = (st.currentPrice - st.entryPrice) * st.positionQty * sideFactor;

    st.positionValueU = Number((st.positionQty * st.currentPrice).toFixed(2));
    updateDerivedTargets(st, acc);

    st.pnl = Number(pnl.toFixed(4));
    st.roi = st.marginUsedU > 0
      ? Number(((st.pnl / st.marginUsedU) * 100).toFixed(2))
      : 0;

    if (st.pnl >= st.nextTakeProfitTargetU && st.positionQty > 0) {
      const closeSide = acc.side === "long" ? "sell" : "buy";

      if (isSimulationAccount(acc)) {
        const entryPriceBeforeClose = st.entryPrice;
        const closeQty = st.positionQty;
        const marginUsedBeforeClose = st.marginUsedU;
        const addCountBeforeClose = st.addCount;
        const exitPriceForHistory = getSimulatedFillPrice(acc, closeSide, st.currentPrice);
        const order = buildSimulationOrder({
          acc,
          side: closeSide,
          size: closeQty,
          price: exitPriceForHistory,
          reduceOnly: true
        });
        const realizedPnl =
          (exitPriceForHistory - entryPriceBeforeClose) *
          closeQty *
          (acc.side === "long" ? 1 : -1);
        const realizedRoi = marginUsedBeforeClose > 0
          ? Number(((realizedPnl / marginUsedBeforeClose) * 100).toFixed(2))
          : 0;

        st.simBalance = Number((Number(st.simBalance || getSimulationInitialBalance(acc)) + realizedPnl).toFixed(4));
        st.simRealizedPnl = Number((Number(st.simRealizedPnl || 0) + realizedPnl).toFixed(4));
        st.cycleCount += 1;

        addProfitHistory(acc.id, buildProfitVoucher({
          acc,
          order,
          entryPrice: entryPriceBeforeClose,
          exitPrice: exitPriceForHistory,
          closeQty,
          marginUsed: marginUsedBeforeClose,
          realizedPnl,
          realizedRoi,
          addCount: addCountBeforeClose
        }));

        addLog(acc.id, `模拟止盈平仓 ${acc.symbol} ${closeQty} @ ${exitPriceForHistory}，盈利 ${Number(realizedPnl.toFixed(4))} U`);
        st.lastAction = "模拟止盈平仓";

        st.entryPrice = 0;
        st.positionQty = 0;
        st.positionValueU = 0;
        st.marginUsedU = 0;
        st.nextAddPrice = 0;
        st.nextAddAmountU = Number((acc.addAmount / acc.leverage).toFixed(4));
        st.nextTakeProfitPrice = 0;
        st.nextTakeProfitTargetU = 0;
        st.pnl = 0;
        st.roi = 0;
        st.addCount = 0;
        st.lastActionPrice = 0;
        syncSimulationAccountView(st, acc);
        return;
      }

      if (acc.platform === "hyperliquid") {
        const entryPriceBeforeClose = st.entryPrice;
        const closeQty = st.positionQty;
        const marginUsedBeforeClose = st.marginUsedU;
        const addCountBeforeClose = st.addCount;

        const order = await runTradingActionWithRetry(
          acc.id,
          "Hyper止盈平仓",
          () => placeHyperliquidOrder({
            account: acc,
            symbol: acc.symbol,
            side: closeSide,
            size: closeQty,
            tif: "Ioc",
            reduceOnly: true
          }),
          2,
          2500
        );

        const exitPriceForHistory = Number(order.price);
        const realizedPnl =
          (exitPriceForHistory - entryPriceBeforeClose) *
          closeQty *
          (acc.side === "long" ? 1 : -1);
        const realizedRoi = marginUsedBeforeClose > 0
          ? Number(((realizedPnl / marginUsedBeforeClose) * 100).toFixed(2))
          : 0;

        st.cycleCount += 1;

        addProfitHistory(acc.id, buildProfitVoucher({
          acc,
          order,
          entryPrice: entryPriceBeforeClose,
          exitPrice: exitPriceForHistory,
          closeQty,
          marginUsed: marginUsedBeforeClose,
          realizedPnl,
          realizedRoi,
          addCount: addCountBeforeClose
        }));

        addLog(acc.id, `Hyper真实止盈平仓，价格 ${exitPriceForHistory}，盈利 ${Number(realizedPnl.toFixed(4))} U`);
        st.lastAction = "真实止盈平仓";

        st.entryPrice = 0;
        st.positionQty = 0;
        st.positionValueU = 0;
        st.marginUsedU = 0;
        st.nextAddPrice = 0;
        st.nextAddAmountU = Number((acc.addAmount / acc.leverage).toFixed(4));
        st.nextTakeProfitPrice = 0;
        st.nextTakeProfitTargetU = 0;
        st.pnl = 0;
        st.roi = 0;
        st.addCount = 0;
        st.lastActionPrice = 0;
        return;
      }

      if (acc.platform === "binance") {
        const entryPriceBeforeClose = st.entryPrice;
        const closeQty = st.positionQty;
        const marginUsedBeforeClose = st.marginUsedU;
        const addCountBeforeClose = st.addCount;

        const order = await placeBinanceOrder({
          account: acc,
          side: closeSide,
          qty: closeQty,
          reduceOnly: true
        });

        const exitPriceForHistory = Number(order.price || st.currentPrice);
        const realizedPnl =
          (exitPriceForHistory - entryPriceBeforeClose) *
          closeQty *
          (acc.side === "long" ? 1 : -1);
        const realizedRoi = marginUsedBeforeClose > 0
          ? Number(((realizedPnl / marginUsedBeforeClose) * 100).toFixed(2))
          : 0;

        st.cycleCount += 1;

        addProfitHistory(acc.id, buildProfitVoucher({
          acc,
          order,
          entryPrice: entryPriceBeforeClose,
          exitPrice: exitPriceForHistory,
          closeQty,
          marginUsed: marginUsedBeforeClose,
          realizedPnl,
          realizedRoi,
          addCount: addCountBeforeClose
        }));

        addLog(acc.id, `Binance真实止盈平仓，价格 ${exitPriceForHistory}，盈利 ${Number(realizedPnl.toFixed(4))} U`);
        st.lastAction = "真实止盈平仓";

        st.entryPrice = 0;
        st.positionQty = 0;
        st.positionValueU = 0;
        st.marginUsedU = 0;
        st.nextAddPrice = 0;
        st.nextAddAmountU = Number((acc.addAmount / acc.leverage).toFixed(4));
        st.nextTakeProfitPrice = 0;
        st.nextTakeProfitTargetU = 0;
        st.pnl = 0;
        st.roi = 0;
        st.addCount = 0;
        st.lastActionPrice = 0;
        return;
      }

      if (acc.platform === "extended") {
        if (st.placingOrder) {
          st.lastAction = "Extended下单中";
          return;
        }

        st.placingOrder = true;
        try {
          const entryPriceBeforeClose = st.entryPrice;
          const closeQty = st.positionQty;
          const marginUsedBeforeClose = st.marginUsedU;
          const addCountBeforeClose = st.addCount;

          const order = await placeExtendedOrder({
            account: acc,
            symbol: acc.symbol,
            side: closeSide,
            size: closeQty,
            price: st.currentPrice,
            reduceOnly: true
          });

          const exitPriceForHistory = Number(st.currentPrice);
          const realizedPnl =
            (exitPriceForHistory - entryPriceBeforeClose) *
            closeQty *
            (acc.side === "long" ? 1 : -1);

          const realizedRoi = marginUsedBeforeClose > 0
            ? Number(((realizedPnl / marginUsedBeforeClose) * 100).toFixed(2))
            : 0;

          st.cycleCount += 1;

          addProfitHistory(acc.id, buildProfitVoucher({
            acc,
            order,
            entryPrice: entryPriceBeforeClose,
            exitPrice: exitPriceForHistory,
            closeQty,
            marginUsed: marginUsedBeforeClose,
            realizedPnl,
            realizedRoi,
            addCount: addCountBeforeClose
          }));

          addLog(acc.id, `Extended真实止盈平仓，展示平仓价 ${exitPriceForHistory}，盈利 ${Number(realizedPnl.toFixed(4))} U`);
          st.lastAction = "真实止盈平仓";

          st.entryPrice = 0;
          st.positionQty = 0;
          st.positionValueU = 0;
          st.marginUsedU = 0;
          st.nextAddPrice = 0;
          st.nextAddAmountU = Number((acc.addAmount / acc.leverage).toFixed(4));
          st.nextTakeProfitPrice = 0;
          st.nextTakeProfitTargetU = 0;
          st.pnl = 0;
          st.roi = 0;
          st.addCount = 0;
          st.lastActionPrice = 0;
          return;
        } finally {
          st.placingOrder = false;
        }
      }
    }

    let shouldAdd = false;

    if (st.positionQty > 0 && st.addCount < acc.maxAdds) {
      const basePrice = st.lastActionPrice > 0 ? st.lastActionPrice : st.entryPrice;

      if (acc.side === "long") {
        const triggerPrice = basePrice * (1 - acc.addTrigger);
        if (st.currentPrice <= triggerPrice) {
          shouldAdd = true;
        }
      } else {
        const triggerPrice = basePrice * (1 + acc.addTrigger);
        if (st.currentPrice >= triggerPrice) {
          shouldAdd = true;
        }
      }

      addLog(
        acc.id,
        `补仓判断：现价=${Number(st.currentPrice).toFixed(4)} 基准价=${Number(basePrice).toFixed(4)}`
      );
    }

    const nowTs = Date.now();
    const addCooldownMs = Math.max(60000, Number(acc.addCooldownMs || 0), Number(acc.interval || 3000) * 3);
    if (shouldAdd && nowTs - (st.lastAddTs || 0) >= addCooldownMs) {
      // 先锁时间，再发单，防止接口慢或定时器重叠造成重复补仓。
      st.lastAddTs = nowTs;
      st.lastOrderTs = nowTs;

      const side = acc.side === "long" ? "buy" : "sell";
      const qty = Number(acc.addAmount / st.currentPrice);

      if (isSimulationAccount(acc)) {
        const fillPrice = getSimulatedFillPrice(acc, side, st.currentPrice);
        assertSimulationMarginAvailable(st, acc, qty * fillPrice);
        const order = buildSimulationOrder({
          acc,
          side,
          size: qty,
          price: fillPrice,
          reduceOnly: false
        });
        const fillSize = Number(order.size);
        const totalCost = st.entryPrice * st.positionQty + fillPrice * fillSize;

        st.positionQty = Number((st.positionQty + fillSize).toFixed(8));
        st.entryPrice = Number((totalCost / st.positionQty).toFixed(8));
        st.positionValueU = Number((st.positionQty * st.currentPrice).toFixed(2));
        st.addCount += 1;
        st.lastAction = "模拟补仓";
        st.lastActionPrice = fillPrice;
        st.lastAddTs = Date.now();

        syncSimulationAccountView(st, acc);
        updateDerivedTargets(st, acc);
        addLog(acc.id, `模拟补仓 #${st.addCount} ${acc.symbol} ${fillSize} @ ${fillPrice}`);
        return;
      }

      if (acc.platform === "hyperliquid") {
        const order = await placeHyperliquidOrder({
          account: acc,
          symbol: acc.symbol,
          side,
          size: qty,
          tif: "Ioc",
          reduceOnly: false
        });

        const fillPrice = Number(order.price);
        const fillSize = Number(order.size);
        const totalCost = st.entryPrice * st.positionQty + fillPrice * fillSize;

        st.positionQty = Number((st.positionQty + fillSize).toFixed(8));
        st.entryPrice = Number((totalCost / st.positionQty).toFixed(8));
        st.positionValueU = Number((st.positionQty * st.currentPrice).toFixed(2));
        st.addCount += 1;
        st.lastAction = "真实补仓";
        st.lastActionPrice = fillPrice;
        st.lastAddTs = Date.now();

        updateDerivedTargets(st, acc);
        addLog(acc.id, `Hyper真实补仓，第 ${st.addCount} 次，价格 ${fillPrice}，数量 ${fillSize}`);
      }

      if (acc.platform === "binance") {
        const order = await placeBinanceOrder({
          account: acc,
          side,
          qty,
          reduceOnly: false
        });

        const fillPrice = Number(order.price || st.currentPrice);
        const fillSize = Number(order.size || qty);
        const totalCost = st.entryPrice * st.positionQty + fillPrice * fillSize;

        st.positionQty = Number((st.positionQty + fillSize).toFixed(8));
        st.entryPrice = Number((totalCost / st.positionQty).toFixed(8));
        st.positionValueU = Number((st.positionQty * st.currentPrice).toFixed(2));
        st.addCount += 1;
        st.lastAction = "真实补仓";
        st.lastActionPrice = fillPrice;
        st.lastAddTs = Date.now();

        updateDerivedTargets(st, acc);
        addLog(acc.id, `Binance真实补仓，第 ${st.addCount} 次，价格 ${fillPrice}，数量 ${fillSize}`);
      }

      if (acc.platform === "extended") {
        if (st.placingOrder) {
          st.lastAction = "Extended下单中";
          return;
        }

        st.placingOrder = true;
        try {
          const refPrice = Number(st.currentPrice);

          const oldQty = st.positionQty;
          const oldEntryPrice = st.entryPrice;

          const order = await placeExtendedOrder({
            account: acc,
            symbol: acc.symbol,
            side,
            size: qty,
            price: refPrice,
            reduceOnly: false
          });

          try {
            const latestAccountInfo = await getExtendedAccount(acc);
            const pos = latestAccountInfo.currentPos;

            if (pos) {
              const realEntry = Number(pos.open_price || pos.openPrice || 0);
              const realSize = Math.abs(Number(pos.size || 0));

              st.positionQty = realSize || Number(oldQty + Number(order.size || qty));
              st.entryPrice = realEntry || oldEntryPrice;
              st.positionValueU = Number((st.positionQty * st.currentPrice).toFixed(2));
            } else {
              const fillSize = Number(order.size || qty);
              const totalCost = oldEntryPrice * oldQty + refPrice * fillSize;

              st.positionQty = Number((oldQty + fillSize).toFixed(8));
              st.entryPrice = Number((totalCost / st.positionQty).toFixed(8));
              st.positionValueU = Number((st.positionQty * st.currentPrice).toFixed(2));
            }
          } catch (e) {
            const fillSize = Number(order.size || qty);
            const totalCost = oldEntryPrice * oldQty + refPrice * fillSize;

            st.positionQty = Number((oldQty + fillSize).toFixed(8));
            st.entryPrice = Number((totalCost / st.positionQty).toFixed(8));
            st.positionValueU = Number((st.positionQty * st.currentPrice).toFixed(2));
            addLog(acc.id, `Extended补仓后读取真实持仓失败，已回退本地均价计算: ${e.message}`);
          }

          st.addCount += 1;
          st.lastAction = "真实补仓";
          st.lastActionPrice = refPrice;
          st.lastAddTs = Date.now();

          updateDerivedTargets(st, acc);
          addLog(acc.id, `Extended真实补仓，第 ${st.addCount} 次，参考价 ${refPrice}，数量 ${Number(order.size || qty)}`);
        } finally {
          st.placingOrder = false;
        }
      }
    } else {
      st.lastAction = "运行中";
    }
  } catch (err) {
    st.lastError = err.message;
    st.lastAction = "错误";
    if (isSmartStrategy(acc)) {
      const policy = classifyTradingError(err);
      if (policy.backoffMs > 0) {
        st.smartOrderBackoffUntil = Math.max(
          Number(st.smartOrderBackoffUntil || 0),
          Date.now() + policy.backoffMs
        );
        st.lastAction = `交易所拒单，已启用 ${Math.round(policy.backoffMs / 60000)} 分钟退避`;
      }
    }
    addLog(acc.id, `错误：${err.message}`);
    console.error(`[账户异常] ${acc.name || acc.id} / ${acc.platform} / ${acc.symbol} / ${acc.side}：${err.message}`);
  } finally {
    if (isSmartStrategy(acc)) {
      try {
        persistSmartRuntime(acc, st);
      } catch (persistError) {
        console.error(`智能策略运行态保存失败 ${acc.id}:`, persistError?.message || persistError);
      }
    }
    st.tickRunning = false;
    releaseAccountTradeLock(tradeLock);
  }
}

let schedulerRunning = false;

setInterval(async () => {
  if (schedulerRunning) return;
  schedulerRunning = true;

  try {
    ensureAccountStates();

    const now = Date.now();
    const dueAccounts = [];
    const accounts = config.accounts || [];

    for (let index = 0; index < accounts.length; index += 1) {
      const acc = accounts[index];
      const st = stateMap[acc.id];
      if (!st) continue;

      const intervalMs = normalizeIntervalMs(acc.interval);
      if (!Number.isFinite(Number(st.nextTickAt)) || Number(st.nextTickAt) <= 0) {
        const offsetMs = Math.floor((intervalMs * index) / Math.max(accounts.length, 1));
        st.nextTickAt = now + offsetMs;
      }

      if (now >= st.nextTickAt) {
        st.lastTickTs = now;
        st.nextTickAt = now + intervalMs;
        dueAccounts.push(acc);
      }
    }

    const concurrency = getSchedulerConcurrency(config);

    await runWithConcurrency(dueAccounts, concurrency, async (acc) => {
      await tickAccount(acc);
    });
  } finally {
    schedulerRunning = false;
  }
}, 1000);

function jsonRes(res, code, data, extraHeaders = {}) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function jsonTextRes(res, code, text, extraHeaders = {}) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    ...extraHeaders
  });
  res.end(text);
}

function profitVoucherTimeToTs(item) {
  const normalized = String(item?.time || "")
    .replace(/\//g, "-")
    .replace("上午", "AM")
    .replace("下午", "PM");
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : 0;
}

function getCachedPublicProfitVouchers() {
  const now = Date.now();
  const cacheValid =
    publicVoucherCache.revision === historyRevision &&
    publicVoucherCache.configRevision === configRevision;

  if (cacheValid) return publicVoucherCache;

  const items = [];
  for (const acc of config.accounts || []) {
    const st = stateMap[acc.id];
    if (!st || !Array.isArray(st.profitHistory)) continue;

    for (const item of st.profitHistory) {
      const voucher = sanitizePublicVoucher(normalizeProfitVoucher(item, acc.id));
      items.push({
        ...voucher,
        accountId: acc.id,
        accountName: voucher.accountName || acc.name || "",
        platform: voucher.platform || acc.platform || "",
        symbol: voucher.symbol || acc.symbol || "",
        quoteAsset: voucher.quoteAsset || acc.quoteAsset || "",
        side: normalizeSideText(voucher.side, acc.side)
      });
    }
  }

  items.sort((a, b) => profitVoucherTimeToTs(b) - profitVoucherTimeToTs(a));
  publicVoucherCache = {
    revision: historyRevision,
    configRevision,
    builtAt: now,
    items,
    payloads: new Map()
  };
  return publicVoucherCache;
}

function getCachedPublicProfitVoucherPayload(limit) {
  const cache = getCachedPublicProfitVouchers();
  let payload = cache.payloads.get(limit);
  if (payload) return payload;

  const text = JSON.stringify({
    ok: true,
    count: Math.min(cache.items.length, limit),
    total: cache.items.length,
    totalAccounts: (config.accounts || []).length,
    limit,
    cachedAt: cache.builtAt,
    cacheTtlMs: PUBLIC_VOUCHER_CACHE_TTL_MS,
    items: cache.items.slice(0, limit)
  });
  payload = {
    text,
    gzip: zlib.gzipSync(text, { level: 6 })
  };
  cache.payloads.set(limit, payload);
  return payload;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function serveFile(res, filePath) {
  const resolved = path.resolve(filePath);
  const relative = path.relative(PUBLIC_DIR, resolved);
  const ext = path.extname(resolved).toLowerCase();
  const allowedTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8",
    ".ico": "image/x-icon",
    ".webp": "image/webp"
  };

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("禁止访问");
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(allowedTypes, ext)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("禁止访问");
    return;
  }

  fs.readFile(resolved, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("文件不存在");
      return;
    }

    res.writeHead(200, {
      "Content-Type": allowedTypes[ext]
    });
    res.end(buf);
  });
}

function hasConfiguredSecret(value) {
  return typeof value === "string" ? value.trim().length > 0 : !!value;
}

function sanitizeAccountForDashboard(acc = {}, st = {}) {
  const strategyType = getStrategyType(acc);
  return {
    id: acc.id,
    name: acc.name,
    platform: acc.platform,
    address: acc.address,
    symbol: acc.symbol,
    quoteAsset: acc.quoteAsset,
    side: isTrendOnly(acc)
      ? (st.trendOnly?.position?.side || st.trendOnly?.signal?.direction || "auto")
      : isSmartStrategy(acc)
        ? (st.smartSide || "auto")
        : acc.side,
    strategyType,
    strategyMode: getStrategyMode(acc),
    strategyLabel: getStrategyLabel(acc),
    tradeMode: isSimulationAccount(acc) ? "simulation" : "live",
    simulationEnabled: isSimulationAccount(acc),
    simulationBalance: acc.simulationBalance,
    simulationSlippageBps: acc.simulationSlippageBps,
    leverage: acc.leverage,
    baseAmount: acc.baseAmount,
    addAmount: acc.addAmount,
    takeProfit: acc.takeProfit,
    addTrigger: acc.addTrigger,
    maxAdds: acc.maxAdds,
    interval: acc.interval,
    smartStrategy: acc.smartStrategy,
    trendOnlyConfig: acc.trendOnlyConfig,
    hasPrivateKey: hasConfiguredSecret(acc.privateKey),
    hasApiKey: hasConfiguredSecret(acc.apiKey),
    hasApiSecret: hasConfiguredSecret(acc.apiSecret),
    hasStarkPrivateKey: hasConfiguredSecret(acc.starkPrivateKey),
    hasPublicKey: hasConfiguredSecret(acc.publicKey),
    hasVault: hasConfiguredSecret(acc.vault)
  };
}

function getPublicAccountPayload(acc, st) {
  const strategyType = getStrategyType(acc);
  return {
    id: acc.id,
    name: acc.name,
    platform: acc.platform,
    symbol: acc.symbol,
    quoteAsset: acc.quoteAsset,
    side: isTrendOnly(acc) ? (st.trendOnly?.position?.side || st.trendOnly?.signal?.direction || "auto") : isSmartStrategy(acc) ? (st.smartSide || "auto") : acc.side,
    strategyType,
    strategyMode: getStrategyMode(acc),
    strategyLabel: getStrategyLabel(acc),
    tradeMode: isSimulationAccount(acc) ? "simulation" : "live",
    simulationEnabled: isSimulationAccount(acc),
    running: st.running,
    pnl: st.pnl,
    roi: st.roi,
    balance: st.balance,
    available: st.available
  };
}

function sanitizeTrendOnlyForPublic(trend = {}, st = {}) {
  const signal = trend.signal || {};
  const nextActions = {
    NO_SIGNAL: "等待交易机会", WAIT_PULLBACK: "等待回踩", WAIT_BREAKOUT: "等待突破", WAIT_CONTINUATION: "等待延续",
    WAIT_ENTRY_ALIGNMENT: "等待 15m 重新确认", READY_TO_OPEN: "满足开仓条件", MONITOR_STOPPED: "趋势监控已停止",
    ACCOUNT_CONFLICT: "账户存在策略冲突", OPEN_ORDER_BLOCK: "等待现有订单结束", REENTRY_COOLDOWN: "再入场冷却中",
    WAIT_LIVE_CONFIRM: "等待 Live 开仓确认", RISK_LOCK: "风控禁止开仓", POST_FILL_RISK_LOCK: "成交后风险锁定",
    PLATFORM_UNSUPPORTED: "当前平台不支持趋势实盘", ORDER_SUBMITTED: "订单已提交", ORDER_FILLED: "订单已成交", POSITION_MANAGED: "持仓保护中"
  };
  return {
    marketStatus: trend.weekendBlocked ? "weekend_blocked" : (signal.regime || "data_insufficient"),
    direction: signal.directionRaw || signal.direction || "none",
    running: !!st.running,
    hasPosition: !!trend.position,
    pnl: Number(st.pnl || 0),
    roi: Number(st.roi || 0),
    nextAction: nextActions[trend.executionState] || "等待趋势判断",
    updatedAt: st.updatedAt || "",
    marketStage: signal.regime || "data_insufficient",
    tradeDirection: signal.tradeDirection || "none"
  };
}

function getPublicStatePayload(acc, st) {
  const strategyType = getStrategyType(acc);
  if (isTrendOnly(acc)) trendRuntime.publish(acc, st);
  const trendPublic = isTrendOnly(acc) ? sanitizeTrendOnlyForPublic(st.trendOnly, st) : null;
  return {
    account: {
      id: acc.id,
      name: acc.name,
      platform: acc.platform,
      symbol: acc.symbol,
      quoteAsset: acc.quoteAsset,
      side: acc.side,
      effectiveSide: isTrendOnly(acc) ? (st.trendOnly?.position?.side || st.trendOnly?.signal?.direction || "auto") : isSmartStrategy(acc) ? (st.smartSide || "auto") : acc.side,
      strategyType,
      strategyMode: getStrategyMode(acc),
      strategyLabel: getStrategyLabel(acc),
      tradeMode: isSimulationAccount(acc) ? "simulation" : "live",
      simulationEnabled: isSimulationAccount(acc)
    },
    state: isTrendOnly(acc) ? {
      activeStrategyType: strategyType,
      activeStrategyLabel: getStrategyLabel(acc),
      isTrendOnly: true,
      isTrendOnlyV2: isTrendOnlyV2(acc),
      running: !!st.running,
      pnl: Number(st.pnl || 0),
      roi: Number(st.roi || 0),
      updatedAt: st.updatedAt || "",
      trendOnly: trendPublic
    } : {
      activeStrategyType: strategyType,
      activeStrategyLabel: getStrategyLabel(acc),
      isTrendOnly: isTrendOnly(acc),
      isTrendOnlyV2: isTrendOnlyV2(acc),
      isSmartStrategy: strategyType === "smart_regime_v1",
      isClassicStrategy: strategyType === "classic",
      running: st.running,
      currentPrice: st.currentPrice,
      entryPrice: st.entryPrice,
      positionQty: st.positionQty,
      positionValueU: st.positionValueU,
      marginUsedU: st.marginUsedU,
      marginRatio: st.marginRatio || 0,
      pnl: st.pnl,
      roi: st.roi,
      balance: st.balance,
      available: st.available,
      realPositionSize: st.realPositionSize,
      realEntryPrice: st.realEntryPrice,
      realUnrealizedPnl: st.realUnrealizedPnl,
      simInitialBalance: st.simInitialBalance,
      simBalance: st.simBalance,
      simRealizedPnl: st.simRealizedPnl,
      lastAction: st.lastAction,
      lastError: st.lastError,
      updatedAt: st.updatedAt,
      ...(isTrendOnly(acc) ? { trendOnly: trendPublic } : {})
    }
  };
}

function buildDashboardPayload(acc, st) {
  const strategyType = getStrategyType(acc);
  if (isTrendOnly(acc)) trendRuntime.publish(acc, st);
  const { profitHistory: _profitHistory, ...state } = st;
  return {
    config: sanitizeAccountForDashboard(acc, st),
    state: {
      ...state,
      activeStrategyType: strategyType,
      activeStrategyLabel: getStrategyLabel(acc),
      isTrendOnly: isTrendOnly(acc),
      isTrendOnlyV2: isTrendOnlyV2(acc),
      isSmartStrategy: strategyType === "smart_regime_v1",
      isClassicStrategy: strategyType === "classic",
      ...(isTrendOnly(acc) ? { trendOnly: state.trendOnly } : {})
    }
  };
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  ensureAccountStates();

  if (pathname === "/api/login" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { username, password } = JSON.parse(body || "{}");
        const auth = loadAuthConfig();
        const rateKey = loginKey(req, username);
        const rate = loginRateState(rateKey);
        if (rate.count >= LOGIN_MAX_FAILURES) {
          const retryAfter = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - rate.startedAt)) / 1000));
          return jsonRes(res, 429, { ok: false, error: "登录失败次数过多，请稍后再试" }, { "Retry-After": String(retryAfter) });
        }

        const usernameMatches = username === auth.adminUsername;
        const passwordMatches = auth.passwordHash
          ? verifyPassword(password, auth.passwordHash)
          : typeof auth.adminPassword === "string" && password === auth.adminPassword;

        if (usernameMatches && passwordMatches) {
          loginFailures.delete(rateKey);
          if (!auth.passwordHash && typeof auth.adminPassword === "string") {
            const migrated = { ...auth, passwordHash: hashPassword(password) };
            delete migrated.adminPassword;
            saveAuthConfig(migrated);
            console.warn("[SECURITY] 管理员密码已从明文迁移为 scrypt passwordHash。");
          }
          const sid = createSession(username);
          return jsonRes(
            res,
            200,
            { ok: true },
            {
              "Set-Cookie": sessionCookie(sid, 7 * 24 * 60 * 60)
            }
          );
        }

        rate.count += 1;
        return jsonRes(res, 401, { ok: false, error: "用户名或密码错误" });
      } catch (e) {
        return jsonRes(res, 400, { ok: false, error: "登录请求无效" });
      }
    });
    return;
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    const cookies = parseCookies(req);
    const sid = cookies.sid;
    if (sid) sessions.delete(sid);
    return jsonRes(
      res,
      200,
      { ok: true },
      {
        "Set-Cookie": sessionCookie("", 0)
      }
    );
  }

  if (pathname === "/api/public/accounts" && req.method === "GET") {
    const items = config.accounts.map(acc => {
      const st = stateMap[acc.id];
      return getPublicAccountPayload(acc, st);
    });
    return jsonRes(res, 200, { ok: true, items, currentAccountId: config.currentAccountId });
  }

  if (pathname === "/api/public/status" && req.method === "GET") {
    const accountId = parsed.query.id || config.currentAccountId;
    const acc = getAccountById(accountId);
    if (!acc) return jsonRes(res, 404, { ok: false, error: "账户不存在" });
    const st = stateMap[acc.id];
    return jsonRes(res, 200, { ok: true, ...getPublicStatePayload(acc, st) });
  }

  if (pathname === "/api/public/profit-history" && req.method === "GET") {
    const accountId = parsed.query.id || config.currentAccountId;
    const st = stateMap[accountId];
    if (!st) return jsonRes(res, 200, { ok: true, items: [] });

    const items = (st.profitHistory || []).map(item => sanitizePublicVoucher(normalizeProfitVoucher(item, accountId)));

    return jsonRes(res, 200, { ok: true, items });
  }


  if (pathname === "/api/public/profit-vouchers-all" && req.method === "GET") {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (token !== PUBLIC_API_TOKEN) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    // 单一限制：所有账户合并后，返回最新 N 条
    // 默认 2000，最大 10000，避免接口一次性返回过大数据。
    const limit = Math.min(Math.max(Number(parsed.query.limit || 2000), 1), 10000);

    const cachedPayload = getCachedPublicProfitVoucherPayload(limit);

    const acceptsGzip = /\bgzip\b/i.test(String(req.headers["accept-encoding"] || ""));
    return jsonTextRes(
      res,
      200,
      acceptsGzip ? cachedPayload.gzip : cachedPayload.text,
      {
        "Cache-Control": "private, max-age=5",
        "Vary": "Accept-Encoding",
        ...(acceptsGzip ? { "Content-Encoding": "gzip" } : {})
      }
    );

    /*
     * Legacy implementation retained temporarily below for source-history
     * readability. The cached response above returns before this code runs.
    const items = [];

    for (const acc of config.accounts || []) {
      const st = stateMap[acc.id];

      if (!st || !Array.isArray(st.profitHistory)) {
        continue;
      }

      for (const item of st.profitHistory) {
        const voucher = sanitizePublicVoucher(normalizeProfitVoucher(item, acc.id));

        items.push({
          ...voucher,
          accountId: acc.id,
          accountName: voucher.accountName || acc.name || "",
          platform: voucher.platform || acc.platform || "",
          symbol: voucher.symbol || acc.symbol || "",
          quoteAsset: voucher.quoteAsset || acc.quoteAsset || "",
          side: normalizeSideText(voucher.side, acc.side)
        });
      }
    }

    function timeToTs(item) {
      const raw = String(item.time || "");

      // 兼容中文时间、斜杠时间、短横线时间。
      const normalized = raw
        .replace(/\//g, "-")
        .replace("上午", "AM")
        .replace("下午", "PM");

      const ts = Date.parse(normalized);
      return Number.isFinite(ts) ? ts : 0;
    }

    items.sort((a, b) => timeToTs(b) - timeToTs(a));

    return jsonRes(res, 200, {
      ok: true,
      count: Math.min(items.length, limit),
      total: items.length,
      totalAccounts: (config.accounts || []).length,
      limit,
      items: items.slice(0, limit)
    });
    */
  }

  if (pathname === "/api/public/profit-vouchers" && req.method === "GET") {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (token !== PUBLIC_API_TOKEN) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    const accountId = parsed.query.id || config.currentAccountId;
    const limit = Math.min(Math.max(Number(parsed.query.limit || 20), 1), 100);
    const st = stateMap[accountId];

    if (!st || !Array.isArray(st.profitHistory)) {
      return jsonRes(res, 200, { ok: true, items: [] });
    }

    const items = st.profitHistory
      .slice(0, limit)
      .map(item => sanitizePublicVoucher(normalizeProfitVoucher(item, accountId)));

    return jsonRes(res, 200, { ok: true, items });
  }

  if (pathname === "/api/public/simulation/binance-total" && req.method === "GET") {
    if (!isPublicApiAuthorized(req)) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    return jsonRes(res, 200, buildSimulationPlatformStats("binance"));
  }

  if (pathname === "/api/public/simulation/extended-total" && req.method === "GET") {
    if (!isPublicApiAuthorized(req)) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    return jsonRes(res, 200, buildSimulationPlatformStats("extended"));
  }

  if (pathname === "/api/public/simulation/order-count" && req.method === "GET") {
    if (!isPublicApiAuthorized(req)) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    return jsonRes(res, 200, buildSimulationOrderCountStats());
  }

  if (pathname === "/api/public/simulation/average-roi" && req.method === "GET") {
    if (!isPublicApiAuthorized(req)) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    return jsonRes(res, 200, buildSimulationAverageRoiStats());
  }

  if (pathname === "/api/public/simulation/summary" && req.method === "GET") {
    if (!isPublicApiAuthorized(req)) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    return jsonRes(res, 200, buildSimulationSummary(), {
      "Cache-Control": "private, max-age=5"
    });
  }

  if (pathname === "/api/public/exchange-display-data" && req.method === "GET") {
    if (!isPublicApiAuthorized(req)) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    return jsonRes(res, 200, buildExchangeDisplayData(parsed.query.id || ""));
  }

  if (pathname === "/api/public/market-klines" && req.method === "GET") {
    if (!isPublicApiAuthorized(req)) {
      return jsonRes(res, 401, { ok: false, error: "Unauthorized" });
    }

    const symbol = String(parsed.query.symbol || "ETH");
    const interval = String(parsed.query.interval || "1h");
    const limit = Number(parsed.query.limit || 260);
    const platform = String(parsed.query.platform || "");
    return getPublicMarketKlines(symbol, interval, limit, platform)
      .then(data => jsonRes(res, 200, data, { "Cache-Control": "public, max-age=10" }))
      .catch(error => jsonRes(res, 502, { ok: false, error: error?.message || "Market data failed" }));
  }

  const needsAuthPage =
    pathname === "/" ||
    pathname === "/index.html" ||
    pathname === "/mobile.html";

  if (needsAuthPage && !isAuthenticated(req)) {
    return redirect(res, `/login.html?next=${encodeURIComponent(pathname === "/index.html" ? "/" : pathname)}`);
  }

  const protectedApiPrefixes = [
    "/api/trend-only",
    "/api/trend-only/confirm",
    "/api/trend-only/close",
    "/api/trend-only/config",
    "/api/status",
    "/api/mobile-status",
    "/api/account-summaries",
    "/api/instruments",
    "/api/config",
    "/api/account/select",
    "/api/account/create",
    "/api/account/delete",
    "/api/start",
    "/api/start-all",
    "/api/stop",
    "/api/stop-all",
    "/api/reset",
    "/api/manual-order",
    "/api/profit-history",
    "/api/profit-voucher",
    "/api/diagnostics/error-summary"
  ];

  if (protectedApiPrefixes.includes(pathname) && !isAuthenticated(req)) {
    return jsonRes(res, 401, { ok: false, error: "未登录或登录已过期" });
  }

  if (pathname.startsWith("/api/trend-only")) {
    if (!isAuthenticated(req)) return jsonRes(res, 401, { ok: false, error: "请先登录" });
    const acc = getCurrentAccount(), st = stateMap[acc.id];
    if (req.method === "GET" && pathname === "/api/trend-only/signal-journal") {
      const target = getAccountById(parsed.query.id || acc.id);
      if (!target) return jsonRes(res, 404, { ok: false, error: "账户不存在" });
      if (!isTrendOnly(target)) return jsonRes(res, 400, { ok: false, error: "该账户未启用 Trend Only" });
      return jsonRes(res, 200, { ok: true, accountId: target.id, ...trendRuntime.signalJournal(target, parsed.query) });
    }
    if (req.method === "GET" && pathname === "/api/trend-only") {
      if (isTrendOnly(acc)) trendRuntime.publish(acc, st);
      const T = trendEngine(acc);
      return jsonRes(res, 200, { ok: true, accountId: acc.id, accountName: acc.name, active: isTrendOnly(acc), paper: isSimulationAccount(acc), running: st.running,
        strategyType: getStrategyType(acc), config: T.normalizeConfig(acc.trendOnlyConfig), state: isTrendOnly(acc) ? st.trendOnly : { weekendBlocked: T.isWeekendBlocked(Date.now(), T.normalizeConfig(acc.trendOnlyConfig)) }, lastAction: isTrendOnly(acc) ? st.lastAction : "旧策略保持运行，趋势模式未启用" });
    }
    if (req.method !== "POST") return jsonRes(res, 405, { ok: false });
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 20000) req.destroy(); });
    req.on("end", async () => {
      let lock;
      try {
        const data = JSON.parse(body || "{}");
        if (data.accountId !== acc.id || getCurrentAccount().id !== acc.id) throw new Error("当前账户已改变，请刷新");
        if (st.tickRunning) throw new Error("账户正在执行，请稍后重试");
        lock = acquireAccountTradeLock(acc.id);
        if (!lock) throw new Error("账户交易锁繁忙");
        st.tickRunning = true;
        if (pathname === "/api/trend-only/config") {
          if (st.running || Number(st.positionQty) > 0 || trendRuntime.busy(acc)) throw new Error("请先停止开仓，并平仓或核对未确认订单后修改配置");
          const cfg = loadConfig(), target = cfg.accounts.find(a => a.id === acc.id);
          const requestedType = ["trend_only_v1", "trend_only_v2"].includes(data.strategyType) ? data.strategyType : (isTrendOnly(acc) ? getStrategyType(acc) : "trend_only_v2");
          target.trendOnlyConfig = trendEngine(requestedType).normalizeConfig(data.config);
          target.strategyType = requestedType; target.strategyMode = requestedType === "trend_only_v2" ? "Trend Only V2" : "Trend Only V1";
          target.leverage = target.trendOnlyConfig.leverage;
          target.maxAdds = 0;
          // Initial activation is Paper. Live remains an explicit separate account setting.
          if (!isTrendOnly(acc)) { target.tradeMode = "simulation"; target.simulationEnabled = true; }
          saveConfig(cfg); config = cfg; trendRuntime.clearApproval(acc.id);
        } else {
          if (!isTrendOnly(acc)) throw new Error("当前账户未选择 Trend Only 策略");
          if (pathname === "/api/trend-only/confirm") { trendRuntime.confirm(acc, data); await trendRuntime.tick(acc, st); }
          else if (pathname === "/api/trend-only/close") await trendRuntime.tick(acc, st, "manual_close");
          else throw new Error("未知趋势操作");
        }
        return jsonRes(res, 200, { ok: true });
      } catch (e) { return jsonRes(res, 400, { ok: false, error: e.message }); }
      finally { if (lock) { st.tickRunning = false; releaseAccountTradeLock(lock); } }
    });
    return;
  }

  if (pathname === "/api/instruments" && req.method === "GET") {
    const platform = String(parsed.query.platform || "hyperliquid").toLowerCase();
    if (!["hyperliquid", "binance", "extended"].includes(platform)) {
      return jsonRes(res, 400, { ok: false, error: "平台类型无效" });
    }
    let items = listInstruments(platform);
    let exchangeVerified = platform !== "binance";
    let warning = "";
    if (platform === "binance") {
      const exchangeInfo = binanceExchangeInfoCache.data;
      if (exchangeInfo) {
        const liveSymbols = new Set((exchangeInfo.symbols || [])
          .filter(isBinanceSupportedPerpetual)
          .map(item => item.symbol));
        items = items.filter(item => liveSymbols.has(`${item.symbol}USDT`));
        exchangeVerified = true;
      } else {
        warning = "Binance 合约目录正在后台校验；实盘下单前仍会强制校验。";
        getBinanceExchangeInfo().catch(error => {
          console.error("Binance contract catalog warm-up failed:", error?.message || error);
        });
      }
    }
    const groups = [
      { id: "crypto", label: "主流币", items: items.filter(item => item.group === "crypto") },
      { id: "tradfi", label: "传统金融 · 股票永续", items: items.filter(item => item.group === "tradfi") }
    ].filter(group => group.items.length);
    return jsonRes(res, 200, {
      ok: true,
      platform,
      groups,
      items,
      exchangeVerified,
      warning,
      derivativeNotice: platform === "binance"
        ? "股票品种为 Binance USD-M 传统金融永续合约，不代表持有真实股票；实盘下单前会再次校验合约状态和数量精度。"
        : ""
    });
  }


  if (pathname === "/api/diagnostics/error-summary" && req.method === "GET") {
    const items = (config.accounts || []).map(acc => {
      const st = stateMap[acc.id] || {};
      const currentPrice = Number(st.currentPrice || 0);
      const nextTakeProfitPrice = Number(st.nextTakeProfitPrice || 0);
      const effectiveSide = isSmartStrategy(acc) ? (st.smartSide || acc.side) : acc.side;

      let takeProfitReachedNow = false;
      if (currentPrice > 0 && nextTakeProfitPrice > 0) {
        takeProfitReachedNow = isSmartStrategy(acc)
          ? effectiveSide === "long"
            ? currentPrice <= nextTakeProfitPrice
            : currentPrice >= nextTakeProfitPrice
          : effectiveSide === "long"
            ? currentPrice >= nextTakeProfitPrice
            : currentPrice <= nextTakeProfitPrice;
      }

      return {
        id: acc.id,
        name: acc.name,
        platform: acc.platform,
        symbol: acc.symbol,
        side: effectiveSide,
        running: !!st.running,
        currentPrice: st.currentPrice || 0,
        entryPrice: st.entryPrice || 0,
        pnl: st.pnl || 0,
        roi: st.roi || 0,
        nextTakeProfitPrice: st.nextTakeProfitPrice || 0,
        nextAddPrice: st.nextAddPrice || 0,
        takeProfitReachedNow,
        lastAction: st.lastAction || "",
        lastError: st.lastError || "",
        updatedAt: st.updatedAt || "",
        recentLogs: Array.isArray(st.logs) ? st.logs.slice(0, 5) : []
      };
    });

    const errorItems = items.filter(item => !!item.lastError);

    return jsonRes(res, 200, {
      ok: true,
      totalAccounts: items.length,
      errorAccounts: errorItems.length,
      items: errorItems
    });
  }

  if (pathname === "/api/status" && req.method === "GET") {
    const currentAccount = getCurrentAccount();
    const currentState = stateMap[currentAccount.id];
    const dashboard = buildDashboardPayload(currentAccount, currentState);

    const accountSummaries = config.accounts.map(acc => {
      const st = stateMap[acc.id];
      return {
        ...sanitizeAccountForDashboard(acc, st),
        running: st.running,
        pnl: st.pnl,
        roi: st.roi,
        lastAction: st.lastAction,
        lastError: st.lastError,
        hasPosition: Number(st.positionQty || st.realPositionSize || st.trendOnly?.position?.positionSize || 0) > 0,
        hasPendingOrder: !!st.trendOnly?.pendingOrder,
        balance: st.balance,
        available: st.available,
        marginRatio: st.marginRatio || 0
      };
    });

    return jsonRes(res, 200, {
      currentAccountId: config.currentAccountId,
      accounts: accountSummaries,
      config: dashboard.config,
      state: dashboard.state
    });
  }

  if (pathname === "/api/mobile-status" && req.method === "GET") {
    const currentAccount = getCurrentAccount();
    const currentState = stateMap[currentAccount.id];
    const dashboard = buildDashboardPayload(currentAccount, currentState);

    return jsonRes(res, 200, {
      ok: true,
      config: dashboard.config,
      state: dashboard.state
    });
  }

  if (pathname === "/api/account-summaries" && req.method === "GET") {
    const items = config.accounts.map(acc => {
      const st = stateMap[acc.id];
      return {
        ...sanitizeAccountForDashboard(acc, st),
        running: st.running,
        pnl: st.pnl,
        roi: st.roi,
        balance: st.balance,
        available: st.available,
        lastAction: st.lastAction,
        lastError: st.lastError,
        hasPosition: Number(st.positionQty || st.realPositionSize || st.trendOnly?.position?.positionSize || 0) > 0,
        hasPendingOrder: !!st.trendOnly?.pendingOrder,
        marginRatio: st.marginRatio || 0
      };
    });

    return jsonRes(res, 200, { ok: true, items });
  }

  if (pathname === "/api/config" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const next = validateAccountConfigPayload(JSON.parse(body || "{}"));
        const cfg = loadConfig();
        const idx = cfg.accounts.findIndex(a => a.id === cfg.currentAccountId);

        if (idx === -1) return jsonRes(res, 404, { ok: false, error: "当前账户不存在" });

        const current = cfg.accounts[idx];
        const currentState = stateMap[current.id];
        for (const key of ["privateKey", "apiKey", "apiSecret", "starkPrivateKey", "publicKey", "vault"]) {
          if (next[key] === undefined || next[key] === null || String(next[key]).trim() === "") {
            delete next[key];
          }
        }
        if (isTrendOnly(next)) { next.trendOnlyConfig = trendEngine(next).normalizeConfig(next.trendOnlyConfig || current.trendOnlyConfig); next.leverage = next.trendOnlyConfig.leverage; next.maxAdds = 0; }
        if ((isTrendOnly(current) || isTrendOnly(next)) && (currentState.tickRunning || currentState.running || trendRuntime.busy(current))) throw new Error("趋势策略运行、持仓或订单未确认时禁止修改配置");
        if (isTrendOnly(next) && !isTrendOnly(current)) { next.tradeMode = "simulation"; next.simulationEnabled = true; }
        if (isTrendOnly(current) && !next.strategyType) next.leverage = (next.trendOnlyConfig || current.trendOnlyConfig).leverage;
        if (next.strategyType && !isTrendOnly(next)) next.strategyMode = next.strategyType === "classic" ? "DCA基础模式" : "智能V1";
        trendRuntime.clearApproval(current.id);
        const changesPositionContract =
          (next.strategyType && next.strategyType !== (current.strategyType || "classic")) ||
          (next.symbol && next.symbol !== current.symbol) ||
          (next.tradeMode && next.tradeMode !== current.tradeMode);
        if (changesPositionContract && Number(currentState?.positionQty || 0) > 0) {
          throw new Error("当前仍有持仓，请先平仓后再切换策略、币种或交易模式");
        }
        if (current.strategyType === "smart_regime_v1" && next.strategyType === "classic") {
          clearSmartRuntime(current.id);
          resetSmartPosition(currentState);
        }
        cfg.accounts[idx] = { ...cfg.accounts[idx], ...next };
        saveConfig(cfg);
        config = cfg;
        ensureAccountStates();

        return jsonRes(res, 200, { ok: true, config: sanitizeAccountForDashboard(cfg.accounts[idx], stateMap[cfg.accounts[idx].id]) });
      } catch (e) {
        return jsonRes(res, 400, { ok: false, error: e.message || "保存配置失败" });
      }
    });
    return;
  }

  if (pathname === "/api/account/select" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { id } = JSON.parse(body || "{}");
        const cfg = loadConfig();
        const target = cfg.accounts.find(a => a.id === id);

        if (!target) return jsonRes(res, 404, { ok: false, error: "账户不存在" });

        cfg.currentAccountId = id;
        saveConfig(cfg);
        config = cfg;

        return jsonRes(res, 200, { ok: true });
      } catch (e) {
        return jsonRes(res, 400, { ok: false, error: "切换账户失败" });
      }
    });
    return;
  }

  if (pathname === "/api/account/create" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const id = "acc_" + Date.now();
        const platform = data.platform || "hyperliquid";
        validateAccountConfigPayload({ platform });

        const newAcc = {
          id,
          name: String(data.name || `账户${Date.now()}`).trim().slice(0, 40),
          platform,
          address: data.address || "",
          privateKey: data.privateKey || "",
          apiKey: data.apiKey || "",
          apiSecret: data.apiSecret || "",
          starkPrivateKey: data.starkPrivateKey || "",
          publicKey: data.publicKey || "",
          vault: data.vault || "",
          symbol: "ETH",
          quoteAsset: platform === "binance" ? "USDT" : (platform === "extended" ? "USD" : "USDC"),
          side: "long",
          strategyType: "trend_only_v2",
          strategyMode: "Trend Only V2",
          trendOnlyConfig: TrendOnlyV2.normalizeConfig({}),
          smartStrategy: { ...SMART_STRATEGY_DEFAULTS },
          leverage: 10,
          baseAmount: 1000,
          addAmount: 1000,
          takeProfit: 0.01,
          addTrigger: 0.005,
          maxAdds: 0,
          interval: DEFAULT_ACCOUNT_INTERVAL_MS,
          tradeMode: "simulation",
          simulationEnabled: true,
          simulationBalance: 10000,
          simulationSlippageBps: 0
        };

        const cfg = loadConfig();
        cfg.accounts.push(newAcc);
        cfg.currentAccountId = id;
        saveConfig(cfg);
        config = cfg;
        ensureAccountStates();

        return jsonRes(res, 200, { ok: true, account: sanitizeAccountForDashboard(newAcc, stateMap[newAcc.id]) });
      } catch (e) {
        return jsonRes(res, 400, { ok: false, error: "创建账户失败" });
      }
    });
    return;
  }

  if (pathname === "/api/account/delete" && req.method === "POST") {
    const cfg = loadConfig();
    const deleting = getCurrentAccount();
    if (isTrendOnly(deleting) && (stateMap[deleting.id]?.running || stateMap[deleting.id]?.tickRunning || trendRuntime.busy(deleting))) return jsonRes(res, 400, { ok: false, error: "趋势账户仍运行、持仓或订单未确认，禁止删除" });

    if (cfg.accounts.length <= 1) {
      return jsonRes(res, 400, { ok: false, error: "至少保留一个账户" });
    }

    const currentId = cfg.currentAccountId;
    cfg.accounts = cfg.accounts.filter(a => a.id !== currentId);
    cfg.currentAccountId = cfg.accounts[0].id;
    saveConfig(cfg);
    config = cfg;

    delete historyMap[currentId];
    historyRevision += 1;
    historyWriter.schedule();
    clearSmartRuntime(currentId);

    ensureAccountStates();

    return jsonRes(res, 200, { ok: true });
  }


  if (pathname === "/api/start-all" && req.method === "POST") {
    (async () => {
      const results = [];

      try {
        const cfg = loadConfig();
        ensureAccountStates();
        normalizeExistingAccountIntervals();

        await runWithConcurrency(cfg.accounts || [], ACCOUNT_START_SYNC_CONCURRENCY, async (current) => {
          try {
            if (isTrendOnly(current)) { results.push({ id: current.id, name: current.name, ok: false, skipped: true, error: `${getStrategyMode(current)} 账户需要单独启动，避免 Live 信号确认被批量绕过。` }); return; }
            validateAccountConfigPayload({
              platform: current.platform,
              strategyType: current.strategyType || "classic",
              smartStrategy: current.smartStrategy,
              side: current.side,
              symbol: current.symbol,
              leverage: current.leverage,
              baseAmount: current.baseAmount,
              addAmount: current.addAmount,
              takeProfit: current.takeProfit,
              addTrigger: current.addTrigger,
              maxAdds: current.maxAdds,
              interval: current.interval
            });

            if (isSimulationAccount(current)) {
              addLog(current.id, "模拟交易已启用，已跳过杠杆同步");
            } else {
              if (current.platform === "hyperliquid") {
              try {
                await syncHyperliquidLeverage(current);
              } catch (e) {
                addLog(current.id, "Hyper设置杠杆失败（批量启动已忽略）: " + e.message);
              }
            }

              if (current.platform === "binance") {
              try {
                await syncBinanceLeverage(current);
              } catch (e) {
                addLog(current.id, "Binance设置杠杆失败（批量启动已忽略）: " + e.message);
              }
            }

              if (current.platform === "extended") {
              try {
                await syncExtendedLeverage(current);
              } catch (e) {
                addLog(current.id, "Extended设置杠杆失败（批量启动已忽略）: " + e.message);
              }
            }

            }

            const st = stateMap[current.id];
            if (st) {
              st.running = true;
              st.lastAction = "机器人已批量启动";
              addLog(current.id, "机器人已批量启动");
            }

            results.push({ id: current.id, name: current.name, ok: true });
          } catch (e) {
            results.push({ id: current.id, name: current.name, ok: false, error: e.message });
            addLog(current.id, "批量启动失败: " + e.message);
          }
        });

        for (const item of results) {
          if (item.ok) {
            const acc = (cfg.accounts || []).find(a => a.id === item.id);
            if (acc) acc.running = true;
          }
        }
        saveConfig(cfg);
        config = cfg;

        const successCount = results.filter(item => item.ok).length;
        const skipped = results.filter(item => !item.ok).map(item => ({ id: item.id, name: item.name, reason: item.error || "未知原因" }));
        return jsonRes(res, 200, { ok: true, results, successCount, skippedCount: skipped.length, skipped });
      } catch (e) {
        return jsonRes(res, 500, { ok: false, error: e.message, results });
      }
    })();
    return;
  }

  if (pathname === "/api/stop-all" && req.method === "POST") {
    const cfg = loadConfig();
    ensureAccountStates();

    for (const current of cfg.accounts || []) {
      const st = stateMap[current.id];
      current.running = false;
      if (!st) continue;
      st.running = false;
      st.lastAction = "机器人已批量停止";
      addLog(current.id, "机器人已批量停止");
    }

    saveConfig(cfg);
    config = cfg;

    return jsonRes(res, 200, { ok: true, count: (cfg.accounts || []).length });
  }

  if (pathname === "/api/start" && req.method === "POST") {
    (async () => {
      try {
        const current = getCurrentAccount();
        if (isTrendOnly(current)) {
          if (isTrendOnlyV2(current) && current.platform === "extended" && !isSimulationAccount(current)) {
            const message = "Extended Live 趋势下单暂未开放；请使用 Paper 测试或切换 Hyperliquid/Binance。";
            return jsonRes(res, 400, { ok: false, error: message, message });
          }
          stateMap[current.id].running = true; persistAccountRunning(current.id, true);
          return jsonRes(res, 200, { ok: true, message: "趋势监控已启动；周末/震荡行情不会新开仓；Live 每次新仓仍须确认。" });
        }
        validateAccountConfigPayload({
          platform: current.platform,
          strategyType: current.strategyType || "classic",
          smartStrategy: current.smartStrategy,
          side: current.side,
          symbol: current.symbol,
          leverage: current.leverage,
          baseAmount: current.baseAmount,
          addAmount: current.addAmount,
          takeProfit: current.takeProfit,
          addTrigger: current.addTrigger,
          maxAdds: current.maxAdds,
          interval: current.interval
        });

        if (isSimulationAccount(current)) {
          addLog(current.id, "模拟交易已启用，已跳过杠杆同步");
        } else {
          if (current.platform === "hyperliquid") {
          try {
            await syncHyperliquidLeverage(current);
          } catch (e) {
            addLog(current.id, "Hyper设置杠杆失败（已忽略）: " + e.message);
          }
        }

          if (current.platform === "binance") {
          try {
            await syncBinanceLeverage(current);
          } catch (e) {
            addLog(current.id, "Binance设置杠杆失败（已忽略）: " + e.message);
          }
        }

          if (current.platform === "extended") {
          try {
            await syncExtendedLeverage(current);
          } catch (e) {
            addLog(current.id, "Extended设置杠杆失败（已忽略）: " + e.message);
          }
        }

        }

        stateMap[current.id].running = true;
        persistAccountRunning(current.id, true);
        stateMap[current.id].lastAction = "机器人已启动";
        addLog(current.id, "机器人已启动");
        return jsonRes(res, 200, { ok: true });
      } catch (e) {
        return jsonRes(res, 500, { ok: false, error: e.message });
      }
    })();
    return;
  }

  if (pathname === "/api/stop" && req.method === "POST") {
    const current = getCurrentAccount();
    stateMap[current.id].running = false;
    persistAccountRunning(current.id, false);
    stateMap[current.id].lastAction = "机器人已停止";
    addLog(current.id, "机器人已停止");
    return jsonRes(res, 200, { ok: true });
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    const current = getCurrentAccount();
    const st = stateMap[current.id];
    if (isTrendOnly(current)) return jsonRes(res, 400, { ok: false, error: "趋势状态不可通过重置清除，请使用趋势平仓或核对订单" });

    st.entryPrice = 0;
    st.positionQty = 0;
    st.positionValueU = 0;
    st.marginUsedU = 0;
    st.marginRatio = 0;
    st.nextAddPrice = 0;
    st.nextAddAmountU = Number((current.addAmount / current.leverage).toFixed(4));
    st.nextTakeProfitPrice = 0;
    st.nextTakeProfitTargetU = 0;
    st.pnl = 0;
    st.roi = 0;
    st.addCount = 0;
    st.cycleCount = 0;
    st.lastAction = "已重置";
    st.lastActionPrice = 0;
    st.lastError = "";
    st.logs = [];
    st.realEntryPrice = "-";
    st.realUnrealizedPnl = "-";
    st.realPositionSize = "-";
    st.lastAddTs = 0;
    st.placingOrder = false;
    st.simInitialBalance = getSimulationInitialBalance(current);
    st.simBalance = st.simInitialBalance;
    st.simRealizedPnl = 0;
    resetSmartPosition(st);
    st.smartRegime = "WAITING";
    st.smartScore = 0;
    st.smartLongScore = 0;
    st.smartShortScore = 0;
    st.smartAtr = 0;
    st.smartRiskOff = false;
    st.smartReduceRisk = false;
    st.smartPauseUntil = 0;
    st.smartLastClosedSignalTime = 0;
    st.smartOrderBackoffUntil = 0;
    st.smartExitSignalTime = 0;
    st.smartExitSignalCount = 0;
    st.smartLossLockedUntil = 0;
    st.smartDailyPnl = 0;
    st.smartConsecutiveLosses = 0;
    clearSmartRuntime(current.id);
    if (isSimulationAccount(current)) {
      syncSimulationAccountView(st, current);
    }

    return jsonRes(res, 200, { ok: true });
  }

  if (pathname === "/api/manual-order" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const current = getCurrentAccount();
        const data = JSON.parse(body || "{}");
        if (isTrendOnly(current)) throw new Error("Trend Only 策略禁止手动加仓，请使用趋势面板平仓");

        const side = data.side || (current.side === "long" ? "buy" : "sell");
        const symbol = data.symbol || current.symbol;

        let size = Number(data.size || 0);
        if (!size && data.amountU) {
          const px = await getMarketPrice(current);
          size = Number(data.amountU) / px;
        }

        if (!size || size <= 0) {
          return jsonRes(res, 400, { ok: false, error: "缺少有效 size 或 amountU" });
        }

        let order;

        if (isSimulationAccount(current)) {
          const px = data.price ? Number(data.price) : await getMarketPrice(current);
          const fillPrice = getSimulatedFillPrice(current, side, px);
          order = buildSimulationOrder({
            acc: current,
            side,
            size,
            price: fillPrice,
            reduceOnly: !!data.reduceOnly
          });
        } else if (current.platform === "hyperliquid") {
          order = await placeHyperliquidOrder({
            account: current,
            symbol,
            side,
            size,
            price: data.price ? Number(data.price) : undefined,
            reduceOnly: !!data.reduceOnly,
            tif: data.tif || "Ioc"
          });
        } else if (current.platform === "binance") {
          order = await placeBinanceOrder({
            account: current,
            side,
            qty: size,
            reduceOnly: !!data.reduceOnly
          });
        } else if (current.platform === "extended") {
          const px = data.price ? Number(data.price) : await getExtendedPrice(symbol);
          order = await placeExtendedOrder({
            account: current,
            symbol,
            side,
            size,
            price: px,
            reduceOnly: !!data.reduceOnly
          });
        } else {
          return jsonRes(res, 400, { ok: false, error: "当前账户平台不支持" });
        }

        addLog(current.id, `手动真实下单成功 ${symbol} ${side} ${order.size} @ ${order.price}`);

        return jsonRes(res, 200, { ok: true, order });
      } catch (e) {
        return jsonRes(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  if (pathname === "/api/profit-history" && req.method === "GET") {
    const accountId = parsed.query.id || config.currentAccountId;
    const st = stateMap[accountId];

    if (!st) return jsonRes(res, 200, { ok: true, items: [] });

    const items = (st.profitHistory || []).map(item => normalizeProfitVoucher(item, accountId));

    return jsonRes(res, 200, { ok: true, items });
  }

  if (pathname === "/api/profit-voucher" && req.method === "GET") {
    const accountId = parsed.query.id || config.currentAccountId;
    const idx = Number(parsed.query.idx);
    const st = stateMap[accountId];

    if (!st || !Array.isArray(st.profitHistory)) {
      return jsonRes(res, 404, { ok: false, error: "历史记录不存在" });
    }

    if (!Number.isInteger(idx) || idx < 0 || idx >= st.profitHistory.length) {
      return jsonRes(res, 400, { ok: false, error: "凭证索引无效" });
    }

    return jsonRes(res, 200, { ok: true, item: normalizeProfitVoucher(st.profitHistory[idx], accountId) });
  }

  let safePathname;
  try { safePathname = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^[/\\]+/, ""); }
  catch { return jsonRes(res, 400, { ok: false, error: "请求路径编码无效" }); }
  const filePath = path.resolve(PUBLIC_DIR, safePathname);
  serveFile(res, filePath);
});

let shutdownStarted = false;
async function gracefulShutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Received ${signal}; flushing runtime state before shutdown.`);
  server.close();

  try {
    await Promise.all([
      historyWriter.flush(),
      simulationOrdersWriter.flush(),
      smartRuntimeWriter.flush()
    ]);
  } catch (error) {
    console.error("Final state flush failed:", error?.message || error);
    historyWriter.flushSync();
    simulationOrdersWriter.flushSync();
    smartRuntimeWriter.flushSync();
  }
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

initSdk()
  .catch((err) => {
    console.error("Hyperliquid SDK 初始化失败，Hyper 下单已禁用:", err);
  })
  .finally(() => {
    getCachedPublicProfitVoucherPayload(200);
    getCachedPublicProfitVoucherPayload(2000);
    getBinanceExchangeInfo().catch((error) => {
      console.error("Binance contract catalog warm-up failed:", error?.message || error);
    });
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`多账户实盘版 UI 已启动: http://localhost:${PORT}`);
    });
  });
