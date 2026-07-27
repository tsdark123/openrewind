use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct EngineProcess(CommandChild);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![fetch_market_data])
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

            // Open the WebView inspector automatically so network/console
            // errors are visible in the release build during debugging.
            // Remove this block once the production issue is resolved.
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenRewind");
}
