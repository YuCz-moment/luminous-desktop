use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use serde::Serialize;
use tauri::{Manager, RunEvent};

// ---------------- state ----------------
struct ServerState {
    port: Mutex<Option<u16>>,
    ready: Condvar,
    child: Mutex<Option<std::process::Child>>,
}

impl Default for ServerState {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
            ready: Condvar::new(),
            child: Mutex::new(None),
        }
    }
}

#[derive(Serialize, Clone)]
struct ExportResult {
    ok: bool,
    message: Option<String>,
    error: Option<String>,
}

impl ExportResult {
    fn ok(msg: &str) -> Self {
        Self { ok: true, message: Some(msg.into()), error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, message: None, error: Some(msg.into()) }
    }
}

#[derive(Serialize, Clone)]
struct ImportFileResult {
    ok: bool,
    path: Option<String>,
    error: Option<String>,
}

impl ImportFileResult {
    fn ok(path: String) -> Self {
        Self { ok: true, path: Some(path), error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, path: None, error: Some(msg.into()) }
    }
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "export.bin".to_string()
    } else {
        cleaned.to_string()
    }
}

// ---------------- commands ----------------
#[tauri::command]
async fn get_server_info(state: tauri::State<'_, Arc<ServerState>>) -> Result<Option<u16>, String> {
    #[cfg(debug_assertions)]
    {
        // dev: the page itself is served by the beforeDevCommand node server on 4521
        return Ok(Some(4521));
    }
    let st = state.inner().clone();
    let port = tauri::async_runtime::spawn_blocking(move || {
        let mut port = st.port.lock().unwrap();
        let deadline = Instant::now() + Duration::from_secs(25);
        while port.is_none() && Instant::now() < deadline {
            let now = Instant::now();
            let dur = deadline.saturating_duration_since(now);
            let (guard, _timeout) = st.ready.wait_timeout(port, dur).unwrap();
            port = guard;
        }
        *port
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(port)
}

#[tauri::command]
fn export_media_file(
    app: tauri::AppHandle,
    path: String,
    mode: String,
    name: Option<String>,
    preview: Option<String>,
) -> ExportResult {
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return ExportResult::err("临时文件不存在");
    }
    match mode.as_str() {
        "save" => save_to_folder(app, &src, name),
        "copy" => copy_file_to_clipboard(&src),
        "drag" => drag_out(app, &src, preview),
        _ => ExportResult::err("未知导出模式"),
    }
}

#[tauri::command]
fn save_canvas_file(app: tauri::AppHandle, name: String, content: String) -> ExportResult {
    use tauri_plugin_dialog::DialogExt;
    let fp = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter("流光画布", &["json"])
        .blocking_save_file();
    let Some(fp) = fp else { return ExportResult::err("已取消保存"); };
    let path = match fp.into_path() {
        Ok(p) => p,
        Err(e) => return ExportResult::err(format!("无法获取保存路径：{e}")),
    };
    if let Err(e) = std::fs::write(&path, content) {
        return ExportResult::err(format!("写入失败：{e}"));
    }
    ExportResult::ok(&format!("已保存到 {}", path.display()))
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("无效链接".into());
    }
    open::that(&url).map_err(|e| e.to_string())
}
// ---------------- 文档卡片（Word / Excel / PPT / PDF） ----------------
fn office_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败：{e}"))?;
    let dir = base.join("office");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建文档目录失败：{e}"))?;
    Ok(dir)
}

#[tauri::command]
fn import_office_file(app: tauri::AppHandle, tmp_path: String, name: String) -> ImportFileResult {
    let src = PathBuf::from(&tmp_path);
    let src_canon = match src.canonicalize() {
        Ok(p) if p.is_file() => p,
        _ => return ImportFileResult::err("临时文件不存在"),
    };
    // 只接受侧边服务写入 luminous-export 临时目录的文件，防止任意路径移动
    let tmp_root = match std::env::temp_dir().join("luminous-export").canonicalize() {
        Ok(r) => r,
        Err(_) => return ImportFileResult::err("临时目录不可用"),
    };
    if !src_canon.starts_with(&tmp_root) {
        return ImportFileResult::err("非法的临时文件路径");
    }
    let dir = match office_dir(&app) {
        Ok(d) => d,
        Err(e) => return ImportFileResult::err(e),
    };
    let safe = sanitize_file_name(&name);
    let safe: String = safe.chars().take(100).collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dest = dir.join(format!("doc-{stamp}-{safe}"));
    if let Err(e) = std::fs::rename(&src_canon, &dest).or_else(|_| {
        std::fs::copy(&src_canon, &dest)?;
        std::fs::remove_file(&src_canon)
    }) {
        return ImportFileResult::err(format!("导入文档失败：{e}"));
    }
    ImportFileResult::ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("文件不存在或已被移动，请重新拖入".into());
    }
    open::that(&p).map_err(|e| format!("打开失败：{e}"))
}

#[tauri::command]
fn cleanup_office_files(app: tauri::AppHandle, keep: Vec<String>) -> Result<u32, String> {
    let dir = match office_dir(&app) {
        Ok(d) => d,
        Err(_) => return Ok(0),
    };
    let keep_set: HashSet<String> = keep
        .iter()
        .filter_map(|k| std::fs::canonicalize(k).ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let mut removed = 0;
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let Ok(path) = entry.path().canonicalize() else { continue };
        if !keep_set.contains(&path.to_string_lossy().to_string())
            && std::fs::remove_file(&path).is_ok()
        {
            removed += 1;
        }
    }
    Ok(removed)
}

#[tauri::command]
fn window_minimize(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "窗口不存在".to_string())?
        .minimize()
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn window_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or_else(|| "窗口不存在".to_string())?;
    if win.is_maximized().unwrap_or(false) {
        win.unmaximize().map_err(|e| e.to_string())
    } else {
        win.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn window_close(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "窗口不存在".to_string())?
        .close()
        .map_err(|e| e.to_string())
}

// ---------------- save ----------------
fn save_to_folder(app: tauri::AppHandle, src: &Path, name: Option<String>) -> ExportResult {
    use tauri_plugin_dialog::DialogExt;

    let file_name = name
        .filter(|n| !n.trim().is_empty())
        .map(|n| sanitize_file_name(&n))
        .unwrap_or_else(|| {
            src.file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "export.bin".to_string())
        });

    let dialog = app.dialog().file().set_file_name(&file_name);
    let ext = Path::new(&file_name)
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default();
    let dialog = if ext.is_empty() {
        dialog
    } else {
        dialog.add_filter("媒体文件", &[ext.as_str()])
    };

    let picked = match dialog.blocking_save_file() {
        Some(p) => p,
        None => return ExportResult::ok("已取消保存"),
    };
    let dest = match picked {
        tauri_plugin_dialog::FilePath::Path(p) => p,
        tauri_plugin_dialog::FilePath::Url(_) => {
            return ExportResult::err("无法解析保存路径")
        }
    };
    if let Err(e) = std::fs::copy(src, &dest) {
        return ExportResult::err(format!("保存失败：{e}"));
    }
    let _ = std::fs::remove_file(src);
    ExportResult::ok("已保存到文件夹")
}

// ---------------- clipboard (文件复制到系统剪贴板) ----------------
#[cfg(windows)]
fn copy_file_to_clipboard(src: &Path) -> ExportResult {
    copy_to_clipboard(src)
}

#[cfg(not(windows))]
fn copy_file_to_clipboard(_src: &Path) -> ExportResult {
    ExportResult::err("当前系统暂不支持复制文件到剪贴板，可改用「保存到文件夹」")
}

#[cfg(windows)]
fn copy_to_clipboard(src: &Path) -> ExportResult {
    const CF_HDROP: u32 = 15;
    const DROPFILES_SIZE: usize = 20; // pFiles(4) + pt(8) + fNC(4) + fWide(4)

    let tmp_dir = std::env::temp_dir().join("luminous-export");
    if let Err(e) = std::fs::create_dir_all(&tmp_dir) {
        return ExportResult::err(format!("准备剪贴板文件失败：{e}"));
    }
    let file_name = src
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "export.bin".to_string());
    let keep = tmp_dir.join(format!("clip-{}-{}", std::process::id(), file_name));
    if let Err(e) = std::fs::copy(src, &keep) {
        return ExportResult::err(format!("准备剪贴板文件失败：{e}"));
    }

    unsafe {
        use windows_sys::Win32::Foundation::GlobalFree;
        use windows_sys::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

        let wide: Vec<u16> = keep
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .chain(std::iter::once(0))
            .collect();

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return ExportResult::err("无法打开剪贴板");
        }
        if EmptyClipboard() == 0 {
            CloseClipboard();
            return ExportResult::err("无法清空剪贴板");
        }
        let size = DROPFILES_SIZE + wide.len() * 2;
        let h = GlobalAlloc(GMEM_MOVEABLE, size);
        if h.is_null() {
            CloseClipboard();
            return ExportResult::err("剪贴板内存分配失败");
        }
        let ptr = GlobalLock(h) as *mut u8;
        if ptr.is_null() {
            GlobalFree(h);
            CloseClipboard();
            return ExportResult::err("剪贴板内存锁定失败");
        }
        (ptr as *mut u32).write_unaligned(DROPFILES_SIZE as u32);
        (ptr.add(4) as *mut i32).write_unaligned(0); // pt.x
        (ptr.add(8) as *mut i32).write_unaligned(0); // pt.y
        (ptr.add(12) as *mut i32).write_unaligned(0); // fNC
        (ptr.add(16) as *mut i32).write_unaligned(1); // fWide = UTF-16
        std::ptr::copy_nonoverlapping(
            wide.as_ptr() as *const u8,
            ptr.add(DROPFILES_SIZE),
            wide.len() * 2,
        );
        GlobalUnlock(h);
        if SetClipboardData(CF_HDROP, h as _).is_null() {
            GlobalFree(h);
            CloseClipboard();
            return ExportResult::err("写入剪贴板失败");
        }
        CloseClipboard();
    }

    // remove leftovers from previous copies but keep the current one
    if let Ok(entries) = std::fs::read_dir(&tmp_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p != keep {
                let is_clip = p
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with("clip-"))
                    .unwrap_or(false);
                if is_clip {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }

    ExportResult::ok("文件已复制到剪贴板，可粘贴到微信/资源管理器")
}

// ---------------- drag out ----------------
fn drag_out(app: tauri::AppHandle, src: &Path, preview: Option<String>) -> ExportResult {
    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => return ExportResult::err("找不到主窗口"),
    };
    let src_owned = src.to_path_buf();
    let preview_bytes = preview
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());

    match drag::start_drag(
        &window,
        drag::DragItem::Files(vec![src_owned.clone()]),
        match preview_bytes {
            Some(bytes) => drag::Image::Raw(bytes),
            None => drag::Image::Raw(include_bytes!("../icons/32x32.png").to_vec()),
        },
        |_res, _pos| {},
        drag::Options {
            mode: drag::DragMode::Copy,
            ..Default::default()
        },
    ) {
        Ok(()) => {
            let _ = std::fs::remove_file(&src_owned);
            ExportResult::ok("已拖出")
        }
        Err(e) => {
            let _ = std::fs::remove_file(&src_owned);
            ExportResult::err(format!("拖出失败：{e}"))
        }
    }
}

// ---------------- tests ----------------
#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn clipboard_cf_hdrop() {
        let tmp = std::env::temp_dir().join("luminous-clip-test.txt");
        std::fs::write(&tmp, b"hello").unwrap();
        let r = super::copy_to_clipboard(&tmp);
        assert!(r.ok, "copy failed: {:?}", r.error);
        unsafe {
            use windows_sys::Win32::System::DataExchange::{
                CloseClipboard, GetClipboardData, OpenClipboard,
            };
            use windows_sys::Win32::System::Memory::GlobalLock;
            const CF_HDROP: u32 = 15;
            assert!(OpenClipboard(std::ptr::null_mut()) != 0, "open clipboard failed");
            let h = GetClipboardData(CF_HDROP);
            assert!(!h.is_null(), "no CF_HDROP data");
            let ptr = GlobalLock(h) as *const u8;
            assert!(!ptr.is_null());
            let mut chars: Vec<u16> = Vec::new();
            let mut i = 20usize;
            loop {
                let c = *(ptr.add(i) as *const u16);
                if c == 0 {
                    break;
                }
                chars.push(c);
                i += 2;
            }
            let s = String::from_utf16_lossy(&chars);
            println!("clipboard file path: {s}");
            assert!(s.contains("luminous-clip-test.txt"), "unexpected path: {s}");
            CloseClipboard();
        }
    }
}

// ---------------- app ----------------
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(ServerState::default()))
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                let st = app.state::<Arc<ServerState>>();
                let st_arc = st.inner().clone();
                std::thread::spawn(move || {
                    use std::io::BufRead;
                    use std::process::{Command, Stdio};

                    // locate sidecar files (layout varies: dev/release dir vs NSIS _up_ dir)
                    let res_dir = handle.path().resource_dir().ok();
                    let exe_dir = std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
                    let mut node_candidates: Vec<std::path::PathBuf> = Vec::new();
                    let mut server_candidates: Vec<std::path::PathBuf> = Vec::new();
                    for base in [res_dir.as_ref(), exe_dir.as_ref()].into_iter().flatten() {
                        node_candidates.push(base.join("node.exe"));
                        server_candidates.push(base.join("server.js"));
                        server_candidates.push(base.join("_up_").join("server.js"));
                    }
                    let node_exe = match node_candidates.iter().find(|p| p.is_file()) {
                        Some(p) => p.clone(),
                        None => {
                            eprintln!("sidecar node.exe not found");
                            return;
                        }
                    };
                    let server_js = match server_candidates.iter().find(|p| p.is_file()) {
                        Some(p) => p.clone(),
                        None => {
                            eprintln!("sidecar server.js not found");
                            return;
                        }
                    };

                    let mut cmd = Command::new(&node_exe);
                    cmd.arg(&server_js)
                        .env("PORT", "0")
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null())
                        .stdin(Stdio::null());
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                    }

                    let mut child = match cmd.spawn() {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("spawn node sidecar failed: {e}");
                            return;
                        }
                    };

                    // read stdout for LUMINOUS_PORT=<port>; keep pipe open until node exits
                    if let Some(stdout) = child.stdout.take() {
                        let st2 = st_arc.clone();
                        std::thread::spawn(move || {
                            let reader = std::io::BufReader::new(stdout);
                            for line in reader.lines() {
                                let line = match line {
                                    Ok(l) => l,
                                    Err(_) => break,
                                };
                                if let Some(rest) = line.strip_prefix("LUMINOUS_PORT=") {
                                    if let Ok(port) = rest.trim().parse::<u16>() {
                                        let mut p = st2.port.lock().unwrap();
                                        *p = Some(port);
                                        st2.ready.notify_all();
                                    }
                                }
                            }
                        });
                    }

                    {
                        let mut c = st_arc.child.lock().unwrap();
                        *c = Some(child);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_server_info,
            export_media_file,
            save_canvas_file,
            open_url,
            import_office_file,
            open_file,
            cleanup_office_files,
            window_minimize,
            window_toggle_maximize,
            window_close
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let st = app.state::<Arc<ServerState>>();
                if let Some(mut child) = st.inner().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}

