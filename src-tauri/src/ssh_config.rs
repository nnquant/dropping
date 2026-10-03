use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
};

use anyhow::{anyhow, Result};
use serde::Serialize;

const MAX_DEPTH: usize = 16;
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 128;
const MAX_HOSTS: usize = 512;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHosts {
    pub path: String,
    pub hosts: Vec<SshConfigHost>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub private_key_path: Option<String>,
    pub warning: Option<String>,
}

#[derive(Clone)]
struct Directive {
    key: String,
    values: Vec<String>,
    line: usize,
}

struct Reader {
    home: PathBuf,
    username: String,
    files: HashMap<PathBuf, std::result::Result<Vec<Directive>, String>>,
    bytes: u64,
    warnings: Vec<String>,
    discovered: HashSet<PathBuf>,
}

#[derive(Default)]
struct HostOptions {
    values: HashMap<String, String>,
    warnings: Vec<String>,
    declared: bool,
    visits: usize,
}

fn unique_push(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

// Backslashes in Windows paths are literal. Only escaped quotes, whitespace and # are decoded.
fn tokens(line: &str) -> std::result::Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut token = String::new();
    let mut started = false;
    let mut quote = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&next) = chars.peek() {
                if Some(next) == quote
                    || (quote.is_none()
                        && (next.is_whitespace() || matches!(next, '#' | '"' | '\'')))
                {
                    token.push(chars.next().unwrap());
                    started = true;
                    continue;
                }
            }
            token.push(c);
            started = true;
        } else if let Some(delimiter) = quote {
            if c == delimiter {
                quote = None;
            } else {
                token.push(c);
            }
        } else if matches!(c, '"' | '\'') {
            quote = Some(c);
            started = true;
        } else if c == '#' {
            break;
        } else if c.is_whitespace() || (c == '=' && result.is_empty()) {
            if started {
                result.push(std::mem::take(&mut token));
                started = false;
            }
        } else {
            token.push(c);
            started = true;
        }
    }
    if quote.is_some() {
        return Err("引号未闭合".into());
    }
    if started {
        result.push(token);
    }
    // Whitespace before '=' is also valid: HostName = example.org.
    if result.get(1).map(String::as_str) == Some("=") {
        result.remove(1);
    } else if result.get(1).is_some_and(|s| s.starts_with('=')) {
        result[1].remove(0);
        if result[1].is_empty() {
            result.remove(1);
        }
    }
    Ok(result)
}

fn wildcard(pattern: &str, value: &str, case_sensitive: bool) -> bool {
    let pattern: Vec<char> = if case_sensitive {
        pattern.to_owned()
    } else {
        pattern.to_lowercase()
    }
    .chars()
    .collect();
    let value: Vec<char> = if case_sensitive {
        value.to_owned()
    } else {
        value.to_lowercase()
    }
    .chars()
    .collect();
    let (mut p, mut v, mut star, mut retry) = (0, 0, None, 0);
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(position) = star {
            p = position + 1;
            retry += 1;
            v = retry;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

fn pattern_list<'a>(
    patterns: impl Iterator<Item = &'a str>,
    value: &str,
    case_sensitive: bool,
) -> bool {
    let mut positive = false;
    for pattern in patterns.flat_map(|s| s.split(',')) {
        if let Some(negated) = pattern.strip_prefix('!') {
            if wildcard(negated, value, case_sensitive) {
                return false;
            }
        } else if wildcard(pattern, value, case_sensitive) {
            positive = true;
        }
    }
    positive
}

fn concrete_alias(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('!')
        && !value.contains(['*', '?', '/', '\\', '\0', ','])
        && !value.chars().any(char::is_whitespace)
}

impl Reader {
    fn load(&mut self, path: &Path) -> std::result::Result<Vec<Directive>, String> {
        if let Some(cached) = self.files.get(path) {
            return cached.clone();
        }
        let loaded = (|| {
            if self.files.len() >= MAX_FILES {
                return Err(format!("SSH 配置包含超过 {MAX_FILES} 个文件，已停止读取"));
            }
            let metadata = match std::fs::metadata(path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
                Err(error) => return Err(format!("无法读取 SSH 配置 {}：{error}", path.display())),
            };
            if !metadata.is_file() {
                return Err(format!("SSH 配置路径不是文件：{}", path.display()));
            }
            if metadata.len() > MAX_BYTES || self.bytes + metadata.len() > MAX_BYTES {
                return Err("SSH 配置总大小超过 2 MiB，已停止读取".into());
            }
            let mut text = String::new();
            std::fs::File::open(path)
                .and_then(|file| {
                    file.take(MAX_BYTES.saturating_sub(self.bytes) + 1)
                        .read_to_string(&mut text)
                })
                .map_err(|error| format!("无法读取 SSH 配置 {}：{error}", path.display()))?;
            if self.bytes + text.len() as u64 > MAX_BYTES {
                return Err("SSH 配置总大小超过 2 MiB，已停止读取".into());
            }
            self.bytes += text.len() as u64;
            let mut directives = Vec::new();
            for (index, line) in text.trim_start_matches('\u{feff}').lines().enumerate() {
                let mut parts = tokens(line).map_err(|reason| {
                    format!("SSH 配置 {}:{} {reason}", path.display(), index + 1)
                })?;
                if parts.is_empty() {
                    continue;
                }
                let key = parts.remove(0).to_ascii_lowercase();
                if parts.is_empty() {
                    return Err(format!(
                        "SSH 配置 {}:{} 缺少选项值",
                        path.display(),
                        index + 1
                    ));
                }
                directives.push(Directive {
                    key,
                    values: parts,
                    line: index + 1,
                });
            }
            Ok(directives)
        })();
        if let Err(warning) = &loaded {
            unique_push(&mut self.warnings, warning.clone());
        }
        self.files.insert(path.to_owned(), loaded.clone());
        loaded
    }

    fn include_paths(&self, values: &[String]) -> std::result::Result<Vec<PathBuf>, String> {
        let mut result = Vec::new();
        for value in values {
            let expanded = self.expand(value, "", "", "", false)?;
            if expanded.contains('%') || expanded.contains("${") {
                return Err("Include 路径含有暂不支持的变量，未读取该配置".into());
            }
            let path = PathBuf::from(&expanded);
            let path = if path.is_absolute() {
                path
            } else {
                self.home.join(".ssh").join(path)
            };
            let pattern = path.to_string_lossy().replace('\\', "/");
            let mut matches = Vec::new();
            for found in
                glob::glob(&pattern).map_err(|error| format!("Include 路径模式无效：{error}"))?
            {
                matches.push(found.map_err(|error| format!("无法读取 Include 文件：{error}"))?);
                if matches.len() > MAX_FILES {
                    return Err(format!("Include 匹配超过 {MAX_FILES} 个文件"));
                }
            }
            matches.sort();
            result.extend(matches);
            if result.len() > MAX_FILES {
                return Err(format!("Include 匹配超过 {MAX_FILES} 个文件"));
            }
        }
        Ok(result)
    }

    fn expand(
        &self,
        value: &str,
        host: &str,
        remote_user: &str,
        alias: &str,
        identity: bool,
    ) -> std::result::Result<String, String> {
        let mut expanded = String::new();
        let mut chars = value.chars();
        while let Some(c) = chars.next() {
            if c != '%' {
                expanded.push(c);
                continue;
            }
            match chars.next() {
                Some('%') => expanded.push('%'),
                Some('d') => expanded.push_str(&self.home.to_string_lossy()),
                Some('u') => expanded.push_str(&self.username),
                Some('h') if identity => expanded.push_str(host),
                Some('r') if identity => expanded.push_str(remote_user),
                Some('n') if identity => expanded.push_str(alias),
                Some(token) => return Err(format!("SSH 配置包含暂不支持的路径变量 %{token}")),
                None => return Err("SSH 配置路径末尾有不完整的 % 变量".into()),
            }
        }
        if expanded == "~" {
            return Ok(self.home.to_string_lossy().into_owned());
        }
        if expanded.starts_with("~/") || expanded.starts_with("~\\") {
            return Ok(self
                .home
                .join(&expanded[2..])
                .to_string_lossy()
                .into_owned());
        }
        if expanded.starts_with('~') {
            return Err("暂不支持 ~其他用户 的 SSH 路径".into());
        }
        if expanded.contains("${") {
            return Err("暂不支持 SSH 路径中的环境变量，请使用完整路径".into());
        }
        Ok(expanded)
    }

    fn enter(path: &Path, stack: &mut Vec<PathBuf>) -> std::result::Result<(), String> {
        let normalized = path.canonicalize().unwrap_or_else(|_| path.to_owned());
        if stack.len() >= MAX_DEPTH {
            return Err(format!("SSH Include 超过 {MAX_DEPTH} 层，已停止读取"));
        }
        if stack.contains(&normalized) {
            return Err(format!("SSH Include 存在循环：{}", path.display()));
        }
        stack.push(normalized);
        Ok(())
    }

    fn discover(
        &mut self,
        path: &Path,
        stack: &mut Vec<PathBuf>,
        aliases: &mut Vec<String>,
        seen: &mut HashSet<String>,
    ) {
        if let Err(warning) = Self::enter(path, stack) {
            unique_push(&mut self.warnings, warning);
            return;
        }
        if !self.discovered.insert(stack.last().unwrap().clone()) {
            stack.pop();
            return;
        }
        if let Ok(directives) = self.load(path) {
            for directive in directives {
                if directive.key == "host" {
                    for alias in directive
                        .values
                        .into_iter()
                        .filter(|value| concrete_alias(value))
                    {
                        if aliases.len() >= MAX_HOSTS {
                            unique_push(
                                &mut self.warnings,
                                format!("SSH 配置超过 {MAX_HOSTS} 个主机，已截断列表"),
                            );
                            break;
                        }
                        if seen.insert(alias.to_lowercase()) {
                            aliases.push(alias);
                        }
                    }
                } else if directive.key == "include" {
                    match self.include_paths(&directive.values) {
                        Ok(paths) => {
                            for included in paths {
                                self.discover(&included, stack, aliases, seen);
                            }
                        }
                        Err(warning) => unique_push(&mut self.warnings, warning),
                    }
                }
            }
        }
        stack.pop();
    }

    fn match_context(&self, values: &[String], alias: &str, options: &mut HostOptions) -> bool {
        if values.len() == 1 && values[0].eq_ignore_ascii_case("all") {
            return true;
        }
        let mut matches = true;
        let mut unknown = Vec::new();
        let mut index = 0;
        while index < values.len() {
            let criterion = values[index].to_ascii_lowercase();
            let (negated, criterion) = criterion
                .strip_prefix('!')
                .map_or((false, criterion.as_str()), |key| (true, key));
            index += 1;
            if matches!(criterion, "all" | "canonical" | "final") {
                unknown.push(criterion.to_owned());
                continue;
            }
            let Some(value) = values.get(index) else {
                unknown.push("不完整条件".into());
                break;
            };
            index += 1;
            let target = match criterion {
                "host" => options
                    .values
                    .get("hostname")
                    .map(String::as_str)
                    .unwrap_or(alias)
                    .replace("%h", alias),
                "originalhost" => alias.to_owned(),
                "user" => options
                    .values
                    .get("user")
                    .cloned()
                    .unwrap_or_else(|| self.username.clone()),
                "localuser" => self.username.clone(),
                other => {
                    unknown.push(other.to_owned());
                    continue;
                }
            };
            let matched = pattern_list(
                std::iter::once(value.as_str()),
                &target,
                matches!(criterion, "user" | "localuser"),
            );
            matches &= if negated { !matched } else { matched };
        }
        if matches && !unknown.is_empty() {
            unique_push(
                &mut options.warnings,
                format!(
                    "此主机可能受不支持的 Match 条件影响（{}），未执行外部命令；请手动配置连接",
                    unknown.join("、")
                ),
            );
        }
        matches && unknown.is_empty()
    }

    fn evaluate(
        &mut self,
        path: &Path,
        alias: &str,
        active: &mut bool,
        stack: &mut Vec<PathBuf>,
        options: &mut HostOptions,
    ) {
        options.visits += 1;
        if options.visits > 1024 {
            unique_push(
                &mut options.warnings,
                "SSH Include 重复引用超过 1024 次，已停止读取".into(),
            );
            return;
        }
        if let Err(warning) = Self::enter(path, stack) {
            unique_push(&mut options.warnings, warning);
            return;
        }
        match self.load(path) {
            Err(warning) => unique_push(&mut options.warnings, warning),
            Ok(directives) => {
                for directive in directives {
                    match directive.key.as_str() {
                        "host" => {
                            *active = pattern_list(
                                directive.values.iter().map(String::as_str),
                                alias,
                                false,
                            );
                            if *active
                                && directive.values.iter().any(|value| {
                                    concrete_alias(value) && value.eq_ignore_ascii_case(alias)
                                })
                            {
                                options.declared = true;
                            }
                        }
                        "match" => *active = self.match_context(&directive.values, alias, options),
                        "include" if *active => match self.include_paths(&directive.values) {
                            Ok(paths) => {
                                for included in paths {
                                    // OpenSSH restores the including file's Host/Match context after each included file.
                                    let mut included_active = *active;
                                    self.evaluate(
                                        &included,
                                        alias,
                                        &mut included_active,
                                        stack,
                                        options,
                                    );
                                }
                            }
                            Err(warning) => unique_push(&mut options.warnings, warning),
                        },
                        key if *active
                            && matches!(
                                key,
                                "hostname"
                                    | "user"
                                    | "port"
                                    | "identityfile"
                                    | "proxyjump"
                                    | "proxycommand"
                                    | "canonicalizehostname"
                                    | "certificatefile"
                            ) =>
                        {
                            if directive.values.len() > 1
                                && !matches!(key, "proxycommand" | "proxyjump")
                            {
                                unique_push(
                                    &mut options.warnings,
                                    format!(
                                        "SSH 配置 {}:{} 选项值格式不受支持",
                                        path.display(),
                                        directive.line
                                    ),
                                );
                            }
                            if key == "identityfile"
                                && options
                                    .values
                                    .get(key)
                                    .is_some_and(|previous| previous != &directive.values.join(" "))
                            {
                                unique_push(&mut options.warnings, "此主机配置了多个 IdentityFile，当前客户端只支持选择一个私钥；请手动配置连接".into());
                            }
                            // Scalar OpenSSH options use the first obtained value. Multiple identities require manual selection.
                            options
                                .values
                                .entry(key.to_owned())
                                .or_insert_with(|| directive.values.join(" "));
                        }
                        _ => {}
                    }
                }
            }
        }
        stack.pop();
    }

    fn host(&mut self, path: &Path, alias: String) -> Option<SshConfigHost> {
        let mut options = HostOptions::default();
        self.evaluate(path, &alias, &mut true, &mut Vec::new(), &mut options);
        if !options.declared {
            return None;
        }
        let host = options
            .values
            .get("hostname")
            .cloned()
            .unwrap_or_else(|| alias.clone())
            .replace("%h", &alias);
        if host.contains('%') || host.contains("${") {
            unique_push(
                &mut options.warnings,
                "HostName 含有暂不支持的变量，请手动配置连接".into(),
            );
        }
        let username = options
            .values
            .get("user")
            .cloned()
            .unwrap_or_else(|| self.username.clone());
        let port = match options.values.get("port") {
            None => 22,
            Some(value) => match value.parse::<u16>() {
                Ok(port) if port > 0 => port,
                _ => {
                    unique_push(
                        &mut options.warnings,
                        "SSH Port 不是有效的 1–65535 端口".into(),
                    );
                    22
                }
            },
        };
        for key in ["proxyjump", "proxycommand", "certificatefile"] {
            if options
                .values
                .get(key)
                .is_some_and(|value| !value.eq_ignore_ascii_case("none"))
            {
                unique_push(
                    &mut options.warnings,
                    format!("此主机使用暂不支持的 {key}，不会自动直连；请手动配置连接"),
                );
            }
        }
        if options
            .values
            .get("canonicalizehostname")
            .is_some_and(|value| !value.eq_ignore_ascii_case("no") && value != "false")
        {
            unique_push(
                &mut options.warnings,
                "此主机启用了 CanonicalizeHostname，请手动配置连接".into(),
            );
        }
        let private_key_path = match options.values.get("identityfile") {
            Some(value) if value.eq_ignore_ascii_case("none") => None,
            Some(value) => match self.expand(value, &host, &username, &alias, true) {
                Ok(path) => Some(path),
                Err(warning) => {
                    unique_push(&mut options.warnings, warning);
                    None
                }
            },
            None => ["id_ed25519", "id_rsa"]
                .into_iter()
                .map(|name| self.home.join(".ssh").join(name))
                .find(|path| path.is_file())
                .map(|path| path.to_string_lossy().into_owned()),
        };
        Some(SshConfigHost {
            alias,
            host,
            port,
            username,
            auth_method: if private_key_path.is_some() {
                "key"
            } else {
                "password"
            }
            .into(),
            private_key_path,
            warning: if options.warnings.is_empty() {
                None
            } else {
                Some(options.warnings.join("；"))
            },
        })
    }
}

fn read_at(home: PathBuf, username: String) -> SshConfigHosts {
    let path = home.join(".ssh").join("config");
    let mut reader = Reader {
        home,
        username,
        files: HashMap::new(),
        bytes: 0,
        warnings: Vec::new(),
        discovered: HashSet::new(),
    };
    let mut aliases = Vec::new();
    reader.discover(&path, &mut Vec::new(), &mut aliases, &mut HashSet::new());
    let hosts = aliases
        .into_iter()
        .filter_map(|alias| reader.host(&path, alias))
        .collect();
    SshConfigHosts {
        path: path.to_string_lossy().into_owned(),
        hosts,
        warnings: reader.warnings,
    }
}

pub fn read_default() -> Result<SshConfigHosts> {
    let home = dirs::home_dir().ok_or_else(|| anyhow!("无法定位本机用户目录"))?;
    let username =
        std::env::var(if cfg!(windows) { "USERNAME" } else { "USER" }).unwrap_or_default();
    Ok(read_at(home, username))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new(config: &str) -> Self {
            let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("work")
                .join(format!("ssh-config-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(home.join(".ssh")).unwrap();
            std::fs::write(home.join(".ssh/config"), config).unwrap();
            Self(home)
        }
        fn write(&self, path: &str, text: &str) {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        fn read(&self) -> SshConfigHosts {
            read_at(self.0.clone(), "local-user".into())
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("work")
                .canonicalize()
                .unwrap();
            let path = self.0.canonicalize().unwrap();
            assert!(path.starts_with(&root) && path != root);
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn imports_six_hosts_and_include_with_first_obtained_defaults() {
        let fixture = Fixture::new("Include ~/.ssh/sealos/devbox_config\nHost alpha beta\n HostName=shared.example\n User researcher\n IdentityFile ~/.ssh/id_ed25519\nHost gamma\n HostName gamma.example\n Port 2202\nHost delta epsilon zeta\nHost *\n User default-user\n Port 2222\n");
        fixture.write(
            ".ssh/sealos/devbox_config",
            "Host devbox\n HostName dev.example\n Port 2200\n",
        );
        let result = fixture.read();
        assert_eq!(result.hosts.len(), 7);
        assert!(result.warnings.is_empty());
        assert_eq!(result.hosts[0].alias, "devbox");
        let alpha = result.hosts.iter().find(|h| h.alias == "alpha").unwrap();
        assert_eq!(
            (&*alpha.host, &*alpha.username, alpha.port),
            ("shared.example", "researcher", 2222)
        );
        assert_eq!(
            alpha.private_key_path.as_deref(),
            Some(fixture.0.join(".ssh/id_ed25519").to_str().unwrap())
        );
        let gamma = result.hosts.iter().find(|h| h.alias == "gamma").unwrap();
        assert_eq!(gamma.port, 2202);
        assert_eq!(gamma.username, "default-user");
    }

    #[test]
    fn wildcard_negation_dedup_and_early_defaults_follow_openssh_order() {
        let fixture = Fixture::new("Host * !excluded\n User early\n Port 2200\nHost alpha ALPHA beta excluded\n User late\nHost alpha\n Port 22\nHost wildcard-* ?only\n HostName unused\n");
        let result = fixture.read();
        assert_eq!(result.hosts.len(), 3);
        assert_eq!(result.hosts[0].username, "early");
        assert_eq!(result.hosts[0].port, 2200);
        assert_eq!(result.hosts[2].username, "late");
        assert_eq!(result.hosts[2].port, 22);
    }

    #[test]
    fn quoted_windows_paths_comments_assignments_and_tokens_are_preserved() {
        let fixture = Fixture::new("hOsT win token\n HostName = server.example # note\n User='remote-user'\nHost win\n IdentityFile \"C:\\Users\\Alice Smith\\.ssh\\id_ed25519\" # path\nHost token\n IdentityFile \"%d/.ssh/%u-%r-%h\"\n");
        let result = fixture.read();
        assert_eq!(
            result.hosts[0].private_key_path.as_deref(),
            Some(r"C:\Users\Alice Smith\.ssh\id_ed25519")
        );
        assert!(result.hosts[1]
            .private_key_path
            .as_ref()
            .unwrap()
            .ends_with("/.ssh/local-user-remote-user-server.example"));
        assert!(result.hosts.iter().all(|host| host.warning.is_none()));
    }

    #[test]
    fn include_is_contextual_sorted_and_relative_to_ssh_directory() {
        let fixture =
            Fixture::new("Host alpha\n Include conf/*.conf\nHost beta\n HostName beta.example\n");
        fixture.write(".ssh/conf/20-second.conf", "Port 2222\n");
        fixture.write(
            ".ssh/conf/10-first.conf",
            "Port 2201\nInclude nested.conf\n",
        );
        fixture.write(".ssh/nested.conf", "User included\n");
        let result = fixture.read();
        assert_eq!(result.hosts.len(), 2);
        assert_eq!(
            (result.hosts[0].port, &*result.hosts[0].username),
            (2201, "included")
        );
        assert_eq!(
            (result.hosts[1].port, &*result.hosts[1].username),
            (22, "local-user")
        );
    }

    #[test]
    fn conditional_include_does_not_invent_unreachable_aliases_and_cycles_are_reported() {
        let fixture = Fixture::new("Host alpha\n Include extra.conf\nHost beta\n");
        fixture.write(
            ".ssh/extra.conf",
            "Host hidden\n HostName unreachable\nInclude config\n",
        );
        let result = fixture.read();
        assert!(!result.hosts.iter().any(|host| host.alias == "hidden"));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("循环")));
        fixture.write(".ssh/extra.conf", "Include config\n");
        let result = fixture.read();
        assert!(result.hosts[0].warning.as_ref().unwrap().contains("循环"));
        assert!(result.hosts[1].warning.is_none());
    }

    #[test]
    fn proxies_and_match_exec_never_silently_become_direct_connections() {
        let fixture = Fixture::new("Host proxied\n ProxyJump gateway\nHost command\n ProxyCommand ssh -W %h:%p gateway\nHost safe danger\nMatch host danger exec \"touch must-not-exist\"\n HostName secret.example\nMatch all\n User researcher\n");
        let result = fixture.read();
        assert!(result.hosts[0]
            .warning
            .as_ref()
            .unwrap()
            .contains("proxyjump"));
        assert!(result.hosts[1]
            .warning
            .as_ref()
            .unwrap()
            .contains("proxycommand"));
        let safe = result
            .hosts
            .iter()
            .find(|host| host.alias == "safe")
            .unwrap();
        assert!(safe.warning.is_none());
        assert_eq!(safe.username, "researcher");
        let danger = result
            .hosts
            .iter()
            .find(|host| host.alias == "danger")
            .unwrap();
        assert!(danger.warning.as_ref().unwrap().contains("exec"));
        assert_eq!(danger.host, "danger");
        assert!(!fixture.0.join("must-not-exist").exists());
    }

    #[test]
    fn missing_config_is_empty_and_default_keys_are_only_checked_for_existence() {
        let fixture = Fixture::new("Host alpha\nHost beta\n IdentityFile none\n");
        fixture.write(
            ".ssh/id_ed25519",
            "not a valid private key; must not be parsed",
        );
        let result = fixture.read();
        assert_eq!(result.hosts[0].auth_method, "key");
        assert_eq!(result.hosts[1].auth_method, "password");
        std::fs::remove_file(fixture.0.join(".ssh/config")).unwrap();
        let empty = fixture.read();
        assert!(empty.hosts.is_empty() && empty.warnings.is_empty());
        std::fs::create_dir(fixture.0.join(".ssh/config")).unwrap();
        assert!(!fixture.read().warnings.is_empty());
    }

    #[test]
    fn include_restores_parent_context_and_can_repeat_under_different_hosts() {
        let fixture = Fixture::new("Host alpha\n Include shared.conf\n Port 2201\nHost beta\n Include shared.conf\n Port 2202\n");
        fixture.write(
            ".ssh/shared.conf",
            "User included\nHost never\n User ignored\n",
        );
        let result = fixture.read();
        assert_eq!(result.hosts.len(), 2);
        assert_eq!((result.hosts[0].port, result.hosts[1].port), (2201, 2202));
        assert!(result
            .hosts
            .iter()
            .all(|host| host.username == "included" && host.warning.is_none()));
    }

    #[test]
    fn match_user_is_case_sensitive_and_hostname_tokens_apply_before_match() {
        let fixture = Fixture::new("Host app\n HostName %h.internal\n User Bob\nMatch host app.internal\n ProxyJump relay\nHost upper\n User Bob\nMatch originalhost upper !user bob\n ProxyJump other-relay\n");
        let result = fixture.read();
        assert_eq!(result.hosts[0].host, "app.internal");
        assert!(result.hosts.iter().all(|host| host
            .warning
            .as_ref()
            .is_some_and(|warning| warning.contains("proxyjump"))));
    }

    #[test]
    fn multiple_identities_are_flagged_and_identity_tokens_distinguish_alias_from_host() {
        let fixture = Fixture::new("Host multiple\n IdentityFile ~/.ssh/one\n IdentityFile ~/.ssh/two\nHost alias\n HostName actual.example\n IdentityFile %d/.ssh/%n-%h-%r\n");
        let result = fixture.read();
        assert!(result.hosts[0]
            .warning
            .as_ref()
            .unwrap()
            .contains("多个 IdentityFile"));
        assert!(result.hosts[1]
            .private_key_path
            .as_ref()
            .unwrap()
            .ends_with("/.ssh/alias-actual.example-local-user"));
        assert!(result.hosts[1].warning.is_none());
    }

    #[test]
    fn oversized_config_is_rejected() {
        let fixture = Fixture::new(&"#".repeat(MAX_BYTES as usize + 1));
        let result = fixture.read();
        assert!(result.hosts.is_empty());
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("2 MiB")));
    }

    #[test]
    #[ignore = "reads local SSH config metadata only; run explicitly for local import verification"]
    fn inspect_local_ssh_config() {
        println!(
            "{}",
            serde_json::to_string_pretty(&read_default().unwrap()).unwrap()
        );
    }
}
