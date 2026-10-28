use ssh_key::PrivateKey;

use super::Encryption;
use crate::keys::Error;

/// Decode a secret key in the PKCS#5 format, possibly deciphering it
/// using the supplied password.
pub fn decode_pkcs5(
    secret: &[u8],
    password: Option<&str>,
    enc: Encryption,
) -> Result<PrivateKey, Error> {
    let pass = password.ok_or(Error::KeyIsEncrypted)?;
    #[cfg(feature = "rsa")]
    {
        use openssl::{
            hash::MessageDigest,
            pkcs5::bytes_to_key,
            symm::{Cipher, decrypt},
        };
        use zeroize::Zeroizing;
        let (cipher, iv) = match enc {
            Encryption::Aes128Cbc(iv) => (Cipher::aes_128_cbc(), iv),
            Encryption::Aes256Cbc(iv) => (Cipher::aes_256_cbc(), iv),
        };
        // Traditional PEM requires this legacy KDF; new encrypted keys use PKCS#8 PBKDF2.
        let derived = bytes_to_key(
            cipher,
            MessageDigest::md5(),
            pass.as_bytes(),
            Some(&iv[..8]),
            1,
        )?;
        let key = Zeroizing::new(derived.key);
        let _derived_iv = derived.iv.map(Zeroizing::new);
        let plaintext = Zeroizing::new(decrypt(cipher, &key, Some(&iv), secret)?);
        super::decode_rsa_pkcs1_der(&plaintext).map(Into::into)
    }
    #[cfg(not(feature = "rsa"))]
    {
        let _ = (secret, pass, enc);
        Err(Error::UnsupportedKeyType {
            key_type_string: "RSA".to_string(),
            key_type_raw: vec![],
        })
    }
}
