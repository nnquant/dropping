use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};

use serde::Deserialize;
use tokio::fs;
use tokio_util::sync::CancellationToken;

use crate::{
    connection::{self, AppState, Endpoint},
    files,
    models::{ConnectConfig, TransferProgress},
    transfer,
};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work")
            .join(format!("rust-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self, child: &str) -> String {
        self.0.join(child).to_str().unwrap().to_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let work = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("work")
            .canonicalize()
            .unwrap();
        if let Ok(path) = self.0.canonicalize() {
            assert!(path.starts_with(&work) && path != work);
            let _ = std::fs::remove_dir_all(path);
        }
    }
}

#[test]
fn rejects_traversal_and_preserves_chinese_names() {
    for name in ["", ".", "..", "../x", "/x", "a/b", "a\\b", "a\0b"] {
        assert!(files::validate_name(name, false).is_err(), "{name:?}");
    }
    assert!(files::validate_name("回测产物 2026.parquet", true).is_ok());
    if cfg!(windows) {
        for name in ["CON.txt", "a:b", "x.", "x ", "COM1", "a?b"] {
            assert!(files::validate_name(name, true).is_err(), "{name:?}");
        }
    }
}

#[tokio::test]
async fn file_tools_preserve_conflicts_and_move_nested_folders() {
    let scratch = Scratch::new();
    let root = scratch.path("");
    let endpoint = Endpoint::Local;
    let folder = endpoint.create_folder(&root, "研究产物").await.unwrap();
    assert!(endpoint.create_folder(&root, "研究产物").await.is_err());
    assert!(endpoint.create_folder(&root, "../escape").await.is_err());
    fs::write(PathBuf::from(&folder).join("报告.txt"), "结果")
        .await
        .unwrap();
    fs::create_dir(PathBuf::from(&folder).join("子目录"))
        .await
        .unwrap();
    fs::write(PathBuf::from(&folder).join("子目录/result.csv"), "收益")
        .await
        .unwrap();
    endpoint.create_folder(&root, "已有目录").await.unwrap();
    assert!(endpoint
        .move_entry(&root, "研究产物", &root, "已有目录")
        .await
        .is_err());
    assert!(endpoint
        .move_entry(&root, "研究产物", &folder, "研究产物")
        .await
        .is_err());
    #[cfg(windows)]
    {
        let renamed = endpoint
            .move_entry(&root, "研究产物", &root, "重命名产物")
            .await
            .unwrap();
        assert!(!endpoint.exists(&folder).await.unwrap());
        assert_eq!(
            fs::read_to_string(PathBuf::from(&renamed).join("报告.txt"))
                .await
                .unwrap(),
            "结果"
        );
        let target = endpoint
            .move_entry(&root, "重命名产物", &scratch.path("已有目录"), "重命名产物")
            .await
            .unwrap();
        assert!(endpoint.exists(&target).await.unwrap());
        endpoint
            .delete_entry(&scratch.path("已有目录"), "重命名产物")
            .await
            .unwrap();
        assert!(!endpoint.exists(&target).await.unwrap());
    }
    #[cfg(not(windows))]
    endpoint.delete_entry(&root, "研究产物").await.unwrap();
    assert!(endpoint.delete_entry(&root, "..").await.is_err());
    assert!(endpoint.exists(&root).await.unwrap());
}

#[tokio::test]
async fn file_tools_rename_files_without_overwriting() {
    let scratch = Scratch::new();
    let root = scratch.path("");
    fs::write(scratch.path("source.txt"), "源文件")
        .await
        .unwrap();
    fs::write(scratch.path("existing.txt"), "原目标")
        .await
        .unwrap();
    #[cfg(windows)]
    assert!(
        files::rename_no_replace(&scratch.path("source.txt"), &scratch.path("existing.txt"))
            .is_err()
    );
    assert!(Endpoint::Local
        .move_entry(&root, "source.txt", &root, "existing.txt")
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(scratch.path("existing.txt"))
            .await
            .unwrap(),
        "原目标"
    );
    Endpoint::Local
        .move_entry(&root, "source.txt", &root, "改名.txt")
        .await
        .unwrap();
    assert!(!Endpoint::Local
        .exists(&scratch.path("source.txt"))
        .await
        .unwrap());
    Endpoint::Local
        .delete_entry(&root, "改名.txt")
        .await
        .unwrap();
    assert!(!Endpoint::Local
        .exists(&scratch.path("改名.txt"))
        .await
        .unwrap());
}

#[tokio::test]
async fn local_nested_copy_and_conflict_preserve_original() {
    let scratch = Scratch::new();
    fs::create_dir_all(scratch.path("source/产物/empty"))
        .await
        .unwrap();
    fs::create_dir_all(scratch.path("destination"))
        .await
        .unwrap();
    fs::write(
        scratch.path("source/产物/result.csv"),
        "日期,收益\n2026-10-03,0.01\n",
    )
    .await
    .unwrap();
    let progress = Mutex::new(Vec::new());
    let result = transfer::run(
        "local",
        &Endpoint::Local,
        &Endpoint::Local,
        &scratch.path("source/产物"),
        &scratch.path("destination"),
        &CancellationToken::new(),
        |p| progress.lock().unwrap().push(p.clone()),
    )
    .await
    .unwrap();
    assert_eq!(result.files, 1);
    assert_eq!(
        fs::read(scratch.path("destination/产物/result.csv"))
            .await
            .unwrap(),
        fs::read(scratch.path("source/产物/result.csv"))
            .await
            .unwrap()
    );
    assert!(PathBuf::from(scratch.path("destination/产物/empty")).is_dir());
    assert_eq!(progress.lock().unwrap().last().unwrap().status, "completed");
    let second = transfer::run(
        "conflict",
        &Endpoint::Local,
        &Endpoint::Local,
        &scratch.path("source/产物"),
        &scratch.path("destination"),
        &CancellationToken::new(),
        |_| {},
    )
    .await;
    assert!(second.unwrap_err().to_string().contains("目标已存在"));
    assert!(PathBuf::from(result.target_path).is_dir());
}

#[tokio::test]
async fn local_conflict_created_during_copy_is_not_overwritten() {
    let scratch = Scratch::new();
    fs::create_dir(scratch.path("destination")).await.unwrap();
    fs::write(scratch.path("result.txt"), b"new result")
        .await
        .unwrap();
    let target = scratch.path("destination/result.txt");
    let result = transfer::run(
        "race",
        &Endpoint::Local,
        &Endpoint::Local,
        &scratch.path("result.txt"),
        &scratch.path("destination"),
        &CancellationToken::new(),
        |p| {
            if p.current_file.ends_with("result.txt") && p.bytes_transferred == 0 {
                std::fs::write(&target, b"do not overwrite").unwrap();
            }
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(fs::read(target).await.unwrap(), b"do not overwrite");
    let listing = Endpoint::Local
        .children(&scratch.path("destination"))
        .await
        .unwrap();
    assert_eq!(listing.len(), 1);
}

#[tokio::test]
async fn cancellation_cleans_only_new_files() {
    let scratch = Scratch::new();
    fs::create_dir(scratch.path("destination")).await.unwrap();
    fs::write(scratch.path("destination/existing.txt"), b"keep")
        .await
        .unwrap();
    fs::write(scratch.path("payload.bin"), vec![42; 1024 * 1024])
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    let states = Mutex::new(Vec::new());
    let result = transfer::run(
        "cancel",
        &Endpoint::Local,
        &Endpoint::Local,
        &scratch.path("payload.bin"),
        &scratch.path("destination"),
        &cancel,
        |p| {
            states.lock().unwrap().push(p.status.clone());
            if p.current_file.ends_with("payload.bin") {
                cancel.cancel();
            }
        },
    )
    .await;
    assert!(result.is_err());
    assert_eq!(states.lock().unwrap().last().unwrap(), "cancelled");
    let listing = Endpoint::Local
        .children(&scratch.path("destination"))
        .await
        .unwrap();
    assert_eq!(listing.len(), 1);
    assert_eq!(listing[0].name, "existing.txt");
}

#[tokio::test]
async fn rejects_directory_into_itself_and_changing_source() {
    let scratch = Scratch::new();
    fs::create_dir_all(scratch.path("source/inner"))
        .await
        .unwrap();
    fs::create_dir(scratch.path("destination")).await.unwrap();
    let bad = transfer::run(
        "descendant",
        &Endpoint::Local,
        &Endpoint::Local,
        &scratch.path("source"),
        &scratch.path("source/inner"),
        &CancellationToken::new(),
        |_| {},
    )
    .await;
    assert!(bad.unwrap_err().to_string().contains("子目录"));
    for changed in [b"longer source".as_slice(), b"x".as_slice()] {
        fs::write(scratch.path("changing.txt"), b"original")
            .await
            .unwrap();
        let result = transfer::run(
            "changing",
            &Endpoint::Local,
            &Endpoint::Local,
            &scratch.path("changing.txt"),
            &scratch.path("destination"),
            &CancellationToken::new(),
            |p| {
                if p.current_file.ends_with("changing.txt") && p.bytes_transferred == 0 {
                    std::fs::write(scratch.path("changing.txt"), changed).unwrap();
                }
            },
        )
        .await;
        assert!(result.is_err());
        assert!(Endpoint::Local
            .children(&scratch.path("destination"))
            .await
            .unwrap()
            .is_empty());
    }
}

#[tokio::test]
async fn previews_are_bounded_and_never_execute_html() {
    let scratch = Scratch::new();
    fs::write(
        scratch.path("page.html"),
        "<script>alert('never execute')</script>",
    )
    .await
    .unwrap();
    let preview = files::preview(&Endpoint::Local, &scratch.path("page.html"))
        .await
        .unwrap();
    assert_eq!(preview.kind, "text");
    assert_eq!(preview.mime, "text/plain");
    fs::write(scratch.path("large.txt"), "中".repeat(100_000))
        .await
        .unwrap();
    let preview = files::preview(&Endpoint::Local, &scratch.path("large.txt"))
        .await
        .unwrap();
    assert_eq!(preview.kind, "text");
    assert!(preview.truncated && preview.content.len() <= 256 * 1024);
    fs::write(scratch.path("binary.bin"), b"abc\0def")
        .await
        .unwrap();
    assert_eq!(
        files::preview(&Endpoint::Local, &scratch.path("binary.bin"))
            .await
            .unwrap()
            .kind,
        "unsupported"
    );
    let mut image = b"\x89PNG\r\n\x1a\n".to_vec();
    image.resize(8 * 1024 * 1024 + 1, 0);
    fs::write(scratch.path("huge.png"), image).await.unwrap();
    assert_eq!(
        files::preview(&Endpoint::Local, &scratch.path("huge.png"))
            .await
            .unwrap()
            .kind,
        "unsupported"
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    endpoints: Vec<FixtureEndpoint>,
    username: String,
    password: String,
    private_key_path: String,
    auth_log_path: String,
}

#[derive(Deserialize)]
struct FixtureEndpoint {
    host: String,
    port: u16,
    fingerprint: String,
}

fn fixture_config(fixture: &Fixture, index: usize, key: bool) -> ConnectConfig {
    let endpoint = &fixture.endpoints[index];
    ConnectConfig {
        name: format!("fixture-{index}"),
        host: endpoint.host.clone(),
        port: endpoint.port,
        username: fixture.username.clone(),
        auth_method: if key { "key" } else { "password" }.into(),
        password: Some(fixture.password.clone()),
        private_key_path: Some(fixture.private_key_path.clone()),
        passphrase: None,
        fingerprint: endpoint.fingerprint.clone(),
    }
}

#[tokio::test]
#[ignore = "requires tests/run-sftp-tests.ps1 ephemeral SFTP fixture"]
async fn sftp_integration() {
    let manifest = std::env::var("DROPPING_SFTP_FIXTURE")
        .expect("DROPPING_SFTP_FIXTURE must point to fixture.json");
    let fixture: Fixture = serde_json::from_slice(&fs::read(manifest).await.unwrap()).unwrap();
    let state = AppState::default();
    let observed = connection::probe(&fixture.endpoints[0].host, fixture.endpoints[0].port)
        .await
        .unwrap();
    assert_eq!(observed.fingerprint, fixture.endpoints[0].fingerprint);
    let auth_before = fs::read(&fixture.auth_log_path)
        .await
        .unwrap_or_default()
        .len();
    let mut untrusted = fixture_config(&fixture, 0, false);
    untrusted.fingerprint = "SHA256:THIS_IS_NOT_THE_SERVER_KEY".into();
    assert!(connection::connect(&state, untrusted).await.is_err());
    assert_eq!(
        auth_before,
        fs::read(&fixture.auth_log_path)
            .await
            .unwrap_or_default()
            .len(),
        "No credentials may be sent to an untrusted host"
    );
    let alpha_connection = connection::connect(&state, fixture_config(&fixture, 0, false))
        .await
        .unwrap();
    let beta_connection = connection::connect(&state, fixture_config(&fixture, 1, true))
        .await
        .unwrap();
    let alpha = state.endpoint(&alpha_connection.id).await.unwrap();
    let beta = state.endpoint(&beta_connection.id).await.unwrap();
    let listing = alpha.list("/").await.unwrap();
    assert!(listing
        .entries
        .iter()
        .any(|entry| entry.name == "hello.txt"));
    assert!(listing
        .entries
        .iter()
        .any(|entry| entry.name == "tree" && entry.is_dir));
    assert_eq!(
        files::preview(&alpha, "/hello.txt").await.unwrap().kind,
        "text"
    );
    let scratch = Scratch::new();
    fs::create_dir(scratch.path("download")).await.unwrap();
    let content: Vec<u8> = (0..350_000).map(|i| (i % 251) as u8).collect();
    fs::write(scratch.path("artifact.bin"), &content)
        .await
        .unwrap();
    let remote_root = format!("/integration-{}", uuid::Uuid::new_v4());
    alpha.mkdir(&remote_root).await.unwrap();
    beta.mkdir(&remote_root).await.unwrap();
    let folder = alpha.create_folder(&remote_root, "工具测试").await.unwrap();
    assert!(alpha.create_folder(&remote_root, "工具测试").await.is_err());
    alpha.create_folder(&folder, "子目录").await.unwrap();
    alpha.create_folder(&remote_root, "已有目录").await.unwrap();
    assert!(alpha
        .move_entry(&remote_root, "工具测试", &remote_root, "已有目录")
        .await
        .is_err());
    assert!(alpha
        .move_entry(&remote_root, "工具测试", &folder, "工具测试")
        .await
        .is_err());
    let renamed = alpha
        .move_entry(&remote_root, "工具测试", &remote_root, "改名目录")
        .await
        .unwrap();
    assert!(!alpha.exists(&folder).await.unwrap());
    alpha
        .move_entry(
            &remote_root,
            "改名目录",
            &format!("{remote_root}/已有目录"),
            "改名目录",
        )
        .await
        .unwrap();
    assert!(!alpha.exists(&renamed).await.unwrap());
    alpha.delete_entry(&remote_root, "已有目录").await.unwrap();
    assert!(!alpha
        .exists(&format!("{remote_root}/已有目录"))
        .await
        .unwrap());
    let remote_file = format!("{remote_root}/artifact.bin");
    let no_cancel = CancellationToken::new();
    let upload = transfer::run(
        "upload",
        &Endpoint::Local,
        &alpha,
        &scratch.path("artifact.bin"),
        &remote_root,
        &no_cancel,
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(upload.bytes, content.len() as u64);
    let conflict = transfer::run(
        "conflict",
        &Endpoint::Local,
        &alpha,
        &scratch.path("artifact.bin"),
        &remote_root,
        &no_cancel,
        |_| {},
    )
    .await;
    assert!(conflict.is_err());
    transfer::run(
        "relay",
        &alpha,
        &beta,
        &remote_file,
        &remote_root,
        &no_cancel,
        |_| {},
    )
    .await
    .unwrap();
    transfer::run(
        "download",
        &beta,
        &Endpoint::Local,
        &remote_file,
        &scratch.path("download"),
        &no_cancel,
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(
        fs::read(scratch.path("download/artifact.bin"))
            .await
            .unwrap(),
        content
    );
    let recursive = transfer::run(
        "recursive",
        &alpha,
        &beta,
        "/tree",
        &remote_root,
        &no_cancel,
        |_| {},
    )
    .await
    .unwrap();
    assert_eq!(recursive.files, 2);
    assert!(
        beta.metadata(&format!("{remote_root}/tree/empty"))
            .await
            .unwrap()
            .is_dir
    );
    assert_eq!(
        files::preview(&beta, &format!("{remote_root}/tree/nested/result.csv"))
            .await
            .unwrap()
            .kind,
        "text"
    );
    let cancel = CancellationToken::new();
    let captured = Arc::new(Mutex::new(Vec::<TransferProgress>::new()));
    let canceled = transfer::run(
        "cancel-remote",
        &alpha,
        &beta,
        "/slow.bin",
        &remote_root,
        &cancel,
        |p| {
            captured.lock().unwrap().push(p.clone());
            if p.bytes_transferred > 0 && p.status == "running" {
                cancel.cancel();
            }
        },
    )
    .await;
    assert!(canceled.is_err());
    assert_eq!(captured.lock().unwrap().last().unwrap().status, "cancelled");
    let entries = beta.children(&remote_root).await.unwrap();
    assert!(!entries
        .iter()
        .any(|e| e.name == "slow.bin" || e.name.starts_with(".dropping-")));
    assert!(beta.exists(&remote_file).await.unwrap());
    connection::disconnect(&state, &alpha_connection.id)
        .await
        .unwrap();
    connection::disconnect(&state, &beta_connection.id)
        .await
        .unwrap();
    assert!(state.endpoint(&alpha_connection.id).await.is_err());
    println!("SFTP verified: pre-auth fingerprint gate, password/key auth, browse, preview, byte-identical upload/relay/download, recursive folders, conflict preservation, cancellation cleanup, disconnect.");
}

#[tokio::test]
async fn reads_bounded_byte_ranges_from_local_files() {
    let scratch = Scratch::new();
    let path = scratch.path("table.parquet");
    let data: Vec<u8> = (0..=255u8).cycle().take(1000).collect();
    fs::write(&path, &data).await.unwrap();
    let endpoint = Endpoint::Local;
    assert_eq!(
        endpoint.read_range(&path, 250, 10).await.unwrap(),
        data[250..260]
    );
    assert_eq!(
        endpoint.read_range(&path, 996, 100).await.unwrap(),
        data[996..]
    );
    assert!(endpoint.read_range(&path, 1001, 1).await.is_err());
    assert!(endpoint
        .read_range(&path, 0, 64 * 1024 * 1024 + 1)
        .await
        .is_err());
    assert!(endpoint.read_range(&scratch.path(""), 0, 1).await.is_err());
}

#[test]
fn lists_existing_drive_roots() {
    let drives = crate::list_drives();
    assert!(!drives.is_empty());
    for drive in &drives {
        assert!(std::path::Path::new(drive).is_dir(), "{drive}");
    }
    if cfg!(windows) {
        assert!(drives
            .iter()
            .all(|drive| drive.len() == 3 && drive.ends_with(":\\")));
    }
}
