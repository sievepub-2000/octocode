//! Shared unscaled font access for PDF extraction, embedding and rendering.

use skrifa::{
    instance::{LocationRef, Size},
    outline::{pen::OutlinePen, DrawSettings},
    raw::{
        tables::cmap::{CmapSubtable, PlatformId},
        tables::os2::SelectionFlags,
        types::NameId,
        ReadError, TableProvider,
    },
    FontRef, GlyphId, MetadataProvider,
};

pub(crate) struct FontFace<'a> {
    font: FontRef<'a>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use skrifa::raw::{FontData, FontRead};

    #[test]
    fn bundled_font_retains_metadata_and_drawable_outlines() {
        let data = include_bytes!("assets/DejaVuSans.ttf");
        let face = FontFace::parse(data, 0).unwrap();
        assert_eq!(face.units_per_em(), 2048);
        assert_eq!(face.glyph_index('A'), Some(36));
        assert_eq!(face.glyph_hor_advance(36), Some(1401));
        assert_eq!(face.glyph_name(36).as_deref(), Some("A"));
        assert_eq!(
            face.name(NameId::FAMILY_NAME).as_deref(),
            Some("DejaVu Sans")
        );
        let mut outline = Vec::new();
        assert!(face.outline_glyph(36, &mut outline).is_some());
        assert!(!outline.is_empty());
        assert!(FontFace::parse(data, 1).is_err());
        assert!(FontFace::parse(&data[..32], 0).is_err());
    }

    #[test]
    fn format_two_mapping_keeps_delta_and_rejects_missing_or_truncated_entries() {
        let mut bytes = vec![0u8; 528];
        bytes[0..2].copy_from_slice(&2u16.to_be_bytes());
        bytes[2..4].copy_from_slice(&528u16.to_be_bytes());
        bytes[518..526].copy_from_slice(&[0, 65, 0, 1, 255, 255, 0, 2]);
        bytes[526..528].copy_from_slice(&2u16.to_be_bytes());
        let table = CmapSubtable::read(FontData::new(&bytes)).unwrap();
        assert_eq!(FontFace::map_codepoint(&table, 65), Some(1));
        assert_eq!(FontFace::map_codepoint(&table, 66), None);
        assert_eq!(FontFace::map_codepoint(&table, 0x10000), None);
        bytes.truncate(526);
        let table = CmapSubtable::read(FontData::new(&bytes)).unwrap();
        assert_eq!(FontFace::map_codepoint(&table, 65), None);
    }
}

impl std::fmt::Debug for FontFace<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FontFace")
            .field("glyph_count", &self.number_of_glyphs())
            .finish_non_exhaustive()
    }
}

impl<'a> FontFace<'a> {
    pub(crate) fn parse(data: &'a [u8], index: u32) -> Result<Self, ReadError> {
        let font = FontRef::from_index(data, index)?;
        let head = font.head()?;
        if !(16..=16384).contains(&head.units_per_em())
            || !matches!(head.index_to_loc_format(), 0 | 1)
        {
            return Err(ReadError::MalformedData("invalid font header"));
        }
        font.hhea()?;
        if font.maxp()?.num_glyphs() == 0 {
            return Err(ReadError::MalformedData("font has no glyphs"));
        }
        Ok(Self { font })
    }

    pub(crate) fn units_per_em(&self) -> u16 {
        self.font.head().expect("validated head").units_per_em()
    }

    pub(crate) fn number_of_glyphs(&self) -> u16 {
        self.font.maxp().expect("validated maxp").num_glyphs()
    }

    pub(crate) fn cmap_records(&self) -> impl Iterator<Item = (PlatformId, u16, CmapSubtable<'a>)> {
        self.font.cmap().ok().into_iter().flat_map(|cmap| {
            cmap.encoding_records().iter().filter_map(move |record| {
                Some((
                    record.platform_id(),
                    record.encoding_id(),
                    record.subtable(cmap.offset_data()).ok()?,
                ))
            })
        })
    }

    pub(crate) fn glyph_index(&self, character: char) -> Option<u16> {
        self.cmap_records()
            .find_map(|(platform, encoding, subtable)| {
                let unicode = platform == PlatformId::Unicode
                    || platform == PlatformId::Windows
                        && (encoding == 1
                            || encoding == 10
                                && matches!(
                                    subtable,
                                    CmapSubtable::Format12(_) | CmapSubtable::Format13(_)
                                ));
                unicode
                    .then(|| Self::map_codepoint(&subtable, character as u32))
                    .flatten()
            })
    }

    pub(crate) fn map_codepoint(subtable: &CmapSubtable<'_>, codepoint: u32) -> Option<u16> {
        // read-fonts exposes format 2 records but has no mapping implementation.
        if let CmapSubtable::Format2(table) = subtable {
            let code = u16::try_from(codepoint).ok()?;
            let index = if code < 0xff {
                0
            } else {
                table.sub_header_keys().get((code >> 8) as usize)?.get() / 8
            };
            let data = table.offset_data();
            let offset = 518 + usize::from(index) * 8;
            let first: u16 = data.read_at(offset).ok()?;
            let count: u16 = data.read_at(offset + 2).ok()?;
            let low = code & 0xff;
            if low < first || low >= first.checked_add(count)? {
                return None;
            }
            let delta: i16 = data.read_at(offset + 4).ok()?;
            let range: u16 = data.read_at(offset + 6).ok()?;
            let glyph: u16 = data
                .read_at(offset + 6 + usize::from(range) + usize::from(low - first) * 2)
                .ok()?;
            return (glyph != 0).then_some(glyph.wrapping_add(delta as u16));
        }
        subtable
            .map_codepoint(codepoint)
            .and_then(|glyph| u16::try_from(glyph.to_u32()).ok())
            .filter(|glyph| *glyph != 0)
    }

    pub(crate) fn glyph_hor_advance(&self, glyph: u16) -> Option<u16> {
        if glyph >= self.number_of_glyphs() {
            return None;
        }
        self.font
            .hmtx()
            .ok()?
            .advance(GlyphId::new(u32::from(glyph)))
    }

    pub(crate) fn glyph_name(&self, glyph: u16) -> Option<String> {
        let glyph = GlyphId::new(u32::from(glyph));
        self.font
            .post()
            .ok()
            .and_then(|post| post.glyph_name(glyph.try_into().ok()?).map(str::to_owned))
            .or_else(|| {
                let cff = self.font.cff().ok()?;
                let sid = cff.charset(0).ok()??.string_id(glyph).ok()?;
                std::str::from_utf8(cff.string(sid)?)
                    .ok()
                    .map(str::to_owned)
            })
    }

    pub(crate) fn name(&self, id: NameId) -> Option<String> {
        self.font
            .localized_strings(id)
            .map(|name| name.to_string())
            .find(|name| !name.is_empty())
    }

    pub(crate) fn ascender(&self) -> i16 {
        let hhea = self
            .font
            .hhea()
            .expect("validated hhea")
            .ascender()
            .to_i16();
        let Ok(os2) = self.font.os2() else {
            return hhea;
        };
        if os2.version() >= 4
            && os2
                .fs_selection()
                .contains(SelectionFlags::USE_TYPO_METRICS)
        {
            return os2.s_typo_ascender();
        }
        if hhea != 0 {
            hhea
        } else if os2.s_typo_ascender() != 0 {
            os2.s_typo_ascender()
        } else {
            os2.us_win_ascent() as i16
        }
    }

    pub(crate) fn descender(&self) -> i16 {
        let hhea = self
            .font
            .hhea()
            .expect("validated hhea")
            .descender()
            .to_i16();
        let Ok(os2) = self.font.os2() else {
            return hhea;
        };
        if os2.version() >= 4
            && os2
                .fs_selection()
                .contains(SelectionFlags::USE_TYPO_METRICS)
        {
            return os2.s_typo_descender();
        }
        if hhea != 0 {
            hhea
        } else if os2.s_typo_descender() != 0 {
            os2.s_typo_descender()
        } else {
            (os2.us_win_descent() as i16).wrapping_neg()
        }
    }

    pub(crate) fn capital_height(&self) -> Option<i16> {
        self.font.os2().ok()?.s_cap_height()
    }
    pub(crate) fn x_height(&self) -> Option<i16> {
        self.font.os2().ok()?.sx_height()
    }
    pub(crate) fn italic_angle(&self) -> f32 {
        self.font
            .post()
            .map(|post| post.italic_angle().to_f64() as f32)
            .unwrap_or(0.0)
    }
    pub(crate) fn is_bold(&self) -> bool {
        self.font
            .os2()
            .is_ok_and(|os2| os2.fs_selection().contains(SelectionFlags::BOLD))
    }
    pub(crate) fn is_italic(&self) -> bool {
        self.italic_angle() != 0.0
            || self
                .font
                .os2()
                .is_ok_and(|os2| os2.fs_selection().contains(SelectionFlags::ITALIC))
    }
    pub(crate) fn is_monospaced(&self) -> bool {
        self.font
            .post()
            .is_ok_and(|post| post.is_fixed_pitch() != 0)
    }

    pub(crate) fn bbox(&self) -> (i16, i16, i16, i16) {
        let head = self.font.head().expect("validated head");
        (head.x_min(), head.y_min(), head.x_max(), head.y_max())
    }

    pub(crate) fn outline_glyph(&self, glyph: u16, pen: &mut impl OutlinePen) -> Option<()> {
        self.font
            .outline_glyphs()
            .get(GlyphId::new(u32::from(glyph)))?
            .draw(
                DrawSettings::unhinted(Size::unscaled(), LocationRef::default()),
                pen,
            )
            .ok()
            .map(|_| ())
    }
}
