//! Token-bucket bandwidth limiter (upload/download caps in the desktop settings).
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct TokenBucket {
    /// bytes per second; 0 = unlimited
    rate: u64,
    capacity: f64,
    tokens: f64,
    last: Duration,
}

impl TokenBucket {
    /// `now` is a monotonic timestamp (e.g. Instant elapsed since start) so tests can control time.
    pub fn new(rate_bytes_per_sec: u64, now: Duration) -> Self {
        let cap = rate_bytes_per_sec as f64; // allow bursts of up to 1 second
        Self { rate: rate_bytes_per_sec, capacity: cap, tokens: cap, last: now }
    }

    pub fn set_rate(&mut self, rate: u64) {
        self.rate = rate;
        self.capacity = rate as f64;
        self.tokens = self.tokens.min(self.capacity);
    }

    /// Consume `n` bytes; returns how long the caller must sleep before sending them.
    pub fn take(&mut self, n: u64, now: Duration) -> Duration {
        if self.rate == 0 {
            return Duration::ZERO;
        }
        let elapsed = now.saturating_sub(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.rate as f64).min(self.capacity);
        self.tokens -= n as f64;
        if self.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-self.tokens / self.rate as f64)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unlimited_never_waits() {
        let mut b = TokenBucket::new(0, Duration::ZERO);
        assert_eq!(b.take(1 << 30, Duration::ZERO), Duration::ZERO);
    }

    #[test]
    fn enforces_average_rate() {
        // 1 MB/s: sending 5 MB back-to-back must take ~4 s (1 s burst allowance).
        let mut b = TokenBucket::new(1_000_000, Duration::ZERO);
        let mut now = Duration::ZERO;
        for _ in 0..50 {
            now += b.take(100_000, now);
        }
        assert!((now.as_secs_f64() - 4.0).abs() < 0.01, "took {now:?}");
    }

    #[test]
    fn refills_over_time() {
        let mut b = TokenBucket::new(1000, Duration::ZERO);
        assert_eq!(b.take(1000, Duration::ZERO), Duration::ZERO);
        assert!(b.take(500, Duration::ZERO) > Duration::ZERO);
        let mut c = TokenBucket::new(1000, Duration::ZERO);
        c.take(1000, Duration::ZERO);
        assert_eq!(c.take(500, Duration::from_millis(600)), Duration::ZERO);
    }
}
