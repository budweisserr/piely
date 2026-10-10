use super::*;

#[test]
fn test_secret_paths_are_refused() {
    assert!(is_sensitive_path(Path::new("/home/x/.ssh/id_rsa")));
    assert!(is_sensitive_path(Path::new("/home/x/project/.env.local")));
    assert!(is_sensitive_path(Path::new("/home/x/cert.pem")));
    assert!(is_sensitive_path(Path::new("/home/x/.aws/config")));
}

#[test]
fn test_hidden_paths_are_refused_even_when_the_name_is_unknown() {
    // Credential stores the name lists do not know about.
    assert!(is_sensitive_path(Path::new("/home/x/.config/gh/hosts.yml")));
    assert!(is_sensitive_path(Path::new(
        "/home/x/.mozilla/firefox/abc.default/logins.json"
    )));
    assert!(is_sensitive_path(Path::new("/home/x/.npmrc")));
    assert!(is_sensitive_path(Path::new("/home/x/.zsh_history")));
    assert!(is_sensitive_path(Path::new(
        "/home/x/Documents/.hidden/notes.md"
    )));
}

#[test]
fn test_ordinary_documents_are_readable() {
    assert!(!is_sensitive_path(Path::new("/home/x/Documents/budget.csv")));
    assert!(!is_sensitive_path(Path::new("/home/x/notes/environment.md")));
    assert!(!is_sensitive_path(Path::new("/home/x/a/keyboard.png")));
    // A relative path must not count as hidden because of its "./" prefix.
    assert!(!is_sensitive_path(Path::new("./notes.md")));
    assert!(!is_sensitive_path(Path::new("reports/quarterly.csv")));
}
