# 板塊輪動掃描器（歐洲版）Sector Rotation Scanner (EU)

STOXX Europe 600 板塊輪動儀表板：偵測機構資金喺 11 個 GICS 板塊之間嘅流向，每日 Xetra 收市後自動更新。呢個係美股版（[finviz-zh](https://github.com/gcfromdowntown/finviz-zh)）嘅歐洲版，計算邏輯同 UI 盡量重用，只換咗數據源同板塊定義。

**Live site:** `https://<owner>.github.io/finviz-eu/`

> **English summary:** A STOXX Europe 600 sector-rotation dashboard that tracks institutional capital flows across the 11 GICS sectors, updated daily after Xetra close. EU counterpart of the US scanner (finviz-zh), reusing its calculation engine and UI with a different data source. Free data only (Yahoo Finance), no API key, $0 cost.

---

## 覆蓋範圍（Universe）

- **大市：** STOXX Europe 600（泛歐 600 隻股票，係美股版標普500 嘅對等物）。
- **板塊量度：** 19 隻 **iShares STOXX Europe 600 板塊 UCITS ETF**（德國 Xetra 上市，歐元計價），對返 11 個 GICS 板塊：

| GICS 板塊 | Supersector ETF |
|---|---|
| 科技 | EXV3.DE Technology |
| 金融 | EXV1.DE Banks、EXH2.DE Financial Services、EXH5.DE Insurance |
| 能源 | EXH1.DE Oil & Gas |
| 醫療保健 | EXV4.DE Health Care |
| 非必需消費 | EXV5.DE Automobiles & Parts、EXH8.DE Retail、EXV9.DE Travel & Leisure |
| 必需消費 | EXH3.DE Food & Beverage、EXH7.DE Personal & Household Goods |
| 工業 | EXH4.DE Industrial Goods & Services、EXV8.DE Construction & Materials |
| 基礎材料 | EXV6.DE Basic Resources、EXV7.DE Chemicals |
| 通訊服務 | EXV2.DE Telecommunications、EXH6.DE Media |
| 房地產 | EXI5.DE Real Estate |
| 公用事業 | EXH9.DE Utilities |

- **資產類別（跨資產輪動）：** EXSA.DE（歐洲股市 STOXX 600）、SPY（美國股市標普500）、EUNH.DE（歐元區政府債）、TLT（20年期以上美債）、4GLD.DE（Xetra 實金）、DBC（商品指數）、USO（石油）、IBIT（比特幣 ETF）。

## 數據源（全部免費，唔使 API key，$0）

| 數據 | 來源 | 用途 |
|---|---|---|
| 板塊 ETF 2 年日線（收市價、成交量） | Yahoo Finance chart API v8（唔使認證） | 計 1W / 1M / 3M 表現、SMA20/50/200、RSI(14)、52 週高低、相對成交量 |
| ETF 總資產 totalAssets（每日快照） | Yahoo Finance quoteSummary（crumb + cookie 認證） | 資金流：Flow = AUM_now − AUM_past × (1 + 價格回報)；市值權重 |
| 技術指標 | 本地計算（Wilder RSI、SMA） | 同美股版 Finviz v=171 嘅欄位對齊 |

**全部 19 隻板塊 ETF + 8 隻資產類別 ETF 嘅 ticker 已於 2026-11-14 經 Yahoo Finance chart / search API 逐一核實**（有價、數字合理）。STOXX supersector 指數本身唔喺 Yahoo 上面（`^SX7P`、`^SX8P` 等全部回 Not Found），所以用 ETF 做代理。

### 試過但唔用得嘅來源（2026-11-14 實測）

- **Finviz：** 只覆蓋美股，冇歐洲股票。
- **stooq.com：** 撞到 JS proof-of-work 驗證牆，curl 攞唔到 CSV。
- **Yahoo crumb / quoteSummary：** 喺個別網絡環境（包括呢部開發機）會被 Yahoo 拒絕（fc.yahoo.com 回 404、getcrumb 回 "Invalid Cookie" 或 hang 幾分鐘）。Chart API（v8）唔使認證，完全正常。**GitHub Actions runner 證明同一 crumb 流程行得通**（美股版每日更新到 2026-11-13），所以歐洲版 build 會優雅降級：AUM 攞唔到嗰陣只警告、資金流留空，等 Actions 跑嗰陣再攞。fetch 加咗 20 秒 timeout，防止認證端點 hang 死成個 build。
- **iShares 官網：** 產品頁攞得到（JSON-LD 入面有 "Net Assets of Fund"），但 19 隻板塊 ETF 嘅正確 product ID 未搵齊，只係文件化嘅後備方案，v1 唔實作。justETF 回 302（疑似擋 bot），唔用。

## 同美股版嘅功能差異（重要）

| 功能 | 美股版 | 歐洲版 | 原因 |
|---|---|---|---|
| 板塊表現（1W/1M/3M） | ✅ Finviz ~500 隻個股 | ✅ 19 隻 ETF 價格 | 同等 |
| 技術指標（SMA/RSI/52W） | ✅ Finviz | ✅ 本地由圖表計 | 同等 |
| 資金流（ETF AUM） | ✅ 每日快照 + N-PORT 長期 | ⚠️ **只靠每日快照** | SEC N-PORT 係美國專屬；頭 5 日只有 5 日流，1 個月流要 22 個快照，3 個月流 66 個，1 年流 264 個。開站頭幾個月長線數字係 0，係正常。 |
| 個別股票廣度 | ✅ 成份股升幅比例 | ⚠️ **Supersector 廣度** | 廣度 = 板塊內 supersector ETF 升幅比例。單一 supersector 嘅板塊（科技、能源、醫療保健、房地產、公用事業）廣度只會係 0% 或 100%，唔好當成份股廣度。 |
| 暗池／沽空量 | ✅ FINRA 沽空量（注意：唔係真暗池成交） | ❌ **冇** | FINRA / NYSE / Nasdaq 沽空數據只覆蓋美股，歐洲無免費等價來源。診斷永遠顯示中性。 |
| 期權數據（P/C 比率、IV） | ✅ Yahoo 期權鏈 | ❌ **冇** | Yahoo 期權鏈只覆蓋美股上市期權；歐洲 ETF 期權喺 Eurex 交易，Yahoo 無。 |
| 資產類別輪動 | ✅ | ✅ | 同等（歐洲債券改用 EUNH.DE、黃金改用 4GLD.DE） |
| 輪動訊號 / 診斷 / 操作訊號 | ✅ | ✅ | 計法完全一樣（rank shift 35%、momentum accel 25%、institutional spread 20%、breadth divergence 20%） |
| 輸出格式 | docs/data.json + history 快照 | ✅ **完全一樣** | 每日板塊簡報可以照讀 |

## 點樣運作

```
Yahoo Finance chart API (2y 日線)
        ↓  19 隻 supersector ETF + 8 隻資產類別 ETF
scraper.ts — 計 1W/1M/3M 表現、SMA、RSI、52W、相對成交量
        ↓  每隻 supersector ETF 當一隻「偽股票」（市值 = AUM，攞唔到就等權重）
analyzer.ts — aggregateBySector（MCW/EW/廣度/頭 3 升幅）
        ↓  calculateRotationSignals（4 因子加權）→ INFLOW/OUTFLOW/NEUTRAL
build.ts — 寫 docs/data.json、data.js、docs/history/YYYY-MM-DD.json
        ↓
GitHub Pages 靜態網站（docs/index.html）
```

每日流程（GitHub Actions，平日 **17:00 UTC**）：
1. 跑 `npm run build`（抓數據 + 計訊號 + 寫快照）
2. 跑 `npm run verify`（27 項檢查：19 隻偽股票、11 訊號／診斷；資金流缺失只警告）
3. Commit + push 到 `main` → GitHub Pages 自動部署

Xetra 收市 17:30 CET（冬令 16:30 UTC）／17:30 CEST（夏令 15:30 UTC），17:00 UTC 兩個季節都喺收市後。

## 本地開發

```bash
npm install
npm run build        # 抓數據 + 寫 docs/data.json + history 快照
npm run verify       # 驗證輸出
npm run build:check  # build + verify 一次過
npm run web          # 本地 server：http://localhost:3000
npm start            # 終端版（文字表格）
```

## 部署步驟（GitHub）

參考美股版上次做法（用戶自己喺 Mac 上傳）：

1. **開新 repo：** 喺 GitHub 開一個 public repo，名 `finviz-eu`（唔好用 private，Pages 免費版要 public 先可以公開訪問）。
2. **Push 程式碼：** 將呢個 project 全部檔案 push 去 `main` 分支（包括 `docs/` 入面嘅 `index.html`、`guide.html` 同第一次 build 出嚟嘅 `data.json`／`data.js`／`history/`；唔好 push `node_modules/`，`.gitignore` 已經排除咗）。
   ```bash
   cd finviz-eu
   git init
   git add .
   git commit -m "Initial commit: EU sector rotation scanner (STOXX 600)"
   git remote add origin https://github.com/<你的用戶名>/finviz-eu.git
   git push -u origin main
   ```
3. **開 GitHub Pages：** Repo → Settings → Pages → Source 揀 **Deploy from a branch** → Branch 揀 `main` → Folder 揀 `/docs` → Save。幾分鐘後網站會喺 `https://<你的用戶名>.github.io/finviz-eu/` 上線。
4. **開 Actions 權限：** Repo → Settings → Actions → General → Workflow permissions 揀 **Read and write permissions**（workflow 要 commit 每日數據返 repo）。
5. **驗證自動更新：** 等下一個平日 17:00 UTC，或者去 Actions → Update Data → Run workflow 手動觸發一次。成功嘅話 `docs/history/` 會多一個當日快照，網站 timestamp 會更新。
6. **每日檢查：** Workflow 入面有 live verification step——push 完會即刻 check 線上 `data.js` 嘅 timestamp 同 stockCount（=19）係咪最新，唔啱會 fail 咗個 job 通知你。

## 檔案結構

```
finviz-eu/
├── src/
│   ├── scraper.ts    # Yahoo Finance 抓取（歐洲版，全新）
│   ├── analyzer.ts   # 板塊聚合 + 輪動訊號（重用美股版，只改 ETF 對照表）
│   ├── build.ts      # 靜態 build（資金流改純 AUM 快照計法）
│   ├── verify.ts     # 驗證（門檻：19 偽股票、11 訊號；資金流缺失只警告）
│   ├── index.ts      # CLI 終端版
│   ├── display.ts    # 終端表格（重用）
│   ├── server.ts     # 本地 dev server
│   └── types.ts      # 型別（重用）
├── docs/
│   ├── index.html    # 儀表板（重用美股版，改標題/meta 文案）
│   ├── guide.html    # 使用指南（歐洲版：19 隻 ETF 對照表 + 歐洲版限制）
│   ├── data.json     # 最新數據（build 產生）
│   ├── data.js       # file:// 後備（build 產生）
│   └── history/      # 每日快照 YYYY-MM-DD.json + index.json
├── public/
│   └── index.html    # 舊版英文靜態頁（遺留，未用於 Pages）
├── .github/workflows/update-data.yml  # 平日 17:00 UTC 自動更新
└── README.md
```

## 免責聲明

呢個工具只作資訊及教育用途，唔係投資建議。數據來自免費公開來源，可能有延遲或錯誤。過去表現唔保證將來回報。
