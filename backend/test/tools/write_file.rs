use super::*;

fn temp_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!("piely-write-{}-{}", std::process::id(), name))
}

#[tokio::test]
async fn writes_a_new_file_and_creates_its_parent_folder() {
    let path = temp_path("reports/summary.md");
    let _ = std::fs::remove_dir_all(path.parent().expect("parent"));

    let result = tools_write_file(
        path.to_string_lossy().into_owned(),
        "# Summary\n".to_string(),
        None,
    )
    .await
    .expect("write succeeds");

    assert_eq!(result["created"], true);
    assert_eq!(result["bytes"], 10);
    assert_eq!(std::fs::read_to_string(&path).expect("file"), "# Summary\n");

    let _ = std::fs::remove_dir_all(path.parent().expect("parent"));
}

#[tokio::test]
async fn refuses_to_replace_an_existing_file_without_the_flag() {
    let path = temp_path("keep.txt");
    std::fs::write(&path, "original").expect("fixture");

    let error = tools_write_file(
        path.to_string_lossy().into_owned(),
        "replaced".to_string(),
        None,
    )
    .await
    .expect_err("must refuse");
    assert!(error.contains("overwrite"), "{error}");
    assert_eq!(std::fs::read_to_string(&path).expect("file"), "original");

    let result = tools_write_file(
        path.to_string_lossy().into_owned(),
        "replaced".to_string(),
        Some(true),
    )
    .await
    .expect("overwrite succeeds");
    assert_eq!(result["created"], false);
    assert_eq!(std::fs::read_to_string(&path).expect("file"), "replaced");

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn refuses_credentials_relative_paths_and_oversized_content() {
    let home = std::env::temp_dir().join("piely-write-home");
    let error = tools_write_file(
        home.join(".ssh/authorized_keys").to_string_lossy().into_owned(),
        "ssh-rsa AAAA".to_string(),
        None,
    )
    .await
    .expect_err("credentials are refused");
    assert!(error.contains("refusing"), "{error}");

    let error = tools_write_file("notes.md".to_string(), "hi".to_string(), None)
        .await
        .expect_err("relative paths are refused");
    assert!(error.contains("absolute"), "{error}");

    let path = temp_path("big.txt");
    let error = tools_write_file(
        path.to_string_lossy().into_owned(),
        "x".repeat(MAX_WRITE_BYTES + 1),
        None,
    )
    .await
    .expect_err("oversized content is refused");
    assert!(error.contains("too large"), "{error}");
    assert!(!path.exists(), "nothing was written");
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_to_write_through_a_symlinked_folder() {
    let home = std::env::temp_dir().join(format!("piely-write-link-{}", std::process::id()));
    let secret = home.join(".ssh");
    let link = home.join("public");
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&secret).expect("secret dir");
    std::os::unix::fs::symlink(&secret, &link).expect("symlink");

    let error = tools_write_file(
        link.join("authorized_keys").to_string_lossy().into_owned(),
        "ssh-rsa AAAA".to_string(),
        None,
    )
    .await
    .expect_err("a symlinked hidden folder is refused");
    assert!(error.contains("refusing"), "{error}");
    assert!(!secret.join("authorized_keys").exists());

    let _ = std::fs::remove_dir_all(&home);
}

#[tokio::test]
async fn test_write_file_refuses_document_formats() {
    let dir = std::env::temp_dir().join(format!("piely-write-doc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("fixture dir");

    // Plain bytes in a .docx are not a .docx: the file would stop opening.
    for name in ["lab.docx", "report.pdf", "grades.xlsx"] {
        let error = tools_write_file(
            dir.join(name).to_string_lossy().into_owned(),
            "hello".to_string(),
            None,
        )
        .await
        .expect_err("a document target is refused");
        assert!(error.contains("plain text"), "{error}");
        assert!(!dir.join(name).exists());
    }

    let _ = std::fs::remove_dir_all(&dir);
}

/// Writing to a FIFO waits for a reader that may never come; writing to a device
/// node talks to hardware. Neither is a text file.
#[cfg(unix)]
#[tokio::test]
async fn refuses_to_write_to_special_files() {
    let path = temp_path("pipe.txt");
    let _ = std::fs::remove_file(&path);
    let made = std::process::Command::new("mkfifo").arg(&path).status();
    if !made.map(|status| status.success()).unwrap_or(false) {
        return; // no mkfifo here
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tools_write_file(
            path.to_string_lossy().into_owned(),
            "hello".to_string(),
            Some(true),
        ),
    )
    .await;

    let error = result
        .expect("the call answers instead of hanging")
        .expect_err("a fifo is refused");
    assert!(error.contains("not a regular file"), "{error}");

    let _ = std::fs::remove_file(path);
}

/// Writing through a symlink would replace whatever it points at, while the
/// user only confirmed the path they were shown.
#[cfg(unix)]
#[tokio::test]
async fn refuses_to_write_through_a_symlink() {
    let target = temp_path("real-target.txt");
    let link = temp_path("link.txt");
    std::fs::write(&target, "original\n").expect("fixture file");
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(&target, &link).expect("fixture symlink");

    let error = tools_write_file(
        link.to_string_lossy().into_owned(),
        "replaced".to_string(),
        Some(true),
    )
    .await
    .expect_err("a symlink is refused");
    assert!(error.contains("symlink"), "{error}");
    assert_eq!(
        std::fs::read_to_string(&target).expect("target"),
        "original\n"
    );

    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_file(&target);
}
