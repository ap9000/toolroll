//! Percentiles over recorded durations.
use std::time::Duration;

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
