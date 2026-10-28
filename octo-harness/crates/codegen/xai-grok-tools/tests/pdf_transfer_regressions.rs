//! Exercise real PDFs through the production renderer; hostile inputs run in
//! child processes so a stack overflow cannot take down the regression driver.
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn stream(dictionary: &str, data: &str) -> Vec<u8> {
    format!(
        "<< {dictionary} /Length {} >>\nstream\n{data}\nendstream",
        data.len()
    )
    .into_bytes()
}

fn pdf(functions: &[String]) -> Vec<u8> {
    let mut objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 8 8] /Resources << /ExtGState << /GS1 5 0 R >> >> /Contents 4 0 R >>".to_vec(),
        stream("", "/GS1 gs 1 0 0 rg 0 0 8 8 re f"),
        b"<< /Type /ExtGState /SMask << /S /Luminosity /G 6 0 R /TR 7 0 R >> >>".to_vec(),
        stream("/Type /XObject /Subtype /Form /BBox [0 0 8 8] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>", "0.5 g 0 0 8 8 re f"),
    ];
    objects.extend(functions.iter().map(|body| body.as_bytes().to_vec()));
    let mut bytes = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(bytes.len());
        bytes.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        bytes.extend_from_slice(body);
        bytes.extend_from_slice(b"\nendobj\n");
    }
    let xref = bytes.len();
    bytes.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        bytes.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    bytes.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    bytes
}

fn type2(exponent: u8) -> String {
    format!("<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N {exponent} >>")
}

fn stitch(domain: &str, functions: &str, bounds: &str, encode: &str) -> String {
    format!(
        "<< /FunctionType 3 /Domain [{domain}] /Functions [{functions}] /Bounds [{bounds}] /Encode [{encode}] >>"
    )
}

fn render(functions: &[String]) -> Vec<u8> {
    let document = pdf_oxide::PdfDocument::from_bytes(pdf(functions)).unwrap();
    pdf_oxide::rendering::render_page(
        &document,
        0,
        &pdf_oxide::rendering::RenderOptions::with_dpi(72),
    )
    .unwrap()
    .data
}

#[test]
fn pdf_transfer_child() {
    let Ok(case) = std::env::var("OCTO_PDF_TRANSFER_CASE") else {
        return;
    };
    let identity = render(&[type2(1)]);
    match case.as_str() {
        "self-reference" => assert_eq!(render(&[stitch("0 1", "7 0 R", "", "0 1")]), identity),
        "inverted-domain" => assert_eq!(
            render(&[stitch("1 0", "8 0 R", "", "0 1"), type2(2)]),
            identity
        ),
        "nonfinite-domain" => assert_eq!(
            render(&[stitch("0 1e100", "8 0 R", "", "0 1"), type2(2)]),
            identity
        ),
        "deep-chain" => {
            let mut functions = (0..64)
                .map(|i| stitch("0 1", &format!("{} 0 R", i + 8), "", "0 1"))
                .collect::<Vec<_>>();
            functions.push(type2(2));
            assert_eq!(render(&functions), identity);
        }
        "shared-tree-budget" => {
            let mut functions = (0..16)
                .map(|i| stitch("0 1", &format!("{0} 0 R {0} 0 R", i + 8), "0.5", "0 1 0 1"))
                .collect::<Vec<_>>();
            functions.push(type2(2));
            assert_eq!(render(&functions), identity);
        }
        "normal" => {
            let direct = render(&[type2(2)]);
            assert_ne!(direct, identity, "fixture must actually exercise /TR");
            assert_eq!(
                render(&[stitch("0 1", "8 0 R", "", "0 1"), type2(2)]),
                direct
            );
            assert_eq!(
                render(&[
                    stitch("0 1", "8 0 R", "", "0 1"),
                    stitch("0 1", "9 0 R", "", "0 1"),
                    type2(2)
                ]),
                direct
            );
        }
        _ => panic!("unknown fixture"),
    }
}

fn child(case: &str) {
    let output = tempfile::NamedTempFile::new().unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "pdf_transfer_child", "--nocapture"])
        .env("OCTO_PDF_TRANSFER_CASE", case)
        .stdout(Stdio::from(output.reopen().unwrap()))
        .stderr(Stdio::from(output.reopen().unwrap()));
    let mut process = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = process.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= deadline {
            process.kill().unwrap();
            let _ = process.wait();
            panic!("{case} exceeded the render deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        status.success(),
        "{case}: {}",
        std::fs::read_to_string(output.path()).unwrap()
    );
}

#[test]
fn self_reference_pdf_is_bounded() {
    child("self-reference")
}
#[test]
fn inverted_domain_pdf_does_not_panic() {
    child("inverted-domain")
}
#[test]
fn nonfinite_domain_pdf_is_rejected() {
    child("nonfinite-domain")
}
#[test]
fn deeply_nested_pdf_is_bounded() {
    child("deep-chain")
}
#[test]
fn repeated_reference_tree_has_total_budget() {
    child("shared-tree-budget")
}
#[test]
fn ordinary_type3_preserves_pixels() {
    child("normal")
}
