//! A recorded terminal session: `TRREC1\n`, one JSON header line {"cols","rows"}, then records of
//! (u64 LE microseconds since start, u32 LE length, bytes). Written by toolroll-tui-harness `record`.
use anyhow::{bail, Context, Result};
use std::time::Duration;

pub struct Recording {
    pub cols: u16,
    pub rows: u16,
    pub chunks: Vec<(Duration, Vec<u8>)>,
}

impl Recording {
    pub fn load(path: &str) -> Result<Self> {
        let data = std::fs::read(path).with_context(|| format!("reading {path}"))?;
        let magic = b"TRREC1\n";
        if !data.starts_with(magic) {
            bail!("{path} is not a TRREC1 recording");
        }
        let rest = &data[magic.len()..];
        let nl = rest.iter().position(|&b| b == b'\n').context("header")?;
        let header: serde_json::Value = serde_json::from_slice(&rest[..nl])?;
        let cols = header["cols"].as_u64().context("cols")? as u16;
        let rows = header["rows"].as_u64().context("rows")? as u16;
        let mut p = &rest[nl + 1..];
        let mut chunks = Vec::new();
        while p.len() >= 12 {
            let t = u64::from_le_bytes(p[..8].try_into()?);
            let n = u32::from_le_bytes(p[8..12].try_into()?) as usize;
            if p.len() < 12 + n {
                bail!("truncated record");
            }
            chunks.push((Duration::from_micros(t), p[12..12 + n].to_vec()));
            p = &p[12 + n..];
        }
        Ok(Self { cols, rows, chunks })
    }
    pub fn duration(&self) -> Duration {
        self.chunks.last().map(|c| c.0).unwrap_or_default()
    }
}

/// Plays a recording in a loop against a clock: `advance(t)` returns the bytes due up to `t`.
pub struct Replay {
    rec: Recording,
    next: usize,
    loop_start: Duration,
    pub loops: u64,
}

impl Replay {
    pub fn new(rec: Recording) -> Self {
        Self {
            rec,
            next: 0,
            loop_start: Duration::ZERO,
            loops: 0,
        }
    }
    pub fn size(&self) -> (u16, u16) {
        (self.rec.rows, self.rec.cols)
    }
    pub fn advance(&mut self, now: Duration, out: &mut Vec<u8>) {
        let len = self.rec.duration() + Duration::from_millis(200);
        loop {
            if self.next >= self.rec.chunks.len() {
                if now < self.loop_start + len {
                    return;
                }
                self.loop_start += len;
                self.next = 0;
                self.loops += 1;
                out.extend_from_slice(b"\x1bc"); // full reset between loops
            }
            let (t, ref bytes) = self.rec.chunks[self.next];
            if self.loop_start + t > now {
                return;
            }
            out.extend_from_slice(bytes);
            self.next += 1;
        }
    }
}
