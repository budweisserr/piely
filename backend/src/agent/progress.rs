//! When to give up on an agent command.
//!
//! The timeout measures silence, not the whole turn: every chunk restarts the
//! window, so a slow answer survives. Its own file so a test can use a fake
//! clock instead of waiting two minutes.
use std::time::{Duration, Instant};

#[derive(Debug)]
pub(super) struct ProgressClock {
    timeout: Duration,
    last: Instant,
}

impl ProgressClock {
    pub(super) fn started(timeout: Duration, now: Instant) -> Self {
        Self { timeout, last: now }
    }

    /// Records progress: the caller may wait another full timeout from `now`.
    pub(super) fn mark(&mut self, now: Instant) {
        self.last = now;
    }

    /// How much longer the caller may wait. `None` means the command has been
    /// silent for the whole timeout and should be abandoned.
    pub(super) fn remaining(&self, now: Instant) -> Option<Duration> {
        self.timeout
            .checked_sub(now.saturating_duration_since(self.last))
            .filter(|remaining| !remaining.is_zero())
    }
}

#[cfg(test)]
#[path = "../../test/agent/progress.rs"]
mod tests;
