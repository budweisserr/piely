//! Paths the model may never read: credential file names, key extensions, and
//! anything hidden, since dot-directories are where tools keep tokens. Opening
//! a file is not covered here; that always asks the user, path on screen.
use std::path::{Component, Path};

/// Credential stores the model never gets to read. Opening a file is not
/// blocked here: that always asks the user first.
const SECRET_DIRS: &[&str] = &[
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    "Keychains",
    "gcloud",
];

const SECRET_NAMES: &[&str] = &[
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    "secrets",
    "netrc",
    "pgpass",
    "htpasswd",
];

const SECRET_EXTS: &[&str] = &[
    "pem", "key", "p12", "pfx", "keystore", "jks", "kdbx", "keychain", "ppk", "asc", "gpg",
];

fn is_sensitive_path(path: &Path) -> bool {
    let name = path
        .file_name()
        .map_or(String::new(), |n| n.to_string_lossy().to_lowercase());
    if name.starts_with(".env") || SECRET_NAMES.contains(&name.as_str()) {
        return true;
    }
    let ext = path
        .extension()
        .map_or(String::new(), |e| e.to_string_lossy().to_lowercase());
    if SECRET_EXTS.contains(&ext.as_str()) {
        return true;
    }
    // Hidden files and directories are where tools keep tokens: a GitHub token
    // in ~/.config/gh/hosts.yml, a registry token in ~/.npmrc, browser
    // sign-ins under ~/.mozilla. The search tools skip them anyway.
    path.components().any(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        let name = name.to_string_lossy().to_lowercase();
        name.starts_with('.') || SECRET_DIRS.contains(&name.as_str())
    })
}

/// True when the path itself or any symlink along the way points into a
/// secret location. `name`-based checks alone are fooled by `/tmp/notes ->
/// ~/.ssh/id_rsa`, so the real path is what gets inspected.
pub(super) fn is_sensitive_target(path: &Path) -> bool {
    if is_sensitive_path(path) {
        return true;
    }
    std::fs::canonicalize(path).is_ok_and(|real| is_sensitive_path(&real))
}

#[cfg(test)]
#[path = "../../test/tools/sensitive_paths.rs"]
mod tests;
