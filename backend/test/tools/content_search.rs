use super::super::limits::MAX_SCAN_DEPTH;
use super::*;
use std::io::Write;

#[test]
fn test_query_terms_splits_and_lowercases() {
    assert_eq!(query_terms("  Roof   Repair "), vec!["roof", "repair"]);
    assert!(query_terms("   ").is_empty());
}

#[test]
fn test_scan_text_needs_every_term_for_a_full_match() {
    let terms = query_terms("roof repair");

    let full = scan_text("The roof was fixed.\nThe repair cost 400.", &terms);
    assert_eq!(full.terms_matched, 2);
    assert_eq!(full.occurrences, 2);
    assert_eq!(full.snippets.len(), 2);
    assert!(full.snippets[0].starts_with("L1: "), "{:?}", full.snippets);

    // One term alone is a partial match, which ranks below a full one.
    let partial = scan_text("Only the roof is mentioned.", &terms);
    assert_eq!(partial.terms_matched, 1);
    assert_eq!(partial.occurrences, 1);
}

#[test]
fn test_scan_text_is_case_insensitive_and_counts_repeats() {
    assert_eq!(scan_text("ROOF Repair", &query_terms("roof repair")).terms_matched, 2);

    let repeated = scan_text("x\nx\nx\nx\nx", &query_terms("x"));
    assert_eq!(repeated.occurrences, 5);
    assert_eq!(repeated.snippets.len(), MAX_SNIPPETS_PER_FILE);
}

#[test]
fn test_scan_text_truncates_long_snippets() {
    let long = "word ".repeat(200);
    let scan = scan_text(&long, &query_terms("word"));
    assert!(scan.snippets[0].chars().count() <= MAX_SNIPPET_CHARS + 8);
}

#[test]
fn test_looks_like_text_rejects_binaries() {
    assert!(looks_like_text(b"hello\nworld"));
    assert!(!looks_like_text(b"PK\x03\x04\x00\x00"), "docx/zip");
    assert!(!looks_like_text(&[0xff, 0xfe, 0x00]), "invalid utf-8");
}

#[test]
fn test_extension_filter() {
    let extensions = normalize_extensions(&Some(vec!["TXT".to_string(), ".md".to_string()]));
    assert_eq!(extensions, vec!["txt", "md"]);
    assert!(extension_allowed(Path::new("/a/notes.txt"), &extensions));
    assert!(extension_allowed(Path::new("/a/notes.md"), &extensions));
    assert!(!extension_allowed(Path::new("/a/notes.pdf"), &extensions));
    assert!(extension_allowed(Path::new("/a/anything"), &[]), "no filter accepts everything");
}
/// The case the tools exist for: "I need the document about X and I do not
/// know its name". Runs on a real directory tree.
#[test]
fn test_content_search_finds_files_by_what_is_inside_them() {
    let dir = std::env::temp_dir().join(format!("piely-search-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("2024/receipts")).expect("fixture dirs");
    std::fs::write(
        dir.join("2024/receipts/roof.txt"),
        "Roof repair invoice\nTotal: 400 EUR\n",
    )
    .expect("fixture file");
    std::fs::write(dir.join("notes.md"), "reminder: call the roofer\n").expect("fixture file");
    std::fs::write(dir.join("unrelated.txt"), "nothing to see here\n").expect("fixture file");
    std::fs::write(dir.join("scan.bin"), [0u8, 1, 2, 3]).expect("fixture file");
    std::fs::write(dir.join(".hidden.txt"), "roof repair\n").expect("fixture file");

    let roots = vec![(dir.clone(), MAX_SCAN_DEPTH)];
    let found = search_for_content(&roots, &query_terms("roof repair"), &[], 10);

    let paths: Vec<&str> = found.matches.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(paths.len(), 2, "{paths:?}");
    assert!(
        !paths.iter().any(|p| p.contains(".hidden")),
        "hidden files stay out of the results"
    );
    assert_eq!(found.skipped_binary, 1, "the binary file is counted, not read");

    // Terms match substrings (so "invoice" finds "invoices"), which means a
    // file matching fewer terms still appears - it just ranks lower.
    let hit = &found.matches[0];
    assert!(hit.path.ends_with("roof.txt"), "ranked first: {}", hit.path);
    assert_eq!(hit.terms_matched, 2);
    assert_eq!(hit.match_count, 2, "two term hits on the line");
    assert_eq!(hit.snippets.len(), 1, "one matching line, so one excerpt");
    assert!(hit.snippets[0].contains("Roof repair invoice"), "{:?}", hit.snippets);

    // "roof" also hits "roofer" in the other file, ranked second.
    let partial = &found.matches[1];
    assert!(partial.path.ends_with("notes.md"), "{}", partial.path);
    assert_eq!(partial.terms_matched, 1);

    // The extension filter narrows the same query to markdown only.
    let markdown_only = search_for_content(
        &roots,
        &query_terms("roof"),
        &normalize_extensions(&Some(vec!["md".to_string()])),
        10,
    );
    assert_eq!(markdown_only.matches.len(), 1);
    assert!(markdown_only.matches[0].path.ends_with("notes.md"));

    let _ = std::fs::remove_dir_all(&dir);
}

/// The user's case: the lab work is a .docx, and its text is what is asked for.
#[test]
fn test_content_search_reads_documents() {
    let dir = std::env::temp_dir().join(format!("piely-search-doc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("fixture dir");

    let file = std::fs::File::create(dir.join("lab1.docx")).expect("fixture file");
    let mut zip = zip::ZipWriter::new(file);
    zip.start_file("word/document.xml", zip::write::SimpleFileOptions::default())
        .expect("zip member");
    zip.write_all(
        r#"<w:document><w:body><w:p><w:r><w:t>Лабораторна робота 1</w:t></w:r></w:p><w:p><w:r><w:t>Machine learning: kNN</w:t></w:r></w:p></w:body></w:document>"#
            .as_bytes(),
    )
    .expect("zip member text");
    zip.finish().expect("zip trailer");

    let roots = vec![(dir.clone(), MAX_SCAN_DEPTH)];
    let found = search_for_content(&roots, &query_terms("machine learning"), &[], 10);

    assert_eq!(found.documents_read, 1, "the docx was unpacked");
    assert_eq!(found.skipped_binary, 0);
    let hit = found.matches.first().expect("the docx matches");
    assert!(hit.path.ends_with("lab1.docx"), "{}", hit.path);
    assert_eq!(hit.terms_matched, 2);
    assert!(
        hit.snippets.iter().any(|s| s.contains("Machine learning")),
        "{:?}",
        hit.snippets
    );

    let _ = std::fs::remove_dir_all(&dir);
}


/// Credential files are unreadable to the model even when they sit in a folder
/// it is allowed to search: the search never asks the user first.
#[test]
fn test_content_search_skips_credential_files() {
    let dir = std::env::temp_dir().join(format!("piely-search-secret-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("fixture dir");
    std::fs::write(dir.join("id_rsa"), "PRIVATE KEY roof repair\n").expect("fixture file");
    std::fs::write(dir.join("server.key"), "PRIVATE KEY roof repair\n").expect("fixture file");
    std::fs::write(dir.join(".env"), "TOKEN=roof repair\n").expect("fixture file");
    std::fs::write(dir.join("notes.txt"), "roof repair\n").expect("fixture file");

    let roots = vec![(dir.clone(), MAX_SCAN_DEPTH)];
    let found = search_for_content(&roots, &query_terms("roof repair"), &[], 10);

    let paths: Vec<&str> = found.matches.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(paths.len(), 1, "{paths:?}");
    assert!(paths[0].ends_with("notes.txt"), "{paths:?}");

    let _ = std::fs::remove_dir_all(&dir);
}
