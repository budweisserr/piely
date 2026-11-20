use super::*;

#[test]
fn a_started_command_may_wait_the_whole_timeout() {
    let timeout = Duration::from_secs(120);
    let start = Instant::now();
    let clock = ProgressClock::started(timeout, start);

    assert_eq!(clock.remaining(start), Some(timeout));
    assert_eq!(
        clock.remaining(start + Duration::from_secs(119)),
        Some(Duration::from_secs(1))
    );
    assert_eq!(clock.remaining(start + timeout), None, "silence expires");
}

#[test]
fn progress_restarts_the_window() {
    let timeout = Duration::from_secs(120);
    let start = Instant::now();
    let mut clock = ProgressClock::started(timeout, start);

    // A chunk arrives after 119 s of "thinking": the answer gets another
    // full window instead of dying one second later.
    let chunk_at = start + Duration::from_secs(119);
    clock.mark(chunk_at);
    assert_eq!(clock.remaining(chunk_at), Some(timeout));
    assert_eq!(
        clock.remaining(chunk_at + Duration::from_secs(119)),
        Some(Duration::from_secs(1))
    );
    assert_eq!(
        clock.remaining(chunk_at + timeout),
        None,
        "and expires again after silence"
    );
}
