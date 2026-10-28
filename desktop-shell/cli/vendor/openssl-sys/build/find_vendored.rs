use openssl_src;
use std::path::PathBuf;

use super::env;

pub fn get_openssl(_target: &str) -> (Vec<PathBuf>, PathBuf) {
    let openssl_config_dir = env("OPENSSL_CONFIG_DIR");

    let mut openssl_src_build = openssl_src::Build::new();
    if let Some(value) = openssl_config_dir {
        openssl_src_build.openssl_dir(PathBuf::from(value));
    }

    let artifacts = openssl_src_build.build();
    if _target.contains("msvc") {
        let pdb = artifacts.lib_dir().join("ossl_static.pdb");
        if pdb.is_file() {
            let recorded = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is required"))
                .join("openssl-build/build/src/ossl_static.pdb");
            // shortcut: retain OpenSSL's PDB at its recorded path until openssl-src preserves it.
            std::fs::create_dir_all(recorded.parent().unwrap()).expect("create OpenSSL PDB directory");
            std::fs::copy(pdb, recorded).expect("preserve OpenSSL static debug information");
        }
    }
    println!("cargo:vendored=1");
    println!(
        "cargo:root={}",
        artifacts.lib_dir().parent().unwrap().display()
    );

    (
        vec![artifacts.lib_dir().to_path_buf()],
        artifacts.include_dir().to_path_buf(),
    )
}
