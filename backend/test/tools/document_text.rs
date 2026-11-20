// Documents are read like text files: the formats people keep their work in are
// unpacked, and a format we cannot read is skipped rather than guessed at.
use super::*;
use std::io::Write;
use std::path::{Path, PathBuf};

fn temp_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("piely-doc-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("fixture dir");
    dir.join(name)
}

/// The real thing: a zip with the XML Word/Excel/LibreOffice write.
fn write_zip(path: &Path, members: &[(&str, &str)]) {
    let file = std::fs::File::create(path).expect("fixture file");
    let mut zip = zip::ZipWriter::new(file);
    for (name, content) in members {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .expect("zip member");
        zip.write_all(content.as_bytes()).expect("zip member text");
    }
    zip.finish().expect("zip trailer");
}

/// A PDF with one text object, xref offsets and all: what pdf-extract needs.
fn write_pdf(path: &Path, text: &str) {
    let content = format!("BT /F1 18 Tf 72 700 Td ({}) Tj ET", text);
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>".to_string(),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        format!("<< /Length {} >>\nstream\n{}\nendstream", content.len(), content),
    ];

    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.push_str(&format!("{} 0 obj\n{}\nendobj\n", index + 1, body));
    }
    let xref_at = pdf.len();
    pdf.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
    for offset in &offsets {
        pdf.push_str(&format!("{:010} 00000 n \n", offset));
    }
    pdf.push_str(&format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
        objects.len() + 1,
        xref_at
    ));

    std::fs::write(path, pdf).expect("fixture file");
}

#[test]
fn test_xml_to_text_keeps_paragraphs_and_entities() {
    let xml = r#"<w:p><w:r><w:t>Roof &amp; walls</w:t></w:r><w:tab/><w:r><w:t>400 &#8364;</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p>"#;
    let text = xml_to_text(xml);

    assert_eq!(text, "Roof & walls\t400 €\nSecond line", "{text}");
}

#[test]
fn test_docx_and_xlsx_and_odt_are_unpacked() {
    let docx = temp_path("lab.docx");
    write_zip(
        &docx,
        &[(
            "word/document.xml",
            r#"<w:document><w:body><w:p><w:r><w:t>Лабораторна робота 1</w:t></w:r></w:p><w:p><w:r><w:t>Machine learning</w:t></w:r></w:p></w:body></w:document>"#,
        )],
    );
    let text = extract_text(&docx).expect("docx text");
    assert!(text.contains("Лабораторна робота 1"), "{text}");
    assert!(text.contains("Machine learning"), "{text}");

    let xlsx = temp_path("grades.xlsx");
    write_zip(
        &xlsx,
        &[
            ("xl/sharedStrings.xml", "<sst><si><t>Machine learning</t></si></sst>"),
            ("xl/worksheets/sheet1.xml", "<worksheet><row><c><v>5</v></c><c><v>4</v></c></row></worksheet>"),
        ],
    );
    let text = extract_text(&xlsx).expect("xlsx text");
    assert!(text.contains("Machine learning"), "{text}");
    assert!(text.contains("5\t4"), "{text}");

    let odt = temp_path("report.odt");
    write_zip(
        &odt,
        &[("content.xml", "<office:body><text:p>First lab</text:p><text:p>Second lab</text:p></office:body>")],
    );
    let text = extract_text(&odt).expect("odt text");
    assert!(text.contains("First lab\nSecond lab"), "{text}");

    for path in [docx, xlsx, odt] {
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn test_pdf_text_is_extracted() {
    let pdf = temp_path("lab.pdf");
    write_pdf(&pdf, "Laboratory work 1");

    let text = extract_text(&pdf).expect("pdf text");
    assert!(text.contains("Laboratory work 1"), "{text}");

    let _ = std::fs::remove_file(pdf);
}

#[test]
fn test_broken_and_unknown_files_yield_nothing() {
    let broken = temp_path("broken.docx");
    std::fs::write(&broken, b"PK\x03\x04not really a zip").expect("fixture file");
    assert_eq!(extract_text(&broken), None);

    let image = temp_path("photo.png");
    std::fs::write(&image, [0x89, b'P', b'N', b'G', 0, 0]).expect("fixture file");
    assert!(!is_document(&image));
    assert_eq!(extract_text(&image), None, "not a document format");

    // A PDF with no text layer (a scan) is empty, not an error.
    let scan = temp_path("scan.pdf");
    write_pdf(&scan, "");
    assert_eq!(extract_text(&scan), None);

    for path in [broken, image, scan] {
        let _ = std::fs::remove_file(path);
    }
}

#[test]
fn test_is_document_covers_the_office_formats() {
    for name in ["a.docx", "b.XLSX", "c.pptx", "d.odt", "e.ods", "f.pdf", "g.epub"] {
        assert!(is_document(Path::new(name)), "{name}");
    }
    for name in ["a.txt", "b.md", "c.png", "d.zip", "noextension"] {
        assert!(!is_document(Path::new(name)), "{name}");
    }
}

#[cfg(unix)]
#[test]
fn test_a_zip_bomb_cannot_blow_up_memory() {
    // 32 MB of text in one member: the reader is capped, so this stays small.
    let bomb = temp_path("bomb.docx");
    let huge = "A".repeat(32 * 1024 * 1024);
    write_zip(&bomb, &[("word/document.xml", &huge)]);

    let text = extract_text(&bomb).expect("the head of the member is still text");
    assert!(
        text.chars().count() <= MAX_DOCUMENT_CHARS,
        "extracted {} chars",
        text.chars().count()
    );

    let _ = std::fs::remove_file(bomb);
}

#[cfg(unix)]
#[test]
fn test_a_fifo_is_not_a_document() {
    let fifo = temp_path("pipe.docx");
    let _ = std::fs::remove_file(&fifo);
    let made = std::process::Command::new("mkfifo").arg(&fifo).status();
    if !made.map(|status| status.success()).unwrap_or(false) {
        return; // no mkfifo on this machine: nothing to test
    }

    // Reading a FIFO would block forever; it must be refused before that.
    assert_eq!(extract_text(&fifo), None);
    assert_eq!(extract_text(&fifo), None);

    let _ = std::fs::remove_file(fifo);
}
