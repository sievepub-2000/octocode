use std::io::Write;
use std::path::Path;

/// MSVC writes its input filename to stderr even with /EP /nologo. cc's
/// try_expand promotes every stderr line to a Cargo warning, including that
/// ordinary progress line. Keep the compiler streams and all diagnostics.
pub fn expand(build: &mut cc::Build, source: &Path) -> Result<Vec<u8>, String> {
    let compiler = build
        .try_get_compiler()
        .map_err(|error| error.to_string())?;
    if !compiler.is_like_msvc() || compiler.is_like_clang_cl() {
        return build
            .file(source)
            .try_expand()
            .map_err(|error| error.to_string());
    }

    let output = compiler
        .to_command()
        .args(["/nologo", "/EP"])
        .arg(source)
        .output()
        .map_err(|error| format!("MSVC header preprocessing could not start: {error}"))?;
    // Retain the original stderr in Cargo's build-script log, without rewriting it.
    std::io::stderr()
        .write_all(&output.stderr)
        .map_err(|error| error.to_string())?;
    let filename = source
        .file_name()
        .ok_or("preprocessor source has no filename")?
        .to_string_lossy();
    for line in String::from_utf8_lossy(&output.stderr).lines() {
        if line == filename {
            println!("{line}");
        } else {
            println!("cargo:warning={line}");
        }
    }
    if !output.status.success() {
        return Err(format!(
            "MSVC header preprocessing failed with {}",
            output.status
        ));
    }
    Ok(output.stdout)
}
