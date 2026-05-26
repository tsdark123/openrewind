#include "csv_loader.hpp"

#include <fstream>
#include <sstream>
#include <algorithm>
#include <stdexcept>
#include <ctime>
#include <charconv>
#include <array>

// =============================================================================
// CsvLoader — Implementation
// =============================================================================

// -----------------------------------------------------------------------------
// Timestamp Parsing
// -----------------------------------------------------------------------------

int64_t CsvLoader::parse_timestamp(const std::string& ts_str) {
    // Expected format: "YYYY-MM-DD HH:MM:SS"
    // Minimum length: 19 characters (e.g., "2024-01-02 09:30:00")
    if (ts_str.size() < 19) {
        return -1;
    }

    // Manual parsing is significantly faster than strptime/std::get_time
    // for high-throughput CSV ingestion. We parse each numeric field directly
    // using fixed offsets in the known format string.
    //
    // Layout: Y Y Y Y - M M - D D   H H : M M : S S
    // Index:  0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18

    auto fast_atoi2 = [](const char* p) -> int {
        return (p[0] - '0') * 10 + (p[1] - '0');
    };

    auto fast_atoi4 = [](const char* p) -> int {
        return (p[0] - '0') * 1000 + (p[1] - '0') * 100 +
               (p[2] - '0') * 10   + (p[3] - '0');
    };

    const char* s = ts_str.c_str();

    int year   = fast_atoi4(s);
    int month  = fast_atoi2(s + 5);
    int day    = fast_atoi2(s + 8);
    int hour   = fast_atoi2(s + 11);
    int minute = fast_atoi2(s + 14);
    int second = fast_atoi2(s + 17);

    // Basic validation.
    if (year < 1970 || year > 2100 ||
        month < 1   || month > 12  ||
        day < 1     || day > 31    ||
        hour < 0    || hour > 23   ||
        minute < 0  || minute > 59 ||
        second < 0  || second > 59) {
        return -1;
    }

    // Convert to Unix epoch seconds using a direct calculation.
    // This avoids mktime() which is locale-dependent and slow.
    // We compute days since epoch, then convert to seconds.
    //
    // Algorithm: convert year/month/day to a day count from epoch using
    // the well-known civil_from_days formula (Howard Hinnant's date algorithms).

    // Shift March-based year so Feb is the last month (simplifies leap year).
    int y = year;
    int m = month;
    if (m <= 2) {
        y -= 1;
        m += 9;
    } else {
        m -= 3;
    }

    // Days from epoch (1970-01-01) to the given date.
    // Era-based calculation for Gregorian calendar correctness.
    int era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = static_cast<unsigned>(y - era * 400);                // year of era [0, 399]
    unsigned doy = (153 * static_cast<unsigned>(m) + 2) / 5 + static_cast<unsigned>(day) - 1; // day of year [0, 365]
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;             // day of era [0, 146096]
    int64_t days_since_epoch = static_cast<int64_t>(era) * 146097 +
                               static_cast<int64_t>(doe) - 719468;

    int64_t epoch_seconds = days_since_epoch * 86400 +
                            static_cast<int64_t>(hour) * 3600 +
                            static_cast<int64_t>(minute) * 60 +
                            static_cast<int64_t>(second);

    // Alpha Vantage timestamps are in US Eastern Time (UTC-5).
    // Shift to UTC by adding 5 hours.
    constexpr int64_t ET_UTC_OFFSET_SECONDS = 5 * 3600;
    epoch_seconds += ET_UTC_OFFSET_SECONDS;

    return epoch_seconds;
}

// -----------------------------------------------------------------------------
// Line Parsing
// -----------------------------------------------------------------------------

bool CsvLoader::parse_line(const std::string& line, Candle& out) {
    // Expected: "2024-01-02 09:30:00,185.52,185.63,185.41,185.55,128456"
    // We parse by finding comma positions rather than using stringstream,
    // which is measurably faster for high-volume CSV ingestion.

    if (line.empty()) {
        return false;
    }

    // Find the 5 comma positions that separate our 6 fields.
    std::array<std::size_t, 5> commas{};
    std::size_t found = 0;

    for (std::size_t i = 0; i < line.size() && found < 5; ++i) {
        if (line[i] == ',') {
            commas[found++] = i;
        }
    }

    if (found != 5) {
        return false;  // Malformed line — wrong number of fields.
    }

    // Field 0: timestamp (chars [0, commas[0]))
    std::string ts_str = line.substr(0, commas[0]);
    int64_t ts = parse_timestamp(ts_str);
    if (ts < 0) {
        return false;
    }

    // Fields 1–4: open, high, low, close (doubles)
    // Field 5: volume (uint64)
    // Use std::from_chars for maximum parse speed (no locale, no allocation).

    auto parse_double = [&](std::size_t start, std::size_t end, double& value) -> bool {
        const char* begin_ptr = line.data() + start;
        const char* end_ptr   = line.data() + end;
        auto [ptr, ec] = std::from_chars(begin_ptr, end_ptr, value);
        return ec == std::errc{} && ptr == end_ptr;
    };

    auto parse_uint64 = [&](std::size_t start, std::size_t end, uint64_t& value) -> bool {
        const char* begin_ptr = line.data() + start;
        const char* end_ptr   = line.data() + end;
        auto [ptr, ec] = std::from_chars(begin_ptr, end_ptr, value);
        return ec == std::errc{};
    };

    double open_val, high_val, low_val, close_val;
    uint64_t volume_val;

    if (!parse_double(commas[0] + 1, commas[1], open_val))          return false;
    if (!parse_double(commas[1] + 1, commas[2], high_val))          return false;
    if (!parse_double(commas[2] + 1, commas[3], low_val))           return false;
    if (!parse_double(commas[3] + 1, commas[4], close_val))         return false;
    if (!parse_uint64(commas[4] + 1, line.size(), volume_val))      return false;

    out.timestamp = ts;
    out.open      = open_val;
    out.high      = high_val;
    out.low       = low_val;
    out.close     = close_val;
    out.volume    = volume_val;

    return true;
}

// -----------------------------------------------------------------------------
// File Discovery
// -----------------------------------------------------------------------------

std::vector<std::filesystem::path> CsvLoader::find_csv_files(
    const std::string& symbol,
    const std::string& data_dir) {

    namespace fs = std::filesystem;

    fs::path symbol_dir = fs::path(data_dir) / symbol;

    if (!fs::exists(symbol_dir) || !fs::is_directory(symbol_dir)) {
        return {};
    }

    // Build the expected filename prefix: "{SYMBOL}_"
    std::string prefix = symbol + "_";

    std::vector<fs::path> files;

    for (const auto& entry : fs::directory_iterator(symbol_dir)) {
        if (!entry.is_regular_file()) {
            continue;
        }

        const auto& path = entry.path();
        std::string filename = path.filename().string();

        // Match files like "AAPL_202401.csv"
        if (filename.size() > prefix.size() &&
            filename.substr(0, prefix.size()) == prefix &&
            path.extension() == ".csv") {
            files.push_back(path);
        }
    }

    // Sort alphabetically — our naming convention (SYMBOL_YYYYMM.csv)
    // ensures this is chronological order.
    std::sort(files.begin(), files.end());

    return files;
}

// -----------------------------------------------------------------------------
// Core Loading
// -----------------------------------------------------------------------------

std::vector<Candle> CsvLoader::load_file(const std::string& path) {
    std::ifstream file(path, std::ios::in);

    if (!file.is_open()) {
        throw std::runtime_error("CsvLoader::load_file() — cannot open file: " + path);
    }

    std::vector<Candle> candles;

    // Pre-allocate for a typical month of 1-min equity data (~8,000–12,000 rows).
    candles.reserve(12000);

    std::string line;

    // Skip the header row.
    if (!std::getline(file, line)) {
        return candles;  // Empty file.
    }

    // Validate header — must contain "timestamp" or "time" (case-insensitive check
    // on first field). Alpha Vantage uses "timestamp" as the first column.
    // We do a loose check: if the first line parses as a valid candle, it's data,
    // not a header, so we process it.
    Candle first_candle{};
    bool header_is_data = parse_line(line, first_candle);
    if (header_is_data) {
        candles.push_back(first_candle);
    }

    // Parse remaining lines.
    Candle candle{};
    while (std::getline(file, line)) {
        // Strip trailing \r if present (Windows line endings).
        if (!line.empty() && line.back() == '\r') {
            line.pop_back();
        }

        if (line.empty()) {
            continue;
        }

        if (parse_line(line, candle)) {
            candles.push_back(candle);
        }
        // Silently skip malformed lines — log in V2.
    }

    sort_and_deduplicate(candles);
    return candles;
}

std::vector<Candle> CsvLoader::load_symbol(const std::string& symbol,
                                            const std::string& data_dir) {
    auto files = find_csv_files(symbol, data_dir);

    if (files.empty()) {
        throw std::runtime_error(
            "CsvLoader::load_symbol() — no CSV files found for symbol '" +
            symbol + "' in directory '" + data_dir + "/" + symbol + "'");
    }

    std::vector<Candle> all_candles;

    // Estimate total rows across all files to minimize reallocations.
    all_candles.reserve(files.size() * 10000);

    for (const auto& file_path : files) {
        auto file_candles = load_file(file_path.string());
        all_candles.insert(all_candles.end(),
                           file_candles.begin(), file_candles.end());
    }

    // Final sort + dedup across all merged files.
    sort_and_deduplicate(all_candles);

    return all_candles;
}

void CsvLoader::load_into_buffer(CandleBuffer& buffer,
                                  const std::string& symbol,
                                  const std::string& data_dir) {
    auto candles = load_symbol(symbol, data_dir);
    buffer.set_candles(std::move(candles));
}

// -----------------------------------------------------------------------------
// Sort & Deduplicate
// -----------------------------------------------------------------------------

void CsvLoader::sort_and_deduplicate(std::vector<Candle>& candles) {
    if (candles.size() <= 1) {
        return;
    }

    // Stable sort preserves insertion order for equal timestamps.
    // When loading multiple files, data from later files (appended second)
    // is considered "fresher" and kept during dedup.
    std::stable_sort(candles.begin(), candles.end());

    // Remove consecutive duplicates. std::unique keeps the first element
    // in each group of consecutive equal elements. Because stable_sort
    // preserved insertion order, the first occurrence of each timestamp
    // is from the earliest-loaded file. If we want "last wins" semantics,
    // we reverse, unique, reverse back.
    //
    // However, for V1 with non-overlapping monthly files, duplicates
    // are rare and typically identical. We use simple forward unique.
    auto new_end = std::unique(candles.begin(), candles.end(),
        [](const Candle& a, const Candle& b) {
            return a.timestamp == b.timestamp;
        });

    candles.erase(new_end, candles.end());
}
