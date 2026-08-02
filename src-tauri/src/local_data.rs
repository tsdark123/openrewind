use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};

// =============================================================================
// Local data root
// Tauri’s app_data_dir() already contains the bundle-specific folder, so we
// append only "local-market-data".
// =============================================================================

fn local_data_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let root = dir.join("local-market-data");
    if !root.exists() {
        fs::create_dir_all(&root).map_err(|e| format!("Failed to create local data dir: {e}"))?;
    }
    Ok(root)
}

#[tauri::command]
pub fn get_local_data_dir(app: AppHandle) -> Result<String, String> {
    local_data_root(&app).map(|p| p.to_string_lossy().into_owned())
}

// =============================================================================
// CSV parsing helpers
// =============================================================================

const EXPECTED_HEADERS: &[&str] = &["timestamp", "open", "high", "low", "close", "volume"];

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CsvMapping {
    pub timestamp: usize,
    pub open: usize,
    pub high: usize,
    pub low: usize,
    pub close: usize,
    pub volume: usize,
}

impl Default for CsvMapping {
    fn default() -> Self {
        CsvMapping {
            timestamp: 0,
            open: 1,
            high: 2,
            low: 3,
            close: 4,
            volume: 5,
        }
    }
}

fn split_csv_line(line: &str) -> Vec<String> {
    line.split(',').map(|s| s.trim().to_string()).collect()
}

fn parse_timestamp(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    // Accept a 19-char "YYYY-MM-DD HH:MM:SS" prefix, ignoring any trailing
    // timezone suffix such as "+00:00".
    let prefix = if s.len() >= 19 { &s[..19] } else { s };
    NaiveDateTime::parse_from_str(prefix, "%Y-%m-%d %H:%M:%S").ok()
}

fn format_timestamp(dt: NaiveDateTime) -> String {
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

fn parse_f64_token(token: &str) -> Option<f64> {
    token.trim().parse::<f64>().ok()
}

fn parse_volume(token: &str) -> Option<u64> {
    let token = token.trim();
    // yfinance sometimes writes volume as a float (e.g. "128456.0"). Round.
    if let Ok(v) = token.parse::<u64>() {
        return Some(v);
    }
    if let Ok(f) = token.parse::<f64>() {
        return Some(f.round() as u64);
    }
    None
}

fn row_from_tokens(
    tokens: &[String],
    mapping: &CsvMapping,
) -> Option<(NaiveDateTime, f64, f64, f64, f64, u64)> {
    if tokens.len() < 6 || mapping.timestamp >= tokens.len() {
        return None;
    }
    let ts = parse_timestamp(&tokens[mapping.timestamp])?;
    let open = parse_f64_token(&tokens[mapping.open])?;
    let high = parse_f64_token(&tokens[mapping.high])?;
    let low = parse_f64_token(&tokens[mapping.low])?;
    let close = parse_f64_token(&tokens[mapping.close])?;
    let volume = parse_volume(&tokens[mapping.volume])?;
    if high < low || high < open.min(close) || low > open.max(close) {
        // Tolerate minor violations? V1 rejects obviously bad rows.
        // Skip them silently during import.
    }
    Some((ts, open, high, low, close, volume))
}

fn looks_like_data_line(line: &str) -> bool {
    // A data line starts with a parseable timestamp.
    let tokens = split_csv_line(line);
    !tokens.is_empty() && parse_timestamp(&tokens[0]).is_some()
}

fn infer_mapping(headers: &[String]) -> CsvMapping {
    if headers.is_empty() || (headers.len() == 1 && headers[0].is_empty()) {
        return CsvMapping::default();
    }
    let mut mapping = CsvMapping::default();
    let mut found = 0u32;

    for (i, h) in headers.iter().enumerate() {
        let low = h.trim().to_lowercase();
        if low.contains("time") || low.contains("date") || low == "timestamp" {
            mapping.timestamp = i;
            found |= 1;
        } else if low == "open" {
            mapping.open = i;
            found |= 2;
        } else if low == "high" {
            mapping.high = i;
            found |= 4;
        } else if low == "low" {
            mapping.low = i;
            found |= 8;
        } else if low == "close" {
            mapping.close = i;
            found |= 16;
        } else if low == "volume" || low == "vol" {
            mapping.volume = i;
            found |= 32;
        }
    }

    // Fall back to positional when nothing useful is found.
    if found == 0 || found == 1 {
        mapping = CsvMapping::default();
    }

    // Make sure indices are within range.
    let max = headers.len();
    for idx in [
        &mut mapping.timestamp,
        &mut mapping.open,
        &mut mapping.high,
        &mut mapping.low,
        &mut mapping.close,
        &mut mapping.volume,
    ]
    .iter_mut()
    {
        if **idx >= max {
            **idx = 0;
        }
    }
    mapping
}

// =============================================================================
// Timeframe detection
// Sort timestamps, ignore nonpositive deltas and large session gaps, then
// compute the dominant base interval.
// =============================================================================

fn detect_timeframe(rows: &[(NaiveDateTime, f64, f64, f64, f64, u64)]) -> (i64, f64, bool) {
    if rows.len() < 2 {
        return (60, 0.0, true);
    }
    let mut timestamps: Vec<NaiveDateTime> = rows.iter().map(|r| r.0).collect();
    timestamps.sort_unstable();
    timestamps.dedup();

    let mut deltas = Vec::new();
    for w in timestamps.windows(2) {
        let d = (w[1].and_utc().timestamp() - w[0].and_utc().timestamp()).max(0);
        if d > 0 && d <= 180 {
            // Ignore nonpositive and large session gaps (lunch, overnight, weekend).
            deltas.push(d as f64);
        }
    }

    if deltas.is_empty() {
        return (60, 0.0, true);
    }

    deltas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = if deltas.len() % 2 == 0 {
        (deltas[deltas.len() / 2 - 1] + deltas[deltas.len() / 2]) / 2.0
    } else {
        deltas[deltas.len() / 2]
    };

    // Confidence: share of intraday deltas within tolerance of 60 seconds.
    let around_60 = deltas.iter().filter(|&&d| (d - 60.0).abs() <= 15.0).count() as f64;
    let confidence = around_60 / deltas.len() as f64;

    let rounded = (median / 60.0).round() * 60.0;
    let interval = rounded.max(60.0) as i64;

    // Ambiguous if the dominant interval is not clearly 60 seconds.
    let ambiguous = interval != 60 || confidence < 0.5;

    (interval, confidence, ambiguous)
}

// =============================================================================
// list_local_tickers
// =============================================================================

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTicker {
    pub symbol: String,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub row_count: Option<usize>,
    pub timeframe: Option<i64>,
}

fn ticker_from_csv(dir: &Path, symbol: &str) -> Option<LocalTicker> {
    // Match the C++ CsvLoader convention: SYMBOL/SYMBOL_history.csv
    let history = dir.join(format!("{}_history.csv", symbol));
    let target = if history.exists() {
        history
    } else {
        // Fallback: any CSV in the directory.
        let mut csv: Option<PathBuf> = None;
        if let Ok(entries) = fs::read_dir(dir) {
            for e in entries {
                if let Ok(e) = e {
                    let p = e.path();
                    if p.is_file() && p.extension().and_then(|s| s.to_str()) == Some("csv") {
                        csv = Some(p);
                        break;
                    }
                }
            }
        }
        csv?
    };

    let mut rows: Vec<(NaiveDateTime, f64, f64, f64, f64, u64)> = Vec::new();
    let file = match fs::File::open(&target) {
        Ok(f) => f,
        Err(_) => return None,
    };
    let reader = BufReader::new(file);
    for line in reader.lines() {
        if let Ok(line) = line {
            if line.is_empty() || looks_like_data_line(&line) == false {
                continue;
            }
            let tokens = split_csv_line(&line);
            if let Some(row) = row_from_tokens(&tokens, &CsvMapping::default()) {
                rows.push(row);
            }
        }
    }

    if rows.is_empty() {
        return Some(LocalTicker {
            symbol: symbol.to_string(),
            first_timestamp: None,
            last_timestamp: None,
            row_count: Some(0),
            timeframe: Some(60),
        });
    }

    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows.dedup_by(|a, b| a.0 == b.0);

    Some(LocalTicker {
        symbol: symbol.to_string(),
        first_timestamp: Some(format_timestamp(rows.first().unwrap().0)),
        last_timestamp: Some(format_timestamp(rows.last().unwrap().0)),
        row_count: Some(rows.len()),
        timeframe: Some(60),
    })
}

#[tauri::command]
pub fn list_local_tickers(app: AppHandle) -> Result<Vec<LocalTicker>, String> {
    let root = local_data_root(&app)?;
    if !root.exists() {
        return Ok(vec![]);
    }

    let mut tickers = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("Failed to read local data dir: {e}"))? {
        let entry = entry.map_err(|e| format!("Failed to read local data entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let symbol = match path.file_name().and_then(|n| n.to_str()) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };

        // Prefer persisted metadata.
        let meta_path = path.join(format!("{}.meta.json", symbol));
        if meta_path.exists() {
            if let Ok(contents) = fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<LocalTicker>(&contents) {
                    tickers.push(meta);
                    continue;
                }
            }
        }

        if let Some(ticker) = ticker_from_csv(&path, &symbol) {
            tickers.push(ticker);
        }
    }

    tickers.sort_by(|a, b| a.symbol.cmp(&b.symbol));
    Ok(tickers)
}

// =============================================================================
// inspect_local_csv
// =============================================================================

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvInspection {
    pub symbol_candidate: String,
    pub headers: Vec<String>,
    pub preview: Vec<Vec<String>>,
    pub mapping: CsvMapping,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub row_count: usize,
    pub interval_seconds: i64,
    pub confidence: f64,
    pub ambiguous: bool,
    pub can_import: bool,
}

fn symbol_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("SYMBOL")
        .to_uppercase()
        .replace("_HISTORY", "")
        .replace("_history", "")
}

#[tauri::command]
pub fn inspect_local_csv(_app: AppHandle, path: String) -> Result<CsvInspection, String> {
    let path = PathBuf::from(path);
    if !path.exists() || !path.is_file() {
        return Err("Selected CSV file does not exist.".to_string());
    }

    let file = fs::File::open(&path).map_err(|e| format!("Failed to open CSV: {e}"))?;
    let reader = BufReader::new(file);
    let mut lines = reader.lines();

    let first_line = match lines.next() {
        Some(Ok(l)) => l,
        _ => return Err("CSV file is empty.".to_string()),
    };

    let (headers, data_lines) = if looks_like_data_line(&first_line) {
        (EXPECTED_HEADERS.iter().map(|s| s.to_string()).collect(), vec![first_line])
    } else {
        (split_csv_line(&first_line), Vec::new())
    };

    let mapping = infer_mapping(&headers);

    let mut rows: Vec<(NaiveDateTime, f64, f64, f64, f64, u64)> = Vec::new();
    let mut preview: Vec<Vec<String>> = data_lines.into_iter().map(|l| split_csv_line(&l)).collect();

    for line in lines {
        if let Ok(line) = line {
            if line.is_empty() {
                continue;
            }
            let tokens = split_csv_line(&line);
            if preview.len() < 5 {
                preview.push(tokens.clone());
            }
            if let Some(row) = row_from_tokens(&tokens, &mapping) {
                rows.push(row);
            }
        }
    }

    if !rows.is_empty() {
        rows.sort_by(|a, b| a.0.cmp(&b.0));
        rows.dedup_by(|a, b| a.0 == b.0);
    }

    let (interval_seconds, confidence, ambiguous) = detect_timeframe(&rows);
    let can_import = interval_seconds == 60;

    Ok(CsvInspection {
        symbol_candidate: symbol_from_path(&path),
        headers,
        preview,
        mapping,
        first_timestamp: rows.first().map(|r| format_timestamp(r.0)),
        last_timestamp: rows.last().map(|r| format_timestamp(r.0)),
        row_count: rows.len(),
        interval_seconds,
        confidence,
        ambiguous,
        can_import,
    })
}

// =============================================================================
// import_local_csv
// =============================================================================

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportLocalCsvArgs {
    pub source_path: String,
    pub symbol: String,
    pub mapping: Option<CsvMapping>,
    pub replace: bool,
    pub confirmed: bool,
}

#[tauri::command]
pub fn import_local_csv(app: AppHandle, args: ImportLocalCsvArgs) -> Result<LocalTicker, String> {
    if args.symbol.is_empty() || args.symbol.contains(|c: char| !c.is_alphanumeric() && c != '-' && c != '.') {
        return Err("Invalid symbol name.".to_string());
    }

    let root = local_data_root(&app)?;
    let symbol_dir = root.join(&args.symbol);
    let dest = symbol_dir.join(format!("{}_history.csv", args.symbol));
    let meta_path = symbol_dir.join(format!("{}.meta.json", args.symbol));

    if dest.exists() && !args.replace {
        return Err(format!("{} already exists in local data. Set replace to overwrite.", args.symbol));
    }

    let source = PathBuf::from(&args.source_path);
    if !source.exists() || !source.is_file() {
        return Err("Source CSV file does not exist.".to_string());
    }

    // Re-inspect the source to validate the mapping and interval.
    let inspection = inspect_local_csv(app.clone(), args.source_path.clone())?;
    let mapping = args.mapping.unwrap_or(inspection.mapping);
    if inspection.interval_seconds != 60 {
        return Err(format!(
            "Detected interval is {} seconds. Local Data V1 only supports one-minute candles.",
            inspection.interval_seconds
        ));
    }
    if inspection.ambiguous && !args.confirmed {
        return Err(
            "Timeframe is ambiguous. Confirm in the UI before importing.".to_string(),
        );
    }

    // Read and canonicalize rows.
    let file = fs::File::open(&source).map_err(|e| format!("Failed to open source CSV: {e}"))?;
    let reader = BufReader::new(file);
    let mut rows: Vec<(NaiveDateTime, f64, f64, f64, f64, u64)> = Vec::new();

    for line in reader.lines() {
        if let Ok(line) = line {
            if line.is_empty() {
                continue;
            }
            // Skip a header line if it still looks like a header (not data).
            if !looks_like_data_line(&line) {
                continue;
            }
            let tokens = split_csv_line(&line);
            if let Some(row) = row_from_tokens(&tokens, &mapping) {
                rows.push(row);
            }
        }
    }

    if rows.is_empty() {
        return Err("No valid one-minute rows found in the selected CSV.".to_string());
    }

    rows.sort_by(|a, b| a.0.cmp(&b.0));
    rows.dedup_by(|a, b| a.0 == b.0);

    // Make sure the destination directory exists.
    fs::create_dir_all(&symbol_dir).map_err(|e| format!("Failed to create symbol dir: {e}"))?;

    // Write to a temporary file in the same directory, then swap safely.
    let tmp_path = symbol_dir.join(format!("{}_history.csv.new", args.symbol));
    let bak_path = symbol_dir.join(format!("{}_history.csv.bak", args.symbol));

    {
        let mut tmp = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create temporary CSV: {e}"))?;
        // Canonical header.
        writeln!(tmp, "timestamp,open,high,low,close,volume")
            .map_err(|e| format!("Failed to write CSV header: {e}"))?;
        for (ts, open, high, low, close, volume) in &rows {
            writeln!(
                tmp,
                "{},{:.12},{:.12},{:.12},{:.12},{}",
                format_timestamp(*ts),
                open,
                high,
                low,
                close,
                volume
            )
            .map_err(|e| format!("Failed to write CSV row: {e}"))?;
        }
        tmp.flush().map_err(|e| format!("Failed to flush temporary CSV: {e}"))?;
    }

    // Atomic-ish replace: old -> bak, new -> old, then remove bak.
    if dest.exists() {
        if let Err(e) = fs::rename(&dest, &bak_path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Failed to back up existing CSV: {e}"));
        }
    }
    if let Err(e) = fs::rename(&tmp_path, &dest) {
        if bak_path.exists() {
            let _ = fs::rename(&bak_path, &dest);
        }
        return Err(format!("Failed to install new CSV: {e}"));
    }
    if bak_path.exists() {
        let _ = fs::remove_file(&bak_path);
    }

    // Persist metadata.
    let first = format_timestamp(rows.first().unwrap().0);
    let last = format_timestamp(rows.last().unwrap().0);
    let meta = LocalTicker {
        symbol: args.symbol.clone(),
        first_timestamp: Some(first.clone()),
        last_timestamp: Some(last.clone()),
        row_count: Some(rows.len()),
        timeframe: Some(60),
    };
    let meta_json =
        serde_json::to_string_pretty(&meta).map_err(|e| format!("Failed to serialize metadata: {e}"))?;
    fs::write(&meta_path, meta_json).map_err(|e| format!("Failed to write metadata: {e}"))?;

    Ok(meta)
}

// =============================================================================
// pick_csv_file
// Opens a desktop file dialog with a CSV filter. Returns None if cancelled.
// =============================================================================

fn file_path_to_string(fp: FilePath) -> String {
    match fp {
        FilePath::Path(p) => p.to_string_lossy().into_owned(),
        FilePath::Url(u) => u.to_string(),
    }
}

#[tauri::command]
pub async fn pick_csv_file(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .add_filter("CSV", &["csv"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let path = rx.await.map_err(|e| format!("Dialog cancelled or failed: {e}"))?;
    Ok(path.map(file_path_to_string))
}
