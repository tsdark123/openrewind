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
    pub value: Option<T>,
    pub source: String,
    pub confidence: Option<Confidence>,
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

fn probe_ram() -> RamProfile {
    let mut sys = System::new_all();
    sys.refresh_all();

    let total = sys.total_memory() / (1024 * 1024);
    let available = sys.available_memory() / (1024 * 1024);

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
    let mut candidates = vec!["nvidia-smi".to_string()];
    #[cfg(target_os = "windows")]
    {
        candidates.push(r"C:\Windows\System32\nvidia-smi.exe".to_string());
        candidates.push(r"C:\Windows\SysWOW64\nvidia-smi.exe".to_string());
        candidates.push(r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe".to_string());
    }
    candidates
}

fn resolve_nvidia_smi_path(candidates: &[String]) -> Option<String> {
    for c in candidates {
        if Path::new(c).is_file() {
            return Some(c.clone());
        }
        // Allow bare "nvidia-smi" to be resolved later by PATH.
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
            Ok(output) => {
                let devices = parse_nvidia_smi_output(&output, warnings);
                if devices.is_empty() {
                    GpuInventory {
                        status: ProbeStatus::Known,
                        source: "nvidia-smi".into(),
                        note: Some("nvidia-smi returned no GPU rows".into()),
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
    fn parse_empty_output() {
        let output = "";
        let mut warnings = Vec::new();
        let devices = parse_nvidia_smi_output(output, &mut warnings);
        assert!(devices.is_empty());
    }

    #[test]
    fn resolve_nvidia_smi_prefers_existing_file() {
        let candidates = vec!["should_not_exist.exe".into(), r"C:\Windows\System32\nvidia-smi.exe".into()];
        let resolved = resolve_nvidia_smi_path(&candidates);
        assert_eq!(resolved.as_deref(), Some(r"C:\Windows\System32\nvidia-smi.exe"));
    }

    #[test]
    fn resolve_nvidia_smi_falls_back_to_path_name() {
        let candidates = vec!["nvidia-smi".into()];
        let resolved = resolve_nvidia_smi_path(&candidates);
        assert_eq!(resolved.as_deref(), Some("nvidia-smi"));
    }

    #[test]
    fn parse_csv_handles_quotes_and_commas() {
        let line = r#"0, "NVIDIA RTX A6000, NVLINK", 8192, 6650, 8.6"#;
        let cols = parse_csv_line(line);
        assert_eq!(cols.len(), 5);
        assert_eq!(cols[1], "NVIDIA RTX A6000, NVLINK");
    }

    #[test]
    fn mib_conversion_from_bytes() {
        // 4 GiB in bytes -> 4096 MiB
        let bytes: u64 = 4 * 1024 * 1024 * 1024;
        let mib = bytes / (1024 * 1024);
        assert_eq!(mib, 4096);
    }

    #[test]
    fn missing_cpu_details_does_not_panic() {
        // probe_cpu uses live sysinfo; this test simply verifies it returns a
        // profile without panicking and that every field has a status.
        let cpu = probe_cpu();
        assert!(!cpu.brand.source.is_empty());
        assert!(!cpu.logical_cores.source.is_empty());
        assert!(!cpu.physical_cores.source.is_empty());
    }

    #[test]
    fn missing_ram_details_does_not_panic() {
        let ram = probe_ram();
        assert!(!ram.total_mib.source.is_empty());
        assert!(!ram.available_mib.source.is_empty());
    }

    #[test]
    fn gpu_inventory_unsupported_on_non_windows() {
        // This test documents that the non-windows cfg path is structured.
        // On a Windows runner it will not exercise the non-windows branch.
        let mut warnings = Vec::new();
        if !cfg!(target_os = "windows") {
            let inv = tokio::runtime::Runtime::new().unwrap().block_on(probe_gpu_inventory(&mut warnings));
            assert_eq!(inv.status, ProbeStatus::Unsupported);
            assert!(inv.devices.is_empty());
        }
    }

    #[test]
    fn probe_value_status_variants_serialize() {
        let v: ProbeValue<u64> = ProbeValue::known(100, "test", Confidence::High);
        let json = serde_json::to_string(&v).unwrap();
        assert!(json.contains("\"status\":\"known\""));
        assert!(json.contains("\"source\":\"test\""));
    }
}
