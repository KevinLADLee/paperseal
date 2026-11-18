#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use seal_core::{Mark, Page, Placement};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};
use tauri::State;

struct Source {
    path: PathBuf,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct Session {
    next: AtomicU32,
    documents: Mutex<HashMap<u32, Arc<Source>>>,
    output_dir: Mutex<Option<PathBuf>>,
    last_saved_dir: Mutex<Option<PathBuf>>,
}

#[derive(Serialize)]
struct Opened {
    id: u32,
    name: String,
    data: String,
    path: String,
}

#[tauri::command]
async fn open_pdf(session: State<'_, Session>) -> Result<Option<Opened>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("打开 PDF")
        .add_filter("PDF", &["pdf"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_owned();
    let bytes = tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || fs::read(path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("读取失败：{e}"))?;
    let id = session.next.fetch_add(1, Ordering::Relaxed);
    let opened = Opened {
        id,
        name: file.file_name(),
        data: STANDARD.encode(&bytes),
        path: path.to_string_lossy().into_owned(),
    };
    session
        .documents
        .lock()
        .unwrap()
        .insert(id, Arc::new(Source { path, bytes }));
    Ok(Some(opened))
}

#[tauri::command]
fn close_pdf(id: u32, session: State<'_, Session>) {
    session.documents.lock().unwrap().remove(&id);
}

#[tauri::command]
fn plan(pages: Vec<Page>, marks: Vec<Mark>) -> Result<Vec<Placement>, String> {
    seal_core::layout(&pages, &marks).map_err(|e| e.to_string())
}

#[tauri::command]
async fn choose_output_dir(session: State<'_, Session>) -> Result<Option<String>, String> {
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("选择盖章副本保存目录")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let path = folder.path().to_path_buf();
    let display = path.to_string_lossy().into_owned();
    *session.output_dir.lock().unwrap() = Some(path);
    Ok(Some(display))
}

fn save_new_copy(
    mut temp: tempfile::NamedTempFile,
    dir: &std::path::Path,
    stem: &str,
) -> Result<PathBuf, String> {
    for number in 1u32.. {
        let name = if number == 1 {
            format!("{stem}_已盖章.pdf")
        } else {
            format!("{stem}_已盖章 ({number}).pdf")
        };
        let path = dir.join(name);
        match temp.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => temp = e.file,
            Err(e) => return Err(format!("保存失败：{}", e.error)),
        }
    }
    Err("无法分配副本文件名".into())
}

#[tauri::command]
async fn save_copy(
    id: u32,
    pages: Vec<Page>,
    marks: Vec<Mark>,
    assets: Vec<String>,
    options: Option<seal_core::OutputOptions>,
    raster: Option<Vec<String>>,
    destination: Option<String>,
    session: State<'_, Session>,
) -> Result<Option<String>, String> {
    let source = session
        .documents
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("请重新打开源文件")?;
    let parent = source.path.parent().ok_or("无法确定文件目录")?;
    let stem = source
        .path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy();
    let stem = stem.into_owned();
    let auto_dir = match destination.as_deref() {
        Some("source") => Some(parent.to_path_buf()),
        Some("folder") => Some(
            session
                .output_dir
                .lock()
                .unwrap()
                .clone()
                .ok_or("请先选择保存目录")?,
        ),
        Some("dialog") | None => None,
        _ => return Err("保存位置无效".into()),
    };
    let path = if let Some(ref dir) = auto_dir {
        dir.join(format!("{stem}_已盖章.pdf"))
    } else {
        let Some(file) = rfd::AsyncFileDialog::new()
            .set_directory(parent)
            .set_file_name(format!("{stem}_已盖章.pdf"))
            .set_title("保存盖章副本")
            .add_filter("PDF", &["pdf"])
            .save_file()
            .await
        else {
            return Ok(None);
        };
        let mut path = file.path().to_owned();
        if path.extension().is_none() {
            path.set_extension("pdf");
            if path.exists() {
                return Err("同名 PDF 已存在，请在保存对话框中选中该文件确认替换".into());
            }
        }
        if !path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
        {
            return Err("请使用 .pdf 扩展名".into());
        }
        path
    };
    let saved = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
        if auto_dir.is_none()
            && path.exists()
            && same_file::is_same_file(&source.path, &path).map_err(|e| e.to_string())?
        {
            return Err("请选择其他文件名，原始 PDF 需要保留".into());
        }
        let images = assets
            .iter()
            .map(|v| STANDARD.decode(v))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "图片数据无效")?;
        let jpegs = raster
            .map(|items| {
                items
                    .into_iter()
                    .map(|item| STANDARD.decode(item))
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()
            .map_err(|_| "图片页数据无效")?;
        let bytes = seal_core::export_copy(
            &source.bytes,
            &pages,
            &marks,
            &images,
            &options.unwrap_or_default(),
            jpegs.as_deref(),
        )
        .map_err(|e| format!("{e:#}"))?;
        let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("保存目录无效")?)
            .map_err(|e| e.to_string())?;
        temp.write_all(&bytes)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        if let Some(dir) = auto_dir {
            return save_new_copy(temp, &dir, &stem);
        }
        temp.persist(&path)
            .map_err(|e| format!("保存失败，请检查文件是否正被占用：{e}"))?;
        Ok(path)
    })
    .await
    .map_err(|e| e.to_string())??;
    *session.last_saved_dir.lock().unwrap() = saved.parent().map(|dir| dir.to_owned());
    Ok(Some(saved.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn open_output_folder(session: State<'_, Session>) -> Result<(), String> {
    let dir = session
        .last_saved_dir
        .lock()
        .unwrap()
        .clone()
        .ok_or("请先保存一份盖章副本")?;
    tauri::async_runtime::spawn_blocking(move || {
        if !dir.is_dir() {
            return Err(format!("输出文件夹不存在或无法访问：{}", dir.display()));
        }
        open_folder(&dir).map_err(|e| format!("无法打开输出文件夹 {}：{e}", dir.display()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "windows")]
fn open_folder(dir: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn open_folder(dir: &std::path::Path) -> Result<(), String> {
    use gio::prelude::*;
    if gio::AppInfo::default_for_type("inode/directory", false).is_none()
        && std::env::var_os("WSL_DISTRO_NAME").is_some()
    {
        // Minimal WSL installations can have WSLg but no Linux file manager.
        let path = std::process::Command::new("wslpath")
            .arg("-w")
            .arg(dir)
            .output()
            .map_err(|e| e.to_string())?;
        if !path.status.success() {
            return Err("无法转换 WSL 文件夹路径".into());
        }
        let win_path = std::str::from_utf8(&path.stdout)
            .map_err(|e| e.to_string())?
            .trim_end_matches(['\r', '\n']);
        let mut child = std::process::Command::new("explorer.exe")
            .arg(win_path)
            .spawn()
            .map_err(|e| e.to_string())?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        return Ok(());
    }
    let uri = gio::File::for_path(dir).uri();
    gio::AppInfo::launch_default_for_uri(&uri, None::<&gio::AppLaunchContext>)
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(Session::default())
        .invoke_handler(tauri::generate_handler![
            open_pdf,
            close_pdf,
            plan,
            save_copy,
            choose_output_dir,
            open_output_folder
        ])
        .run(tauri::generate_context!())
        .expect("启动纸印失败");
}
