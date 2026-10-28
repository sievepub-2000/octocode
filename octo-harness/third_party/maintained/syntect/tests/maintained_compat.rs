use std::io::{self, Write};
use syntect::{
    dumps,
    highlighting::ThemeSet,
    parsing::{SyntaxDefinition, SyntaxSet},
};

#[test]
fn existing_embedded_syntaxes_and_themes_load() {
    for syntaxes in [
        SyntaxSet::load_defaults_nonewlines(),
        SyntaxSet::load_defaults_newlines(),
    ] {
        assert!(syntaxes.syntaxes().len() > 50);
        assert!(syntaxes.find_syntax_by_extension("rs").is_some());
        let bytes = dumps::dump_binary(&syntaxes);
        let restored: SyntaxSet = dumps::from_reader(bytes.as_slice()).unwrap();
        assert_eq!(restored.syntaxes().len(), syntaxes.syntaxes().len());
    }
    assert!(ThemeSet::load_defaults().themes.len() >= 5);
}

#[test]
fn yaml_loader_preserves_valid_and_invalid_inputs() {
    let syntax = SyntaxDefinition::load_from_str(
        "name: Example\nscope: source.example\ncontexts:\n  main: []\n",
        false,
        None,
    )
    .unwrap();
    assert_eq!(syntax.name, "Example");
    assert!(SyntaxDefinition::load_from_str("name: [unterminated", false, None).is_err());
}

#[test]
fn legacy_fixed_width_encoding_and_corruption_are_checked() {
    let bytes = [3, 0, 0, 0, 0, 0, 0, 0, 10, 20, 30];
    assert_eq!(
        dumps::from_uncompressed_data::<Vec<u8>>(&bytes).unwrap(),
        vec![10, 20, 30]
    );
    for length in 0..bytes.len() {
        assert!(
            dumps::from_uncompressed_data::<Vec<u8>>(&bytes[..length]).is_err(),
            "accepted truncated length {length}"
        );
    }
    assert!(dumps::from_reader::<Vec<u8>, _>(&b"invalid zlib"[..]).is_err());
    let value = vec![10u8, 20, 30];
    assert_eq!(
        dumps::from_reader::<Vec<u8>, _>(dumps::dump_binary(&value).as_slice()).unwrap(),
        value
    );
}

#[test]
fn uncompressed_output_matches_legacy_wire_bytes_and_reports_missing_files() {
    let path = std::env::temp_dir().join(format!(
        "octocode-syntect-{}-{}.dump",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(path.clone());
    assert_eq!(
        dumps::from_uncompressed_dump_file::<Vec<u8>, _>(&path)
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
    dumps::dump_to_uncompressed_file(&vec![10u8, 20, 30], &path).unwrap();
    assert_eq!(
        std::fs::read(&path).unwrap(),
        [3, 0, 0, 0, 0, 0, 0, 0, 10, 20, 30]
    );
    assert_eq!(
        dumps::from_uncompressed_dump_file::<Vec<u8>, _>(&path).unwrap(),
        vec![10, 20, 30]
    );
}

struct FailingWriter {
    flush_only: bool,
}
impl Write for FailingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.flush_only {
            Ok(bytes.len())
        } else {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "write denied",
            ))
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "flush denied",
        ))
    }
}

#[test]
fn compressed_writer_propagates_write_and_flush_failures() {
    for flush_only in [false, true] {
        let error =
            dumps::dump_to_writer(&vec![1u8, 2, 3], FailingWriter { flush_only }).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
    }
}
