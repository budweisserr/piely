// `read_file` is the tool that hands file contents to the provider: it must
// answer quickly for anything a user or a model can point it at.
use super::*;

fn temp_path(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("piely-read-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("fixture dir");
    dir.join(name)
}

#[tokio::test]
async fn reads_a_text_file() {
    let path = temp_path("notes.txt");
    std::fs::write(&path, "roof repair\n").expect("fixture file");

    let preview = tools_read_file(path.to_string_lossy().into_owned(), None)
        .await
        .expect("read succeeds");

    assert_eq!(preview["kind"], "text");
    assert_eq!(preview["text"], "roof repair\n");
    assert_eq!(preview["truncated"], false);

    let _ = std::fs::remove_file(path);
}

#[tokio::test]
async fn reads_a_document_as_text() {
    let path = temp_path("lab.docx");
    {
        use std::io::Write;
        let file = std::fs::File::create(&path).expect("fixture file");
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("word/document.xml", zip::write::SimpleFileOptions::default())
            .expect("zip member");
        zip.write_all(b"<w:document><w:body><w:p><w:r><w:t>Machine learning</w:t></w:r></w:p></w:body></w:document>")
            .expect("zip member text");
        zip.finish().expect("zip trailer");
    }

    let preview = tools_read_file(path.to_string_lossy().into_owned(), None)
        .await
        .expect("read succeeds");

    assert_eq!(preview["kind"], "document");
    assert_eq!(preview["text"], "Machine learning\n");

    let _ = std::fs::remove_file(path);
}

/// A FIFO has no bytes until something writes to it, so opening it would block
/// the tool call (and, before this was fixed, the whole async runtime) forever.
#[cfg(unix)]
#[tokio::test]
async fn refuses_a_fifo_instead_of_blocking_on_it() {
    let path = temp_path("pipe.txt");
    let _ = std::fs::remove_file(&path);
    let made = std::process::Command::new("mkfifo").arg(&path).status();
    if !made.map(|status| status.success()).unwrap_or(false) {
        return; // no mkfifo here
    }

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tools_read_file(path.to_string_lossy().into_owned(), None),
    )
    .await;

    let error = result
        .expect("the call answers instead of hanging")
        .expect_err("a fifo is refused");
    assert!(error.contains("not a regular file"), "{error}");

    let _ = std::fs::remove_file(path);
}
