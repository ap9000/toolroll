//! Serve the fake console's scenario for a manual look or a screenshot: `toolroll-fake-engine --port P --link-out F
//! [--records-per-sec N]`. The one-time link is written to F (0600); records stream into the live build at N per second.
use std::io::Write;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let port: u16 = arg("--port").and_then(|p| p.parse().ok()).unwrap_or(0);
    let rate: u64 = arg("--records-per-sec")
        .and_then(|p| p.parse().ok())
        .unwrap_or(0);
    let engine =
        toolroll_fake_engine::FakeEngine::start(toolroll_fake_engine::scenario(), port).await;
    if let Some(out) = arg("--link-out") {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(out)
            .expect("link file");
        writeln!(f, "{}", engine.link()).unwrap();
    }
    println!("fake console on {}", engine.addr);
    let mut n = 1000;
    loop {
        if rate == 0 {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            continue;
        }
        tokio::time::sleep(Duration::from_millis(1000 / rate.max(1))).await;
        engine.push_records(
            toolroll_fake_engine::LIVE_RUN,
            toolroll_fake_engine::busy_records(n, 1),
        );
        n += 1;
    }
}
