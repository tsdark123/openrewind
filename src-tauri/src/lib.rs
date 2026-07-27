use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use futures_util::StreamExt;
use sysinfo::{ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::time::{sleep, timeout};

#[allow(dead_code)]
struct EngineProcess(CommandChild);

fn journal_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?;
    let data_dir = dir.join("data");
    if !data_dir.exists() {
        fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    }
    Ok(data_dir.join("journal.json"))
}

#[tauri::command]
fn read_journal(app: AppHandle) -> Result<String, String> {
    let path = journal_path(&app)?;
    if !path.exists() {
        return Ok("{}".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read journal: {e}"))
}

#[tauri::command]
fn write_journal(app: AppHandle, contents: String) -> Result<(), String> {
    let path = journal_path(&app)?;
    let mut file = fs::File::create(&path).map_err(|e| format!("Failed to create journal file: {e}"))?;
    file.write_all(contents.as_bytes())
        .map_err(|e| format!("Failed to write journal: {e}"))?;
    Ok(())
}

/// Runs the bundled Python fetch_data.py to pull the latest 1-minute market
/// data. The script writes into the bundled `data/` directory, which the C++
/// engine will see via /api/data_refreshed.
#[tauri::command]
async fn fetch_market_data(app: AppHandle) -> Result<(), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to resolve resource directory: {e}"))?;

    let script = resource_dir.join("scripts").join("fetch_data.py");
    if !script.exists() {
        return Err(format!("fetch_data.py not found at {}", script.display()));
    }

    let data_dir = resource_dir.join("data");

    let (mut rx, _child) = app
        .shell()
        .command("python")
        .args([
            script.to_string_lossy().as_ref(),
            "--mode",
            "sync",
            "--data-dir",
            data_dir.to_string_lossy().as_ref(),
        ])
        .current_dir(resource_dir.to_string_lossy().as_ref())
        .spawn()
        .map_err(|e| format!("Failed to spawn fetch_data.py: {e}"))?;

    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line)
            | tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                println!("[fetch_data] {}", String::from_utf8_lossy(&line));
            }
            tauri_plugin_shell::process::CommandEvent::Error(err) => {
                return Err(format!("fetch_data.py error: {err}"));
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) {
                    println!("[fetch_data] warning: exited with code {:?}", payload.code);
                }
                break;
            }
            _ => {}
        }
    }

    Ok(())
}

const OLLAMA_HOST: &str = "127.0.0.1:11434";
const OLLAMA_DOWNLOAD_URL: &str =
    "https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip";
const OLLAMA_DOWNLOAD_TIMEOUT_SECS: u64 = 1800; // 30 minutes for the ~1.4 GB archive

#[derive(Clone, serde::Serialize)]
struct OllamaDownloadProgress {
    stage: &'static str,
    percent: u32,
    message: String,
}

async fn ollama_port_open() -> bool {
    TcpStream::connect(OLLAMA_HOST).await.is_ok()
}

async fn ollama_accepts_origin() -> bool {
    match reqwest::Client::new()
        .get(format!("http://{OLLAMA_HOST}/api/tags"))
        .header("Origin", "https://tauri.localhost")
        .send()
        .await
    {
        Ok(resp) => resp.status().as_u16() != 403,
        Err(_) => false,
    }
}

fn kill_ollama_by_path(target: &Path) -> Result<bool, String> {
    let mut sys = System::new_all();
    sys.refresh_processes(ProcessesToUpdate::All);
    for (pid, process) in sys.processes() {
        if let Some(exe) = process.exe() {
            if exe == target {
                if process.kill() {
                    return Ok(true);
                }
                return Err(format!(
                    "Found existing Ollama process ({pid}) but could not terminate it"
                ));
            }
        }
    }
    Ok(false)
}

async fn wait_for_ollama_port_closed(timeout_secs: u64) -> Result<(), String> {
    let result = timeout(Duration::from_secs(timeout_secs), async {
        while ollama_port_open().await {
            sleep(Duration::from_millis(500)).await;
        }
        true
    })
    .await;

    if result == Ok(true) {
        Ok(())
    } else {
        Err(format!(
            "Ollama port {OLLAMA_HOST} did not close within {timeout_secs}s"
        ))
    }
}

async fn is_ollama_in_path() -> bool {
    tokio::task::spawn_blocking(|| {
        StdCommand::new("ollama")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

async fn wait_for_ollama_port(timeout_secs: u64) -> Result<(), String> {
    let result = timeout(Duration::from_secs(timeout_secs), async {
        loop {
            if TcpStream::connect(OLLAMA_HOST).await.is_ok() {
                return true;
            }
            sleep(Duration::from_millis(500)).await;
        }
    })
    .await;

    if result == Ok(true) {
        Ok(())
    } else {
        Err(format!(
            "Ollama did not respond on {OLLAMA_HOST} within {timeout_secs}s"
        ))
    }
}

fn spawn_ollama(exe: &Path, cwd: Option<&Path>) -> Result<(), String> {
    let threads = std::thread::available_parallelism()
        .map(|n| (n.get() / 2).clamp(2, 8))
        .unwrap_or(4)
        .to_string();

    let mut cmd = StdCommand::new(exe);
    cmd.arg("serve")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("OLLAMA_ORIGINS", "*")
        .env("OLLAMA_HOST", OLLAMA_HOST)
        .env("OLLAMA_NUM_THREADS", &threads)
        .env("OLLAMA_NUM_PARALLEL", "1");

    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let _child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn Ollama ({}): {e}", exe.display()))?;

    Ok(())
}

#[tauri::command]
async fn ensure_ollama_running(app: AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let data_dir = app_data.join("data");
    let local_exe = data_dir.join("ollama.exe");

    if ollama_port_open().await {
        if ollama_accepts_origin().await {
            return Ok("RUNNING".into());
        }

        // Port is up but rejects our app's Origin. If it's our local binary, restart it
        // with OLLAMA_ORIGINS=* so the webview/plugin can reach it.
        if local_exe.exists() && kill_ollama_by_path(&local_exe).unwrap_or(false) {
            wait_for_ollama_port_closed(10).await?;
        } else {
            return Err(
                "Ollama is already running and is blocking requests from this app. \
                 Stop the existing Ollama process or set OLLAMA_ORIGINS=* for it."
                    .into(),
            );
        }
    }

    // Prefer a globally-installed Ollama binary (PATH).
    if is_ollama_in_path().await {
        spawn_ollama(Path::new("ollama"), None)?;
        wait_for_ollama_port(60).await?;
        return Ok("STARTED".into());
    }

    // Fall back to a locally-downloaded copy under AppData/<app>/data/ollama.exe.
    if local_exe.exists() {
        spawn_ollama(&local_exe, Some(&data_dir))?;
        wait_for_ollama_port(60).await?;
        return Ok("STARTED".into());
    }

    Ok("OLLAMA_MISSING".into())
}

#[tauri::command]
async fn download_ollama(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("data");
    tokio::fs::create_dir_all(&data_dir)
        .await
        .map_err(|e| e.to_string())?;

    let zip_path = data_dir.join("ollama-windows-amd64.zip");

    let emit = |stage: &'static str, percent: u32, message: String| {
        let _ = app.emit(
            "ollama-download-progress",
            OllamaDownloadProgress { stage, percent, message },
        );
    };

    emit(
        "downloading",
        0,
        "Initializing core AI infrastructure onto your machine... please wait.".into(),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(OLLAMA_DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(OLLAMA_DOWNLOAD_URL)
        .send()
        .await
        .map_err(|e| format!("Failed to start Ollama download: {e}"))?;

    let total = response.content_length().unwrap_or(0);

    let mut file = tokio::fs::File::create(&zip_path)
        .await
        .map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_percent = 0;

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Download error: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;

        if total > 0 {
            let percent = ((downloaded * 100) / total) as u32;
            if percent != last_percent {
                last_percent = percent;
                emit(
                    "downloading",
                    percent,
                    format!("Initializing core AI infrastructure onto your machine... {percent}%"),
                );
            }
        }
    }
    file.shutdown().await.ok();

    emit("extracting", 99, "Extracting core AI infrastructure...".into());

    // Extracting is CPU/disk bound, so run it in a blocking thread.
    let zip_path_clone = zip_path.clone();
    let data_dir_clone = data_dir.clone();
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let file = std::fs::File::open(&zip_path_clone).map_err(|e| e.to_string())?;
        let mut archive =
            zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;

        let total_files = archive.len();
        for i in 0..total_files {
            let mut file_in = archive.by_index(i).map_err(|e| e.to_string())?;
            let outpath = data_dir_clone.join(file_in.mangled_name());

            if file_in.is_dir() {
                std::fs::create_dir_all(&outpath).map_err(|e| e.to_string())?;
            } else {
                if let Some(parent) = outpath.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let mut outfile = std::fs::File::create(&outpath).map_err(|e| e.to_string())?;
                std::io::copy(&mut file_in, &mut outfile).map_err(|e| e.to_string())?;
            }

            let percent = (((i + 1) * 100) / total_files) as u32;
            let _ = app_clone.emit(
                "ollama-download-progress",
                OllamaDownloadProgress {
                    stage: "extracting",
                    percent,
                    message: format!("Extracting core AI infrastructure... {percent}%"),
                },
            );
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Extraction task failed: {e}"))??;

    // Clean up the archive to save disk space.
    tokio::fs::remove_file(&zip_path).await.ok();

    emit("complete", 100, "Core AI infrastructure ready.".into());
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![fetch_market_data, read_journal, write_journal, ensure_ollama_running, download_ollama])
        .setup(|app| {
            // Resolve the directory where Tauri unpacks bundled resources.
            // In production this is the install prefix (e.g. C:\Program Files\OpenRewind\).
            // In dev mode it falls back to the src-tauri/ directory.
            let resource_dir = app
                .path()
                .resource_dir()
                .expect("Failed to resolve Tauri resource directory");

            // Spawn the C++ engine as a sidecar child process.
            // Tauri resolves "openrewind-engine" →
            //   binaries/openrewind-engine-<target-triple>[.exe]
            // automatically for the current platform.
            // Build the absolute path to the bundled data/ directory and pass
            // it to the engine via env var. This is more reliable than relying
            // on CWD, which Windows can set to System32 for installed apps.
            let data_dir = resource_dir.join("data");

            let (_rx, child) = app
                .shell()
                .sidecar("openrewind-engine")
                .expect("openrewind-engine sidecar not found — run the CMake build first")
                .env("OPENREWIND_DATA_DIR", data_dir.to_string_lossy().as_ref())
                .spawn()
                .expect("Failed to spawn openrewind-engine sidecar");

            // Keep the child alive for the entire app lifetime by storing it
            // in Tauri managed state. Dropping it would kill the process.
            app.manage(EngineProcess(child));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenRewind");
}
