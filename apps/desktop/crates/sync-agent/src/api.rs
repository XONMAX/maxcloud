//! Minimal blocking client for the MaxCloud API (native mode: tokens in body, X-Client: desktop).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sync_core::limiter::TokenBucket;

#[derive(Debug)]
pub enum ApiError {
    Http(u16, String),
    Transport(String),
    Io(std::io::Error),
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Http(s, m) => write!(f, "HTTP {s}: {m}"),
            ApiError::Transport(m) => write!(f, "network: {m}"),
            ApiError::Io(e) => write!(f, "io: {e}"),
        }
    }
}
impl std::error::Error for ApiError {}
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        ApiError::Io(e)
    }
}
pub type Result<T> = std::result::Result<T, ApiError>;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteNode {
    pub id: String,
    pub parent_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub name: String,
    pub size: u64,
    pub sha256: Option<String>,
}

pub struct Client {
    base: String,
    agent: ureq::Agent,
    pub tokens: Mutex<Tokens>,
    started: Instant,
    pub upload_limit: Mutex<TokenBucket>,
    pub download_limit: Mutex<TokenBucket>,
    device: String,
}

fn map_err(e: ureq::Error) -> ApiError {
    match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["message"].as_str().map(String::from)).unwrap_or(body);
            ApiError::Http(code, msg)
        }
        ureq::Error::Transport(t) => ApiError::Transport(t.to_string()),
    }
}

impl Client {
    pub fn new(base: &str, device: &str, upload_bps: u64, download_bps: u64) -> Self {
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(300)).build();
        Client {
            base: base.trim_end_matches('/').to_string(),
            agent,
            tokens: Mutex::new(Tokens::default()),
            started: Instant::now(),
            upload_limit: Mutex::new(TokenBucket::new(upload_bps, Duration::ZERO)),
            download_limit: Mutex::new(TokenBucket::new(download_bps, Duration::ZERO)),
            device: device.to_string(),
        }
    }

    fn req(&self, method: &str, path: &str) -> ureq::Request {
        let t = self.tokens.lock().unwrap().access_token.clone();
        self.agent
            .request(method, &format!("{}{}", self.base, path))
            .set("X-Client", "desktop")
            .set("X-Device-Name", &self.device)
            .set("User-Agent", "MaxCloud-Desktop/0.1")
            .set("Authorization", &format!("Bearer {t}"))
    }

    /// JSON call with one transparent token refresh on 401.
    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
        for attempt in 0..2 {
            let r = match &body {
                Some(b) => self.req(method, path).send_json(b.clone()),
                None => self.req(method, path).call(),
            };
            match r {
                Ok(resp) => return resp.into_json::<Value>().map_err(ApiError::Io),
                Err(ureq::Error::Status(401, _)) if attempt == 0 => self.refresh()?,
                Err(e) => return Err(map_err(e)),
            }
        }
        unreachable!()
    }

    pub fn login(&self, email: &str, password: &str, totp: Option<&str>) -> Result<Tokens> {
        let v: Value = self
            .agent
            .post(&format!("{}/auth/login", self.base))
            .set("X-Client", "desktop")
            .set("X-Device-Name", &self.device)
            .send_json(match totp {
                Some(code) => json!({ "email": email, "password": password, "totp": code }),
                None => json!({ "email": email, "password": password }),
            })
            .map_err(map_err)?
            .into_json()?;
        let t = Tokens { access_token: v["accessToken"].as_str().unwrap_or_default().into(), refresh_token: v["refreshToken"].as_str().unwrap_or_default().into() };
        *self.tokens.lock().unwrap() = t.clone();
        Ok(t)
    }

    pub fn refresh(&self) -> Result<()> {
        let rt = self.tokens.lock().unwrap().refresh_token.clone();
        let v: Value = self
            .agent
            .post(&format!("{}/auth/refresh", self.base))
            .set("X-Client", "desktop")
            .send_json(json!({ "refreshToken": rt }))
            .map_err(map_err)?
            .into_json()?;
        *self.tokens.lock().unwrap() = Tokens { access_token: v["accessToken"].as_str().unwrap_or_default().into(), refresh_token: v["refreshToken"].as_str().unwrap_or_default().into() };
        Ok(())
    }

    pub fn tree(&self) -> Result<Vec<RemoteNode>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let q = match &cursor {
                Some(c) => format!("/files/tree?limit=5000&cursor={c}"),
                None => "/files/tree?limit=5000".into(),
            };
            let v = self.call("GET", &q, None)?;
            let items: Vec<RemoteNode> = serde_json::from_value(v["items"].clone()).map_err(|e| ApiError::Transport(e.to_string()))?;
            out.extend(items);
            match v["nextCursor"].as_str() {
                Some(c) => cursor = Some(c.to_string()),
                None => return Ok(out),
            }
        }
    }

    pub fn mkdir(&self, name: &str, parent: Option<&str>) -> Result<String> {
        let v = self.call("POST", "/folders", Some(json!({ "name": name, "parentId": parent })))?;
        Ok(v["id"].as_str().unwrap_or_default().to_string())
    }

    /// Moves to the server Trash (recoverable for 30 days) rather than deleting.
    pub fn trash(&self, id: &str) -> Result<()> {
        self.call("DELETE", &format!("/files/{id}"), None).map(|_| ())
    }

    fn throttle(&self, bucket: &Mutex<TokenBucket>, n: u64) {
        let wait = bucket.lock().unwrap().take(n, self.started.elapsed());
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
    }

    /// Resumable multipart upload straight to storage. Returns the node id.
    pub fn upload(&self, path: &Path, name: &str, parent: Option<&str>, sha256: &str) -> Result<String> {
        let size = std::fs::metadata(path)?.len();
        let init = self.call("POST", "/uploads", Some(json!({ "name": name, "parentId": parent, "size": size, "sha256": sha256 })))?;
        let upload_id = init["uploadId"].as_str().unwrap_or_default().to_string();
        let part_size = init["partSize"].as_u64().unwrap_or(8 << 20);
        let part_count = init["partCount"].as_u64().unwrap_or(1);
        let mut file = File::open(path)?;
        if size > 0 {
            for first in (1..=part_count).step_by(50) {
                let nums: Vec<u64> = (first..=(first + 49).min(part_count)).collect();
                let signed = self.call("POST", &format!("/uploads/{upload_id}/parts"), Some(json!({ "partNumbers": nums })))?;
                for p in signed["parts"].as_array().cloned().unwrap_or_default() {
                    let n = p["partNumber"].as_u64().unwrap_or(1);
                    let url = p["url"].as_str().unwrap_or_default();
                    let len = part_size.min(size - (n - 1) * part_size);
                    let mut buf = vec![0u8; len as usize];
                    file.seek(SeekFrom::Start((n - 1) * part_size))?;
                    file.read_exact(&mut buf)?;
                    self.throttle(&self.upload_limit, len);
                    let mut tries = 0;
                    loop {
                        match self.agent.put(url).send_bytes(&buf) {
                            Ok(_) => break,
                            Err(e) if tries < 5 => {
                                tries += 1;
                                eprintln!("part {n} failed ({}), retrying", map_err(e));
                                std::thread::sleep(Duration::from_secs(1 << tries));
                            }
                            Err(e) => return Err(map_err(e)),
                        }
                    }
                }
            }
        }
        let node = self.call("POST", &format!("/uploads/{upload_id}/complete"), Some(json!({ "parts": [] })))?;
        Ok(node["id"].as_str().unwrap_or_default().to_string())
    }

    /// Download to `dest` via a temporary file, renamed into place only when complete.
    pub fn download(&self, id: &str, dest: &Path) -> Result<()> {
        let v = self.call("GET", &format!("/files/{id}/download"), None)?;
        let url = v["url"].as_str().unwrap_or_default();
        let resp = self.agent.get(url).call().map_err(map_err)?;
        let tmp = dest.with_extension(format!("{}.partial", dest.extension().and_then(|e| e.to_str()).unwrap_or("")));
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = File::create(&tmp)?;
        let mut reader = resp.into_reader();
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            self.throttle(&self.download_limit, n as u64);
            out.write_all(&buf[..n])?;
        }
        out.sync_all()?;
        std::fs::rename(&tmp, dest)?;
        Ok(())
    }
}
