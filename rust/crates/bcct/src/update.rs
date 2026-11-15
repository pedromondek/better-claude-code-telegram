use std::ffi::OsString;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use semver::Version;
use serde_json::Value;

use crate::install::{MARKETPLACE_NAME, MARKETPLACE_REPO, marketplace_source};
use crate::messages::{Messages, messages_for};
use crate::paths::Paths;
use crate::prompt::{FakePrompter, Prompter, create_prompter};
use crate::self_install::{Channel, InstallError, Origin, Store};
use crate::setup::{HOOKS_PLUGIN_ID, has_command, setup_locale};
use crate::ui::{fail, info, should_colorize, skipped, success, warn};

pub const NPM_ROOT_ENV: &str = "BETTER_CC_TELEGRAM_NPM_ROOT";
pub const RELEASES_ROOT_ENV: &str = "BETTER_CC_TELEGRAM_RELEASES_ROOT";

const NPM_ROOT: &str = "https://registry.npmjs.org";
const PACKAGE: &str = crate::package::NPM_PACKAGE;
const CHECKSUMS_FILE: &str = "checksums.txt";
const CHECK_FLAG: &str = "--check";
const DOWNLOAD_LIMIT: u64 = 256 * 1024 * 1024;
const LIST_LIMIT: u64 = 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const BODY_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REDIRECTS: u32 = 10;
const HTTP_OK: u16 = 200;
const HTTP_NOT_FOUND: u16 = 404;
const FAILURE_MARK: char = '✘';
const SUCCESS: u8 = 0;
const FAILURE: u8 = 1;
const USAGE: u8 = 2;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Newest {
    pub stable: Option<String>,
    pub beta: Option<String>,
    pub alpha: Option<String>,
}

impl Newest {
    #[must_use]
    pub fn of(&self, channel: Channel) -> Option<&str> {
        match channel {
            Channel::Stable => self.stable.as_deref(),
            Channel::Beta => self.beta.as_deref(),
            Channel::Alpha => self.alpha.as_deref(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wanted {
    Default,
    Channel(Channel),
    Version(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub wanted: Wanted,
    pub check: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plugins {
    pub ids: Vec<(String, bool)>,
    pub hooks_version: String,
    pub hooks_path: PathBuf,
}

pub type Getter<'a> = &'a dyn Fn(&str) -> Result<(u16, Vec<u8>), String>;

pub struct World<'a> {
    pub app_dir: &'a Path,
    pub running: &'a str,
    pub claude: &'a dyn Fn(&[&str]) -> String,
    pub has_command: &'a dyn Fn(&str) -> bool,
    pub get: Getter<'a>,
    pub download: &'a dyn Fn(&str, &Path) -> Result<u16, String>,
    pub npm_root: &'a str,
    pub releases_root: &'a str,
}

impl std::fmt::Debug for World<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("World")
            .field("app_dir", &self.app_dir)
            .field("running", &self.running)
            .field("npm_root", &self.npm_root)
            .field("releases_root", &self.releases_root)
            .finish_non_exhaustive()
    }
}

pub struct Screen<'a> {
    pub out: &'a mut dyn Write,
    pub err: &'a mut dyn Write,
    pub colorize_out: bool,
    pub colorize_err: bool,
}

impl std::fmt::Debug for Screen<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Screen")
            .field("colorize_out", &self.colorize_out)
            .field("colorize_err", &self.colorize_err)
            .finish_non_exhaustive()
    }
}

impl Screen<'_> {
    fn line(&mut self, text: &str) {
        let _shown = writeln!(self.out, "{text}");
    }

    fn failed(&mut self, text: &str) -> u8 {
        let _shown = writeln!(self.err, "{}", fail(text, self.colorize_err));
        FAILURE
    }
}

#[must_use]
pub fn parse_request(args: &[OsString]) -> Option<Request> {
    let mut wanted = None;
    let mut check = false;

    for arg in args {
        match arg.to_str()? {
            CHECK_FLAG => check = true,
            word if wanted.is_none() => wanted = Some(parse_wanted(word)?),
            _ => return None,
        }
    }

    Some(Request {
        wanted: wanted.unwrap_or(Wanted::Default),
        check,
    })
}

fn parse_wanted(word: &str) -> Option<Wanted> {
    if let Some(channel) = Channel::ALL
        .into_iter()
        .find(|channel| channel.name() == word)
    {
        return Some(Wanted::Channel(channel));
    }

    let version = word.strip_prefix('v').unwrap_or(word);

    Version::parse(version)
        .ok()
        .map(|parsed| Wanted::Version(parsed.to_string()))
}

#[must_use]
pub fn parse_dist_tags(bytes: &[u8]) -> Option<Newest> {
    let tags: Value = serde_json::from_slice(bytes).ok()?;
    let mut found: Vec<(Channel, Version)> = Vec::new();

    for (tag, value) in tags.as_object()? {
        let version = Version::parse(value.as_str()?).ok()?;
        let channel = Channel::of(&version.to_string());

        if matches!(
            (tag.as_str(), channel),
            ("latest", Channel::Stable)
                | ("beta" | "next", Channel::Beta)
                | ("alpha", Channel::Alpha)
        ) {
            found.push((channel, version));
        }
    }

    let newest_of = |wanted: Channel| {
        found
            .iter()
            .filter(|(channel, _)| *channel == wanted)
            .map(|(_, version)| version)
            .max()
            .map(Version::to_string)
    };

    Some(Newest {
        stable: newest_of(Channel::Stable),
        beta: newest_of(Channel::Beta),
        alpha: newest_of(Channel::Alpha),
    })
}

#[must_use]
pub fn recommended(current: &str, newest: &Newest) -> Channel {
    if newest.stable.is_some() {
        Channel::Stable
    } else {
        Channel::of(current)
    }
}

const NPM_OS_NAMES: [(&str, &str); 2] = [("macos", "darwin"), ("windows", "win32")];
const NPM_ARCH_NAMES: [(&str, &str); 2] = [("x86_64", "x64"), ("aarch64", "arm64")];

fn npm_name<'a>(names: &[(&str, &'a str)], value: &'a str) -> &'a str {
    names
        .iter()
        .find(|(rust, _)| *rust == value)
        .map_or(value, |(_, npm)| npm)
}

#[must_use]
pub fn npm_platform(os: &str, arch: &str) -> String {
    format!(
        "{}-{}",
        npm_name(&NPM_OS_NAMES, os),
        npm_name(&NPM_ARCH_NAMES, arch)
    )
}

#[must_use]
pub fn platform() -> String {
    npm_platform(std::env::consts::OS, std::env::consts::ARCH)
}

#[must_use]
pub fn asset_name() -> String {
    let extension = if cfg!(windows) { ".exe" } else { "" };

    format!("bcct-{}{extension}", platform())
}

#[must_use]
pub fn hash_from_checksums(text: &str, version: &str, asset: &str) -> Option<String> {
    text.lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .find_map(|line| {
            let mut words = line.split_whitespace();
            let found = (words.next()?, words.next()?, words.next()?);

            (found.0 == version && found.1 == asset).then(|| found.2.to_owned())
        })
}

#[must_use]
pub fn parse_plugins(text: &str) -> Option<Plugins> {
    let list: Value = serde_json::from_str(text).ok()?;
    let suffix = format!("@{MARKETPLACE_NAME}");
    let mut ids = Vec::new();
    let mut hooks = None;

    for plugin in list.as_array()? {
        let Some(id) = plugin["id"].as_str().filter(|id| id.ends_with(&suffix)) else {
            continue;
        };

        ids.push((id.to_owned(), plugin["enabled"].as_bool() != Some(false)));

        if id == HOOKS_PLUGIN_ID {
            hooks = Some((
                plugin["version"].as_str()?.to_owned(),
                PathBuf::from(plugin["installPath"].as_str()?),
            ));
        }
    }

    let (hooks_version, hooks_path) = hooks?;

    Some(Plugins {
        ids,
        hooks_version,
        hooks_path,
    })
}

#[must_use]
pub fn failure_line(output: &str) -> Option<String> {
    output
        .lines()
        .find(|line| line.contains(FAILURE_MARK))
        .map(|line| {
            line.trim()
                .trim_start_matches(FAILURE_MARK)
                .trim()
                .to_owned()
        })
}

fn source_ref(source: &str) -> &str {
    source
        .rsplit_once('#')
        .map_or(source, |(_, reference)| reference)
}

fn joined(items: &[String], last: &str) -> String {
    let mut text = String::new();

    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            text.push_str(if index + 1 == items.len() { last } else { ", " });
        }

        text.push_str(item);
    }

    text
}

fn channel_label(channel: Channel, messages: &Messages) -> &'static str {
    let names = messages.version_channels;

    match channel {
        Channel::Stable => names.stable,
        Channel::Beta => names.beta,
        Channel::Alpha => names.alpha,
    }
}

enum Fetched {
    Found(Vec<u8>),
    Missing,
}

fn fetch(world: &World<'_>, url: &str) -> Result<Fetched, String> {
    match (world.get)(url)? {
        (HTTP_OK, body) => Ok(Fetched::Found(body)),
        (HTTP_NOT_FOUND, _) => Ok(Fetched::Missing),
        (status, _) => Err(format!("HTTP {status}")),
    }
}

struct Run<'a, 'b> {
    world: &'a World<'b>,
    messages: &'static Messages,
    screen: Screen<'a>,
    store: Store,
}

impl Run<'_, '_> {
    fn newest(&mut self) -> Result<Newest, u8> {
        let texts = self.messages.update;
        let url = format!("{}/-/package/{PACKAGE}/dist-tags", self.world.npm_root);

        match fetch(self.world, &url) {
            Ok(Fetched::Found(body)) => {
                parse_dist_tags(&body).ok_or_else(|| self.screen.failed(texts.bad_list))
            }
            Ok(Fetched::Missing) => Err(self.screen.failed(texts.bad_list)),
            Err(reason) => Err(self.screen.failed(&(texts.npm_failed)(&reason))),
        }
    }

    fn newest_list(&self, newest: &Newest) -> String {
        Channel::ALL
            .into_iter()
            .filter_map(|channel| {
                newest
                    .of(channel)
                    .map(|version| format!("{} {version}", channel_label(channel, self.messages)))
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    fn existing(&mut self, version: &str, newest: &Newest) -> Result<String, u8> {
        let texts = self.messages.update;
        let url = format!("{}/{PACKAGE}/{version}", self.world.npm_root);

        match fetch(self.world, &url) {
            Ok(Fetched::Found(_)) => Ok(version.to_owned()),
            Ok(Fetched::Missing) => {
                let list = self.newest_list(newest);
                Err(self.screen.failed(&(texts.no_version)(version, &list)))
            }
            Err(reason) => Err(self.screen.failed(&(texts.npm_failed)(&reason))),
        }
    }

    fn of_channel(&mut self, channel: Channel, newest: &Newest) -> Result<String, u8> {
        let label = channel_label(channel, self.messages);

        newest.of(channel).map(str::to_owned).ok_or_else(|| {
            self.screen
                .failed(&(self.messages.update.no_channel)(label))
        })
    }

    fn chosen(&mut self, current: &str, newest: &Newest, ask: &mut dyn Prompter) -> Option<String> {
        let texts = self.messages.update;
        let options: Vec<(Channel, String)> = [Channel::Alpha, Channel::Beta, Channel::Stable]
            .into_iter()
            .filter_map(|channel| {
                newest
                    .of(channel)
                    .map(|version| (channel, version.to_owned()))
            })
            .collect();
        let pick = recommended(current, newest);
        let default = options
            .iter()
            .position(|(channel, _)| *channel == pick)
            .unwrap_or_default();

        if !ask.interactive() {
            let mut ordered: Vec<&(Channel, String)> = options.iter().collect();
            ordered.sort_by_key(|(channel, _)| *channel != pick);
            let listed: Vec<String> = ordered
                .into_iter()
                .map(|(channel, version)| (texts.pick_option)(channel.name(), version))
                .collect();
            let text = (texts.pick)(current, &joined(&listed, texts.or));
            self.screen.line(&skipped(&text, self.screen.colorize_out));
            return None;
        }

        self.screen.line(&(texts.unstable_intro)(
            Channel::of(current).name(),
            current,
        ));

        for (index, (channel, version)) in options.iter().enumerate() {
            let shown = match channel {
                Channel::Alpha => (texts.newest_alpha)(version),
                Channel::Beta => (texts.newest_beta)(version),
                Channel::Stable => (texts.newest_stable_option)(version),
            };
            let current_mark = if version == current {
                format!(" {}", texts.the_current)
            } else {
                String::new()
            };

            self.screen
                .line(&format!("  {}. {shown}{current_mark}", index + 1));
        }

        let numbers: Vec<String> = (1..=options.len())
            .map(|number| number.to_string())
            .collect();
        let question = (texts.which)(&numbers.join(", "), &(default + 1).to_string());

        loop {
            let answer = ask.line(&question, self.messages).ok()?;
            let trimmed = answer.trim();

            if trimmed.is_empty() {
                return options.get(default).map(|(_, version)| version.clone());
            }

            if let Some(found) = trimmed
                .parse::<usize>()
                .ok()
                .and_then(|number| number.checked_sub(1))
                .and_then(|index| options.get(index))
            {
                return Some(found.1.clone());
            }
        }
    }

    fn target(
        &mut self,
        request: &Request,
        current: &str,
        newest: &Newest,
        ask: &mut dyn Prompter,
    ) -> Result<Option<String>, u8> {
        match &request.wanted {
            Wanted::Version(version) => self.existing(version, newest).map(Some),
            Wanted::Channel(channel) => self.of_channel(*channel, newest).map(Some),
            Wanted::Default if Channel::of(current).is_unstable() => {
                Ok(self.chosen(current, newest, ask))
            }
            Wanted::Default => self.of_channel(Channel::Stable, newest).map(Some),
        }
    }

    fn plugins(&mut self) -> Result<Plugins, u8> {
        let texts = self.messages.update;

        if !(self.world.has_command)("claude") {
            return Err(self.screen.failed(texts.no_plugins));
        }

        parse_plugins(&(self.world.claude)(&["plugin", "list", "--json"]))
            .ok_or_else(|| self.screen.failed(texts.no_plugins))
    }

    fn claude_step(&mut self, args: &[&str]) -> Result<(), u8> {
        let output = (self.world.claude)(args);

        failure_line(&output).map_or(Ok(()), |line| {
            Err(self
                .screen
                .failed(&(self.messages.update.plugin_failed)(&line)))
        })
    }

    fn update_plugins(&mut self, plugins: &Plugins, target: &str) -> Result<Plugins, u8> {
        let texts = self.messages.update;
        let from = marketplace_source(&plugins.hooks_version);
        let to = marketplace_source(target);

        if from == to {
            self.claude_step(&["plugin", "marketplace", "update", MARKETPLACE_NAME])?;

            for (id, _) in &plugins.ids {
                self.claude_step(&["plugin", "update", id])?;
            }
        } else {
            let colorize = self.screen.colorize_out;
            self.screen.line(&info(
                &format!(
                    "ℹ {}",
                    (texts.switching)(source_ref(&from), source_ref(&to))
                ),
                colorize,
            ));
            self.claude_step(&["plugin", "marketplace", "remove", MARKETPLACE_NAME])?;
            self.claude_step(&["plugin", "marketplace", "add", &to])?;

            for (id, _) in &plugins.ids {
                self.claude_step(&["plugin", "install", id, "--scope", "user"])?;
            }

            for (id, enabled) in &plugins.ids {
                if !enabled {
                    self.claude_step(&["plugin", "disable", id, "--scope", "user"])?;
                }
            }
        }

        let updated = self.plugins()?;

        if updated.hooks_version != target {
            return Err(self
                .screen
                .failed(&(texts.plugin_stayed)(&updated.hooks_version, target)));
        }

        let colorize = self.screen.colorize_out;
        self.screen.line(&success(
            &(texts.plugins)(&plugins.hooks_version, target),
            colorize,
        ));

        Ok(updated)
    }

    fn update_binary(&mut self, plugins: &Plugins, from: &str, target: &str) -> Result<(), u8> {
        let texts = self.messages.update;
        let asset = asset_name();
        let checksums =
            fs::read_to_string(plugins.hooks_path.join(CHECKSUMS_FILE)).unwrap_or_default();
        let Some(hash) = hash_from_checksums(&checksums, target, &asset) else {
            return Err(self.screen.failed(&(texts.no_hash)(target, &platform())));
        };
        let versions = self.world.app_dir.join("bin").join("versions");
        let downloaded = fs::create_dir_all(&versions)
            .and_then(|()| {
                tempfile::Builder::new()
                    .prefix(".download-")
                    .tempfile_in(&versions)
            })
            .map_err(|error| {
                self.screen
                    .failed(&(texts.download_failed)(target, &error.kind().to_string()))
            })?;
        let url = format!("{}/v{target}/{asset}", self.world.releases_root);

        match (self.world.download)(&url, downloaded.path()) {
            Ok(HTTP_OK) => {}
            Ok(status) => {
                return Err(self
                    .screen
                    .failed(&(texts.download_failed)(target, &format!("HTTP {status}"))));
            }
            Err(reason) => {
                return Err(self
                    .screen
                    .failed(&(texts.download_failed)(target, &reason)));
            }
        }

        match self
            .store
            .install(downloaded.path(), &hash, Origin::Release)
        {
            Ok(_) => {
                let colorize = self.screen.colorize_out;
                self.screen
                    .line(&success(&(texts.binary)(from, target), colorize));
                Ok(())
            }
            Err(failure) => {
                let reason = match failure {
                    InstallError::HashMismatch => texts.hash_mismatch.to_owned(),
                    InstallError::NotBcct => (texts.not_bcct)(target),
                    InstallError::Io(error) => error.kind().to_string(),
                };
                Err(self.screen.failed(&(texts.binary_failed)(target, &reason)))
            }
        }
    }

    fn cleanup(&mut self, ask: &mut dyn Prompter) {
        let texts = self.messages.update;
        let kept = self.store.unstable_versions();

        if kept.len() <= 2 || !ask.interactive() {
            return;
        }

        let count = u64::try_from(kept.len()).unwrap_or(u64::MAX);
        let question = (texts.cleanup_question)(count, &kept.join(", "));
        let Ok(answer) = ask.line(&question, self.messages) else {
            return;
        };

        if !matches!(answer.trim().chars().next(), Some('s' | 'S' | 'y' | 'Y')) {
            return;
        }

        let removed: Vec<String> = kept
            .into_iter()
            .filter(|version| self.store.remove(version).is_ok())
            .collect();

        if !removed.is_empty() {
            let colorize = self.screen.colorize_out;
            self.screen.line(&success(
                &(texts.cleaned)(&joined(&removed, texts.and)),
                colorize,
            ));
        }
    }

    fn run(&mut self, request: &Request, ask: &mut dyn Prompter) -> u8 {
        let texts = self.messages.update;
        let current = self
            .store
            .active()
            .map_or_else(|| self.world.running.to_owned(), |active| active.version);

        self.screen.line(texts.looking);

        let newest = match self.newest() {
            Ok(newest) => newest,
            Err(code) => return code,
        };
        let target = match self.target(request, &current, &newest, ask) {
            Ok(Some(target)) => target,
            Ok(None) => return SUCCESS,
            Err(code) => return code,
        };
        let plugins = match self.plugins() {
            Ok(plugins) => plugins,
            Err(code) => return code,
        };

        if target == current && target == plugins.hooks_version {
            let text = if request.wanted == Wanted::Default && !Channel::of(&target).is_unstable() {
                (texts.newest_stable)(&target)
            } else {
                (texts.already)(&target)
            };
            let colorize = self.screen.colorize_out;
            self.screen.line(&skipped(&text, colorize));
            return SUCCESS;
        }

        if request.check {
            self.screen.line(&(texts.check)(&current, &target));
            return SUCCESS;
        }

        if !(self.world.has_command)("git") {
            return self.screen.failed(texts.no_git);
        }

        let plugins = if plugins.hooks_version == target {
            plugins
        } else {
            match self.update_plugins(&plugins, &target) {
                Ok(updated) => updated,
                Err(code) => return code,
            }
        };

        if current != target
            && let Err(code) = self.update_binary(&plugins, &current, &target)
        {
            return code;
        }

        self.cleanup(ask);
        self.screen.line(texts.reload);

        let channel = Channel::of(&target);

        if channel.is_unstable() {
            let colorize = self.screen.colorize_out;
            self.screen.line(&warn(
                &(self.messages.version_unstable)(channel.name()),
                colorize,
            ));
        }

        SUCCESS
    }
}

pub fn run_with<'a>(
    args: &[OsString],
    world: &'a World<'a>,
    messages: &'static Messages,
    screen: Screen<'a>,
    ask: &mut dyn Prompter,
) -> u8 {
    let Some(request) = parse_request(args) else {
        let _shown = writeln!(screen.err, "{}", messages.update.usage);
        return USAGE;
    };
    let mut run = Run {
        world,
        messages,
        screen,
        store: Store::new(world.app_dir),
    };

    run.run(&request, ask)
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(MAX_REDIRECTS)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .timeout_recv_body(Some(BODY_TIMEOUT))
        .build()
        .into()
}

#[must_use]
pub fn reason_of(error: &ureq::Error) -> String {
    match error {
        ureq::Error::Timeout(_) => "timed out".to_owned(),
        ureq::Error::Io(error) => error.kind().to_string(),
        ureq::Error::HostNotFound => "host not found".to_owned(),
        ureq::Error::ConnectionFailed => "connection failed".to_owned(),
        _ => "request failed".to_owned(),
    }
}

pub fn http_get(url: &str) -> Result<(u16, Vec<u8>), String> {
    let mut response = agent().get(url).call().map_err(|error| reason_of(&error))?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(LIST_LIMIT)
        .read_to_vec()
        .map_err(|error| reason_of(&error))?;

    Ok((status, body))
}

pub fn http_download(url: &str, file: &Path) -> Result<u16, String> {
    let mut response = agent().get(url).call().map_err(|error| reason_of(&error))?;
    let status = response.status().as_u16();

    if status != HTTP_OK {
        return Ok(status);
    }

    let mut reader = response
        .body_mut()
        .with_config()
        .limit(DOWNLOAD_LIMIT)
        .reader();
    let mut output = fs::File::create(file).map_err(|error| error.kind().to_string())?;

    io::copy(&mut reader, &mut output).map_err(|error| error.kind().to_string())?;

    Ok(status)
}

fn claude_with_errors(args: &[&str]) -> String {
    Command::new("claude")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map(|output| {
            let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&output.stderr));
            text
        })
        .unwrap_or_default()
}

fn with_process_world<T>(
    run: impl FnOnce(&World<'_>, &'static Messages, &dyn Fn(&str) -> Option<OsString>) -> T,
) -> T {
    let paths = Paths::from_process();
    let var = |name: &str| std::env::var_os(name);
    let messages = messages_for(setup_locale(&paths.app_dir, &var));
    let root = |name: &str, fallback: String| {
        var(name)
            .map(|value| value.to_string_lossy().trim_end_matches('/').to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback)
    };
    let npm_root = root(NPM_ROOT_ENV, NPM_ROOT.to_owned());
    let releases_root = root(
        RELEASES_ROOT_ENV,
        format!("https://github.com/{MARKETPLACE_REPO}/releases/download"),
    );
    let world = World {
        app_dir: &paths.app_dir,
        running: env!("CARGO_PKG_VERSION"),
        claude: &claude_with_errors,
        has_command: &has_command,
        get: &http_get,
        download: &http_download,
        npm_root: &npm_root,
        releases_root: &releases_root,
    };

    run(&world, messages, &var)
}

pub fn run_process(args: &[OsString], stdout: &mut dyn Write, stderr: &mut dyn Write) -> u8 {
    with_process_world(|world, messages, var| {
        let screen = Screen {
            out: stdout,
            err: stderr,
            colorize_out: should_colorize(var, io::stdout().is_terminal()),
            colorize_err: should_colorize(var, io::stderr().is_terminal()),
        };
        let mut ask = create_prompter(var);

        run_with(args, world, messages, screen, &mut *ask)
    })
}

pub fn run_quietly(version: &str) -> Result<(), String> {
    with_process_world(|world, messages, _| quietly(world, messages, version))
}

pub fn quietly(
    world: &World<'_>,
    messages: &'static Messages,
    version: &str,
) -> Result<(), String> {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let screen = Screen {
        out: &mut out,
        err: &mut err,
        colorize_out: false,
        colorize_err: false,
    };
    let code = run_with(
        &[OsString::from(version)],
        world,
        messages,
        screen,
        &mut FakePrompter::new(false),
    );

    if code == SUCCESS {
        return Ok(());
    }

    let text = String::from_utf8_lossy(&err);

    Err(text
        .lines()
        .next()
        .unwrap_or_default()
        .trim_start_matches(FAILURE_MARK)
        .trim()
        .to_owned())
}
