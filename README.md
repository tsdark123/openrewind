# OpenRewind

A free, open-source market replay and backtesting desktop app. Pick a symbol, pick the most recent trading day, and play historical 1-minute candles bar-by-bar with realistic order execution, P&L tracking, drawing tools, and zero risk.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![C++](https://img.shields.io/badge/C++-20-blue.svg)
![React](https://img.shields.io/badge/React-18+-61DAFB.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6.svg)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131.svg)

---

## Download & install (Windows)

For normal users who just want to run OpenRewind, grab the latest installer from the [GitHub Releases](https://github.com/tsdark123/openrewind/releases) page.

1. Download the latest `.msi` or `.exe` installer.
2. Run the installer and follow the prompts.
3. Launch **OpenRewind** from the Start Menu or desktop shortcut.

The installer bundles the C++ engine, the Tauri shell, and the Python data-fetch dependencies, so no manual setup is required. On first launch the app will automatically download the latest 30 days of 1-minute market data.

> **Note:** The project currently publishes an **NSIS-based Windows installer** (`pnpm tauri build`). macOS and Linux builds can be produced from the same command but are not pre-built yet.

---

## What it does

- **Market replay** — load real 1-minute historical data and step through it candle-by-candle.
- **Multi-timeframe charts** — 1m, 5m, 15m, 1H, 4H, 1D, aggregated on the fly by the C++ engine.
- **Order simulation** — market/limit orders, stop loss, take profit, position tracking, realized/unrealized P&L.
- **Technical indicators** — EMA 20, SMA 50, Bollinger Bands, RSI, MACD, ATR, Stochastic.
- **Drawing tools** — trend lines, rays, Fibonacci retracements, rectangles, brush, text, and more via `lightweight-charts-drawing`.
- **Light/dark themes** — full UI theming including the calendar picker.
- **Auto-fetch on open** — every launch refreshes the rolling 30-day 1-minute cache automatically (Tauri desktop builds).

---

## Stack

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri v2 desktop shell                                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  React + TypeScript frontend (Vite, Tailwind)         │  │
│  │  lightweight-charts + lightweight-charts-drawing     │  │
│  └───────────────────┬───────────────────────────────────┘  │
│                      │ HTTP / WebSocket                    │
└──────────────────────┼──────────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        │  C++20 engine (Crow)        │
        │  localhost:9000             │
        │  /api/* REST + /ws          │
        └──────────────┬──────────────┘
                       │
        ┌──────────────┴──────────────┐
        │  data/ CSV cache            │
        │  scripts/fetch_data.py      │
        └─────────────────────────────┘
```

- **Frontend:** `frontend/` — Vite + React + TypeScript + Tailwind CSS.
- **Backend:** `engine/` — C++20 HTTP/WebSocket server using Crow.
- **Desktop wrapper:** `src-tauri/` — Tauri v2 Rust app that spawns the C++ engine as a sidecar and runs `fetch_data.py`.
- **Data pipeline:** `scripts/fetch_data.py` — yfinance-based 1-minute downloader with a cached-append pattern.

---

## Prerequisites

- **Node.js 18+** and **pnpm** (used by this repo).
- **Rust** (for Tauri builds).
- **Python 3.9+** with the packages listed in `scripts/requirements.txt`.
- **Windows:** Visual Studio 2022 (MSVC) — the C++ engine ships as an MSBuild solution in `engine/build/openrewind-engine.vcxproj`.

---

## Developer quick start

### 1. Install frontend dependencies

```bash
cd frontend
pnpm install
```

### 2. Install Python data-fetch dependencies

```bash
cd scripts
pip install -r requirements.txt
```

### 3. Build the C++ engine

From the repo root, using the existing MSBuild solution:

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe" `
  "engine\build\openrewind-engine.vcxproj" /p:Configuration=Release /v:minimal
```

> The build will copy the engine sidecar to `src-tauri/binaries/openrewind-engine-x86_64-pc-windows-msvc.exe`.

### 4. Seed market data

```bash
cd scripts
python fetch_data.py
```

This pulls the last ~30 days of 1-minute data for the top 50 tickers into `data/`.

### 5. Run the desktop app

```bash
pnpm tauri dev
```

The app opens an intro animation, then lands directly on the chart workspace with the latest trading weekday pre-selected and the ticker list ready.

### 6. Run in the browser (without Tauri)

If you just want to hack the UI:

```bash
cd frontend
pnpm dev
```

Then manually start the C++ engine from `engine/build/Release/openrewind-engine.exe`.

---

## Data refresh behavior

`scripts/fetch_data.py` keeps a **rolling 30-day window** of 1-minute bars.

- Open the app on **August 7th** → it fetches/merges data from approximately **July 7th to August 7th**.
- Open it on **August 12th** → it fetches/merges data from approximately **July 12th to August 12th**.

On every Tauri launch the Rust sidecar runs `fetch_data.py --mode sync` automatically. The script also POSTs `/api/data_refreshed` so the engine rescans the `data/` directory and the frontend refreshes its ticker list.

---

## Project structure

```
openrewind/
├── engine/                 # C++20 core backend
│   ├── include/            # Headers (candle, session, matching, server, csv_loader)
│   ├── src/                # Implementation files
│   ├── build/              # MSBuild/CMake output
│   ├── CMakeLists.txt
│   └── vcpkg.json
├── frontend/               # React + TypeScript UI
│   ├── src/
│   │   ├── components/     # Chart, Toolbar, panels, drawing tools
│   │   ├── hooks/          # useWebSocket, etc.
│   │   ├── types/
│   │   └── utils/
│   ├── package.json
│   └── vite.config.ts
├── scripts/                # Data ingestion
│   ├── fetch_data.py       # yfinance 1-minute rolling sync
│   └── requirements.txt
├── src-tauri/              # Tauri v2 Rust wrapper
│   ├── src/lib.rs          # Engine sidecar spawn + fetch_market_data command
│   └── capabilities/
└── data/                   # Local CSV cache (git-ignored)
    └── AAPL/AAPL_history.csv
```

---

## API reference

### REST

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/tickers` | List symbols with loadable data |
| `POST` | `/api/session/start` | Start a new replay session |
| `POST` | `/api/session/stop` | End session and return summary |
| `GET`  | `/api/session/state` | Poll current session state |
| `POST` | `/api/order` | Place an order |
| `POST` | `/api/order/cancel` | Cancel a pending order |
| `POST` | `/api/data_refreshed` | Tell the engine to rescan `data/` and broadcast `data_synced` |

### WebSocket (`ws://127.0.0.1:9000/ws`)

```json
{ "cmd": "next_candle" }
{ "cmd": "rewind" }
{ "cmd": "play" }
{ "cmd": "pause" }
{ "cmd": "set_speed", "speed": 5 }
{ "cmd": "set_timeframe", "minutes": 15 }
{ "cmd": "place_order", "side": "buy", "type": "market", "quantity": 100 }
```

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Space` | Next candle |
| `Alt + 1` | Play / pause |
| `Backspace` | Remove the most recent drawing |

---

## Scripts

Root `package.json` helpers:

```bash
pnpm dev              # pnpm tauri dev
pnpm build            # pnpm tauri build
pnpm frontend:dev     # cd frontend && pnpm dev
pnpm frontend:build   # cd frontend && pnpm build
```

---

## Build the consumer installer

To produce the same one-click installer that is uploaded to GitHub Releases:

```bash
# 1. Make sure the engine sidecar is built (see Developer quick start step 3).
# 2. Build the Tauri app + NSIS installer.
pnpm build
```

Output:

- `src-tauri/target/release/openrewind.exe`
- `src-tauri/target/release/bundle/nsis/OpenRewind_0.1.0_x64-setup.exe`

Upload the `OpenRewind_*-setup.exe` (or the `.msi` if you switch the bundle target) to a new GitHub Release.

---

## License

MIT — see the `LICENSE` file for details.

---

## Acknowledgments

- [TradingView lightweight-charts](https://www.tradingview.com/lightweight-charts/)
- [lightweight-charts-drawing](https://github.com/tradingview/lightweight-charts)
- [Crow](https://crowcpp.org) C++ web framework
- [yfinance](https://github.com/ranaroussi/yfinance) for free market data
- [Tauri](https://tauri.app) for the desktop shell
