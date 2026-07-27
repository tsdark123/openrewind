#!/usr/bin/env python3
"""
OpenRewind — yfinance Rolling Data Sync (cached-append pattern)

Maintains a single rolling 1-minute CSV per symbol that the C++ engine
ingests directly. Higher timeframes (5m, 15m, 1H, 1D, …) are computed
on the fly by the engine's timeframe-aggregation layer.

  data/
  ├── AAPL/AAPL_history.csv   ← 1m bars, rolling 30 days (sole source)
  ├── TSLA/TSLA_history.csv
  └── ...

Cached-append logic per symbol
──────────────────────────────
  • CSV absent (first run) → SEED: chunked 7-day windows back 30 days
  • CSV present            → APPEND: incremental 7-day pull, merge + dedupe

Rate-limit-safe without an API key — yfinance's free 1m endpoint caps
each request at 7 calendar days; we slide the window to cover 30 days.

After all symbols are processed the script:
  1. Writes  data/.sync_manifest.json  (per-symbol stats)
  2. POSTs   http://localhost:{port}/api/data_refreshed  (optional, engine
             broadcasts 'data_synced' WS event so connected clients refresh)

Usage
─────
  # Smart sync for all 50 tickers (auto seed/append per symbol):
  python scripts/fetch_data.py

  # Legacy modes kept for backward-compat (C++ ingest worker uses these):
  python scripts/fetch_data.py --mode full      # bulk rewrite, 1m only
  python scripts/fetch_data.py --mode append    # 7d merge, 1m only

  # Subset / custom directory:
  python scripts/fetch_data.py --symbols AAPL TSLA --data-dir C:/data

  # Only specific timeframes:
  python scripts/fetch_data.py --timeframes 1m 1d
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import pandas as pd
import yfinance as yf

# =============================================================================
# Configuration
# =============================================================================

TOP_TICKERS: list[str] = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA",
    "AMD",  "AVGO", "BRK-B", "JPM",  "V",     "MA",   "UNH",  "XOM",
    "JNJ",  "WMT",  "PG",    "HD",   "COST",  "NFLX", "ORCL", "CRM",
    "ADBE", "BAC",  "KO",    "PEP",  "MRK",   "LLY",  "ABBV", "CVX",
    "INTC", "QCOM", "TXN",   "CSCO", "IBM",   "GE",   "BA",   "DIS",
    "NKE",  "MCD",  "SBUX",  "T",    "VZ",    "PFE",  "F",    "GM",
    "UBER", "SHOP",
]

# Only 1m data is maintained on disk.  The C++ engine aggregates all higher
# timeframes (5m, 15m, 1H, 1D …) from this single master file at runtime.
TIMEFRAME_CONFIG: dict[str, dict[str, Any]] = {
    "1m": {
        "filename_tpl": "{sym}_history.csv",
        "interval":     "1m",
        "seed_days":    30,
        "append_period": "7d",
        "max_age_days": 30,
        "label": "1-minute, rolling 30-day master (engine sole source)",
    },
}

CHUNK_DAYS = 7             # yfinance hard cap per 1m request
SLEEP_BETWEEN_TICKERS = 0.5   # polite delay between symbols
SLEEP_BETWEEN_TF = 0.3        # polite delay between timeframes for one symbol
REQUIRED_COLS = ["timestamp", "open", "high", "low", "close", "volume"]

DEFAULT_ENGINE_PORT = int(os.environ.get("OPENREWIND_PORT", "9000"))


# =============================================================================
# yfinance Download Helpers
# =============================================================================

def _clean_df(symbol: str, raw: pd.DataFrame | None) -> pd.DataFrame:
    """Normalise a raw yfinance DataFrame into our required column layout."""
    if raw is None or raw.empty:
        return pd.DataFrame(columns=REQUIRED_COLS)

    df = raw.copy()

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df = df.reset_index()

    dt_col = next(
        (c for c in ("Datetime", "Date", "datetime", "date", "index")
         if c in df.columns),
        df.columns[0],
    )
    df = df.rename(columns={
        dt_col:   "timestamp",
        "Open":   "open",
        "High":   "high",
        "Low":    "low",
        "Close":  "close",
        "Volume": "volume",
    })

    missing = [c for c in REQUIRED_COLS if c not in df.columns]
    if missing:
        print(f"    {symbol}: missing columns {missing} after rename; skipping.")
        return pd.DataFrame(columns=REQUIRED_COLS)

    df = df[REQUIRED_COLS].copy()

    # Strip timezone; format as "YYYY-MM-DD HH:MM:SS" for the C++ parser.
    df["timestamp"] = pd.to_datetime(df["timestamp"]).dt.tz_localize(None)
    df["timestamp"] = df["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")
    df = df.dropna()
    for col in ("open", "high", "low", "close"):
        df[col] = df[col].astype(float).round(4)
    df["volume"] = df["volume"].astype("int64")

    return df


def fetch_period(symbol: str, interval: str, period: str) -> pd.DataFrame:
    """Fetch via the period= interface (safe for 5m / 1d seeds and appends)."""
    try:
        raw = yf.download(
            tickers=symbol,
            period=period,
            interval=interval,
            auto_adjust=True,
            progress=False,
            threads=False,
        )
    except Exception as exc:
        print(f"    fetch_period({symbol}, {interval}, {period}) raised: {exc}")
        return pd.DataFrame(columns=REQUIRED_COLS)
    return _clean_df(symbol, raw)


def fetch_window(symbol: str, start: datetime, end: datetime) -> pd.DataFrame:
    """Fetch a single (start, end) window of 1m data."""
    try:
        raw = yf.download(
            tickers=symbol,
            start=start.strftime("%Y-%m-%d"),
            end=end.strftime("%Y-%m-%d"),
            interval="1m",
            auto_adjust=True,
            progress=False,
            threads=False,
        )
    except Exception as exc:
        print(f"    fetch_window({symbol}, {start.date()}, {end.date()}) raised: {exc}")
        return pd.DataFrame(columns=REQUIRED_COLS)
    return _clean_df(symbol, raw)


def fetch_1m_chunked(symbol: str, days: int) -> pd.DataFrame:
    """
    Seed 1m data by sliding CHUNK_DAYS windows backward from today.
    yfinance caps each 1m request to 7 calendar days.
    """
    end = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=1)
    start_target = end - timedelta(days=days)
    chunks: list[pd.DataFrame] = []
    cur_end = end

    while cur_end > start_target:
        cur_start = max(cur_end - timedelta(days=CHUNK_DAYS), start_target)
        print(f"    window {cur_start.date()} → {cur_end.date()} ... ", end="", flush=True)
        chunk = fetch_window(symbol, cur_start, cur_end)
        print(f"{len(chunk):,} rows")
        if not chunk.empty:
            chunks.append(chunk)
        cur_end = cur_start
        if cur_end > start_target:
            time.sleep(SLEEP_BETWEEN_TF)

    if not chunks:
        return pd.DataFrame(columns=REQUIRED_COLS)

    merged = pd.concat(chunks, ignore_index=True)
    merged = merged.drop_duplicates(subset="timestamp", keep="last")
    merged = merged.sort_values("timestamp").reset_index(drop=True)
    return merged


# =============================================================================
# CSV I/O
# =============================================================================

def csv_path(symbol: str, tf: str, data_dir: str) -> str:
    tpl = TIMEFRAME_CONFIG[tf]["filename_tpl"]
    return os.path.join(data_dir, symbol, tpl.format(sym=symbol))


def read_csv(path: str) -> pd.DataFrame:
    if not os.path.exists(path):
        return pd.DataFrame(columns=REQUIRED_COLS)
    try:
        df = pd.read_csv(path, dtype={"timestamp": str})
        for col in REQUIRED_COLS:
            if col not in df.columns:
                return pd.DataFrame(columns=REQUIRED_COLS)
        return df[REQUIRED_COLS]
    except Exception as exc:
        print(f"    read_csv({path}) failed: {exc}; treating as empty.")
        return pd.DataFrame(columns=REQUIRED_COLS)


def write_csv_atomic(df: pd.DataFrame, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    df.to_csv(tmp, index=False, header=True, lineterminator="\n")
    os.replace(tmp, path)


def merge_and_prune(existing: pd.DataFrame,
                    new_rows: pd.DataFrame,
                    max_age_days: int) -> pd.DataFrame:
    """
    Merge new_rows into existing:
      - new rows win on timestamp collision (keep='last' after existing-first concat)
      - rows older than max_age_days are pruned to keep files bounded
      - result is sorted ascending
    """
    if existing.empty and new_rows.empty:
        return pd.DataFrame(columns=REQUIRED_COLS)

    combined = pd.concat([existing, new_rows], ignore_index=True)
    combined = combined.drop_duplicates(subset="timestamp", keep="last")
    combined = combined.sort_values("timestamp").reset_index(drop=True)

    cutoff_str = (
        datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=max_age_days)
    ).strftime("%Y-%m-%d %H:%M:%S")
    combined = combined[combined["timestamp"] >= cutoff_str].reset_index(drop=True)
    return combined


# =============================================================================
# Per-timeframe Sync
# =============================================================================

def sync_timeframe(symbol: str, tf: str, data_dir: str) -> dict[str, Any]:
    """
    Cached-append sync for one symbol × timeframe.

    Returns a stats dict: {rows, first_ts, last_ts, action, ok}
    """
    cfg = TIMEFRAME_CONFIG[tf]
    path = csv_path(symbol, tf, data_dir)
    existing = read_csv(path)

    if existing.empty:
        # ── SEED ──────────────────────────────────────────────────────────────
        # Slide 7-day windows back 30 days — yfinance's per-request limit for 1m.
        action = "seed"
        print(f"  [{tf}] no existing data → seeding ({cfg['label']}) ...")
        new_df = fetch_1m_chunked(symbol, cfg["seed_days"])
    else:
        # ── APPEND ────────────────────────────────────────────────────────────
        last_ts = existing["timestamp"].iloc[-1]
        action = "append"
        print(f"  [{tf}] existing {len(existing):,} rows (last: {last_ts}) → "
              f"fetching {cfg['append_period']} incremental ...")
        new_df = fetch_period(symbol, cfg["interval"], cfg["append_period"])

    if new_df.empty and existing.empty:
        print(f"  [{tf}] no data returned and no cache — skipping.")
        return {"rows": 0, "first_ts": None, "last_ts": None, "action": action, "ok": False}

    merged = merge_and_prune(existing, new_df, cfg["max_age_days"])

    if merged.empty:
        print(f"  [{tf}] merged result is empty — skipping write.")
        return {"rows": 0, "first_ts": None, "last_ts": None, "action": action, "ok": False}

    write_csv_atomic(merged, path)
    added = max(0, len(merged) - len(existing))
    print(f"  [{tf}] ✓ {len(merged):,} rows total (+{added:,} new) → {path}")
    print(f"  [{tf}]   range: {merged['timestamp'].iloc[0]}  →  {merged['timestamp'].iloc[-1]}")

    return {
        "rows":     len(merged),
        "added":    added,
        "first_ts": merged["timestamp"].iloc[0],
        "last_ts":  merged["timestamp"].iloc[-1],
        "action":   action,
        "ok":       True,
    }


# =============================================================================
# Per-symbol Pipeline
# =============================================================================

def process_symbol_sync(symbol: str,
                         timeframes: list[str],
                         data_dir: str) -> dict[str, Any]:
    """
    Run cached-append sync for every requested timeframe for one symbol.
    Returns per-timeframe stats dict.
    """
    results: dict[str, Any] = {}
    for i, tf in enumerate(timeframes):
        results[tf] = sync_timeframe(symbol, tf, data_dir)
        if i < len(timeframes) - 1:
            time.sleep(SLEEP_BETWEEN_TF)
    return results


def process_symbol_legacy(symbol: str, mode: str, data_dir: str) -> tuple[bool, int]:
    """
    Legacy full / append modes kept for backward compatibility with
    the C++ auto-ingest worker call:  python fetch_data.py --mode append
    """
    LOOKBACK_DAYS = 30
    APPEND_DAYS   = 7

    print(f"  [1m] legacy mode={mode}")

    if mode == "full":
        df = fetch_1m_chunked(symbol, LOOKBACK_DAYS)
        if df.empty:
            print(f"  {symbol}: no data returned, skipping.")
            return (False, 0)
        path = csv_path(symbol, "1m", data_dir)
        write_csv_atomic(df, path)
        print(f"  {symbol}: wrote {len(df):,} rows → {path}")
        return (True, len(df))

    if mode == "append":
        new_df = fetch_period(symbol, "1m", f"{APPEND_DAYS}d")
        path   = csv_path(symbol, "1m", data_dir)
        existing = read_csv(path)
        merged   = merge_and_prune(existing, new_df, LOOKBACK_DAYS)
        if merged.empty:
            print(f"  {symbol}: nothing to write.")
            return (False, 0)
        write_csv_atomic(merged, path)
        print(f"  {symbol}: {len(merged):,} rows → {path}")
        return (True, len(merged))

    raise ValueError(f"Unknown mode: {mode!r}")


# =============================================================================
# Engine Notification
# =============================================================================

def notify_engine(port: int, manifest: dict[str, Any]) -> None:
    """
    POST to the C++ engine's /api/data_refreshed endpoint.
    The engine broadcasts a 'data_synced' WS event so connected clients
    refresh their ticker list and market pricing.
    Silently swallows any error (engine may not be running yet).
    """
    try:
        import requests  # optional; already in requirements.txt
        url = f"http://127.0.0.1:{port}/api/data_refreshed"
        requests.post(url, json=manifest, timeout=3)
        print(f"\nEngine notified at {url}")
    except Exception as exc:
        print(f"\n  (Engine notification skipped: {exc})")


def write_manifest(data_dir: str, manifest: dict[str, Any]) -> str:
    path = os.path.join(data_dir, ".sync_manifest.json")
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=2, default=str)
    except Exception as exc:
        print(f"  Warning: could not write manifest ({exc})")
    return path


# =============================================================================
# Main
# =============================================================================

def main() -> None:
    parser = argparse.ArgumentParser(
        description="OpenRewind — yfinance rolling data sync (cached-append)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--mode",
        choices=("sync", "full", "append"),
        default="sync",
        help=(
            "sync   = smart cached-append per symbol (default).\n"
            "full   = legacy bulk 1m rewrite.\n"
            "append = legacy 7d 1m merge (used by C++ ingest worker)."
        ),
    )
    parser.add_argument(
        "--timeframes", nargs="+",
        choices=list(TIMEFRAME_CONFIG.keys()),
        default=list(TIMEFRAME_CONFIG.keys()),
        help="Timeframes to sync in 'sync' mode (default: 1m — the only supported value).",
    )
    parser.add_argument(
        "--symbols", nargs="+", default=None,
        help="Subset of tickers. Defaults to TOP_TICKERS.",
    )
    parser.add_argument(
        "--data-dir", default="data",
        help="Base directory for per-symbol CSV cache (default: data).",
    )
    parser.add_argument(
        "--port", type=int, default=DEFAULT_ENGINE_PORT,
        help=f"Engine port for data_refreshed notification (default: {DEFAULT_ENGINE_PORT}).",
    )
    parser.add_argument(
        "--no-notify", action="store_true",
        help="Skip the POST /api/data_refreshed engine notification.",
    )
    args = parser.parse_args()

    symbols    = [s.upper() for s in (args.symbols or TOP_TICKERS)]
    timeframes = args.timeframes
    mode       = args.mode

    # ── Header ────────────────────────────────────────────────────────────────
    print("OpenRewind — yfinance data sync")
    print("=" * 44)
    print(f"  Mode:       {mode}")
    if mode == "sync":
        print(f"  Timeframes: {', '.join(timeframes)}")
        for tf in timeframes:
            cfg = TIMEFRAME_CONFIG[tf]
            print(f"    {tf:4s} → {cfg['label']}")
    print(f"  Tickers:    {len(symbols)} "
          f"({', '.join(symbols[:6])}{'...' if len(symbols) > 6 else ''})")
    print(f"  Data dir:   {os.path.abspath(args.data_dir)}")
    print()

    t_start = time.monotonic()
    ok = fail = 0
    total_rows = 0
    manifest_data: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": mode,
        "symbols": {},
    }

    for i, symbol in enumerate(symbols, start=1):
        print(f"── [{i}/{len(symbols)}] {symbol} " + "─" * max(0, 30 - len(symbol)))

        try:
            if mode == "sync":
                stats = process_symbol_sync(symbol, timeframes, args.data_dir)
                success = any(v["ok"] for v in stats.values())
                rows = sum(v.get("rows", 0) for v in stats.values() if v["ok"])
                manifest_data["symbols"][symbol] = stats
            else:
                success, rows = process_symbol_legacy(symbol, mode, args.data_dir)
                manifest_data["symbols"][symbol] = {"rows": rows, "ok": success}
        except Exception as exc:
            print(f"  {symbol}: unhandled error: {exc}")
            success, rows = False, 0
            manifest_data["symbols"][symbol] = {"ok": False, "error": str(exc)}

        if success:
            ok += 1
            total_rows += rows
        else:
            fail += 1

        if i < len(symbols):
            time.sleep(SLEEP_BETWEEN_TICKERS)

    # ── Summary ───────────────────────────────────────────────────────────────
    elapsed = time.monotonic() - t_start
    manifest_data["elapsed_s"] = round(elapsed, 1)
    manifest_data["ok"]        = ok
    manifest_data["fail"]      = fail

    print()
    print("Summary")
    print("─" * 30)
    print(f"  Succeeded:   {ok}/{len(symbols)}")
    print(f"  Failed:      {fail}")
    print(f"  Total rows:  {total_rows:,}")
    print(f"  Elapsed:     {elapsed:.1f}s")
    print()

    if mode == "sync":
        print("Data boundaries by timeframe:")
        for tf, cfg in TIMEFRAME_CONFIG.items():
            if tf in timeframes:
                print(f"  {tf:4s} → {cfg['label']}")
        print()

    manifest_path = write_manifest(args.data_dir, manifest_data)
    print(f"Manifest written → {manifest_path}")

    if not args.no_notify:
        notify_engine(args.port, manifest_data)

    if fail > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
