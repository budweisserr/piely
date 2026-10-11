// Where a tool looks when the model names a directory: an existing one is used
// as given, a directory that is not on this machine falls back to the defaults,
// and a credential folder is refused outright.
use super::*;

fn defaults() -> Vec<(PathBuf, usize)> {
    vec![(PathBuf::from("/home/someone/Documents"), 4)]
}

#[test]
fn no_directory_means_the_defaults() {
    let (roots, note) = resolve_roots(defaults(), None).expect("no directory is fine");
    assert_eq!(roots.len(), 1);
    assert!(note.is_none());
}

#[test]
fn an_existing_directory_is_used_as_given() {
    let dir = std::env::temp_dir();
    let (roots, note) =
        resolve_roots(defaults(), Some(dir.to_string_lossy().into_owned())).expect("readable");

    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].0, dir);
    assert!(note.is_none());
}

#[test]
fn a_container_path_falls_back_with_a_note() {
    // Codex models ask for the shared folder of their sandbox.
    let (roots, note) = resolve_roots(defaults(), Some("/home/oai/share/Documents".to_string()))
        .expect("a missing directory falls back");

    assert_eq!(roots.len(), 1);
    assert_eq!(roots[0].0, PathBuf::from("/home/someone/Documents"));
    let note = note.expect("the answer explains the substitution");
    assert!(note.contains("/home/oai/share/Documents"), "{note}");
}

#[test]
fn a_credential_folder_is_refused() {
    // The model chooses this path, so ~/.ssh must not become a search root.
    let home = std::env::var("HOME").unwrap_or_else(|_| "/home/someone".to_string());
    let ssh = PathBuf::from(&home).join(".ssh");
    if !ssh.is_dir() {
        return; // no ~/.ssh on this machine
    }

    let error = resolve_roots(defaults(), Some(ssh.to_string_lossy().into_owned()))
        .expect_err("a credential folder is refused");
    assert!(error.contains("credential"), "{error}");

    let error = resolve_dir(defaults()[0].0.clone(), Some(ssh.to_string_lossy().into_owned()))
        .expect_err("a credential folder is refused");
    assert!(error.contains("credential"), "{error}");
}

#[test]
fn list_directory_falls_back_to_its_default() {
    let home = std::env::temp_dir();

    let (root, note) = resolve_dir(home.clone(), Some("/home/oai/share".to_string()))
        .expect("a missing directory falls back");
    assert_eq!(root, home);
    let note = note.expect("the answer explains the substitution");
    assert!(note.contains("/home/oai/share"), "{note}");

    let (root, note) = resolve_dir(home.clone(), None).expect("no path is fine");
    assert_eq!(root, home);
    assert!(note.is_none());
}
