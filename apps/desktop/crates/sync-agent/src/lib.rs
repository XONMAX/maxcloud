//! MaxCloud desktop sync engine. `sync_once` = scan disk + fetch server tree -> sync-core plan -> execute.
pub mod api;

use api::{ApiError, Client, RemoteNode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use sync_core::{is_excluded, is_ignored, plan, Action, BaseEntry, LocalEntry, RelPath, RemoteEntry, SyncConfig};

/// Persisted in `<root>/.maxcloud/state.json`.
#[derive(Default, Serialize, Deserialize)]
pub struct State {
    /// path -> (hash, is_dir) after the last successful sync
    pub base: BTreeMap<RelPath, (Option<String>, bool)>,
    /// path -> (size, mtime, sha256): avoids re-hashing unchanged files
    pub hash_cache: HashMap<RelPath, (u64, u64, String)>,
}

impl State {
    pub fn load(root: &Path) -> State {
        std::fs::read(root.join(".maxcloud/state.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }
    pub fn save(&self, root: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(root.join(".maxcloud"))?;
        let tmp = root.join(".maxcloud/state.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, root.join(".maxcloud/state.json"))
    }
}

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

fn rel(root: &Path, p: &Path) -> RelPath {
    p.strip_prefix(root).unwrap().components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

pub fn scan_local(root: &Path, state: &mut State, cfg: &SyncConfig) -> std::io::Result<BTreeMap<RelPath, LocalEntry>> {
    let mut out = BTreeMap::new();
    for entry in walkdir::WalkDir::new(root).min_depth(1).into_iter().filter_entry(|e| e.file_name() != ".maxcloud") {
        let entry = entry.map_err(std::io::Error::other)?;
        let path = rel(root, entry.path());
        if is_ignored(&path) || is_excluded(&path, cfg) {
            continue;
        }
        let md = entry.metadata().map_err(std::io::Error::other)?;
        if md.is_dir() {
            out.insert(path, LocalEntry { hash: String::new(), size: 0, is_dir: true });
        } else if md.is_file() {
            let mtime = md.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos() as u64).unwrap_or(0);
            let hash = match state.hash_cache.get(&path) {
                Some((s, m, h)) if *s == md.len() && *m == mtime => h.clone(),
                _ => {
                    let h = sha256_file(entry.path())?;
                    state.hash_cache.insert(path.clone(), (md.len(), mtime, h.clone()));
                    h
                }
            };
            out.insert(path, LocalEntry { hash, size: md.len(), is_dir: false });
        }
    }
    Ok(out)
}

/// Rebuild "a/b/c" paths from the flat server tree.
pub fn remote_paths(nodes: &[RemoteNode]) -> BTreeMap<RelPath, RemoteEntry> {
    let by_id: HashMap<&str, &RemoteNode> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut out = BTreeMap::new();
    'nodes: for n in nodes {
        let mut parts = vec![n.name.clone()];
        let mut cur = n.parent_id.as_deref();
        let mut guard = 0;
        while let Some(pid) = cur {
            match by_id.get(pid) {
                Some(p) => {
                    parts.push(p.name.clone());
                    cur = p.parent_id.as_deref();
                }
                None => continue 'nodes, // parent not owned/visible: skip
            }
            guard += 1;
            if guard > 200 {
                continue 'nodes;
            }
        }
        parts.reverse();
        let is_dir = n.kind == "FOLDER";
        out.insert(parts.join("/"), RemoteEntry { id: n.id.clone(), hash: if is_dir { None } else { n.sha256.clone() }, size: n.size, is_dir });
    }
    out
}

#[derive(Debug, Default)]
pub struct Report {
    pub uploaded: usize,
    pub downloaded: usize,
    pub deleted_local: usize,
    pub deleted_remote: usize,
    pub conflicts: usize,
    pub errors: Vec<String>,
}

pub fn sync_once(client: &Client, root: &Path, cfg: &SyncConfig) -> Result<Report, ApiError> {
    let mut state = State::load(root);
    let local = scan_local(root, &mut state, cfg)?;
    let mut remote = remote_paths(&client.tree()?);
    let base: BTreeMap<RelPath, BaseEntry> = state.base.iter().map(|(k, (h, d))| (k.clone(), BaseEntry { hash: h.clone(), is_dir: *d })).collect();
    let actions = plan(&local, &remote, &base, cfg);
    let mut report = Report::default();
    let abs = |p: &str| -> PathBuf { root.join(p) };
    let parent_of = |p: &str| p.rsplit_once('/').map(|(a, _)| a.to_string());
    let name_of = |p: &str| p.rsplit('/').next().unwrap_or(p).to_string();

    for action in actions {
        let res: Result<(), ApiError> = (|| {
            match &action {
                Action::CreateRemoteDir(p) => {
                    let parent = parent_of(p).and_then(|pp| remote.get(&pp).map(|e| e.id.clone()));
                    let id = client.mkdir(&name_of(p), parent.as_deref())?;
                    remote.insert(p.clone(), RemoteEntry { id, hash: None, size: 0, is_dir: true });
                    state.base.insert(p.clone(), (None, true));
                }
                Action::CreateLocalDir(p) => {
                    std::fs::create_dir_all(abs(p))?;
                    state.base.insert(p.clone(), (None, true));
                }
                Action::Upload(p) => {
                    let hash = local[p].hash.clone();
                    let parent = parent_of(p).and_then(|pp| remote.get(&pp).map(|e| e.id.clone()));
                    let id = client.upload(&abs(p), &name_of(p), parent.as_deref(), &hash)?;
                    remote.insert(p.clone(), RemoteEntry { id, hash: Some(hash.clone()), size: local[p].size, is_dir: false });
                    state.base.insert(p.clone(), (Some(hash), false));
                    report.uploaded += 1;
                }
                Action::Download(p) => {
                    let r = remote[p].clone();
                    client.download(&r.id, &abs(p))?;
                    state.hash_cache.remove(p);
                    state.base.insert(p.clone(), (r.hash.clone(), false));
                    report.downloaded += 1;
                }
                Action::DeleteRemote(p) => {
                    if let Some(r) = remote.get(p) {
                        client.trash(&r.id).or_else(|e| if matches!(e, ApiError::Http(404, _)) { Ok(()) } else { Err(e) })?;
                    }
                    state.base.remove(p);
                    report.deleted_remote += 1;
                }
                Action::DeleteLocal(p) => {
                    let a = abs(p);
                    if a.is_dir() {
                        // only remove if empty: never silently drop unsynced local files
                        let _ = std::fs::remove_dir(&a);
                    } else if a.exists() {
                        std::fs::remove_file(&a)?;
                    }
                    state.base.remove(p);
                    state.hash_cache.remove(p);
                    report.deleted_local += 1;
                }
                Action::Conflict { path, rename_local_to } => {
                    std::fs::rename(abs(path), abs(rename_local_to))?;
                    let r = remote[path].clone();
                    if !r.is_dir {
                        client.download(&r.id, &abs(path))?;
                    } else {
                        std::fs::create_dir_all(abs(path))?;
                    }
                    state.base.insert(path.clone(), (r.hash.clone(), r.is_dir));
                    // the conflict copy is uploaded on the next round (it's a new local file)
                    report.conflicts += 1;
                }
                Action::MarkSynced(p) => {
                    let hash = local.get(p).filter(|l| !l.is_dir).map(|l| l.hash.clone());
                    state.base.insert(p.clone(), (hash, local.get(p).map(|l| l.is_dir).unwrap_or(false)));
                }
            }
            Ok(())
        })();
        if let Err(e) = res {
            report.errors.push(format!("{action:?}: {e}"));
        }
    }
    // Paths gone on both sides: forget them.
    state.base.retain(|k, _| local.contains_key(k) || remote.contains_key(k));
    state.save(root)?;
    Ok(report)
}

/// "YYYY-MM-DD" (UTC) for conflict-copy names, without a date library.
pub fn today_utc() -> String {
    let days = (std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() / 86400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use api::RemoteNode;

    #[test]
    fn today_is_iso_date() {
        let t = today_utc();
        assert_eq!(t.len(), 10);
        assert!(t.starts_with("20"));
    }

    #[test]
    fn rebuilds_paths_from_flat_tree() {
        let n = |id: &str, parent: Option<&str>, kind: &str, name: &str| RemoteNode { id: id.into(), parent_id: parent.map(Into::into), kind: kind.into(), name: name.into(), size: 1, sha256: Some("h".into()) };
        let tree = vec![n("1", None, "FOLDER", "Docs"), n("2", Some("1"), "FOLDER", "2026"), n("3", Some("2"), "FILE", "a.txt"), n("4", Some("missing"), "FILE", "orphan.txt")];
        let m = remote_paths(&tree);
        assert_eq!(m.keys().cloned().collect::<Vec<_>>(), vec!["Docs", "Docs/2026", "Docs/2026/a.txt"]);
        assert!(m["Docs"].hash.is_none());
        assert_eq!(m["Docs/2026/a.txt"].hash.as_deref(), Some("h"));
    }
}
