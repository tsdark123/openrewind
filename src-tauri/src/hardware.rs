// =============================================================================
// hardware.rs — read-only local hardware evidence for Orion model selection.
//
// 2B.1 scope: collect CPU, RAM and NVIDIA GPU facts through safe, bounded
// local commands.  This module does not select, reject, download or configure
// models.  All uncertain values are reported with a status/source/note so
// callers cannot confuse "unknown" with "false".
// =============================================================================

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sysinfo::System;

const NVIDIA_SMI_TIMEOUT_SECS: u64 = 5;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeStatus {
    Known,
    Unknown,
    Unsupported,
    Error,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeValue<T> {
    pub status: ProbeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<T>,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<Confidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl<T> ProbeValue<T> {
    pub fn known(value: T, source: impl Into<String>, confidence: Confidence) -> Self {
        Self {
            status: ProbeStatus::Known,
            value: Some(value),
            source: source.into(),
            confidence: Some(confidence),
            note: None,
        }
    }

    pub fn unknown(source: impl Into<String>, note: impl Into<String>) -> Self {
        Self {
            status: ProbeStatus::Unknown,
            value: None,
            source: source.into(),
            confidence: None,
            note: Some(note.into()),
        }
    }

    pub fn error(source: impl Into<String>, note: impl Into<String>) -> Self {
        Self {
            status: ProbeStatus::Error,
            value: None,
            source: source.into(),
            confidence: None,
            note: Some(note.into()),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuProfile {
    pub logical_cores: ProbeValue<u32>,
    pub physical_cores: ProbeValue<u32>,
    pub brand: ProbeValue<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RamProfile {
    pub total_mib: ProbeValue<u64>,
    pub available_mib: ProbeValue<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuDeviceProfile {
    pub index: u32,
    pub model: ProbeValue<String>,
    pub total_vram_mib: ProbeValue<u64>,
    pub available_vram_mib: ProbeValue<u64>,
    pub compute_capability: ProbeValue<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInventory {
    pub status: ProbeStatus,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    pub devices: Vec<GpuDeviceProfile>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub platform: String,
    pub timestamp: String,
    pub cpu: CpuProfile,
    pub ram: RamProfile,
    pub gpu_inventory: GpuInventory,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug)]
enum NvidiaSmiError {
    NotFound,
    Timeout,
    NonZeroExit { code: i32, stderr: String },
    Io(String),
}

fn platform_name() -> String {
    if cfg!(target_os = "windows") {
        "win32".into()
    } else if cfg!(target_os = "macos") {
        "darwin".into()
    } else if cfg!(target_os = "linux") {
        "linux".into()
    } else {
        "unknown".into()
    }
}

fn probe_cpu() -> CpuProfile {
    let mut sys = System::new_all();
    sys.refresh_all();

    let logical = sys.cpus().len() as u32;
    let logical_probe = if logical > 0 {
        ProbeValue::known(logical, "sysinfo", Confidence::High)
    } else {
        ProbeValue::unknown("sysinfo", "cpu list is empty after refresh")
    };

    let physical = sys.physical_core_count();
    let physical_probe = physical.map_or_else(
        || ProbeValue::unknown("sysinfo", "physical core count unavailable"),
        |n| ProbeValue::known(n as u32, "sysinfo", Confidence::High),
    );

    let brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty());
    let brand_probe = brand.map_or_else(
        || ProbeValue::unknown("sysinfo", "cpu brand unavailable"),
        |s| ProbeValue::known(s, "sysinfo", Confidence::High),
    );

    CpuProfile {
        logical_cores: logical_probe,
        physical_cores: physical_probe,
        brand: brand_probe,
    }
}

fn bytes_to_mib(bytes: u64) -> u64 {
    bytes / (1024 * 1024)
}

fn probe_ram() -> RamProfile {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total = bytes_to_mib(sys.total_memory());
    let available = bytes_to_mib(sys.available_memory());

    RamProfile {
        total_mib: if total > 0 {
            ProbeValue::known(total, "sysinfo", Confidence::High)
        } else {
            ProbeValue::unknown("sysinfo", "total memory reported as zero")
        },
        available_mib: if available > 0 || total > 0 {
            ProbeValue::known(available, "sysinfo", Confidence::High)
        } else {
            ProbeValue::unknown("sysinfo", "available memory reported as zero")
        },
    }
}

fn nvidia_smi_candidates() -> Vec<String> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "windows")]
    {
        candidates.push(r"C:\Windows\System32\nvidia-smi.exe".to_string());
        candidates.push(r"C:\Windows\SysWOW64\nvidia-smi.exe".to_string());
        candidates.push(r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe".to_string());
    }
    // PATH fallback.  Command resolution is left to the OS at spawn time.
    candidates.push("nvidia-smi".to_string());
    candidates
}

fn resolve_nvidia_smi_path(candidates: &[String]) -> Option<String> {
    // Prefer the first candidate that points to an existing file.  The bare
    // "nvidia-smi" name is not a file path, so it falls through to the second
    // pass and is returned as a PATH-resolution fallback.
    for c in candidates {
        if Path::new(c).is_file() {
            return Some(c.clone());
        }
    }
    for c in candidates {
        if c == "nvidia-smi" {
            return Some(c.clone());
        }
    }
    None
}

async fn run_nvidia_smi(exe: &str) -> Result<String, NvidiaSmiError> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args([
        "--query-gpu=index,name,memory.total,memory.free,compute_cap",
        "--format=csv,noheader,nounits",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let future = cmd.output();
    let result = tokio::time::timeout(Duration::from_secs(NVIDIA_SMI_TIMEOUT_SECS), future)
        .await
        .map_err(|_| NvidiaSmiError::Timeout)?;

    match result {
        Ok(output) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                Err(NvidiaSmiError::NonZeroExit {
                    code: output.status.code().unwrap_or(-1),
                    stderr,
                })
            }
        }
        Err(e) => {
            let kind = e.kind();
            if kind == std::io::ErrorKind::NotFound {
                Err(NvidiaSmiError::NotFound)
            } else {
                Err(NvidiaSmiError::Io(e.to_string()))
            }
        }
    }
}

fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        if c == '"' {
            if in_quotes && chars.peek() == Some(&'"') {
                current.push('"');
                chars.next();
            } else {
                in_quotes = !in_quotes;
            }
        } else if c == ',' && !in_quotes {
            fields.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(c);
        }
    }
    fields.push(current.trim().to_string());
    fields
}

fn parse_nvidia_smi_output(output: &str, warnings: &mut Vec<String>) -> Vec<GpuDeviceProfile> {
    let mut devices = Vec::new();

    for raw_line in output.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        let cols = parse_csv_line(line);
        if cols.len() != 5 {
            warnings.push(format!("Skipping malformed nvidia-smi row ({} columns): {line}", cols.len()));
            continue;
        }

        let index = match cols[0].trim().parse::<u32>() {
            Ok(i) => i,
            Err(e) => {
                warnings.push(format!("Skipping nvidia-smi row with bad index '{line}': {e}"));
                continue;
            }
        };

        let model = {
            let s = cols[1].trim().to_string();
            if s.is_empty() {
                ProbeValue::unknown("nvidia-smi", "model name empty")
            } else {
                ProbeValue::known(s, "nvidia-smi", Confidence::High)
            }
        };

        let total_vram_mib = parse_mib_field(&cols[2], "nvidia-smi", "memory.total");
        let available_vram_mib = parse_mib_field(&cols[3], "nvidia-smi", "memory.free");

        let compute_capability = {
            let s = cols[4].trim().to_string();
            if s.is_empty() {
                ProbeValue::unknown("nvidia-smi", "compute capability empty")
            } else {
                ProbeValue::known(s, "nvidia-smi", Confidence::High)
            }
        };

        devices.push(GpuDeviceProfile {
            index,
            model,
            total_vram_mib,
            available_vram_mib,
            compute_capability,
        });
    }

    devices
}

fn parse_mib_field(token: &str, source: &str, field: &str) -> ProbeValue<u64> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return ProbeValue::unknown(source, format!("{field} empty"));
    }
    match trimmed.parse::<u64>() {
        Ok(n) => ProbeValue::known(n, source, Confidence::High),
        Err(e) => ProbeValue::error(source, format!("{field} '{token}' is not an integer MiB value: {e}")),
    }
}

fn classify_nvidia_smi_output(output: &str, warnings: &mut Vec<String>) -> GpuInventory {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        // nvidia-smi produced empty output -> no NVIDIA GPUs detected.
        return GpuInventory {
            status: ProbeStatus::Known,
            source: "nvidia-smi".into(),
            note: Some("nvidia-smi returned no GPU rows".into()),
            devices: Vec::new(),
        };
    }

    let devices = parse_nvidia_smi_output(output, warnings);
    if devices.is_empty() {
        // Output was not empty but parsing yielded nothing -> malformed.
        let mut detail = String::from("nvidia-smi output contained no parseable GPU rows");
        if !warnings.is_empty() {
            detail.push_str("; ");
            detail.push_str(&warnings.join("; "));
        }
        GpuInventory {
            status: ProbeStatus::Error,
            source: "nvidia-smi".into(),
            note: Some(detail),
            devices,
        }
    } else {
        GpuInventory {
            status: ProbeStatus::Known,
            source: "nvidia-smi".into(),
            note: None,
            devices,
        }
    }
}

async fn probe_gpu_inventory(warnings: &mut Vec<String>) -> GpuInventory {
    #[cfg(not(target_os = "windows"))]
    {
        return GpuInventory {
            status: ProbeStatus::Unsupported,
            source: "platform".into(),
            note: Some("2B.1 GPU probe is Windows-first; no reliable cross-vendor probe on this platform".into()),
            devices: Vec::new(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        let candidates = nvidia_smi_candidates();
        let Some(exe) = resolve_nvidia_smi_path(&candidates) else {
            return GpuInventory {
                status: ProbeStatus::Unknown,
                source: "nvidia-smi".into(),
                note: Some("nvidia-smi not found in PATH or known NVIDIA locations".into()),
                devices: Vec::new(),
            };
        };

        match run_nvidia_smi(&exe).await {
            Ok(output) => classify_nvidia_smi_output(&output, warnings),
            Err(NvidiaSmiError::NotFound) => GpuInventory {
                status: ProbeStatus::Unknown,
                source: "nvidia-smi".into(),
                note: Some("nvidia-smi executable not found".into()),
                devices: Vec::new(),
            },
            Err(NvidiaSmiError::Timeout) => GpuInventory {
                status: ProbeStatus::Error,
                source: "nvidia-smi".into(),
                note: Some(format!("nvidia-smi did not complete within {NVIDIA_SMI_TIMEOUT_SECS}s")),
                devices: Vec::new(),
            },
            Err(NvidiaSmiError::NonZeroExit { code, stderr }) => GpuInventory {
                status: ProbeStatus::Error,
                source: "nvidia-smi".into(),
                note: Some(format!("nvidia-smi exited with code {code}: {stderr}")),
                devices: Vec::new(),
            },
            Err(NvidiaSmiError::Io(s)) => GpuInventory {
                status: ProbeStatus::Error,
                source: "nvidia-smi".into(),
                note: Some(format!("nvidia-smi failed to run: {s}")),
                devices: Vec::new(),
            },
        }
    }
}

#[tauri::command]
pub async fn probe_hardware() -> HardwareProfile {
    let mut warnings = Vec::new();
    let cpu = probe_cpu();
    let ram = probe_ram();
    let gpu_inventory = probe_gpu_inventory(&mut warnings).await;

    HardwareProfile {
        platform: platform_name(),
        timestamp: Utc::now().to_rfc3339(),
        cpu,
        ram,
        gpu_inventory,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    fn unique_temp_path(prefix: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let t = SystemTime::UNIX_EPOCH.elapsed().unwrap().as_nanos();
        std::env::temp_dir().join(format!("{prefix}_{t}_{n}"))
    }

    struct TempFile(PathBuf);
    impl TempFile {
        fn new() -> Self {
            let path = unique_temp_path("orion_hw_file");
            File::create(&path).expect("failed to create temp file");
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = unique_temp_path("orion_hw_dir");
            fs::create_dir_all(&path).expect("failed to create temp dir");
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn parse_one_valid_gpu() {
        let output = "0, NVIDIA GeForce RTX 3070 Ti, 8192, 6650, 8.6\r\n";
        let mut warnings = Vec::new();
        let devices = parse_nvidia_smi_output(output, &mut warnings);
        assert_eq!(devices.len(), 1);
        let gpu = &devices[0];
        assert_eq!(gpu.index, 0);
        assert_eq!(gpu.model.value.as_deref().unwrap(), "NVIDIA GeForce RTX 3070 Ti");
        assert_eq!(gpu.total_vram_mib.value, Some(8192));
        assert_eq!(gpu.available_vram_mib.value, Some(6650));
        assert_eq!(gpu.compute_capability.value.as_deref().unwrap(), "8.6");
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_multiple_gpus() {
        let output = "0, NVIDIA GeForce RTX 3070 Ti, 8192, 6650, 8.6\n1, NVIDIA GeForce RTX 4090, 24576, 12000, 8.9\n";
        let mut warnings = Vec::new();
        let devices = parse_nvidia_smi_output(output, &mut warnings);
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[1].index, 1);
        assert_eq!(devices[1].model.value.as_deref().unwrap(), "NVIDIA GeForce RTX 4090");
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_quoted_name_with_comma_and_whitespace() {
        let output = "0, \"NVIDIA RTX A6000, NVLINK\", 49152, 40000, 8.6\n";
        let mut warnings = Vec::new();
        let devices = parse_nvidia_smi_output(output, &mut warnings);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].model.value.as_deref().unwrap(), "NVIDIA RTX A6000, NVLINK");
        assert!(warnings.is_empty());
    }

    #[test]
    fn parse_malformed_numeric_value() {
        let output = "0, NVIDIA RTX 3060, not_a_number, 6650, 8.6\n";
        let mut warnings = Vec::new();
        let devices = parse_nvidia_smi_output(output, &mut warnings);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].total_vram_mib.status, ProbeStatus::Error);
        assert!(devices[0].total_vram_mib.note.as_ref().unwrap().contains("memory.total"));
    }

    #[test]
    fn parse_malformed_row_beside_valid_row() {
        let output = "bad-index, NVIDIA RTX 3060, 12288, 6650, 8.6\n0, NVIDIA RTX 3070, 8192, 4000, 8.6\n";
        let mut warnings = Vec::new();
        let devices = parse_nvidia_smi_output(output, &mut warnings);
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].index, 0);
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn classify_empty_nvidia_smi_output_is_known_no_gpus() {
        let output = "";
        let mut warnings = Vec::new();
        let inventory = classify_nvidia_smi_output(output, &mut warnings);
        assert_eq!(inventory.status, ProbeStatus::Known);
        assert!(inventory.devices.is_empty());
        assert_eq!(inventory.note.as_deref().unwrap(), "nvidia-smi returned no GPU rows");
    }

    #[test]
    fn classify_valid_nvidia_smi_output_is_known_with_devices() {
        let output = "0, NVIDIA GeForce RTX 3070 Ti, 8192, 6650, 8.6\n";
        let mut warnings = Vec::new();
        let inventory = classify_nvidia_smi_output(output, &mut warnings);
        assert_eq!(inventory.status, ProbeStatus::Known);
        assert_eq!(inventory.devices.len(), 1);
        assert!(inventory.note.is_none());
    }

    #[test]
    fn classify_non_empty_malformed_output_is_error() {
        // Output is not empty but contains no parseable GPU rows.
        let output = "this is not a csv row\nanother bad line\n";
        let mut warnings = Vec::new();
        let inventory = classify_nvidia_smi_output(output, &mut warnings);
        assert_eq!(inventory.status, ProbeStatus::Error);
        assert!(inventory.devices.is_empty());
        let note = inventory.note.as_deref().unwrap();
        assert!(note.contains("no parseable GPU rows"));
        assert!(!warnings.is_empty(), "parser warnings should be retained");
    }

    #[test]
    fn resolve_nvidia_smi_prefers_existing_file() {
        // A controlled temporary file is used so the test does not depend on
        // the host having NVIDIA drivers, Windows, or any particular layout.
        let existing = TempFile::new();
        let missing = unique_temp_path("orion_hw_missing").to_string_lossy().to_string();
        let candidates = vec![
            missing,
            existing.path().to_string_lossy().to_string(),
            "nvidia-smi".into(),
        ];
        let resolved = resolve_nvidia_smi_path(&candidates);
        assert_eq!(resolved.as_deref(), existing.path().to_str());
    }

    #[test]
    fn resolve_nvidia_smi_skips_directory() {
        let dir = TempDir::new();
        let candidates = vec![
            dir.path().to_string_lossy().to_string(),
            "nvidia-smi".into(),
        ];
        let resolved = resolve_nvidia_smi_path(&candidates);
        assert_eq!(resolved.as_deref(), Some("nvidia-smi"));
    }

    #[test]
    fn resolve_nvidia_smi_falls_back_to_path_name_when_no_explicit_file_exists() {
        let missing = unique_temp_path("orion_hw_missing").to_string_lossy().to_string();
        let candidates = vec![
            missing,
            "does_not_exist.exe".into(),
            "nvidia-smi".into(),
        ];
        let resolved = resolve_nvidia_smi_path(&candidates);
        assert_eq!(resolved.as_deref(), Some("nvidia-smi"));
    }

    #[test]
    fn resolve_nvidia_smi_returns_none_when_no_candidates_available() {
        let resolved = resolve_nvidia_smi_path(&[]);
        assert!(resolved.is_none());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn nvidia_smi_candidates_order_on_windows() {
        let candidates = nvidia_smi_candidates();
        assert_eq!(candidates.first().cloned().as_deref(), Some(r"C:\Windows\System32\nvidia-smi.exe"));
        assert_eq!(candidates.last().cloned().as_deref(), Some("nvidia-smi"));
        assert!(candidates.len() >= 4);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn nvidia_smi_candidates_on_non_windows_is_path_fallback_only() {
        let candidates = nvidia_smi_candidates();
        assert_eq!(candidates, vec!["nvidia-smi".to_string()]);
    }

    #[test]
    fn parse_csv_handles_quotes_and_commas() {
        let line = r#"0, "NVIDIA RTX A6000, NVLINK", 8192, 6650, 8.6"#;
        let cols = parse_csv_line(line);
        assert_eq!(cols.len(), 5);
        assert_eq!(cols[1], "NVIDIA RTX A6000, NVLINK");
    }

    #[test]
    fn bytes_to_mib_conversion_is_exact() {
        assert_eq!(bytes_to_mib(0), 0);
        assert_eq!(bytes_to_mib(1024 * 1024), 1);
        assert_eq!(bytes_to_mib(4 * 1024 * 1024 * 1024), 4096);
    }

    #[test]
    fn probe_ram_reports_ram_in_mib() {
        let ram = probe_ram();
        let mut sys = System::new_all();
        sys.refresh_all();

        // Values are dynamic, so compare within a small tolerance rather than
        // exact equality.  The important property is the conversion path used.
        let expected_total = bytes_to_mib(sys.total_memory());
        let total = ram.total_mib.value.expect("total RAM should be known");
        assert!(
            total.abs_diff(expected_total) <= 2,
            "probe_ram total_mib {total} should be within 2 MiB of expected {expected_total}"
        );

        let available = ram.available_mib.value.expect("available RAM should be known");
        assert!(available > 0, "available RAM should be positive");
        assert_eq!(ram.total_mib.status, ProbeStatus::Known);
        assert_eq!(ram.available_mib.status, ProbeStatus::Known);
    }

    #[test]
    fn missing_cpu_details_does_not_panic() {
        let cpu = probe_cpu();
        assert!(!cpu.brand.source.is_empty());
        assert!(!cpu.logical_cores.source.is_empty());
        assert!(!cpu.physical_cores.source.is_empty());
    }

    #[test]
    fn gpu_inventory_unsupported_on_non_windows() {
        let mut warnings = Vec::new();
        if !cfg!(target_os = "windows") {
            let inv = tokio::runtime::Runtime::new().unwrap().block_on(probe_gpu_inventory(&mut warnings));
            assert_eq!(inv.status, ProbeStatus::Unsupported);
            assert!(inv.devices.is_empty());
        }
    }

    #[test]
    fn probe_value_serialization_omits_null_optionals() {
        let known: ProbeValue<u64> = ProbeValue::known(100, "test", Confidence::High);
        let known_json = serde_json::to_string(&known).unwrap();
        assert!(known_json.contains("\"status\":\"known\""));
        assert!(known_json.contains("\"value\":100"));
        assert!(known_json.contains("\"source\":\"test\""));
        assert!(known_json.contains("\"confidence\":\"high\""));
        assert!(!known_json.contains("\"note\""));

        let unknown: ProbeValue<u64> = ProbeValue::unknown("test", "missing");
        let unknown_json = serde_json::to_string(&unknown).unwrap();
        assert!(unknown_json.contains("\"status\":\"unknown\""));
        assert!(!unknown_json.contains("\"value\""));
        assert!(!unknown_json.contains("\"confidence\""));
        assert!(unknown_json.contains("\"note\":\"missing\""));
    }

    #[test]
    fn gpu_inventory_note_omitted_when_none() {
        let inv = GpuInventory {
            status: ProbeStatus::Known,
            source: "nvidia-smi".into(),
            note: None,
            devices: Vec::new(),
        };
        let json = serde_json::to_string(&inv).unwrap();
        assert!(!json.contains("\"note\":null"));
        assert!(json.contains("\"status\":\"known\""));
    }
}
