//! A fixed-capacity ring of lines: O(1) push, the newest `n` read without copying.

pub struct Ring {
    lines: Vec<String>,
    head: usize,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Self {
            lines: Vec::with_capacity(cap),
            head: 0,
            cap,
        }
    }
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.lines.len()
    }
    pub fn push(&mut self, line: String) {
        if self.lines.len() < self.cap {
            self.lines.push(line);
        } else {
            self.lines[self.head] = line;
            self.head = (self.head + 1) % self.cap;
        }
    }
    /// The newest `n` lines, oldest first.
    pub fn tail(&self, n: usize) -> impl Iterator<Item = &str> {
        let len = self.lines.len();
        let n = n.min(len);
        let start = if len < self.cap {
            len - n
        } else {
            (self.head + self.cap - n) % self.cap
        };
        (0..n).map(move |i| self.lines[(start + i) % len.max(1)].as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::Ring;
    #[test]
    fn wraps_and_tails_in_order() {
        let mut r = Ring::new(3);
        for i in 0..5 {
            r.push(i.to_string());
        }
        assert_eq!(r.len(), 3);
        assert_eq!(r.tail(2).collect::<Vec<_>>(), vec!["3", "4"]);
        assert_eq!(r.tail(9).collect::<Vec<_>>(), vec!["2", "3", "4"]);
    }
}
