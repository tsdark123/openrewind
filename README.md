# OpenReplay

A free, open-source market replay and backtesting engine. Practice trading on any historical date with bar-by-bar playback, realistic order execution, and zero risk — powered by a C++20 core and a React/TypeScript UI.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![C++](https://img.shields.io/badge/C++-20-blue.svg)
![React](https://img.shields.io/badge/React-18+-61DAFB.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6.svg)

## Features

- **Bar-by-bar playback** with variable speed (1x to 50x candles/sec)
- **Multi-timeframe support** (1m, 5m, 15m, 1H, 4H, Daily)
- **Order management** with market/limit orders, stop loss, and take profit
- **Real-time P&L tracking** (unrealized + realized)
- **Technical indicators:** EMA 20, SMA 50, Bollinger Bands, RSI 14, MACD, ATR 14, Stochastic
- **Drawing tools:** Trend lines, rectangles, Fibonacci retracements, text annotations, brush
- **Professional charting** with TradingView's lightweight-charts
- **Light/dark mode** with full UI theming
- **Zero risk** — practice on historical data without real money

## Architecture

OpenReplay is split into two independently deployable halves that communicate over localhost:

```
┌─────────────────────────────────────────────────────────────────┐
│                        USER'S BROWSER                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              React / TypeScript Frontend                  │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐   │  │
│  │  │ TradingView  │  │  Order Entry │  │   Account &    │   │  │
│  │  │ Lightweight  │  │    Panel     │  │  Replay Panel  │   │  │
│  │  │   Charts     │  │ (SL/TP/Mkt) │  │  (Balance/PnL) │   │  │
│  │  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘   │  │
│  │         │                 │                   │            │  │
│  │         └────────┬────────┴───────────────────┘            │  │
│  │                  │  WebSocket (ws://localhost:9000/ws)      │  │
│  └──────────────────┼────────────────────────────────────────┘  │
└─────────────────────┼───────────────────────────────────────────┘
                      │
        ──────────────┼──────────────── Network Boundary ─────────
                      │
┌─────────────────────┼───────────────────────────────────────────┐
│                     ▼                                           │
│            C++20 Core Engine  (Crow HTTP/WS Server)             │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐  │
│  │ CandleBuffer │  │   Matching   │  │   Session Manager     │  │
│  │  (in-memory  │  │    Engine    │  │  (cursor, speed,      │  │
│  │   vector +   │──│  (orders,    │──│   playback state)     │  │
│  │   cursor)    │  │   SL/TP,     │  │                       │  │
│  │              │  │   account)   │  │                       │  │
│  └──────┬───────┘  └──────────────┘  └───────────────────────┘  │
│         │                                                       │
│  ┌──────┴───────┐                                               │
│  │  CSV Loader  │◄──── /data/{symbol}/{symbol}_YYYYMM.csv      │
│  └──────────────┘                                               │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Prerequisites

### C++ Backend
- **CMake 3.20+**
- **vcpkg** (C++ package manager)
- **C++20 compiler** (MSVC 17+ on Windows, GCC 12+ on Linux, Clang 15+ on macOS)

### Frontend
- **Node.js 18+**
- **pnpm** (recommended) or npm

### Data
- **Alpha Vantage API key** (free tier available at https://www.alphavantage.co/support/#api-key)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/tsdark123/openreplay.git
cd openreplay
```

### 2. Install C++ Dependencies

#### Windows (MSVC)

```bash
# Install vcpkg if not already installed
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
.\bootstrap-vcpkg.bat

# Install Crow and nlohmann-json
.\vcpkg install crow:x64-windows
.\vcpkg install nlohmann-json:x64-windows
```

#### Linux (Ubuntu/Debian)

```bash
# Install vcpkg
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
./bootstrap-vcpkg.sh

# Install dependencies
./vcpkg install crow
./vcpkg install nlohmann-json
```

#### macOS

```bash
# Install vcpkg
git clone https://github.com/Microsoft/vcpkg.git
cd vcpkg
./bootstrap-vcpkg.sh

# Install dependencies
./vcpkg install crow
./vcpkg install nlohmann-json
```

### 3. Build the C++ Engine

```bash
cd engine

# Replace [vcpkg root] with your actual vcpkg installation path
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=[vcpkg root]/scripts/buildsystems/vcpkg.cmake
cmake --build build --config Release
```

**Example Windows:**
```bash
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=C:/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build --config Release
```

**Example Linux/macOS:**
```bash
cmake -B build -S . -DCMAKE_TOOLCHAIN_FILE=/home/user/vcpkg/scripts/buildsystems/vcpkg.cmake
cmake --build build
```

### 4. Install Frontend Dependencies

```bash
cd frontend
pnpm install
# or
npm install
```

### 5. Fetch Historical Data

```bash
cd ../scripts

# Get your free API key from https://www.alphavantage.co/support/#api-key
python fetch_data.py --symbol AAPL --start 2024-01 --end 2024-06 --apikey YOUR_API_KEY
```

This will download 1-minute candle data from Alpha Vantage and save it to `data/AAPL/`.

## Running the Application

You need **two terminals** running simultaneously.

### Terminal 1: C++ Backend

```bash
cd engine
./build/engine.exe        # Windows
# or
./build/engine            # Linux/macOS
```

The backend will start on `http://localhost:9000` with WebSocket at `ws://localhost:9000/ws`.

### Terminal 2: React Frontend

```bash
cd frontend
pnpm dev
# or
npm run dev
```

The frontend will start on `http://localhost:5173` (Vite default).

Open your browser and navigate to `http://localhost:5173`.

## Usage

1. **Start a Session**
   - Enter a symbol (e.g., AAPL)
   - Select a date range
   - Set your starting balance
   - Click "Start Session"

2. **Control Playback**
   - Use the playback bar at the bottom: Play/Pause, Next Candle, Rewind
   - Adjust speed (1x to 50x candles/sec)
   - Drag the playback bar to reposition

3. **Place Orders**
   - Use the order panel on the right
   - Select Buy/Sell, Market/Limit
   - Set quantity, stop loss, and take profit
   - Click Submit

4. **Monitor Positions**
   - View open positions in the account panel
   - Track real-time P&L
   - Close positions manually or let SL/TP trigger

5. **Use Drawing Tools**
   - Click the lock icon to enable drawing mode
   - Select a tool from the toolbar (trend line, rectangle, fib, etc.)
   - Draw on the chart
   - Press Backspace to delete selected drawings

## Project Structure

```
OpenReplay/
├── engine/                  # C++20 core backend
│   ├── include/             # Header files
│   │   ├── candle.hpp       # Candle struct, CandleBuffer
│   │   ├── matching.hpp     # Order, Position, Account, MatchingEngine
│   │   ├── session.hpp      # SessionManager (cursor, playback, timeframe)
│   │   ├── csv_loader.hpp   # CSV parsing into CandleBuffer
│   │   └── server.hpp       # Crow routes + WebSocket hub
│   ├── src/                 # Implementation files
│   ├── CMakeLists.txt       # CMake build configuration
│   └── vcpkg.json           # C++ dependencies
├── frontend/                # React / TypeScript UI
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── hooks/           # Custom React hooks
│   │   ├── types/           # TypeScript interfaces
│   │   └── utils/           # Utility functions
│   ├── package.json
│   └── vite.config.ts
├── scripts/                 # Data ingestion
│   ├── fetch_data.py        # Alpha Vantage downloader
│   └── requirements.txt
├── data/                    # Local CSV cache (git-ignored)
└── ARCHITECTURE.md          # Detailed architecture documentation
```

## API Reference

### REST Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/session/start` | Start a new trading session |
| `POST` | `/api/session/stop` | End session and return summary |
| `GET`  | `/api/session/state` | Poll current state |
| `POST` | `/api/order` | Place a new order |
| `POST` | `/api/order/cancel` | Cancel a pending order |

### WebSocket Commands

```json
// Advance one candle
{ "cmd": "next_candle" }

// Rewind one candle
{ "cmd": "rewind" }

// Jump to timestamp
{ "cmd": "seek", "timestamp": 1704067200 }

// Play/Pause
{ "cmd": "play" }
{ "cmd": "pause" }

// Set speed
{ "cmd": "set_speed", "speed": 5 }

// Change timeframe
{ "cmd": "set_timeframe", "minutes": 15 }

// Place order
{ "cmd": "place_order", "side": "buy", "type": "market", "quantity": 100 }
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [TradingView lightweight-charts](https://www.tradingview.com/lightweight-charts/) for the excellent charting library
- [Crow](https://crowcpp.org) for the C++ web framework
- [Alpha Vantage](https://www.alphavantage.co/) for providing free historical market data

## Support

If you encounter any issues or have questions, please open an issue on GitHub.
