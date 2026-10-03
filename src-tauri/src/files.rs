use std::{path::Path, pin::Pin, time::UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use russh_sftp::{
    client::error::Error as SftpError,
    protocol::{OpenFlags, StatusCode},
};
use tokio::{
    fs,
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, SeekFrom},
};

use crate::{
    connection::Endpoint,
    models::{DirectoryListing, FileEntry, Preview},
};

pub type Reader = Pin<Box<dyn AsyncRead + Send>>;
pub type Writer = Pin<Box<dyn AsyncWrite + Send>>;

#[derive(Clone)]
pub struct FileInfo {
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_file: bool,
    pub size: u64,
    pub modified: Option<u64>,
}

pub fn validate_name(name: &str, local: bool) -> Result<()> {
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
        bail!("文件名含有无效路径字符：{name}");
    }
    if local && cfg!(windows) {
        let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'));
        if reserved
            || name.contains(['<', '>', ':', '"', '|', '?', '*'])
            || name.ends_with(['.', ' '])
            || name.chars().any(|c| c < ' ')
        {
            bail!("目标 Windows 文件系统不支持此文件名：{name}");
        }
    }
    Ok(())
}

fn local_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn path_text(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("路径包含无法显示的非 UTF-8 字符"))
}

impl Endpoint {
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local)
    }

    pub fn join(&self, parent: &str, name: &str) -> Result<String> {
        validate_name(name, self.is_local())?;
        match self {
            Self::Local => path_text(&Path::new(parent).join(name)),
            Self::Remote(_) => Ok(format!("{}/{name}", parent.trim_end_matches('/'))),
        }
    }

    pub fn basename(&self, path: &str) -> Result<String> {
        let name = match self {
            Self::Local => Path::new(path).file_name().and_then(|s| s.to_str()),
            Self::Remote(_) => path.trim_end_matches('/').rsplit('/').next(),
        }
        .ok_or_else(|| anyhow!("不能传输文件系统根目录"))?;
        validate_name(name, false)?;
        Ok(name.to_owned())
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String> {
        match self {
            Self::Local => {
                let canonical = fs::canonicalize(path).await.context("无法访问本机路径")?;
                let value = path_text(&canonical)?;
                #[cfg(windows)]
                {
                    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
                        return Ok(format!(r"\\{unc}"));
                    }
                    if let Some(normal) = value.strip_prefix(r"\\?\") {
                        return Ok(normal.to_owned());
                    }
                }
                Ok(value)
            }
            Self::Remote(remote) => remote
                .sftp
                .canonicalize(path)
                .await
                .context("无法访问远程路径"),
        }
    }

    pub async fn metadata(&self, path: &str) -> Result<FileInfo> {
        match self {
            Self::Local => {
                let meta = fs::symlink_metadata(path)
                    .await
                    .with_context(|| format!("无法读取文件信息：{path}"))?;
                Ok(FileInfo {
                    is_dir: meta.is_dir(),
                    is_symlink: local_link(&meta),
                    is_file: meta.is_file(),
                    size: meta.len(),
                    modified: meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64),
                })
            }
            Self::Remote(remote) => {
                let meta = remote
                    .sftp
                    .symlink_metadata(path)
                    .await
                    .with_context(|| format!("无法读取远程文件信息：{path}"))?;
                let kind = meta.file_type();
                Ok(FileInfo {
                    is_dir: kind.is_dir(),
                    is_symlink: kind.is_symlink(),
                    is_file: kind.is_file(),
                    size: meta.size.unwrap_or(0),
                    modified: meta.mtime.map(|t| u64::from(t) * 1000),
                })
            }
        }
    }

    pub async fn exists(&self, path: &str) -> Result<bool> {
        match self {
            Self::Local => match fs::symlink_metadata(path).await {
                Ok(_) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(e.into()),
            },
            Self::Remote(remote) => match remote.sftp.symlink_metadata(path).await {
                Ok(_) => Ok(true),
                Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
                    Ok(false)
                }
                Err(e) => Err(e.into()),
            },
        }
    }

    pub async fn children(&self, path: &str) -> Result<Vec<FileEntry>> {
        let mut entries = Vec::new();
        match self {
            Self::Local => {
                let mut directory = fs::read_dir(path).await.context("无法读取本机目录")?;
                while let Some(entry) = directory.next_entry().await? {
                    let name = entry
                        .file_name()
                        .into_string()
                        .map_err(|_| anyhow!("目录含有无法显示的非 UTF-8 文件名"))?;
                    let path = path_text(&entry.path())?;
                    let meta = self.metadata(&path).await?;
                    entries.push(FileEntry {
                        name,
                        path,
                        is_dir: meta.is_dir && !meta.is_symlink,
                        is_symlink: meta.is_symlink,
                        size: meta.size,
                        modified: meta.modified,
                    });
                }
            }
            Self::Remote(remote) => {
                for entry in remote
                    .sftp
                    .read_dir(path)
                    .await
                    .context("无法读取远程目录")?
                {
                    let name = entry.file_name();
                    validate_name(&name, false)?;
                    let meta = entry.metadata();
                    let kind = meta.file_type();
                    entries.push(FileEntry {
                        path: self.join(path, &name)?,
                        name,
                        is_dir: kind.is_dir(),
                        is_symlink: kind.is_symlink(),
                        size: meta.size.unwrap_or(0),
                        modified: meta.mtime.map(|t| u64::from(t) * 1000),
                    });
                }
            }
        }
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    pub async fn list(&self, path: &str) -> Result<DirectoryListing> {
        let path = self.canonicalize(path).await?;
        let parent = if self.is_local() {
            Path::new(&path)
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .map(path_text)
                .transpose()?
        } else if path == "/" {
            None
        } else {
            Some(
                path.rsplit_once('/')
                    .map(|(p, _)| if p.is_empty() { "/" } else { p })
                    .unwrap_or("/")
                    .to_owned(),
            )
        };
        let entries = self.children(&path).await?;
        Ok(DirectoryListing {
            path,
            parent,
            entries,
        })
    }

    pub async fn open_read(&self, path: &str) -> Result<Reader> {
        let meta = self.metadata(path).await?;
        if meta.is_symlink || !meta.is_file {
            bail!("仅支持普通文件，符号链接和特殊文件不会被读取：{path}");
        }
        match self {
            Self::Local => Ok(Box::pin(fs::File::open(path).await?)),
            Self::Remote(remote) => Ok(Box::pin(remote.sftp.open(path).await?)),
        }
    }

    /// Reads `length` bytes starting at `offset`; used for formats such as Parquet
    /// whose metadata lives at the end of the file.
    pub async fn read_range(&self, path: &str, offset: u64, length: u64) -> Result<Vec<u8>> {
        const RANGE_LIMIT: u64 = 64 * 1024 * 1024;
        if length > RANGE_LIMIT {
            bail!("单次读取超过 64 MiB 预览上限");
        }
        let meta = self.metadata(path).await?;
        if meta.is_symlink || !meta.is_file {
            bail!("仅支持普通文件，符号链接和特殊文件不会被读取：{path}");
        }
        if offset > meta.size {
            bail!("读取位置超出文件末尾");
        }
        let length = length.min(meta.size - offset);
        let mut bytes = Vec::with_capacity(length as usize);
        match self {
            Self::Local => {
                let mut file = fs::File::open(path).await?;
                file.seek(SeekFrom::Start(offset)).await?;
                file.take(length).read_to_end(&mut bytes).await?;
            }
            Self::Remote(remote) => {
                let mut file = remote.sftp.open(path).await?;
                file.seek(SeekFrom::Start(offset)).await?;
                file.take(length).read_to_end(&mut bytes).await?;
            }
        }
        Ok(bytes)
    }

    pub async fn create_exclusive(&self, path: &str) -> Result<Writer> {
        match self {
            Self::Local => Ok(Box::pin(
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(path)
                    .await?,
            )),
            Self::Remote(remote) => Ok(Box::pin(
                remote
                    .sftp
                    .open_with_flags(
                        path,
                        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                    )
                    .await?,
            )),
        }
    }

    pub async fn mkdir(&self, path: &str) -> Result<()> {
        match self {
            Self::Local => fs::create_dir(path).await.map_err(Into::into),
            Self::Remote(remote) => remote.sftp.create_dir(path).await.map_err(Into::into),
        }
    }

    pub async fn remove_file(&self, path: &str) -> Result<()> {
        match self {
            Self::Local => fs::remove_file(path).await.map_err(Into::into),
            Self::Remote(remote) => remote.sftp.remove_file(path).await.map_err(Into::into),
        }
    }

    pub async fn remove_dir(&self, path: &str) -> Result<()> {
        match self {
            Self::Local => fs::remove_dir(path).await.map_err(Into::into),
            Self::Remote(remote) => remote.sftp.remove_dir(path).await.map_err(Into::into),
        }
    }

    pub async fn commit_file(&self, partial: &str, target: &str) -> Result<()> {
        match self {
            Self::Local => {
                // Hard-link publication is atomic and refuses an existing destination on every supported OS.
                fs::hard_link(partial, target)
                    .await
                    .context("目标已存在或文件系统不支持安全提交，未覆盖任何文件")?;
                if let Err(error) = fs::remove_file(partial).await {
                    let _ = fs::remove_file(target).await;
                    return Err(error.into());
                }
                Ok(())
            }
            Self::Remote(remote) => {
                if self.exists(target).await? {
                    bail!("目标已存在，未覆盖：{target}");
                }
                // SSH_FXP_RENAME (SFTP v3) must fail if the destination exists; never use posix-rename.
                remote
                    .sftp
                    .rename(partial, target)
                    .await
                    .context("远程文件提交失败，未请求覆盖目标")
            }
        }
    }
}

fn image_mime(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if data.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        Some("image/webp")
    } else if data.starts_with(b"BM") {
        Some("image/bmp")
    } else {
        None
    }
}

pub async fn preview(endpoint: &Endpoint, path: &str) -> Result<Preview> {
    const TEXT_LIMIT: usize = 256 * 1024;
    const IMAGE_LIMIT: usize = 8 * 1024 * 1024;
    let meta = endpoint.metadata(path).await?;
    let mut reader = endpoint.open_read(path).await?;
    let mut prefix = vec![0; 16];
    let mut count = 0;
    while count < prefix.len() {
        let read = reader.read(&mut prefix[count..]).await?;
        if read == 0 {
            break;
        }
        count += read;
    }
    prefix.truncate(count);
    let mime = image_mime(&prefix);
    let limit = if mime.is_some() {
        IMAGE_LIMIT
    } else {
        TEXT_LIMIT
    };
    let mut bytes = prefix;
    reader
        .take((limit + 1 - bytes.len()) as u64)
        .read_to_end(&mut bytes)
        .await?;
    let truncated = bytes.len() > limit || meta.size > limit as u64;
    bytes.truncate(limit);
    if let Some(mime) = mime {
        return Ok(if truncated {
            Preview {
                kind: "unsupported".into(),
                content: "图片超过 8 MiB 预览上限".into(),
                mime: mime.into(),
                truncated: true,
                size: meta.size,
            }
        } else {
            Preview {
                kind: "image".into(),
                content: STANDARD.encode(bytes),
                mime: mime.into(),
                truncated: false,
                size: meta.size,
            }
        });
    }
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => Some(text),
        Err(error) if truncated && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()]).ok()
        }
        Err(_) => None,
    };
    if let Some(text) = text.filter(|text| {
        !text
            .chars()
            .any(|c| c == '\0' || (c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{feff}')))
    }) {
        Ok(Preview {
            kind: "text".into(),
            content: text.into(),
            mime: "text/plain".into(),
            truncated,
            size: meta.size,
        })
    } else {
        Ok(Preview {
            kind: "unsupported".into(),
            content: "暂不支持此二进制文件预览，可先传输到本机".into(),
            mime: "application/octet-stream".into(),
            truncated: false,
            size: meta.size,
        })
    }
}
