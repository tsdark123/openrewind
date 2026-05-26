#!/usr/bin/env python3
"""
OpenReplay — Alpha Vantage Historical Data Ingestion Script

Downloads 1-minute intraday OHLCV data from Alpha Vantage and saves it to
the local CSV cache used by the C++ engine.

Usage:
    python fetch_data.py --symbol AAPL --start 2024-01 --end 2024-06 --apikey YOUR_KEY

Each API call fetches one full month of 1-minute data (~8,000–12,000 rows).
The free tier allows 25 calls/day. A 4-second delay between requests keeps
us well within rate limits.

Output directory structure:
    data/
    └── AAPL/
        ├── AAPL_202401.csv
        ├── AAPL_202402.csv
        └── ...

CSV format (compatible with CsvLoader):
    timestamp,open,high,low,close,volume
    2024-01-02 09:30:00,185.52,185.63,185.41,185.55,128456
"""

import argparse
import os
import sys
import time
import csv
from datetime import datetime
from io import StringIO

import requests

# =============================================================================
# Constants
# =============================================================================

ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query"
DELAY_BETWEEN_CALLS = 4  # seconds — respect free-tier rate limits
OUTPUT_HEADER = "timestamp,open,high,low,close,volume"


# =============================================================================
# Month Range Generator
# =============================================================================

def generate_months(start_str: str, end_str: str) -> list[str]:
    """
    Generate a list of 'YYYY-MM' strings from start to end (inclusive).

    Args:
        start_str: Start month in 'YYYY-MM' format (e.g., '2024-01')
        end_str:   End month in 'YYYY-MM' format (e.g., '2024-06')

    Returns:
        List of month strings: ['2024-01', '2024-02', ..., '2024-06']
    """
    start = datetime.strptime(start_str, "%Y-%m")
    end = datetime.strptime(end_str, "%Y-%m")

    if start > end:
        print(f"Error: start month ({start_str}) is after end month ({end_str})")
        sys.exit(1)

    months = []
    current = start
    while current <= end:
        months.append(current.strftime("%Y-%m"))
        # Advance to the next month.
        if current.month == 12:
            current = current.replace(year=current.year + 1, month=1)
        else:
            current = current.replace(month=current.month + 1)

    return months


# =============================================================================
# Data Fetching
# =============================================================================

def fetch_month(symbol: str, month: str, api_key: str) -> str | None:
    """
    Fetch one month of 1-minute intraday data from Alpha Vantage.

    Args:
        symbol:  Ticker symbol (e.g., 'AAPL')
        month:   Month string in 'YYYY-MM' format
        api_key: Alpha Vantage API key

    Returns:
        Raw CSV string on success, None on failure.
    """
    params = {
        "function":   "TIME_SERIES_INTRADAY",
        "symbol":     symbol,
        "interval":   "1min",
        "month":      month,
        "outputsize": "full",
        "datatype":   "csv",
        "apikey":     api_key,
    }

    try:
        response = requests.get(ALPHA_VANTAGE_BASE_URL, params=params, timeout=30)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"  Error fetching {symbol} {month}: {e}")
        return None

    content = response.text

    # Alpha Vantage returns JSON error messages even when datatype=csv.
    # Detect this by checking if the response starts with '{'.
    if content.strip().startswith("{"):
        print(f"  API error for {symbol} {month}: {content.strip()[:200]}")
        return None

    # Verify we got actual CSV data (should have a header with 'timestamp').
    if "timestamp" not in content.split("\n")[0].lower():
        print(f"  Unexpected response format for {symbol} {month}")
        return None

    return content


# =============================================================================
# CSV Processing
# =============================================================================

def process_and_save(raw_csv: str, output_path: str) -> int:
    """
    Parse the raw Alpha Vantage CSV, sort chronologically, and write to disk
    in our standard format.

    Alpha Vantage returns data in reverse chronological order (newest first).
    We reverse it to chronological (oldest first) for our C++ loader.

    Args:
        raw_csv:     Raw CSV string from Alpha Vantage
        output_path: Full path to write the processed CSV file

    Returns:
        Number of data rows written.
    """
    reader = csv.reader(StringIO(raw_csv))

    # Read and skip the header row.
    header = next(reader, None)
    if header is None:
        return 0

    # Parse all data rows.
    rows = []
    for row in reader:
        if len(row) < 6:
            continue

        timestamp = row[0].strip()
        open_price = row[1].strip()
        high_price = row[2].strip()
        low_price = row[3].strip()
        close_price = row[4].strip()
        volume = row[5].strip()

        # Basic validation: skip rows with empty or obviously invalid data.
        if not timestamp or not open_price:
            continue

        rows.append((timestamp, open_price, high_price, low_price,
                      close_price, volume))

    if not rows:
        return 0

    # Sort chronologically (Alpha Vantage sends newest first).
    rows.sort(key=lambda r: r[0])

    # Deduplicate by timestamp (keep last occurrence if duplicates exist).
    seen = {}
    for row in rows:
        seen[row[0]] = row
    unique_rows = sorted(seen.values(), key=lambda r: r[0])

    # Write the processed CSV.
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(output_path, "w", newline="", encoding="utf-8") as f:
        f.write(OUTPUT_HEADER + "\n")
        for row in unique_rows:
            f.write(",".join(row) + "\n")

    return len(unique_rows)


# =============================================================================
# Main
# =============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="OpenReplay — Download historical 1-minute market data from Alpha Vantage",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
    python fetch_data.py --symbol AAPL --start 2024-01 --end 2024-06 --apikey YOUR_KEY
    python fetch_data.py --symbol MSFT --start 2024-03 --end 2024-03 --apikey YOUR_KEY
    python fetch_data.py --symbol BTCUSD --start 2024-01 --end 2024-12 --apikey YOUR_KEY
        """,
    )

    parser.add_argument("--symbol", required=True,
                        help="Ticker symbol (e.g., AAPL, MSFT, BTCUSD)")
    parser.add_argument("--start", required=True,
                        help="Start month in YYYY-MM format (e.g., 2024-01)")
    parser.add_argument("--end", required=True,
                        help="End month in YYYY-MM format (e.g., 2024-06)")
    parser.add_argument("--apikey", required=True,
                        help="Alpha Vantage API key (get one free at alphavantage.co)")
    parser.add_argument("--data-dir", default="data",
                        help="Base directory for CSV cache (default: data)")

    args = parser.parse_args()

    symbol = args.symbol.upper()
    months = generate_months(args.start, args.end)

    print(f"OpenReplay Data Ingestion")
    print(f"========================")
    print(f"Symbol:     {symbol}")
    print(f"Range:      {args.start} to {args.end} ({len(months)} month(s))")
    print(f"Data dir:   {args.data_dir}")
    print()

    total_rows = 0
    downloaded = 0
    skipped = 0
    failed = 0

    for i, month in enumerate(months):
        # Build output path: data/AAPL/AAPL_202401.csv
        month_compact = month.replace("-", "")
        output_path = os.path.join(args.data_dir, symbol,
                                    f"{symbol}_{month_compact}.csv")

        # Skip if file already exists.
        if os.path.exists(output_path):
            # Count existing rows for the summary.
            with open(output_path, "r", encoding="utf-8") as f:
                existing_rows = sum(1 for _ in f) - 1  # subtract header
            print(f"  [{i+1}/{len(months)}] {symbol} {month} — "
                  f"already cached ({existing_rows:,} rows), skipping")
            total_rows += max(existing_rows, 0)
            skipped += 1
            continue

        print(f"  [{i+1}/{len(months)}] {symbol} {month} — downloading...", end="", flush=True)

        raw_csv = fetch_month(symbol, month, args.apikey)

        if raw_csv is None:
            print(" FAILED")
            failed += 1
        else:
            row_count = process_and_save(raw_csv, output_path)

            if row_count > 0:
                file_size = os.path.getsize(output_path)
                size_str = f"{file_size / 1024:.1f} KB"
                print(f" OK ({row_count:,} rows, {size_str})")
                total_rows += row_count
                downloaded += 1
            else:
                print(" EMPTY (no data rows)")
                failed += 1

        # Rate-limit delay between API calls (skip after last call).
        if i < len(months) - 1:
            time.sleep(DELAY_BETWEEN_CALLS)

    # Summary
    print()
    print(f"Summary")
    print(f"-------")
    print(f"  Downloaded:  {downloaded} month(s)")
    print(f"  Skipped:     {skipped} month(s) (already cached)")
    print(f"  Failed:      {failed} month(s)")
    print(f"  Total rows:  {total_rows:,}")

    # Calculate total disk usage for this symbol.
    symbol_dir = os.path.join(args.data_dir, symbol)
    if os.path.exists(symbol_dir):
        total_size = sum(
            os.path.getsize(os.path.join(symbol_dir, f))
            for f in os.listdir(symbol_dir)
            if f.endswith(".csv")
        )
        if total_size > 1024 * 1024:
            print(f"  Disk usage:  {total_size / (1024 * 1024):.1f} MB")
        else:
            print(f"  Disk usage:  {total_size / 1024:.1f} KB")

    print()

    if failed > 0:
        print(f"Warning: {failed} month(s) failed. Re-run the script to retry.")
        sys.exit(1)


if __name__ == "__main__":
    main()
