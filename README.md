# OpenRewind

A free, open-source market replay and backtesting desktop app. Pick a symbol, pick a trading day, and play historical 1-minute candles bar-by-bar with realistic order execution, P&L tracking, drawing tools, and zero risk.

Now with **Orion**, a private, local AI trading coach, and a **hybrid data system** that lets you use OpenRewind's managed market-data library or import your own one-minute CSVs — all without a cloud API or subscription.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![C++](https://img.shields.io/badge/C++-20-blue.svg)
![React](https://img.shields.io/badge/React-18+-61DAFB.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6.svg)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131.svg)
![Ollama](https://img.shields.io/badge/Ollama-local-000000.svg)

---

## Download & install (Windows)

For normal users who just want to run OpenRewind, grab the latest installer from the [GitHub Releases](https://github.com/tsdark123/openrewind/releases) page.

1. Download the latest `.msi` or `.exe` installer.
2. Run the installer and follow the prompts.
3. Launch **OpenRewind** from the Start Menu or desktop shortcut.
4. On first launch, choose your data source:
   - **OpenRewind Data** — managed yfinance market-data library. Auto-syncs on startup.
   - **Local Data** — import your own one-minute CSV files and replay them privately (desktop only; restart the app to switch sources).
5. If you want to chat with Orion, the app can install and start a local Ollama runtime and pull the certified `qwen3:8b` model with your consent.

> **Note:** The project currently publishes an **NSIS-based Windows installer** (`pnpm build`). macOS and Linux builds can be produced from the same command but are not pre-built yet.

---

## What it does

- **Market replay** — load real 1-minute historical data and step through it candle-by-candle.
- **Hybrid data sources** — choose between OpenRewind's managed market data or your own imported one-minute CSVs.
- **Multi-timeframe charts** — 1m, 5m, 15m, 1H, 4H, 1D, aggregated on the fly by the C++ engine.
- **Order simulation** — market/limit/stop orders, stop loss, take profit, position tracking, realized/unrealized P&L.
- **Technical indicators** — EMA 20, SMA 50, Bollinger Bands, RSI, MACD, ATR, Stochastic.
- **Drawing tools** — trend lines, rays, Fibonacci retracements, rectangles, brush, text, and more via `lightweight-charts-drawing`.
- **Light/dark themes** — full UI theming including the calendar picker.
- **Performance journal** — persisted trade history, per-session stats, and win-rate summaries.
- **Orion AI assistant** — chat or terminal interface that can switch symbols, control playback, answer questions, run backtests, and reason over your current workspace.

---

## Stack

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri v2 desktop shell                                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  React + TypeScript frontend (Vite, Tailwind)         │  │
│  │  lightweight-charts + lightweight-charts-drawing      │  │
│  │  Orion chat / terminal panels                         │  │
│  └───────────────────┬───────────────────────────────────┘  │
│                      │ HTTP / WebSocket                    │
├──────────────────────┼──────────────────────────────────────┤
│  Local Ollama        │  C++20 engine (Crow)                │
│  qwen3:8b certified  │  localhost:9000                     │
│  model               │  /api/* REST + /ws                  │
└──────────────────────┴──────────────────────────────────────┘
                       │
        ┌──────────────┴──────────────┐
        │  Hybrid data layer          │
        │  - data/ managed CSV cache  │
        │  - local-market-data/       │
        │    (user-imported CSVs)     │
        │  - scripts/fetch_data.py    │
        └─────────────────────────────┘
```

- **Frontend:** `frontend/` — Vite + React + TypeScript + Tailwind CSS.
- **Backend:** `engine/` — C++20 HTTP/WebSocket server using Crow.
- **Desktop wrapper:** `src-tauri/` — Tauri v2 Rust app that spawns the C++ engine as a sidecar, runs `fetch_data.py`, manages the local data directory, and can install/start Ollama for Orion.
- **Data pipeline:** `scripts/fetch_data.py` — yfinance-based 1-minute downloader with a cached-append pattern.
- **AI runtime:** local Ollama, defaulting to the bundled certified model `qwen3:8b`.

---

## Hybrid data system

OpenRewind supports two mutually exclusive data sources. You choose one at startup and can switch by restarting the app.

### OpenRewind Data (managed)

- Uses `scripts/fetch_data.py` to maintain a rolling 30-day window of 1-minute bars for ~50 top US equities.
- On every Tauri launch the Rust sidecar runs `fetch_data.py --mode sync` automatically.
- The script writes a per-symbol CSV (`data/<SYMBOL>/<SYMBOL>_history.csv`) and POSTs `/api/data_refreshed` so the engine rescans the directory.
- In browser development, set `OPENREWIND_DATA_DIR=data` (or run `pnpm dev:full`, which does it for you).

### Local Data (user imports)

- Available in the desktop build only.
- Import any one-minute OHLCV CSV via the **Local Data** screen.
- Accepted format:
  - One row per minute.
  - Columns: `timestamp`, `open`, `high`, `low`, `close`, `volume` (headers are inferred; column order can be remapped).
  - Timestamp must start with `YYYY-MM-DD HH:MM:SS` (a trailing timezone such as `+00:00` is ignored).
- Imported files are stored under the app's `local-market-data/<SYMBOL>/<SYMBOL>_history.csv` directory and the engine is passed the path via `OPENREWIND_LOCAL_DATA_DIR`.
- The engine authorizes only the managed data root and the configured local data root; any other `data_dir` is rejected to prevent path traversal.

---

## Orion AI assistant

Orion is a local, offline AI layer that sits alongside the chart. It is **not** a cloud service: all model calls go to a local Ollama runtime.

### Default model

- The bundled certified-model registry currently pins **`qwen3:8b`** as the only certified Orion model.
- You can override the model for development with `ORION_AGENT_MODEL` (Node/Vitest) or `VITE_ORION_AGENT_MODEL` (browser/Tauri dev). Uncertified overrides are allowed for validation but are explicitly flagged as such.
- In production the Tauri wrapper can install Ollama and pull `qwen3:8b` with your consent.

### How it works

- **Deterministic commands** (`switch`, `play`, `pause`, `set_timeframe`, `seek`, etc.) are parsed offline and executed directly, so they work even if Ollama is not reachable.
- **Semantic or compound requests** (`"What did the first-hour range look like?"`, `"Backtest an opening-range breakout on TSLA"`) are routed through compact intent extraction, compiled into an `AgentPlan`, validated, and executed.
- The model always reasons from a canonical **WorldState** snapshot (current symbol/date/timeframe, account, open positions, recent candles, and lifetime journal summary), so its answers are grounded in what is actually on screen.
- Chat history is persisted per session to `app_data_dir/data/orion_threads.json`.

### Things you can ask Orion

| Request | What Orion does |
|--------|-----------------|
| `switch to AAPL` / `AAPL 5m` | Switches symbol and optionally sets timeframe. |
| `play` / `pause` / `reset` | Controls replay playback. |
| `seek 10:30` / `go to 2:15` | Jumps to a specific market time. |
| `what's my open P&L?` | Returns the current account and positions from WorldState. |
| `analyze my session` | Reads the active session's trades and journal summary. |
| `backtest opening range breakout on TSLA` | Runs the named strategy against historical candles and reports simulated P&L, win rate, and trades. |
| `what did I do wrong on that trade?` | Pulls the session trade history and gives a grounded post-trade review. |

### Driving mode

When Orion is asked to perform a multi-step task (for example, backtest a strategy and then step through the chart), it takes control of the workspace. A driving overlay appears with an **Esc to stop** affordance. All automated trades are tagged and excluded from the persisted journal.

---

## Prerequisites

- **Node.js 18+** and **pnpm**.
- **Rust** (for Tauri builds).
- **Python 3.9+** with the packages listed in `scripts/requirements.txt`.
- **Windows:** Visual Studio 2022 (MSVC) — the C++ engine ships as both an MSBuild solution (`engine/build/openrewind-engine.vcxproj`) and a CMake project (`engine/CMakeLists.txt`).
- **Ollama** for Orion (optional for core replay, but required for AI features):
  - The Tauri app can install and start Ollama for you on Windows.
  - For development, install Ollama and pull the certified model:
    ```powershell
    ollama pull qwen3:8b
    ```

---

## Developer quick start

### 1. Install dependencies

From the repo root:

```powershell
pnpm install
```

Then in the frontend:

```powershell
cd frontend
pnpm install
```

### 2. Install Python data-fetch dependencies

```bash
cd scripts
pip install -r requirements.txt
```

### 3. Build the C++ engine

Using the existing MSBuild solution:

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe" `
  "engine\build\openrewind-engine.vcxproj" /p:Configuration=Release /v:minimal
```

Or with CMake + vcpkg:

```powershell
cd engine
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE="<vcpkg-root>\scripts\buildsystems\vcpkg.cmake"
cmake --build build --config Release
```

> The build will copy the engine sidecar to `src-tauri/binaries/openrewind-engine-x86_64-pc-windows-msvc.exe`.

### 4. Seed market data

For managed mode:

```bash
cd scripts
python fetch_data.py
```

This pulls the last ~30 days of 1-minute data for the top 50 tickers into `data/`.

### 5. Run the full browser dev stack

From the repo root:

```powershell
pnpm dev:full
```

This starts the C++ engine with `OPENREWIND_DATA_DIR=data`, waits for it to serve tickers, then starts the Vite dev server on `http://localhost:5173`.

### 6. Run the desktop app

From the repo root:

```powershell
pnpm dev
```

Or from `frontend/`:

```powershell
pnpm tauri:dev
```

This launches the Tauri app with Vite dev-server hot-reload. Both frontend and Rust changes rebuild automatically.

### 7. Run the frontend only (when the engine is already running)

```bash
cd frontend
pnpm dev
```

Then open `http://localhost:5173` in your browser.

---

## Data refresh behavior

### Managed data

`scripts/fetch_data.py` keeps a **rolling 30-day window** of 1-minute bars.

- Open the app on **August 7th** → it fetches/merges data from approximately **July 7th to August 7th**.
- Open it on **August 12th** → it fetches/merges data from approximately **July 12th to August 12th**.

On every Tauri launch the Rust sidecar runs `fetch_data.py --mode sync` automatically. The script also POSTs `/api/data_refreshed` so the engine rescans the `data/` directory and the frontend refreshes its ticker list.

### Local data

Imported CSVs are not modified by `fetch_data.py`. To add or replace a local symbol, use **Local Data → Import CSV** and restart the workspace. The engine will rescan on the next session start.

---

## Project structure

```
openrewind/
├── .devin/                 # Devin skill metadata
│   └── skills/
│       └── orion-ai-dev/
├── docs/                   # Orion design and certification docs
│   ├── ORION_AUTOMATIC_MODEL_SELECTION.md
│   ├── ORION_CERTIFICATION_POLICY.md
│   └── ORION_MODEL_BAKEOFF_HANDOFF.md
├── engine/                 # C++20 core backend
│   ├── include/            # Headers (candle, session, matching, server, csv_loader, path_utils)
│   ├── src/                # Implementation files
│   ├── tests/              # Engine utility tests
│   ├── build/              # MSBuild/CMake output
│   ├── CMakeLists.txt
│   └── vcpkg.json
├── frontend/               # Vite + React + TypeScript UI
│   ├── src/
│   │   ├── components/     # Chart, Toolbar, panels, drawing tools, DataSourceMenu, LocalDataScreen, Orion UI
│   │   ├── hooks/          # useWebSocket, etc.
│   │   ├── lib/            # Utilities, dataSourceContext, localData, journal, Orion runtime
│   │   │   └── orion/      # Client, controller, planner, tools, agent pipeline, certified models
│   │   ├── types/
│   │   └── utils/
│   ├── benchmark/orion/    # Orion bake-off and certification harness
│   ├── package.json
│   └── vite.config.ts
├── scripts/                # Data ingestion
│   ├── fetch_data.py       # yfinance 1-minute rolling sync
│   ├── requirements.txt
│   └── dev-full.ps1        # Engine + Vite dev launcher
├── src-tauri/              # Tauri v2 Rust wrapper
│   ├── src/
│   │   ├── lib.rs          # Engine sidecar spawn, Ollama install/launch, journal/threads IPC
│   │   └── local_data.rs   # CSV import, inspection, and local ticker listing
│   └── capabilities/
└── data/                   # Managed CSV cache (git-ignored)
    └── AAPL/AAPL_history.csv
```

---

## API reference

### REST

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/tickers` | List symbols with loadable data |
| `GET`  | `/api/available_dates?symbol=SYMBOL` | List dates available for a symbol |
| `GET`  | `/api/candles?symbol=SYMBOL&date=YYYY-MM-DD&timeframe=1&limit=500` | Load historical candles (up to 5000) for any symbol/date/timeframe |
| `POST` | `/api/session/start` | Start a new replay session |
| `POST` | `/api/session/stop` | End session and return summary |
| `GET`  | `/api/session/state` | Poll current session state |
| `POST` | `/api/order` | Place an order |
| `POST` | `/api/order/cancel` | Cancel a pending order |
| `POST` | `/api/data_refreshed` | Tell the engine to rescan `data/` and broadcast `data_synced` |

> Many endpoints accept an optional `data_dir` query/body parameter. The engine authorizes it against the managed root (`OPENREWIND_DATA_DIR`) or the local-data root (`OPENREWIND_LOCAL_DATA_DIR`). Any other path is rejected.

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
| `Esc` | Cancel an active Orion driving task |

---

## Scripts

Root `package.json` helpers:

```bash
pnpm dev              # pnpm tauri dev
pnpm build            # pnpm tauri build
pnpm dev:full         # Start the C++ engine, then pnpm dev in frontend/
pnpm frontend:dev     # cd frontend && pnpm dev
pnpm frontend:build   # cd frontend && pnpm build
```

Frontend test and typecheck (from `frontend/`):

```bash
npx tsc --noEmit
node node_modules/vitest/vitest.mjs run
```

For the LLM-backed acceptance suite (requires a running Ollama and engine):

```bash
node node_modules/vitest/vitest.mjs run -c vitest.acceptance.config.ts
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

## Troubleshooting

- **Orion stays on "Checking for qwen3:8b…" or "Warming qwen3:8b…"** — Ollama is not reachable. Ensure the Ollama tray app is running and `http://localhost:11434` is reachable. In the browser dev build, Vite proxies `/ollama` to `127.0.0.1:11434`.
- **"Ollama is not responding" after a few seconds** — The app can't reach `http://localhost:11434`. Start Ollama and retry.
- **First agent request is slow after an Ollama restart** — The planner warm-up is non-blocking but the first real agent call may still wait for the model to load. This is expected once per cold Ollama session.
- **Local Data import fails with "Detected interval is … seconds"** — Local Data V1 only supports one-minute candles. Resample your CSV to 1-minute bars before importing.
- **Ticker list is empty in managed mode** — Run `python scripts/fetch_data.py` to seed `data/`, or restart the app to trigger the automatic sync.

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
- [Ollama](https://ollama.com) and the Qwen model family for the local Orion AI runtime
