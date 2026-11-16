//! Percentiles over recorded durations.
use std::time::Duration;

/// When the process started, and how long each start-up step took after it (for `--stats-out`'s `startup`): where a
/// slow launch spends its time, measured, never guessed.
static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
static MARKS: std::sync::Mutex<Vec<(&'static str, f64)>> = std::sync::Mutex::new(Vec::new());

/// The process began (main's first line).
pub fn started() {
    let _ = START.set(std::time::Instant::now());
}

/// A start-up step done now: its time since the process began, kept once per name.
pub fn mark(name: &'static str) {
    let Some(start) = START.get() else { return };
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    if let Ok(mut marks) = MARKS.lock() {
        if !marks.iter().any(|(n, _)| *n == name) {
            marks.push((name, round(ms)));
        }
    }
}

/// The start-up steps so far, in order (milliseconds since the process began).
pub fn marks() -> serde_json::Value {
    let marks = MARKS.lock().map(|m| m.clone()).unwrap_or_default();
    serde_json::Value::Object(
        marks
            .into_iter()
            .map(|(n, ms)| (n.to_string(), serde_json::json!(ms)))
            .collect(),
    )
}

#[derive(Default)]
pub struct Samples(pub Vec<Duration>);

impl Samples {
    pub fn push(&mut self, d: Duration) {
        self.0.push(d);
    }
    pub fn summary(&self) -> serde_json::Value {
        let mut v: Vec<f64> = self.0.iter().map(|d| d.as_secs_f64() * 1000.0).collect();
        if v.is_empty() {
            return serde_json::json!({ "n": 0 });
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pct = |p: f64| v[((v.len() as f64 - 1.0) * p).round() as usize];
        let mean = v.iter().sum::<f64>() / v.len() as f64;
        serde_json::json!({
            "n": v.len(),
            "mean_ms": round(mean), "p50_ms": round(pct(0.5)), "p95_ms": round(pct(0.95)),
            "p99_ms": round(pct(0.99)), "max_ms": round(*v.last().unwrap()),
        })
    }
}

fn round(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}
