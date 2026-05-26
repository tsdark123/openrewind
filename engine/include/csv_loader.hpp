#pragma once

#include "candle.hpp"
#include <string>
#include <vector>
#include <filesystem>

// -----------------------------------------------------------------------------
// CsvLoader — Static utility for reading historical OHLCV data from CSV files
// into Candle vectors suitable for CandleBuffer consumption.
//
// Expected CSV format (Alpha Vantage TIME_SERIES_INTRADAY, datatype=csv):
//
//   timestamp,open,high,low,close,volume
//   2024-01-02 09:30:00,185.52,185.63,185.41,185.55,128456
//   2024-01-02 09:31:00,185.55,185.70,185.50,185.68,95230
//   ...
//
// Timestamps are in "YYYY-MM-DD HH:MM:SS" format, US Eastern time.
// The loader converts them to Unix epoch seconds (UTC) at parse time,
// assuming the input is US Eastern (ET = UTC-5, no DST adjustment in V1).
//
// Performance targets:
//   - 6 months of 1-min data (~60,000 rows, ~3 MB CSV): < 50 ms parse time
//   - Achieved via buffered std::ifstream + single-pass line parsing
//
// Thread safety: All methods are stateless and static — safe to call from
// any thread without synchronization.
// -----------------------------------------------------------------------------
class CsvLoader {
public:
    CsvLoader() = delete;  // Pure static utility — no instantiation.

    // -------------------------------------------------------------------------
    // Core loading functions
    // -------------------------------------------------------------------------

    // Parse a single CSV file into a vector of Candles.
    // The returned vector is sorted by timestamp ascending and deduplicated.
    // Throws std::runtime_error if the file cannot be opened or parsed.
    static std::vector<Candle> load_file(const std::string& path);

    // Load all CSV files matching the pattern data/{symbol}/{symbol}_*.csv
    // from the given data directory. Merges, sorts, and deduplicates all rows
    // across files into a single chronologically ordered vector.
    // Throws std::runtime_error if no files are found for the symbol.
    static std::vector<Candle> load_symbol(const std::string& symbol,
                                           const std::string& data_dir = "data");

    // Load all CSV files for a symbol and directly populate a CandleBuffer.
    // Convenience wrapper around load_symbol() + CandleBuffer::set_candles().
    static void load_into_buffer(CandleBuffer& buffer,
                                 const std::string& symbol,
                                 const std::string& data_dir = "data");

    // -------------------------------------------------------------------------
    // Parsing utilities (exposed for testing)
    // -------------------------------------------------------------------------

    // Parse a single CSV data line (not the header) into a Candle.
    // Expected format: "YYYY-MM-DD HH:MM:SS,open,high,low,close,volume"
    // Returns true on success, false if the line is malformed.
    static bool parse_line(const std::string& line, Candle& out);

    // Convert a "YYYY-MM-DD HH:MM:SS" timestamp string to Unix epoch seconds.
    // Assumes US Eastern Time (UTC-5). Returns -1 on parse failure.
    static int64_t parse_timestamp(const std::string& ts_str);

    // -------------------------------------------------------------------------
    // File discovery
    // -------------------------------------------------------------------------

    // Find all CSV files for a given symbol in the data directory.
    // Returns paths sorted alphabetically (which is chronological for our
    // naming convention: {symbol}_YYYYMM.csv).
    static std::vector<std::filesystem::path> find_csv_files(
        const std::string& symbol,
        const std::string& data_dir = "data");

private:
    // Sort candles by timestamp ascending and remove duplicates (same timestamp).
    // When duplicates exist, the last occurrence wins (most recent data).
    static void sort_and_deduplicate(std::vector<Candle>& candles);
};
