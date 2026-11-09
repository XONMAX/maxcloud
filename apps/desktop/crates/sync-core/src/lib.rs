//! MaxCloud two-way sync planner.
//!
//! Three-way merge per path between:
//!   * `local`  – what is on disk now (content hash),
//!   * `remote` – what the server has now (content hash + node id),
//!   * `base`   – what both sides agreed on after the last successful sync.
//!
//! The planner is pure: it returns [`Action`]s and never touches the disk or network,
//! so every rule below is covered by unit tests. The agent executes the plan.

pub mod limiter;

use std::collections::{BTreeMap, BTreeSet};

/// Normalised relative path using '/' separators, e.g. "Photos/2026/a.jpg".
pub type RelPath = String;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalEntry {
    pub hash: String,
    pub size: u64,
    pub is_dir: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteEntry {
    pub id: String,
    pub hash: Option<String>,
    pub size: u64,
    pub is_dir: bool,
}

/// State recorded after the last successful sync of a path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BaseEntry {
    pub hash: Option<String>,
    pub is_dir: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Action {
    CreateRemoteDir(RelPath),
    CreateLocalDir(RelPath),
    Upload(RelPath),
    Download(RelPath),
    DeleteRemote(RelPath),
    DeleteLocal(RelPath),
    /// Both sides changed differently: keep the remote at `path`, move the local file to `rename_local_to`, then upload it.
    Conflict { path: RelPath, rename_local_to: RelPath },
    /// Both sides already identical: just record the base.
    MarkSynced(RelPath),
}

#[derive(Clone, Debug, Default)]
pub struct SyncConfig {
    /// Selective sync: remote folders (prefixes) NOT mirrored locally.
    pub excluded: Vec<RelPath>,
    /// Device name used in conflict copy names.
    pub device_name: String,
    /// "YYYY-MM-DD" for conflict copy names (injected for deterministic tests).
    pub today: String,
}

/// Files never synced (OS junk and editor temp files).
pub fn is_ignored(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    let lower = name.to_ascii_lowercase();
    lower == ".ds_store"
        || lower == "thumbs.db"
        || lower == "desktop.ini"
        || name.starts_with("~$")
        || name.starts_with(".~lock.")
        || lower.ends_with(".tmp")
        || lower.ends_with(".partial")
        || name.starts_with(".maxcloud")
}

pub fn is_excluded(path: &str, cfg: &SyncConfig) -> bool {
    cfg.excluded.iter().any(|p| path == p || path.starts_with(&format!("{}/", p.trim_end_matches('/'))))
}

/// "report.pdf" -> "report (conflicted copy from Laptop 2026-11-09).pdf"
pub fn conflict_name(path: &str, device: &str, day: &str) -> String {
    let (dir, file) = match path.rfind('/') {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let (stem, ext) = match file.rfind('.') {
        Some(i) if i > 0 => (&file[..i], &file[i..]),
        _ => (file, ""),
    };
    format!("{dir}{stem} (conflicted copy from {device} {day}){ext}")
}

/// Compute the plan. Directories are created parents-first; deletions children-first.
pub fn plan(
    local: &BTreeMap<RelPath, LocalEntry>,
    remote: &BTreeMap<RelPath, RemoteEntry>,
    base: &BTreeMap<RelPath, BaseEntry>,
    cfg: &SyncConfig,
) -> Vec<Action> {
    let mut paths: BTreeSet<&RelPath> = BTreeSet::new();
    paths.extend(local.keys());
    paths.extend(remote.keys());
    paths.extend(base.keys());

    let mut creates = Vec::new();
    let mut transfers = Vec::new();
    let mut deletes = Vec::new();

    for p in paths {
        if is_ignored(p) || is_excluded(p, cfg) {
            continue;
        }
        let l = local.get(p);
        let r = remote.get(p);
        // Remote file whose content hash the server hasn't computed yet (just uploaded from the web):
        // can't compare safely, retry next round.
        if matches!(r, Some(e) if !e.is_dir && e.hash.is_none()) {
            continue;
        }
        let b = base.get(p);
        let l_hash = l.map(|e| e.hash.clone());
        let r_hash = r.and_then(|e| e.hash.clone());
        let b_hash = b.and_then(|e| e.hash.clone());

        match (l, r, b) {
            (None, None, _) => {} // gone on both sides; agent drops the base entry
            (Some(l), None, None) => creates.push(if l.is_dir { Action::CreateRemoteDir(p.clone()) } else { Action::Upload(p.clone()) }),
            (None, Some(r), None) => creates.push(if r.is_dir { Action::CreateLocalDir(p.clone()) } else { Action::Download(p.clone()) }),
            (Some(l), None, Some(_)) => {
                // Deleted remotely. If the local copy changed since, re-upload instead of losing edits.
                if !l.is_dir && l_hash != b_hash {
                    transfers.push(Action::Upload(p.clone()));
                } else {
                    deletes.push(Action::DeleteLocal(p.clone()));
                }
            }
            (None, Some(r), Some(_)) => {
                // Deleted locally. If the remote changed since, bring it back instead.
                if !r.is_dir && r_hash != b_hash {
                    transfers.push(Action::Download(p.clone()));
                } else {
                    deletes.push(Action::DeleteRemote(p.clone()));
                }
            }
            (Some(l), Some(r), b) => {
                if l.is_dir && r.is_dir {
                    if b.is_none() {
                        transfers.push(Action::MarkSynced(p.clone()));
                    }
                    continue;
                }
                if l.is_dir != r.is_dir {
                    // File vs folder with the same name: keep remote, move local aside.
                    transfers.push(Action::Conflict { path: p.clone(), rename_local_to: conflict_name(p, &cfg.device_name, &cfg.today) });
                    continue;
                }
                if l_hash == r_hash {
                    if b_hash != l_hash {
                        transfers.push(Action::MarkSynced(p.clone()));
                    }
                    continue;
                }
                let local_changed = l_hash != b_hash;
                let remote_changed = r_hash != b_hash;
                match (local_changed, remote_changed) {
                    (true, false) => transfers.push(Action::Upload(p.clone())),
                    (false, true) => transfers.push(Action::Download(p.clone())),
                    _ => transfers.push(Action::Conflict { path: p.clone(), rename_local_to: conflict_name(p, &cfg.device_name, &cfg.today) }),
                }
            }
        }
    }

    let depth = |a: &Action| -> usize {
        let p = match a {
            Action::CreateRemoteDir(p) | Action::CreateLocalDir(p) | Action::Upload(p) | Action::Download(p) | Action::DeleteRemote(p) | Action::DeleteLocal(p) | Action::MarkSynced(p) => p,
            Action::Conflict { path, .. } => path,
        };
        p.matches('/').count()
    };
    creates.sort_by_key(|a| (depth(a), a.clone()));
    deletes.sort_by_key(|a| (std::cmp::Reverse(depth(a)), a.clone()));
    creates.into_iter().chain(transfers).chain(deletes).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(h: &str) -> LocalEntry {
        LocalEntry { hash: h.into(), size: 1, is_dir: false }
    }
    fn d() -> LocalEntry {
        LocalEntry { hash: String::new(), size: 0, is_dir: true }
    }
    fn rf(h: &str) -> RemoteEntry {
        RemoteEntry { id: format!("id-{h}"), hash: Some(h.into()), size: 1, is_dir: false }
    }
    fn rd() -> RemoteEntry {
        RemoteEntry { id: "dir".into(), hash: None, size: 0, is_dir: true }
    }
    fn bf(h: &str) -> BaseEntry {
        BaseEntry { hash: Some(h.into()), is_dir: false }
    }
    fn cfg() -> SyncConfig {
        SyncConfig { excluded: vec![], device_name: "Laptop".into(), today: "2026-11-09".into() }
    }
    fn m<T: Clone>(items: &[(&str, T)]) -> BTreeMap<RelPath, T> {
        items.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn new_local_file_uploads_new_remote_file_downloads() {
        let p = plan(&m(&[("a.txt", f("1"))]), &m(&[("b.txt", rf("2"))]), &BTreeMap::new(), &cfg());
        assert_eq!(p, vec![Action::Upload("a.txt".into()), Action::Download("b.txt".into())]);
    }

    #[test]
    fn edits_flow_in_the_right_direction() {
        let base = m(&[("a", bf("1")), ("b", bf("1"))]);
        let p = plan(&m(&[("a", f("2")), ("b", f("1"))]), &m(&[("a", rf("1")), ("b", rf("3"))]), &base, &cfg());
        assert_eq!(p, vec![Action::Upload("a".into()), Action::Download("b".into())]);
    }

    #[test]
    fn concurrent_edits_make_a_conflict_copy() {
        let p = plan(&m(&[("docs/report.pdf", f("L"))]), &m(&[("docs/report.pdf", rf("R"))]), &m(&[("docs/report.pdf", bf("B"))]), &cfg());
        assert_eq!(
            p,
            vec![Action::Conflict { path: "docs/report.pdf".into(), rename_local_to: "docs/report (conflicted copy from Laptop 2026-11-09).pdf".into() }]
        );
    }

    #[test]
    fn both_created_differently_without_base_is_a_conflict_identical_is_synced() {
        let p = plan(&m(&[("x", f("L")), ("y", f("S"))]), &m(&[("x", rf("R")), ("y", rf("S"))]), &BTreeMap::new(), &cfg());
        assert!(matches!(&p[0], Action::Conflict { path, .. } if path == "x"));
        assert_eq!(p[1], Action::MarkSynced("y".into()));
    }

    #[test]
    fn deletions_propagate_unless_the_other_side_edited() {
        let base = m(&[("gone-local", bf("1")), ("gone-remote", bf("1")), ("edited-then-deleted-remote", bf("1"))]);
        let local = m(&[("gone-remote", f("1")), ("edited-then-deleted-remote", f("2"))]);
        let remote = m(&[("gone-local", rf("1"))]);
        let p = plan(&local, &remote, &base, &cfg());
        assert!(p.contains(&Action::DeleteRemote("gone-local".into())));
        assert!(p.contains(&Action::DeleteLocal("gone-remote".into())));
        assert!(p.contains(&Action::Upload("edited-then-deleted-remote".into())));
    }

    #[test]
    fn dirs_created_parents_first_deleted_children_first() {
        let local = m(&[("a", d()), ("a/b", d()), ("a/b/c.txt", f("1"))]);
        let p = plan(&local, &BTreeMap::new(), &BTreeMap::new(), &cfg());
        assert_eq!(p, vec![Action::CreateRemoteDir("a".into()), Action::CreateRemoteDir("a/b".into()), Action::Upload("a/b/c.txt".into())]);

        let base = m(&[("a", BaseEntry { hash: None, is_dir: true }), ("a/b", BaseEntry { hash: None, is_dir: true }), ("a/b/c.txt", bf("1"))]);
        let remote = m(&[("a", rd()), ("a/b", rd()), ("a/b/c.txt", rf("1"))]);
        let p = plan(&BTreeMap::new(), &remote, &base, &cfg());
        assert_eq!(p, vec![Action::DeleteRemote("a/b/c.txt".into()), Action::DeleteRemote("a/b".into()), Action::DeleteRemote("a".into())]);
    }

    #[test]
    fn selective_sync_and_ignore_rules() {
        let mut c = cfg();
        c.excluded = vec!["Videos".into()];
        let remote = m(&[("Videos", rd()), ("Videos/big.mp4", rf("1")), ("VideosX.txt", rf("2"))]);
        let local = m(&[(".DS_Store", f("x")), ("~$draft.docx", f("y")), ("note.tmp", f("z"))]);
        let p = plan(&local, &remote, &BTreeMap::new(), &c);
        assert_eq!(p, vec![Action::Download("VideosX.txt".into())]);
    }

    #[test]
    fn file_vs_folder_name_clash() {
        let p = plan(&m(&[("x", f("1"))]), &m(&[("x", rd())]), &BTreeMap::new(), &cfg());
        assert!(matches!(&p[0], Action::Conflict { rename_local_to, .. } if rename_local_to == "x (conflicted copy from Laptop 2026-11-09)"));
    }

    #[test]
    fn remote_files_without_hash_wait_for_server_hashing() {
        let remote = m(&[("new.jpg", RemoteEntry { id: "x".into(), hash: None, size: 9, is_dir: false })]);
        assert!(plan(&m(&[("new.jpg", f("L"))]), &remote, &BTreeMap::new(), &cfg()).is_empty());
    }

    #[test]
    fn conflict_names() {
        assert_eq!(conflict_name("a/b.tar.gz", "PC", "2026-01-02"), "a/b.tar (conflicted copy from PC 2026-01-02).gz");
        assert_eq!(conflict_name(".env", "PC", "d"), ".env (conflicted copy from PC d)");
    }
}
