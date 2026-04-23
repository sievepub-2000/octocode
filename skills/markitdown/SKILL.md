---
name: markitdown
description: Convert office / PDF / HTML / image formats to clean Markdown. Prefer this before summarizing document content or extracting structured requirements from attachments.
source: https://github.com/microsoft/markitdown
integration: external-library
status: descriptor-only
---

# markitdown

Descriptor-only registration (P9 batch). Parallel to the existing `skills/document/` (Docling) skill, `markitdown` is Microsoft's lighter-weight equivalent — good fallback when Docling is unavailable.

## Integration plan (deferred)
1. Add an optional Python subprocess adapter `octocode_markitdown` behind a feature flag.
2. Route to `markitdown` when the file is `.docx`/`.pptx`/`.xlsx` and Docling is not installed.
3. Keep Docling as the default for PDFs (better layout preservation).

## Contract
- Input: file path.
- Output: UTF-8 Markdown string + `{source_path, source_mime, generated_at}` metadata.
