//! A small server-sent-events parser for the console's `/live` stream (its own: no dependency, bounded memory).

/// One event: its name (`message` when unnamed) and its data lines joined by newlines.
#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// The longest line kept; a longer one is dropped whole (the console's events are small).
const LINE_CAP: usize = 256 * 1024;

#[derive(Default)]
pub struct SseParser {
    line: Vec<u8>,
    overflow: bool,
    event: String,
    data: String,
    has_data: bool,
}

impl SseParser {
    /// Feed bytes as they arrive; the complete events they finish.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        let mut out = Vec::new();
        for &b in chunk {
            if b == b'\n' {
                let line = std::mem::take(&mut self.line);
                if std::mem::take(&mut self.overflow) {
                    continue;
                }
                let mut text = String::from_utf8_lossy(&line).into_owned();
                if text.ends_with('\r') {
                    text.pop();
                }
                self.line_done(&text, &mut out);
            } else if self.line.len() < LINE_CAP {
                self.line.push(b);
            } else {
                self.overflow = true;
            }
        }
        out
    }

    fn line_done(&mut self, line: &str, out: &mut Vec<SseEvent>) {
        if line.is_empty() {
            if self.has_data || !self.event.is_empty() {
                let event = if self.event.is_empty() {
                    "message".to_string()
                } else {
                    std::mem::take(&mut self.event)
                };
                out.push(SseEvent {
                    event,
                    data: std::mem::take(&mut self.data),
                });
            }
            self.event.clear();
            self.data.clear();
            self.has_data = false;
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (field, value) = match line.find(':') {
            Some(i) => (
                &line[..i],
                line[i + 1..].strip_prefix(' ').unwrap_or(&line[i + 1..]),
            ),
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => {
                if self.has_data {
                    self.data.push('\n');
                }
                self.data.push_str(value);
                self.has_data = true;
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_split_across_chunks_and_comments_skipped() {
        let mut p = SseParser::default();
        assert!(p.push(b"event: hello\ndata: {\"tick\":15000}").is_empty());
        let evs =
            p.push(b"\n\n: keep-alive\nevent: change\ndata: {\"room\":\"workspace\"}\r\n\r\n");
        assert_eq!(
            evs,
            vec![
                SseEvent {
                    event: "hello".into(),
                    data: "{\"tick\":15000}".into()
                },
                SseEvent {
                    event: "change".into(),
                    data: "{\"room\":\"workspace\"}".into()
                },
            ]
        );
    }

    #[test]
    fn multi_line_data_and_unnamed_events() {
        let mut p = SseParser::default();
        let evs = p.push(b"data: a\ndata: b\n\n");
        assert_eq!(
            evs,
            vec![SseEvent {
                event: "message".into(),
                data: "a\nb".into()
            }]
        );
    }

    #[test]
    fn an_over_long_line_is_dropped_whole() {
        let mut p = SseParser::default();
        let mut big = b"data: ".to_vec();
        big.extend(std::iter::repeat_n(b'x', LINE_CAP + 10));
        big.extend_from_slice(b"\nevent: change\ndata: ok\n\n");
        assert_eq!(
            p.push(&big),
            vec![SseEvent {
                event: "change".into(),
                data: "ok".into()
            }]
        );
    }
}
