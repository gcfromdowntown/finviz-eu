// finviz-eu — 歐洲版板塊輪動掃描器數據抓取
//
// 數據源（全部免費、唔使 API key、現金成本 $0）：
//   - Yahoo Finance chart API v8（唔使認證）：19 隻 iShares STOXX Europe 600
//     板塊 UCITS ETF（Xetra）+ 資產類別 ETF 嘅 2 年日線收市價／成交量。
//     由收市價直接計出 1W / 1M / 3M 表現、SMA20/50/200、RSI(14)、52 週高低。
//   - Yahoo Finance quoteSummary（crumb + cookie 認證）：ETF 總資產 totalAssets，
//     用嚟計資金流（同美股版同一做法）。呢個認證流程喺個別網絡環境
//     （例如呢部開發機）會被 Yahoo 拒絕；失敗嗰陣只會警告並跳過，
//     資金流留空，等 GitHub Actions runner 跑嗰陣再攞。
//
// 做唔到嘅部分（美股版有、歐洲版無，原因見 README）：
//   - 暗池／沽空量：FINRA / NYSE / Nasdaq 沽空數據只覆蓋美股，歐洲無免費等價來源。
//   - SEC EDGAR N-PORT：美國 SEC 專屬；歐洲版長期資金流靠每日 AUM 快照累積歷史。
//   - 期權數據：Yahoo 期權鏈只覆蓋美股上市期權；歐洲 ETF 期權喺 Eurex 交易，Yahoo 無。
//   - 個別股票廣度：歐洲版用 19 隻 supersector ETF 做「偽股票」，
//     板塊廣度 = 板塊內 supersector 升幅比例（唔係成份股比例），
//     等權重 vs 市值加權 spread 用 AUM 做權重（AUM 攞唔到嗰陣退回等權重）。
import type { StockData, SectorETF, AssetClassETF, TechnicalData, ETFAUMSnapshot, NPortQuarterlyData, DarkPoolData, DarkPoolAggregate, OptionsData } from "./types.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Yahoo chart API 唔使認證，但加 timeout 防止個別請求 hang 死成個 build
//（開發機實測：Yahoo 認證端點可以 hang 幾分鐘）。
const FETCH_TIMEOUT_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return res;
}

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, {
        headers: {
          Accept: "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": USER_AGENT,
        },
      });
    } catch (err) {
      if (i === retries) throw err;
      await sleep(2000 * (i + 1));
      continue;
    }

    if (res.ok) return res;
    if (
      (res.status === 403 || res.status === 429 || res.status >= 500) &&
      i < retries
    ) {
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * (i + 1));
      continue;
    }
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  throw new Error(`Failed after ${retries} retries: ${url}`);
}

// ---------------------------------------------------------------------------
// 板塊定義：19 個 STOXX supersector ETF（Xetra）→ 11 個 GICS 板塊
// 全部 ticker 已於 2026-11-14 經 Yahoo Finance chart / search API 逐一核實。
// ---------------------------------------------------------------------------

export interface SupersectorInfo {
  sector: string;       // GICS 板塊（同美股版一致）
  supersector: string;  // STOXX supersector 名
}

export const SECTOR_ETF_MAP: Record<string, SupersectorInfo> = {
  "EXV5.DE": { sector: "Consumer Cyclical", supersector: "Automobiles & Parts" },
  "EXV1.DE": { sector: "Financial", supersector: "Banks" },
  "EXV6.DE": { sector: "Basic Materials", supersector: "Basic Resources" },
  "EXV7.DE": { sector: "Basic Materials", supersector: "Chemicals" },
  "EXV8.DE": { sector: "Industrials", supersector: "Construction & Materials" },
  "EXH2.DE": { sector: "Financial", supersector: "Financial Services" },
  "EXH3.DE": { sector: "Consumer Defensive", supersector: "Food & Beverage" },
  "EXV4.DE": { sector: "Healthcare", supersector: "Health Care" },
  "EXH4.DE": { sector: "Industrials", supersector: "Industrial Goods & Services" },
  "EXH5.DE": { sector: "Financial", supersector: "Insurance" },
  "EXH6.DE": { sector: "Communication Services", supersector: "Media" },
  "EXH1.DE": { sector: "Energy", supersector: "Oil & Gas" },
  "EXH7.DE": { sector: "Consumer Defensive", supersector: "Personal & Household Goods" },
  "EXI5.DE": { sector: "Real Estate", supersector: "Real Estate" },
  "EXH8.DE": { sector: "Consumer Cyclical", supersector: "Retail" },
  "EXV3.DE": { sector: "Technology", supersector: "Technology" },
  "EXV2.DE": { sector: "Communication Services", supersector: "Telecommunications" },
  "EXV9.DE": { sector: "Consumer Cyclical", supersector: "Travel & Leisure" },
  "EXH9.DE": { sector: "Utilities", supersector: "Utilities" },
};

const SECTOR_ETF_TICKERS = Object.keys(SECTOR_ETF_MAP);

// ---------------------------------------------------------------------------
// 資產類別 ETF（跨資產輪動）— 全部已於 2026-11-14 核實
// ---------------------------------------------------------------------------

const ASSET_CLASS_ETF_MAP: Record<string, { assetClass: string; label: string }> = {
  "EXSA.DE": { assetClass: "歐洲股市", label: "STOXX 600" },
  "SPY":     { assetClass: "美國股市", label: "標普500" },
  "EUNH.DE": { assetClass: "歐洲債券", label: "歐元區政府債" },
  "TLT":     { assetClass: "美國債券", label: "20年期以上美債" },
  "4GLD.DE": { assetClass: "黃金",     label: "Xetra 實金" },
  "DBC":     { assetClass: "商品",     label: "商品指數" },
  "USO":     { assetClass: "商品",     label: "石油" },
  "IBIT":    { assetClass: "加密貨幣", label: "比特幣ETF" },
};

const ASSET_CLASS_TICKERS = Object.keys(ASSET_CLASS_ETF_MAP);

// ---------------------------------------------------------------------------
// Yahoo chart API — 2 年日線（夠計 SMA200 + 3M 表現）
// ---------------------------------------------------------------------------

export interface ChartPriceHistory {
  ticker: string;
  /** date → close price map (ISO date strings) */
  prices: Map<string, number>;
  /** date → volume map */
  volumes: Map<string, number>;
}

interface ChartSeries {
  ticker: string;
  dates: string[];   // ascending ISO dates
  closes: number[];  // aligned with dates (nulls removed)
  volumes: number[]; // aligned with dates
}

async function fetchChartSeries(ticker: string): Promise<ChartSeries | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`;
  try {
    const res = await fetchWithRetry(url);
    const json = (await res.json()) as any;
    const result = json?.chart?.result?.[0];
    if (!result) {
      console.warn(`    ⚠ ${ticker}: Yahoo chart 回傳空結果`);
      return null;
    }
    const timestamps: number[] = result?.timestamp || [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
    const volumes: (number | null)[] = result?.indicators?.quote?.[0]?.volume || [];

    const dates: string[] = [];
    const cleanCloses: number[] = [];
    const cleanVolumes: number[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      dates.push(new Date(timestamps[i] * 1000).toISOString().slice(0, 10));
      cleanCloses.push(closes[i] as number);
      cleanVolumes.push(volumes[i] ?? 0);
    }
    if (cleanCloses.length < 70) {
      console.warn(`    ⚠ ${ticker}: 只有 ${cleanCloses.length} 個交易日數據（要 ≥70 先計到 3M 表現）`);
      return null;
    }
    return { ticker, dates, closes: cleanCloses, volumes: cleanVolumes };
  } catch (err) {
    console.warn(`    ⚠ ${ticker}: chart 抓取失敗：${err}`);
    return null;
  }
}

/** 由收市價序列計出 1W / 1M / 3M 表現（5 / 22 / 66 個交易日前） */
function perfFromCloses(closes: number[], daysBack: number): number {
  const n = closes.length;
  if (n <= daysBack) return 0;
  const past = closes[n - 1 - daysBack];
  const now = closes[n - 1];
  if (!past || past === 0) return 0;
  return ((now - past) / past) * 100;
}

/** 簡單移動平均（最後 N 個收市價） */
function sma(closes: number[], period: number): number {
  const slice = closes.slice(-period);
  if (slice.length < period) return NaN;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/** Wilder's RSI(14)：由最近 15 個收市價（14 個變化）計出 */
function rsi14(closes: number[]): number {
  if (closes.length < 15) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** 由收市價序列計出技術指標（同美股版 Finviz v=171 嘅欄位對齊） */
function technicalsFromCloses(ticker: string, closes: number[]): TechnicalData {
  const price = closes[closes.length - 1];
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const pct = (ma: number) => (Number.isFinite(ma) && ma > 0 ? ((price - ma) / ma) * 100 : 0);

  // 52 週高低：用最近 252 個交易日
  const year = closes.slice(-252);
  const high52 = Math.max(...year);
  const low52 = Math.min(...year);

  return {
    ticker,
    sma20: Math.round(pct(sma20) * 100) / 100,
    sma50: Math.round(pct(sma50) * 100) / 100,
    sma200: Math.round(pct(sma200) * 100) / 100,
    from52WHigh: high52 > 0 ? Math.round(((price - high52) / high52) * 100 * 100) / 100 : 0,
    from52WLow: low52 > 0 ? Math.round(((price - low52) / low52) * 100 * 100) / 100 : 0,
    rsi: Math.round(rsi14(closes) * 100) / 100,
  };
}

/** 平均成交量（最近 N 個交易日） */
function avgVolume(volumes: number[], days: number): number {
  const slice = volumes.slice(-days).filter((v) => v > 0);
  if (slice.length === 0) return 0;
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

// ---------------------------------------------------------------------------
// 1. 板塊 ETF — 由圖表計表現 + 技術指標
// ---------------------------------------------------------------------------

export async function fetchSectorETFs(): Promise<{
  etfs: SectorETF[];
  technicals: Map<string, TechnicalData>;
  charts: ChartPriceHistory[];
}> {
  console.log("  Fetching sector ETF charts from Yahoo Finance...");
  const etfs: SectorETF[] = [];
  const technicals = new Map<string, TechnicalData>();
  const charts: ChartPriceHistory[] = [];

  for (const ticker of SECTOR_ETF_TICKERS) {
    const series = await fetchChartSeries(ticker);
    if (!series) continue;
    const info = SECTOR_ETF_MAP[ticker];
    const price = series.closes[series.closes.length - 1];
    const avgVol66 = avgVolume(series.volumes, 66);
    const avgVol5 = avgVolume(series.volumes, 5);

    etfs.push({
      ticker,
      sector: info.sector,
      perf1W: Math.round(perfFromCloses(series.closes, 5) * 100) / 100,
      perf1M: Math.round(perfFromCloses(series.closes, 22) * 100) / 100,
      perf3M: Math.round(perfFromCloses(series.closes, 66) * 100) / 100,
      avgVolume: Math.round(avgVol66),
      relVolume: avgVol66 > 0 ? Math.round((avgVol5 / avgVol66) * 100) / 100 : 1,
      price: Math.round(price * 100) / 100,
    });
    technicals.set(ticker, technicalsFromCloses(ticker, series.closes));

    const prices = new Map<string, number>();
    const volumes = new Map<string, number>();
    series.dates.forEach((d, i) => {
      prices.set(d, series.closes[i]);
      volumes.set(d, series.volumes[i]);
    });
    charts.push({ ticker, prices, volumes });
    await sleep(150);
  }

  console.log(`  Fetched ${etfs.length}/${SECTOR_ETF_TICKERS.length} sector ETFs`);
  if (etfs.length < SECTOR_ETF_TICKERS.length) {
    throw new Error(`Sector ETF charts returned ${etfs.length}/${SECTOR_ETF_TICKERS.length} ETFs`);
  }
  return { etfs, technicals, charts };
}

// ---------------------------------------------------------------------------
// 2. 資產類別 ETF — 同樣由圖表計表現 + 技術指標
// ---------------------------------------------------------------------------

export async function fetchAssetClassETFs(): Promise<{
  etfs: AssetClassETF[];
  technicals: Map<string, TechnicalData>;
}> {
  console.log("  Fetching asset class ETF charts from Yahoo Finance...");
  const etfs: AssetClassETF[] = [];
  const technicals = new Map<string, TechnicalData>();

  for (const ticker of ASSET_CLASS_TICKERS) {
    const info = ASSET_CLASS_ETF_MAP[ticker];
    const series = await fetchChartSeries(ticker);
    if (!series) {
      console.warn(`    ⚠ ${ticker}（${info.label}）攞唔到，跳過`);
      continue;
    }
    const avgVol66 = avgVolume(series.volumes, 66);
    const avgVol5 = avgVolume(series.volumes, 5);
    etfs.push({
      ticker,
      assetClass: info.assetClass,
      label: info.label,
      perf1W: Math.round(perfFromCloses(series.closes, 5) * 100) / 100,
      perf1M: Math.round(perfFromCloses(series.closes, 22) * 100) / 100,
      perf3M: Math.round(perfFromCloses(series.closes, 66) * 100) / 100,
      relVolume: avgVol66 > 0 ? Math.round((avgVol5 / avgVol66) * 100) / 100 : 1,
    });
    technicals.set(ticker, technicalsFromCloses(ticker, series.closes));
    await sleep(150);
  }

  console.log(`  Fetched ${etfs.length}/${ASSET_CLASS_TICKERS.length} asset class ETFs`);
  if (etfs.length === 0) {
    throw new Error("Asset class ETF charts returned no rows");
  }
  return { etfs, technicals };
}

// ---------------------------------------------------------------------------
// 3. Yahoo Finance — 現時 AUM（totalAssets）做每日快照（資金流用）
//    同美股版同一 crumb + cookie 流程。喺 Yahoo 封鎖嘅網絡環境會失敗，
//    失敗嗰陣只警告、唔終止 build（資金流留空，等 GitHub Actions 再攞）。
// ---------------------------------------------------------------------------

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string }> {
  const cookieRes = await fetchWithTimeout("https://fc.yahoo.com", {
    headers: { "User-Agent": USER_AGENT },
    redirect: "manual",
  });
  const setCookies = cookieRes.headers.getSetCookie?.() || [];
  const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

  const crumbRes = await fetchWithTimeout("https://query2.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": USER_AGENT, Cookie: cookie },
  });
  const crumb = await crumbRes.text();
  if (!crumb || crumb.includes("Unauthorized")) {
    throw new Error("Failed to get Yahoo crumb");
  }
  return { crumb, cookie };
}

export async function fetchYahooAUM(): Promise<ETFAUMSnapshot[]> {
  console.log("  Fetching AUM from Yahoo Finance...");
  const tickers = Object.keys(SECTOR_ETF_MAP);
  const snapshots: ETFAUMSnapshot[] = [];
  const today = new Date().toISOString().slice(0, 10);

  try {
    const { crumb, cookie } = await getYahooCrumb();

    for (const ticker of tickers) {
      try {
        const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=summaryDetail,price&crumb=${encodeURIComponent(crumb)}`;
        const res = await fetchWithTimeout(url, {
          headers: { "User-Agent": USER_AGENT, Cookie: cookie },
        });
        const json = (await res.json()) as any;
        const detail = json?.quoteSummary?.result?.[0]?.summaryDetail;
        const priceData = json?.quoteSummary?.result?.[0]?.price;
        const totalAssets = detail?.totalAssets?.raw ?? 0;
        const price = priceData?.regularMarketPrice?.raw ?? detail?.regularMarketPreviousClose?.raw ?? 0;

        if (totalAssets > 0) {
          snapshots.push({
            ticker,
            sector: SECTOR_ETF_MAP[ticker].sector,
            totalAssets,
            price,
            date: today,
          });
          console.log(`    ${ticker}: $${(totalAssets / 1e9).toFixed(2)}B AUM @ $${price.toFixed(2)}`);
        } else {
          console.warn(`    ⚠ ${ticker}: no totalAssets in Yahoo response`);
        }
        await sleep(200);
      } catch (err) {
        console.warn(`    ⚠ ${ticker}: Yahoo fetch failed: ${err}`);
      }
    }
  } catch (err) {
    console.warn(`  ⚠ Yahoo crumb auth failed (AUM 攞唔到，資金流會留空): ${err}`);
  }

  console.log(`  Fetched AUM for ${snapshots.length}/${tickers.length} sector ETFs`);
  return snapshots;
}

// ---------------------------------------------------------------------------
// 4. Orchestrator — 歐洲版唔用 Finviz / SEC / FINRA / 期權數據，
//    嗰啲欄位留空陣列，等 UI 同每日簡報照讀同一格式。
// ---------------------------------------------------------------------------

export async function fetchAllData(): Promise<{
  stocks: StockData[];
  etfs: SectorETF[];
  assetClassETFs: AssetClassETF[];
  technicals: Map<string, TechnicalData>;
  aumSnapshots: ETFAUMSnapshot[];
  nportData: NPortQuarterlyData[];
  chartHistory: ChartPriceHistory[];
  darkPoolData: DarkPoolData[];
  darkPoolAggregates: DarkPoolAggregate[];
  optionsData: OptionsData[];
}> {
  console.log("Fetching data from Yahoo Finance (EU)...");

  const { etfs, technicals: sectorTechnicals, charts } = await fetchSectorETFs();
  const { etfs: assetClassETFs, technicals: assetTechnicals } = await fetchAssetClassETFs();
  const technicals = new Map<string, TechnicalData>([...sectorTechnicals, ...assetTechnicals]);

  // AUM 快照（資金流 + 偽股票市值權重用）。攞唔到嗰陣用等權重。
  const aumSnapshots = await fetchYahooAUM();
  const aumMap = new Map(aumSnapshots.map((s) => [s.ticker, s.totalAssets]));

  // 偽股票：每隻 supersector ETF 當一隻「股票」，
  // 市值 = AUM（攞唔到嗰陣 = 1，即等權重），等 analyzer 原封不動重用。
  const stocks: StockData[] = etfs.map((etf) => ({
    ticker: etf.ticker,
    company: SECTOR_ETF_MAP[etf.ticker].supersector,
    sector: etf.sector,
    industry: SECTOR_ETF_MAP[etf.ticker].supersector,
    marketCap: aumMap.get(etf.ticker) ?? 1,
    perf1W: etf.perf1W,
    perf1M: etf.perf1M,
    perf3M: etf.perf3M,
  }));

  console.log(`  Built ${stocks.length} pseudo-stocks (19 supersector ETFs → 11 GICS sectors)`);

  return {
    stocks,
    etfs,
    assetClassETFs,
    technicals,
    aumSnapshots,
    nportData: [], // SEC N-PORT 係美國專屬，歐洲版無
    chartHistory: charts,
    darkPoolData: [], // FINRA 沽空量只覆蓋美股，歐洲無免費等價來源
    darkPoolAggregates: [],
    optionsData: [], // Yahoo 期權鏈只覆蓋美股上市期權
  };
}
