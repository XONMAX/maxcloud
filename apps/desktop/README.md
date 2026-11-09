# MaxCloud desktop

```
crates/sync-core   pure 3-way sync planner + bandwidth limiter  (cargo test -p sync-core)
crates/sync-agent  engine + HTTP client + `maxcloud-sync` CLI  (cargo build)
src-tauri + ui     tray/settings app (Windows/macOS/Linux) embedding sync-agent
```

Status:
- `sync-core` and `sync-agent` build and are tested; `scripts/desktop-sync-smoke.sh` runs a real
  two-computer sync (propagation, edits, conflict copies, deletes, selective sync) against a running API.
- `src-tauri` has not been compiled in CI yet: it needs WebView2 (Windows), WebKitGTK 4.1 (Linux) or
  Xcode (macOS). Build with `cargo install tauri-cli@^2 && cd src-tauri && cargo tauri build`.

Behaviour:
- Two-way sync every 30 s; unchanged files aren't re-hashed (size+mtime cache in `.maxcloud/state.json`).
- Conflicts: the server version keeps the name; the local edit becomes
  `name (conflicted copy from <PC> <date>).ext` and is uploaded too. Nothing is ever silently overwritten.
- Remote deletes go to the server Trash (30 days); local folders are only removed when empty.
- Selective sync (excluded top-level folders) and upload/download bandwidth caps (token bucket).

TODO (next iteration, with reasons):
- File-system watcher (`notify` crate) for instant uploads instead of 30 s polling. Polling is simpler to make correct first.
- Server push (SSE/WebSocket) of tree changes instead of fetching the whole tree each round; fine up to ~100k files.
- Resumable *downloads* via HTTP Range (uploads are already resumable per part).
