use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use russh::{
    client,
    keys::{key::PrivateKeyWithHashAlg, load_secret_key, HashAlg, PublicKeyOrCertificate},
    Disconnect,
};
use russh_sftp::client::SftpSession;
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

use crate::models::{ConnectConfig, Connection, HostKey};

pub struct VerifyHost {
    expected: Option<String>,
    observed: Arc<StdMutex<Option<HostKey>>>,
}

impl client::Handler for VerifyHost {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key = server_key.public_key();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let accepted = self
            .expected
            .as_ref()
            .map_or(true, |expected| expected == &fingerprint);
        if let Ok(mut observed) = self.observed.lock() {
            *observed = Some(HostKey {
                fingerprint,
                key_type: key.algorithm().to_string(),
            });
        }
        Ok(accepted)
    }
}

pub struct Remote {
    pub ssh: Mutex<client::Handle<VerifyHost>>,
    pub sftp: SftpSession,
    pub identity: String,
}

#[derive(Clone)]
pub enum Endpoint {
    Local,
    Remote(Arc<Remote>),
}

impl Endpoint {
    pub fn same_endpoint(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Local, Self::Local) => true,
            (Self::Remote(left), Self::Remote(right)) => left.identity == right.identity,
            _ => false,
        }
    }
}

#[derive(Default)]
pub struct AppState {
    pub connections: RwLock<HashMap<String, Arc<Remote>>>,
    pub transfers: Mutex<HashMap<String, ActiveTransfer>>,
}

pub struct ActiveTransfer {
    pub cancel: CancellationToken,
    pub source: String,
    pub destination: String,
}

impl AppState {
    pub async fn endpoint(&self, id: &str) -> Result<Endpoint> {
        if id == "local" {
            return Ok(Endpoint::Local);
        }
        self.connections
            .read()
            .await
            .get(id)
            .cloned()
            .map(Endpoint::Remote)
            .ok_or_else(|| anyhow!("连接已断开，请重新连接"))
    }
}

fn validate_address(host: &str, port: u16) -> Result<()> {
    if host.trim().is_empty()
        || host.chars().any(char::is_whitespace)
        || host.contains('\0')
        || port == 0
    {
        bail!("请输入有效的主机地址和端口");
    }
    Ok(())
}

async fn handshake(
    host: &str,
    port: u16,
    expected: Option<String>,
) -> Result<(client::Handle<VerifyHost>, HostKey)> {
    validate_address(host, port)?;
    let observed = Arc::new(StdMutex::new(None));
    let handler = VerifyHost {
        expected,
        observed: observed.clone(),
    };
    let config = client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    };
    let connection = tokio::time::timeout(
        Duration::from_secs(20),
        client::connect(Arc::new(config), (host, port), handler),
    )
    .await
    .context("连接超时，请检查主机地址、端口和网络")?
    .context("SSH 握手失败；若主机指纹发生变化，请核实服务器身份")?;
    let key = observed
        .lock()
        .map_err(|_| anyhow!("无法读取主机指纹"))?
        .clone()
        .ok_or_else(|| anyhow!("服务器未提供主机公钥"))?;
    Ok((connection, key))
}

pub fn local_info() -> Result<Connection> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("无法定位本机用户目录"))?;
    Ok(Connection {
        id: "local".into(),
        name: "此电脑".into(),
        kind: "local".into(),
        host: None,
        username: None,
        home: home.to_string_lossy().into_owned(),
    })
}

pub async fn probe(host: &str, port: u16) -> Result<HostKey> {
    let (session, key) = handshake(host, port, None).await?;
    let _ = session
        .disconnect(Disconnect::ByApplication, "Host key inspection", "")
        .await;
    Ok(key)
}

pub async fn connect(state: &AppState, config: ConnectConfig) -> Result<Connection> {
    if config.username.trim().is_empty() || !config.fingerprint.starts_with("SHA256:") {
        bail!("请填写用户名，并核实主机指纹后再连接");
    }
    let (mut session, _) = handshake(&config.host, config.port, Some(config.fingerprint)).await?;
    // The expected fingerprint is checked during key exchange, before credentials are sent.
    let authenticated = tokio::time::timeout(Duration::from_secs(30), async {
        match config.auth_method.as_str() {
            "password" => session
                .authenticate_password(&config.username, config.password.as_deref().unwrap_or(""))
                .await
                .map_err(anyhow::Error::from),
            "key" => {
                let path = config
                    .private_key_path
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| anyhow!("请填写私钥文件路径"))?;
                let key = load_secret_key(path, config.passphrase.as_deref())
                    .context("无法读取私钥，请检查路径、格式和私钥密码")?;
                let hash = session.best_supported_rsa_hash().await?.flatten();
                session
                    .authenticate_publickey(
                        &config.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                    )
                    .await
                    .map_err(anyhow::Error::from)
            }
            _ => bail!("不支持的认证方式"),
        }
    })
    .await
    .context("SSH 认证超时")??;
    if !authenticated.success() {
        bail!("认证失败，请检查用户名、密码或私钥；暂不支持交互式多因素认证");
    }
    let (sftp, home) = tokio::time::timeout(Duration::from_secs(20), async {
        let channel = session.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let sftp = SftpSession::new(channel.into_stream()).await?;
        sftp.set_timeout(30);
        let home = sftp.canonicalize(".").await?;
        Ok::<_, anyhow::Error>((sftp, home))
    })
    .await
    .context("SFTP 初始化超时")??;
    let id = uuid::Uuid::new_v4().to_string();
    let identity = format!(
        "{}@{}:{}",
        config.username,
        config.host.to_lowercase(),
        config.port
    );
    state.connections.write().await.insert(
        id.clone(),
        Arc::new(Remote {
            ssh: Mutex::new(session),
            sftp,
            identity,
        }),
    );
    Ok(Connection {
        id,
        name: if config.name.trim().is_empty() {
            config.host.clone()
        } else {
            config.name
        },
        kind: "ssh".into(),
        host: Some(config.host),
        username: Some(config.username),
        home,
    })
}

pub async fn disconnect(state: &AppState, id: &str) -> Result<()> {
    if id == "local" {
        return Ok(());
    }
    let transfers = state.transfers.lock().await;
    if transfers
        .values()
        .any(|task| task.source == id || task.destination == id)
    {
        bail!("该连接仍有传输任务，请先取消或等待任务结束");
    }
    let remote = state.connections.write().await.remove(id);
    drop(transfers);
    if let Some(remote) = remote {
        let _ = remote.sftp.close().await;
        let _ = remote
            .ssh
            .lock()
            .await
            .disconnect(Disconnect::ByApplication, "Disconnected", "")
            .await;
    }
    Ok(())
}
