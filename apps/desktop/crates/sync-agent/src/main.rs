//! `maxcloud-sync` — headless sync client (the Tauri app embeds the same engine).
//!   maxcloud-sync login  --server URL --email E --password P [--totp CODE] --root DIR
//!   maxcloud-sync sync   --root DIR [--watch SECONDS] [--exclude Videos] [--upload-kbps N] [--download-kbps N]
use std::path::PathBuf;
use std::time::Duration;
use sync_agent::api::{Client, Tokens};
use sync_core::SyncConfig;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");
    let root = PathBuf::from(arg(&args, "--root").unwrap_or_else(|| ".".into()));
    let auth_file = root.join(".maxcloud/auth.json");
    let device = arg(&args, "--device").unwrap_or_else(|| std::env::var("HOSTNAME").unwrap_or_else(|_| "Desktop".into()));
    let kbps = |n: &str| arg(&args, n).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0) * 1024;

    match cmd {
        "login" => {
            let server = arg(&args, "--server").expect("--server");
            let client = Client::new(&server, &device, 0, 0);
            let t = client
                .login(&arg(&args, "--email").expect("--email"), &arg(&args, "--password").expect("--password"), arg(&args, "--totp").as_deref())
                .unwrap_or_else(|e| {
                    eprintln!("login failed: {e}");
                    std::process::exit(1)
                });
            std::fs::create_dir_all(root.join(".maxcloud")).unwrap();
            std::fs::write(&auth_file, serde_json::to_vec(&serde_json::json!({ "server": server, "access": t.access_token, "refresh": t.refresh_token })).unwrap()).unwrap();
            println!("signed in; sync folder: {}", root.display());
        }
        "sync" => {
            let auth: serde_json::Value = serde_json::from_slice(&std::fs::read(&auth_file).expect("run `login` first")).unwrap();
            let client = Client::new(auth["server"].as_str().unwrap(), &device, kbps("--upload-kbps"), kbps("--download-kbps"));
            *client.tokens.lock().unwrap() = Tokens { access_token: auth["access"].as_str().unwrap().into(), refresh_token: auth["refresh"].as_str().unwrap().into() };
            let cfg = SyncConfig { excluded: args.iter().enumerate().filter(|(_, a)| *a == "--exclude").filter_map(|(i, _)| args.get(i + 1).cloned()).collect(), device_name: device.clone(), today: sync_agent::today_utc() };
            let watch = arg(&args, "--watch").and_then(|s| s.parse::<u64>().ok());
            loop {
                match sync_agent::sync_once(&client, &root, &cfg) {
                    Ok(r) => println!("{r:?}"),
                    Err(e) => eprintln!("sync failed: {e}"),
                }
                // persist rotated refresh token
                let t = client.tokens.lock().unwrap().clone();
                std::fs::write(&auth_file, serde_json::to_vec(&serde_json::json!({ "server": auth["server"], "access": t.access_token, "refresh": t.refresh_token })).unwrap()).unwrap();
                match watch {
                    Some(s) => std::thread::sleep(Duration::from_secs(s)),
                    None => break,
                }
            }
        }
        _ => eprintln!("usage: maxcloud-sync login|sync --root DIR ..."),
    }
}
