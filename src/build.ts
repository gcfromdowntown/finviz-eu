// Generates static data.json for GitHub Pages deployment (EU version)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAllData } from "./scraper.js";
import {
  aggregateBySector,
  calculateRotationSignals,
  validateWithETFs,
  calculateAssetClassFlows,
  buildETFTrendDetails,
  generateActionSignals,
  computeSectorDiagnostics,
} from "./analyzer.js";
import type { CapitalMode, Strategy, ETFFundFlow, ETFAUMSnapshot } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load historical AUM snapshots from daily history files */
function loadHistoricalAUM(historyDir: string): Map<string, ETFAUMSnapshot[]> {
  // Map: ticker → array of snapshots sorted by date
  const result = new Map<string, ETFAUMSnapshot[]>();

  try {
    const manifestPath = path.join(historyDir, "index.json");
    const dates: string[] = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    for (const date of dates) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(historyDir, `${date}.json`), "utf-8"));
        if (snap.aumSnapshots) {
          for (const aum of snap.aumSnapshots) {
            if (!result.has(aum.ticker)) result.set(aum.ticker, []);
            result.get(aum.ticker)!.push(aum);
          }
        }
      } catch {}
    }
  } catch {}

  // Sort each ticker's snapshots by date
  for (const [, snaps] of result) {
    snaps.sort((a, b) => a.date.localeCompare(b.date));
  }

  return result;
}

/**
 * Compute fund flows purely from daily AUM snapshots (EU version).
 * Flow = AUM_now - AUM_past × (1 + price_return)
 *
 * 歐洲版無 SEC N-PORT（美國專屬），所以 3 個月以上嘅長期資金流
 * 都係由每日快照直接計出 — 要等歷史累積夠日子先有數：
 *   5d = 5 個快照前、1m = 22 個、3m = 66 個、6m = 132 個、1y = 264 個。
 * 新 repo 頭幾個月，長線數字會係 0，係正常，唔係 bug。
 * Shares % change 同樣由快照直接計出（shares = AUM / price）。
 */
function computeFundFlows(
  todayAUM: ETFAUMSnapshot[],
  historicalAUM: Map<string, ETFAUMSnapshot[]>
): ETFFundFlow[] {
  const flows: ETFFundFlow[] = [];

  const flowFromSnapshots = (
    current: ETFAUMSnapshot,
    history: ETFAUMSnapshot[],
    daysBack: number
  ): number => {
    if (history.length < daysBack) return 0;
    const past = history[history.length - daysBack];
    if (!past || past.price === 0) return 0;
    const priceReturn = (current.price - past.price) / past.price;
    return current.totalAssets - past.totalAssets * (1 + priceReturn);
  };

  const sharesPctFromSnapshots = (
    current: ETFAUMSnapshot,
    history: ETFAUMSnapshot[],
    daysBack: number
  ): number => {
    if (history.length < daysBack || current.price === 0) return 0;
    const past = history[history.length - daysBack];
    if (!past || past.price === 0) return 0;
    const sharesNow = current.totalAssets / current.price;
    const sharesPast = past.totalAssets / past.price;
    if (sharesPast === 0) return 0;
    return (sharesNow - sharesPast) / sharesPast;
  };

  for (const aum of todayAUM) {
    const { ticker, sector, totalAssets, price } = aum;
    const history = historicalAUM.get(ticker) || [];
    const sharesOutstanding = price > 0 ? totalAssets / price : 0;

    flows.push({
      ticker,
      sector,
      totalAssets,
      sharesOutstanding,
      sharesPct5Day: sharesPctFromSnapshots(aum, history, 5),
      sharesPct1Month: sharesPctFromSnapshots(aum, history, 22),
      sharesPct3Month: sharesPctFromSnapshots(aum, history, 66),
      sharesPct1Year: sharesPctFromSnapshots(aum, history, 264),
      flow5Day: flowFromSnapshots(aum, history, 5),
      flow1Month: flowFromSnapshots(aum, history, 22),
      flow3Month: flowFromSnapshots(aum, history, 66),
      flow6Month: flowFromSnapshots(aum, history, 132),
      flow1Year: flowFromSnapshots(aum, history, 264),
    });
  }

  const nonZero = flows.filter((f) => f.flow5Day !== 0 || f.flow1Month !== 0 || f.flow3Month !== 0);
  console.log(`  Computed fund flows for ${flows.length} ETFs (${nonZero.length} have non-zero data)`);

  return flows;
}

async function build() {
  console.log("Building static data (EU)...");

  const { stocks, etfs, assetClassETFs, technicals, aumSnapshots } = await fetchAllData();

  if (stocks.length === 0) {
    console.error("No stock data fetched.");
    process.exit(1);
  }

  // Load historical AUM snapshots for flow computation
  const docsDir = path.join(__dirname, "..", "docs");
  const historyDir = path.join(docsDir, "history");
  const historicalAUM = loadHistoricalAUM(historyDir);

  // Fund flows: EU version uses daily AUM snapshots only (no N-PORT).
  // First runs have no history → flows are 0 until snapshots accumulate.
  const fundFlows = computeFundFlows(aumSnapshots, historicalAUM);
  if (aumSnapshots.length === 0) {
    console.warn("  ⚠ 今日攞唔到 AUM 快照（Yahoo 認證失敗）：資金流留空，輪動訊號唔受影響。");
  }

  const sectorPerfs = aggregateBySector(stocks);
  const signals = calculateRotationSignals(sectorPerfs);
  // 歐洲版無暗池／期權數據：傳空陣列，diagnostics 嗰兩項會顯示「—」／中性。
  const diagnostics = computeSectorDiagnostics(sectorPerfs, signals, fundFlows, [], []);
  const etfValidations = validateWithETFs(sectorPerfs, etfs);
  const assetClassFlows = calculateAssetClassFlows(assetClassETFs, technicals);
  const { sectorTrends, assetClassTrends } = buildETFTrendDetails(
    etfs, assetClassETFs, technicals
  );

  const flowMap = new Map(assetClassFlows.map((f) => [f.assetClass, f]));

  // Generate signals for all 6 mode combinations
  const capitalModes: CapitalMode[] = ["deploy", "rotate"];
  const strategies: Strategy[] = ["momentum", "contrarian", "rotation"];
  const actionSignals: Record<string, { sector: ReturnType<typeof generateActionSignals>; assetClass: ReturnType<typeof generateActionSignals> }> = {};

  for (const capital of capitalModes) {
    for (const strategy of strategies) {
      const mode = { capital, strategy };
      const key = `${capital}_${strategy}`;
      actionSignals[key] = {
        sector: generateActionSignals(sectorTrends, flowMap, signals, mode),
        assetClass: generateActionSignals(assetClassTrends, flowMap, undefined, mode),
      };
    }
  }

  const result = {
    timestamp: new Date().toISOString(),
    stockCount: stocks.length,
    sectorPerformance: sectorPerfs,
    rotationSignals: signals,
    diagnostics,
    etfValidation: etfValidations,
    assetClassFlows,
    fundFlows,
    aumSnapshots,
    nportData: [], // SEC N-PORT 係美國專屬，歐洲版無
    darkPoolData: [], // FINRA 沽空量只覆蓋美股，歐洲無免費等價來源
    darkPoolAggregates: [],
    darkPoolTrends: [],
    optionsData: [], // Yahoo 期權鏈只覆蓋美股上市期權
    sectorTrends,
    assetClassTrends,
    actionSignals,
  };

  // Write to docs/ for GitHub Pages (HTML files live directly in docs/)
  fs.mkdirSync(docsDir, { recursive: true });

  // Write JSON data only — HTML files are edited directly in docs/
  const jsonDst = path.join(docsDir, "data.json");
  fs.writeFileSync(jsonDst, JSON.stringify(result, null, 2));

  // Write data.js for file:// protocol support (no fetch needed)
  const jsDst = path.join(docsDir, "data.js");
  fs.writeFileSync(jsDst, `window.__FINVIZ_DATA = ${JSON.stringify(result)};`);

  // Save daily snapshot for historical navigation
  fs.mkdirSync(historyDir, { recursive: true });

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const snapshotPath = path.join(historyDir, `${today}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(result));

  // Update manifest of available dates
  const manifestPath = path.join(historyDir, "index.json");
  let dates: string[] = [];
  try {
    dates = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {}
  if (!dates.includes(today)) {
    dates.push(today);
    dates.sort();
  }
  fs.writeFileSync(manifestPath, JSON.stringify(dates));

  // Embed available dates in result so file:// protocol works without fetch
  (result as any).availableDates = dates;

  console.log(`\nBuild complete:`);
  console.log(`  docs/index.html`);
  console.log(`  docs/data.json (${stocks.length} pseudo-stocks, ${new Date().toISOString()})`);
  console.log(`  docs/data.js (file:// fallback)`);
  console.log(`  docs/history/${today}.json (snapshot #${dates.length})`);
}

build().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
