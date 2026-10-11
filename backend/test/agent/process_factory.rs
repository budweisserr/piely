// A bundled sidecar is only used after it passes its own self check; a stale
// bundle would otherwise fail much later, at the first login.
use super::*;

#[cfg(unix)]
fn fake_sidecar(name: &str, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let path = std::env::temp_dir().join(format!("piely-fake-{}-{}", std::process::id(), name));
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).expect("fixture");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("exec bit");
    path
}

#[cfg(unix)]
#[test]
fn accepts_a_binary_that_passes_its_self_check() {
    let binary = fake_sidecar("ok", "exit 0");
    assert!(self_check(&binary).is_ok());
    let _ = std::fs::remove_file(&binary);
}

#[cfg(unix)]
#[test]
fn refuses_a_binary_and_quotes_the_reason() {
    let binary = fake_sidecar(
        "broken",
        "echo 'selfcheck failed: oauth flows are not bundled' >&2\nexit 1",
    );

    let error = self_check(&binary).expect_err("a broken binary is refused");
    assert!(error.contains("oauth flows are not bundled"), "{error}");

    let _ = std::fs::remove_file(&binary);
}
