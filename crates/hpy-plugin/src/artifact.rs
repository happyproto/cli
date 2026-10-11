//! Checks on the bytes a release carries, matching the release lexicon's
//! blob constraints.

pub const MAX_WASM_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_IMAGE_BYTES: usize = 1024 * 1024;
pub const WASM_MIME: &str = "application/wasm";

pub fn wasm_problem(bytes: &[u8]) -> Option<String> {
    if !bytes.starts_with(b"\0asm") {
        return Some("is not a WebAssembly module (no `\\0asm` header)".into());
    }
    if bytes.len() > MAX_WASM_BYTES {
        return Some(format!(
            "is {} bytes; the registry accepts at most 16 MiB",
            bytes.len()
        ));
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}

/// The type and size of a presentation image. SVG and anything else the
/// lexicon does not accept is refused.
pub fn inspect_image(bytes: &[u8]) -> Result<ImageInfo, String> {
    use imagesize::{Compression, ImageType};
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "is {} bytes; images may be at most 1 MiB",
            bytes.len()
        ));
    }
    let mime = match imagesize::image_type(bytes) {
        Ok(ImageType::Png) => "image/png",
        Ok(ImageType::Jpeg) => "image/jpeg",
        Ok(ImageType::Webp) => "image/webp",
        Ok(ImageType::Gif) => "image/gif",
        Ok(ImageType::Heif(Compression::Av1)) => "image/avif",
        _ => return Err("must be PNG, JPEG, WebP, GIF or AVIF (SVG is not accepted)".into()),
    };
    let size =
        imagesize::blob_size(bytes).map_err(|e| format!("cannot read its dimensions: {e}"))?;
    Ok(ImageInfo {
        mime,
        width: size.width as u32,
        height: size.height as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 1x1 PNG
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0,
        0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0a, 0x49, 0x44,
        0x41, 0x54, 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1, 0x0d, 0x0a, 0x2d, 0xb4, 0, 0, 0, 0,
        0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn wasm_magic_and_size() {
        assert_eq!(wasm_problem(b"\0asm\x01\0\0\0"), None);
        assert!(
            wasm_problem(b"PK\x03\x04")
                .unwrap()
                .contains("not a WebAssembly")
        );
        let mut big = b"\0asm\x01\0\0\0".to_vec();
        big.resize(MAX_WASM_BYTES + 1, 0);
        assert!(wasm_problem(&big).unwrap().contains("16 MiB"));
    }

    #[test]
    fn png_is_inspected() {
        let info = inspect_image(PNG).unwrap();
        assert_eq!((info.mime, info.width, info.height), ("image/png", 1, 1));
    }

    #[test]
    fn svg_and_oversize_refused() {
        assert!(inspect_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>").is_err());
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(inspect_image(&big).unwrap_err().contains("1 MiB"));
    }
}
