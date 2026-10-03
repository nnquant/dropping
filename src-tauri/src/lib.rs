mod connection;
mod files;
mod models;
mod ssh_config;
mod transfer;

use connection::{ActiveTransfer, AppState};
use models::*;
use tauri::{Emitter, State};
use tokio_util::sync::CancellationToken;

fn display_error(error: anyhow::Error) -> String {
    format!("{error:#}")
}

#[tauri::command]
fn get_local_info() -> Result<Connection, String> {
    connection::local_info().map_err(display_error)
}

#[tauri::command]
async fn get_ssh_config_hosts() -> Result<ssh_config::SshConfigHosts, String> {
    tokio::task::spawn_blocking(ssh_config::read_default)
        .await
        .map_err(|error| format!("读取 SSH 配置失败：{error}"))?
        .map_err(display_error)
}

#[tauri::command]
async fn probe_ssh(host: String, port: u16) -> Result<HostKey, String> {
    connection::probe(&host, port).await.map_err(display_error)
}

#[tauri::command]
async fn connect_ssh(
    state: State<'_, AppState>,
    config: ConnectConfig,
) -> Result<Connection, String> {
    connection::connect(&state, config)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>, connection_id: String) -> Result<(), String> {
    connection::disconnect(&state, &connection_id)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn list_directory(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<DirectoryListing, String> {
    state
        .endpoint(&connection_id)
        .await
        .map_err(display_error)?
        .list(&path)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn preview_file(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<Preview, String> {
    let endpoint = state
        .endpoint(&connection_id)
        .await
        .map_err(display_error)?;
    files::preview(&endpoint, &path)
        .await
        .map_err(display_error)
}

#[tauri::command]
async fn start_transfer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    source_connection_id: String,
    destination_connection_id: String,
    source_path: String,
    destination_directory: String,
) -> Result<TransferResult, String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
    {
        return Err("无效的传输任务编号".into());
    }
    let cancel = CancellationToken::new();
    {
        let mut transfers = state.transfers.lock().await;
        if transfers.contains_key(&id) {
            return Err("任务编号已存在".into());
        }
        transfers.insert(
            id.clone(),
            ActiveTransfer {
                cancel: cancel.clone(),
                source: source_connection_id.clone(),
                destination: destination_connection_id.clone(),
            },
        );
    }
    let result = async {
        let source = state.endpoint(&source_connection_id).await?;
        let destination = state.endpoint(&destination_connection_id).await?;
        transfer::run(
            &id,
            &source,
            &destination,
            &source_path,
            &destination_directory,
            &cancel,
            |progress| {
                let _ = app.emit("transfer-progress", progress);
            },
        )
        .await
    }
    .await;
    state.transfers.lock().await.remove(&id);
    result.map_err(display_error)
}

#[tauri::command]
async fn cancel_transfer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(task) = state.transfers.lock().await.get(&id) {
        task.cancel.cancel();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_local_info,
            get_ssh_config_hosts,
            probe_ssh,
            connect_ssh,
            disconnect,
            list_directory,
            preview_file,
            start_transfer,
            cancel_transfer
        ])
        .run(tauri::generate_context!())
        .expect("Dropping 启动失败");
}

#[cfg(test)]
mod tests;
