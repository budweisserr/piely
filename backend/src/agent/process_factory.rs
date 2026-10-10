//! Finding and starting the sidecar process. Dev builds run it from source,
//! release builds run the bundled binary; both can be overridden with
//! `PIELY_AGENT_PATH` and `PIELY_NODE_BIN`.
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{AppHandle, Manager};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

pub(super) fn find_node_bin() -> String {
    if let Ok(node) = env::var("PIELY_NODE_BIN") {
        return node;
    }
    for path in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/bun",
        "/usr/local/bin/bun",
        "/usr/bin/node",
        "/usr/bin/bun",
    ] {
        if Path::new(path).exists() {
            return path.to_string();
        }
    }
    if let Ok(home) = env::var("HOME") {
        let bun_path = PathBuf::from(home).join(".bun/bin/bun");
        if bun_path.exists() {
            return bun_path.to_string_lossy().into_owned();
        }
    }
    "node".to_string()
}

pub(super) fn agent_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("PIELY_AGENT_PATH") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Ok(p);
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        for candidate in ["piely-agent/agent.mjs", "agent.mjs"] {
            let p = dir.join(candidate);
            if p.exists() {
                return Ok(p);
            }
        }
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        for candidate in [
            "piely-agent/agent.mjs",
            "agent.mjs",
            "../Resources/piely-agent/agent.mjs",
            "../Resources/agent.mjs",
        ] {
            let p = dir.join(candidate);
            if p.exists() {
                return Ok(p);
            }
        }
    }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../piely-agent/agent.mjs");
    if dev_path.exists() {
        return Ok(dev_path);
    }
    Err("piely-agent/agent.mjs not found. Ensure piely-agent is installed or set PIELY_AGENT_PATH.".to_string())
}

/// The sidecar as (program, args before --auth-file), in order of preference:
/// 1. `PIELY_AGENT_PATH` (a binary, or a .mjs run with node)
/// 2. the bundled resource (tauri copies it verbatim; `externalBin` would
///    rpath-patch it and break the bun-compiled ELF)
/// 3. next to the app executable (the old externalBin layout)
/// 4. `piely-agent/bin` (dev build)
/// 5. `agent.mjs` with node
pub(super) fn agent_command(app: &AppHandle) -> Result<(String, Vec<String>), String> {
    if let Ok(path) = env::var("PIELY_AGENT_PATH") {
        let is_js = std::path::Path::new(&path)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("mjs") || ext.eq_ignore_ascii_case("js"));
        if is_js {
            let node = find_node_bin();
            return Ok((node, vec![path]));
        }
        return Ok((path, vec![]));
    }

    // Dev runs the sidecar from source: the compiled binary in the build tree
    // goes stale without saying so. `PIELY_AGENT_PATH` forces the binary.
    #[cfg(debug_assertions)]
    {
        if let Ok(path) = agent_path(app) {
            let node = find_node_bin();
            return Ok((node, vec![path.to_string_lossy().into_owned()]));
        }
    }

    // Release: the bundled resource is always named "piely-agent"
    // (tauri.conf.json); on Windows dev machines bun may also emit piely-agent.exe.
    let candidates = ["piely-agent", "piely-agent.exe"];
    if let Ok(dir) = app.path().resource_dir() {
        for name in candidates {
            let resource = dir.join(name);
            if resource.exists() {
                // squashfs (AppImage) may drop the exec bit; make sure we can run it
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&resource, std::fs::Permissions::from_mode(0o755));
                }
                return Ok((resource.to_string_lossy().into_owned(), vec![]));
            }
        }
    }
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        for name in candidates {
            let bundled = dir.join(name);
            if bundled.exists() {
                return Ok((bundled.to_string_lossy().into_owned(), vec![]));
            }
        }
    }
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../piely-agent/bin");
    for name in ["piely-agent", "piely-agent.exe"] {
        let dev_bin = dev_dir.join(name);
        if dev_bin.exists() {
            return Ok((dev_bin.to_string_lossy().into_owned(), vec![]));
        }
    }
    let node = find_node_bin();
    Ok((node, vec![agent_path(app)?.to_string_lossy().into_owned()]))
}

pub(super) fn auth_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    Ok(dir.join("piely-auth.json"))
}

pub(super) fn spawn_agent(app: &AppHandle) -> Result<(Child, ChildStdin, ChildStdout), String> {
    let (program, args) = agent_command(app)?;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .arg("--auth-file")
        .arg(auth_file(app)?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    cmd.kill_on_drop(true); // never leave an orphaned sidecar
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never pop a console window for the sidecar.
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start piely agent (node + pi-ai required): {}", e))?;
    let stdin = child.stdin.take().ok_or_else(|| "No agent stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "No agent stdout".to_string())?;
    Ok((child, stdin, stdout))
}
