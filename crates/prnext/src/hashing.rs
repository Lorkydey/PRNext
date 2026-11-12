use sha2::{Digest, Sha256};

/// Keep persisted cache keys and integrity manifests in lowercase SHA-256 hex.
pub(crate) fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(value.as_ref());
    let mut encoded = [0u8; 64];
    for (&byte, pair) in digest.iter().zip(encoded.chunks_exact_mut(2)) {
        pair[0] = DIGITS[(byte >> 4) as usize];
        pair[1] = DIGITS[(byte & 15) as usize];
    }
    String::from_utf8(encoded.to_vec()).expect("hexadecimal output is ASCII")
}

#[cfg(test)]
mod tests {
    use super::sha256_hex;

    #[test]
    fn preserves_existing_sha256_wire_format() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex("prnext-versioned:example:7"),
            "1b3c719aa56a31843a6e5dc917db5069212ea71743e40495e6ee1e3f5adea212"
        );
        assert_eq!(
            sha256_hex((0..=255).collect::<Vec<u8>>()),
            "40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880"
        );
    }
}
