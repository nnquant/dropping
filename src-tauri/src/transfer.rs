use std::{
    future::Future,
    time::{Duration, Instant},
};

use anyhow::{anyhow, bail, Context, Result};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::{
    connection::Endpoint,
    files::{validate_name, FileInfo},
    models::{TransferProgress, TransferResult},
};

struct PlannedEntry {
    source: String,
    relative: Vec<String>,
    info: FileInfo,
}

fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        bail!("传输已取消");
    }
    Ok(())
}

async fn cancellable<T>(
    cancel: &CancellationToken,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    tokio::select! {
        _ = cancel.cancelled() => Err(anyhow!("传输已取消")),
        result = future => result,
    }
}

async fn plan(
    source: &Endpoint,
    path: &str,
    destination: &Endpoint,
    cancel: &CancellationToken,
) -> Result<Vec<PlannedEntry>> {
    let mut pending = vec![(path.to_owned(), Vec::<String>::new())];
    let mut entries = Vec::new();
    while let Some((path, relative)) = pending.pop() {
        check_cancel(cancel)?;
        if relative.len() > 64 || entries.len() >= 100_000 {
            bail!("目录超过 64 层或 100,000 项，请分批传输");
        }
        let info = cancellable(cancel, source.metadata(&path)).await?;
        if info.is_symlink {
            bail!("目录包含符号链接，为避免跨目录读取，已停止传输：{path}");
        }
        if !info.is_dir && !info.is_file {
            bail!("暂不支持传输设备、套接字等特殊文件：{path}");
        }
        if info.is_dir {
            for child in cancellable(cancel, source.children(&path))
                .await?
                .into_iter()
                .rev()
            {
                validate_name(&child.name, destination.is_local())?;
                let mut child_relative = relative.clone();
                child_relative.push(child.name);
                pending.push((child.path, child_relative));
            }
        }
        entries.push(PlannedEntry {
            source: path,
            relative,
            info,
        });
    }
    Ok(entries)
}

fn target_path(destination: &Endpoint, root: &str, relative: &[String]) -> Result<String> {
    relative.iter().try_fold(root.to_owned(), |parent, name| {
        destination.join(&parent, name)
    })
}

pub async fn run<F>(
    id: &str,
    source: &Endpoint,
    destination: &Endpoint,
    source_path: &str,
    destination_directory: &str,
    cancel: &CancellationToken,
    emit: F,
) -> Result<TransferResult>
where
    F: Fn(&TransferProgress) + Send + Sync,
{
    let mut progress = TransferProgress {
        id: id.into(),
        status: "running".into(),
        bytes_transferred: 0,
        total_bytes: 0,
        files_transferred: 0,
        total_files: 0,
        current_file: "正在检查文件…".into(),
        error: None,
    };
    emit(&progress);
    // Only paths created by this task are recorded; cleanup never recursively deletes a user directory.
    let mut created: Vec<(String, bool)> = Vec::new();
    let result = async {
        check_cancel(cancel)?;
        let initial = cancellable(cancel, source.metadata(source_path)).await?;
        if initial.is_symlink {
            bail!("不支持传输符号链接");
        }
        let source_path = cancellable(cancel, source.canonicalize(source_path)).await?;
        let destination_directory =
            cancellable(cancel, destination.canonicalize(destination_directory)).await?;
        let destination_info =
            cancellable(cancel, destination.metadata(&destination_directory)).await?;
        if !destination_info.is_dir || destination_info.is_symlink {
            bail!("目标必须是普通目录");
        }
        let name = source.basename(&source_path)?;
        let target = destination.join(&destination_directory, &name)?;
        if cancellable(cancel, destination.exists(&target)).await? {
            bail!("目标已存在，未覆盖：{target}");
        }
        if source.same_endpoint(destination) && initial.is_dir {
            let normalized_source = source_path
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_owned();
            let normalized_destination = destination_directory.replace('\\', "/");
            let (normalized_source, normalized_destination) = if source.is_local() && cfg!(windows)
            {
                (
                    normalized_source.to_lowercase(),
                    normalized_destination.to_lowercase(),
                )
            } else {
                (normalized_source, normalized_destination)
            };
            if normalized_destination == normalized_source
                || normalized_destination.starts_with(&format!("{normalized_source}/"))
            {
                bail!("不能把目录传入它自身或它的子目录");
            }
        }
        let entries = plan(source, &source_path, destination, cancel).await?;
        progress.total_files = entries.iter().filter(|entry| entry.info.is_file).count() as u64;
        progress.total_bytes =
            entries
                .iter()
                .filter(|entry| entry.info.is_file)
                .try_fold(0u64, |sum, entry| {
                    sum.checked_add(entry.info.size)
                        .ok_or_else(|| anyhow!("传输总大小超出支持范围"))
                })?;
        emit(&progress);
        let mut last_emit = Instant::now();
        let mut buffer = vec![0u8; 256 * 1024];
        for entry in entries {
            check_cancel(cancel)?;
            let target = target_path(destination, &target, &entry.relative)?;
            if entry.info.is_dir {
                destination
                    .mkdir(&target)
                    .await
                    .with_context(|| format!("无法创建目录（已有目录不会合并）：{target}"))?;
                created.push((target, true));
                continue;
            }
            progress.current_file = entry.source.clone();
            emit(&progress);
            let parent = if destination.is_local() {
                std::path::Path::new(&target)
                    .parent()
                    .and_then(|p| p.to_str())
                    .ok_or_else(|| anyhow!("无效目标路径"))?
                    .to_owned()
            } else {
                target
                    .rsplit_once('/')
                    .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
                    .unwrap_or("/")
                    .to_owned()
            };
            let partial =
                destination.join(&parent, &format!(".dropping-{}.part", uuid::Uuid::new_v4()))?;
            let mut input = cancellable(cancel, source.open_read(&entry.source)).await?;
            let mut output = destination
                .create_exclusive(&partial)
                .await
                .context("无法创建临时传输文件")?;
            created.push((partial.clone(), false));
            let mut bytes = 0u64;
            let copy_result: Result<()> = async {
                loop {
                    let count = tokio::select! {
                        _ = cancel.cancelled() => { bail!("传输已取消"); }
                        value = input.read(&mut buffer) => value?,
                    };
                    if count == 0 {
                        break;
                    }
                    check_cancel(cancel)?;
                    tokio::select! {
                        _ = cancel.cancelled() => { bail!("传输已取消"); }
                        result = output.write_all(&buffer[..count]) => result?,
                    }
                    bytes += count as u64;
                    progress.bytes_transferred += count as u64;
                    if bytes > entry.info.size {
                        bail!("源文件在传输中增大，请等待写入结束后重试：{}", entry.source);
                    }
                    if last_emit.elapsed() >= Duration::from_millis(100) {
                        emit(&progress);
                        last_emit = Instant::now();
                    }
                }
                tokio::select! {
                    _ = cancel.cancelled() => { bail!("传输已取消"); }
                    result = async { output.flush().await?; output.shutdown().await } => result?,
                }
                Ok(())
            }
            .await;
            drop(input);
            drop(output);
            copy_result?;
            check_cancel(cancel)?;
            let after = cancellable(cancel, source.metadata(&entry.source)).await?;
            if bytes != entry.info.size
                || after.size != entry.info.size
                || after.modified != entry.info.modified
                || after.is_symlink
            {
                bail!(
                    "源文件在传输中发生变化，请等待写入结束后重试：{}",
                    entry.source
                );
            }
            destination.commit_file(&partial, &target).await?;
            created.pop();
            created.push((target, false));
            progress.files_transferred += 1;
            emit(&progress);
        }
        check_cancel(cancel)?;
        Ok(TransferResult {
            target_path: target,
            bytes: progress.bytes_transferred,
            files: progress.files_transferred,
        })
    }
    .await;
    match result {
        Ok(result) => {
            progress.status = "completed".into();
            emit(&progress);
            Ok(result)
        }
        Err(error) => {
            let mut leftovers = Vec::new();
            let mut leftover_count = 0usize;
            let cleanup_deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            for (path, directory) in created.into_iter().rev() {
                let cleaned = tokio::time::timeout_at(cleanup_deadline, async {
                    if directory {
                        destination.remove_dir(&path).await
                    } else {
                        destination.remove_file(&path).await
                    }
                })
                .await;
                if !matches!(cleaned, Ok(Ok(()))) {
                    leftover_count += 1;
                    if leftovers.len() < 8 {
                        leftovers.push(path);
                    }
                }
            }
            let message = if leftovers.is_empty() {
                format!("{error:#}")
            } else {
                format!(
                    "{error:#}；{leftover_count} 项临时文件清理失败，请检查：{}",
                    leftovers.join("、")
                )
            };
            progress.status = if cancel.is_cancelled() {
                "cancelled"
            } else {
                "failed"
            }
            .into();
            progress.error = Some(message.clone());
            emit(&progress);
            Err(anyhow!(message))
        }
    }
}
