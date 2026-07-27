"""
OpenRewind — Yahoo Finance Data Ingestion (yfinance)
====================================================
Downloads free 1-minute intraday data (last 7 days) for a given symbol.
No API key required.

Usage:
    python scripts/fetch_yahoo.py --symbol AAPL
"""

import argparse
import os
import sys

import yfinance as yf
import pandas as pd


def main():
    parser = argparse.ArgumentParser(
        description="Download 1-minute intraday data from Yahoo Finance"
    )
    parser.add_argument(
        "--symbol", required=True, help="Ticker symbol (e.g. AAPL, MSFT, SPY)"
    )
    parser.add_argument(
        "--period", default="7d",
        help="Period to fetch (default: 7d). Options: 1d, 5d, 7d"
    )
    args = parser.parse_args()

    symbol = args.symbol.upper()
    period = args.period

    print("OpenRewind — Yahoo Finance Ingestion")
    print("=" * 40)
    print(f"  Symbol:   {symbol}")
    print(f"  Period:   {period}")
    print(f"  Interval: 1m")
    print()

    # -------------------------------------------------------------------------
    # Download
    # -------------------------------------------------------------------------
    print(f"  Downloading {symbol} 1m data for last {period}...")

    df = yf.download(
        tickers=symbol,
        period=period,
        interval="1m",
        progress=False,
        auto_adjust=True,
    )

    if df is None or df.empty:
        print("  ERROR: No data returned. Check the symbol and try again.")
        sys.exit(1)

    # -------------------------------------------------------------------------
    # Data Engineering — flatten MultiIndex columns if present
    # -------------------------------------------------------------------------
    # yfinance may return MultiIndex columns like ('Close', 'AAPL').
    # Flatten to simple column names.
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    # Reset index to get 'Datetime' as a column
    df = df.reset_index()

    # The datetime column may be named 'Datetime' or 'Date' depending on version
    dt_col = None
    for candidate in ["Datetime", "Date", "datetime", "date", "index"]:
        if candidate in df.columns:
            dt_col = candidate
            break

    if dt_col is None:
        # Fall back to first column
        dt_col = df.columns[0]

    # Rename columns to match our C++ CSV loader format
    df = df.rename(columns={
        dt_col: "timestamp",
        "Open": "open",
        "High": "high",
        "Low": "low",
        "Close": "close",
        "Volume": "volume",
    })

    # Keep only the columns we need
    required = ["timestamp", "open", "high", "low", "close", "volume"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        print(f"  ERROR: Missing columns after rename: {missing}")
        print(f"  Available columns: {list(df.columns)}")
        sys.exit(1)

    df = df[required]

    # Strip timezone info and format timestamp as "YYYY-MM-DD HH:MM:SS"
    df["timestamp"] = pd.to_datetime(df["timestamp"]).dt.tz_localize(None)
    df["timestamp"] = df["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")

    # Drop any rows with NaN values
    df = df.dropna()

    # Ensure numeric types
    for col in ["open", "high", "low", "close"]:
        df[col] = df[col].astype(float).round(4)
    df["volume"] = df["volume"].astype(int)

    # Sort by timestamp ascending
    df = df.sort_values("timestamp").reset_index(drop=True)

    # -------------------------------------------------------------------------
    # Save to disk
    # -------------------------------------------------------------------------
    out_dir = os.path.join("data", symbol)
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{symbol}_Yahoo.csv")

    df.to_csv(out_path, index=False)

    file_size = os.path.getsize(out_path)
    size_str = (
        f"{file_size / 1024:.1f} KB"
        if file_size < 1024 * 1024
        else f"{file_size / (1024 * 1024):.1f} MB"
    )

    print(f"  SUCCESS!")
    print(f"  Rows:     {len(df):,}")
    print(f"  File:     {out_path}")
    print(f"  Size:     {size_str}")
    print(f"  Range:    {df['timestamp'].iloc[0]} → {df['timestamp'].iloc[-1]}")
    print()
    print("  Ready for OpenRewind engine.")


if __name__ == "__main__":
    main()
