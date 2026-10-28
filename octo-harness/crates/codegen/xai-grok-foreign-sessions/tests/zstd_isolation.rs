//! Guard RUSTSEC-2026-0391: reused contexts must not expose abandoned session data.
use std::io::{Read, Write};

#[test]
fn abandoned_encoder_does_not_leak_into_the_next_session() {
    let mut context = zstd::zstd_safe::CCtx::create();
    zstd::stream::write::Encoder::with_context(Vec::new(), &mut context)
        .write_all(b"private first session")
        .unwrap();
    let mut next = zstd::stream::write::Encoder::with_context(Vec::new(), &mut context);
    next.write_all(b"second session").unwrap();
    let frame = next.finish().unwrap();
    assert_eq!(zstd::decode_all(frame.as_slice()).unwrap(), b"second session");
}

#[test]
fn abandoned_decoder_does_not_leak_into_the_next_session() {
    let first = zstd::encode_all(&b"private first session"[..], 1).unwrap();
    let second = zstd::encode_all(&b"second session"[..], 1).unwrap();
    let mut context = zstd::zstd_safe::DCtx::create();
    zstd::stream::read::Decoder::with_context(first.as_slice(), &mut context)
        .read_exact(&mut [0; 3])
        .unwrap();
    let mut output = Vec::new();
    zstd::stream::read::Decoder::with_context(second.as_slice(), &mut context)
        .read_to_end(&mut output)
        .unwrap();
    assert_eq!(output, b"second session");
}
