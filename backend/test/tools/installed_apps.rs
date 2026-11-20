use super::*;

fn app(name: &str, path: &str) -> AppEntry {
    AppEntry {
        name: name.to_string(),
        id: path.to_string(),
        path: path.to_string(),
    }
}

#[test]
fn test_open_app_matches_exactly() {
    let apps = vec![
        app("Visual Studio Code", "/Applications/Visual Studio Code.app"),
        app("Code", "/Applications/Code.app"),
    ];

    let found = resolve_app(&apps, "Code").expect("exact name wins");
    assert_eq!(found.name, "Code");
    let found = resolve_app(&apps, "visual studio code").expect("case-insensitive");
    assert_eq!(found.name, "Visual Studio Code");
    let found = resolve_app(&apps, "/Applications/Code.app").expect("by path");
    assert_eq!(found.name, "Code");
}

#[test]
fn test_open_app_refuses_to_guess() {
    let apps = vec![app("Visual Studio Code", "/Applications/Visual Studio Code.app")];

    // "Code" is a substring, not a name: launching it would be a guess.
    let error = resolve_app(&apps, "Code").expect_err("must not guess");
    assert!(error.contains("Visual Studio Code"), "suggests near matches: {error}");

    let error = resolve_app(&apps, "Firefox").expect_err("nothing installed");
    assert!(error.contains("list_apps"), "points at list_apps: {error}");
}
