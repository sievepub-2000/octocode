---
name: document
description: Document processing skill for parsing, converting, summarizing, and extracting structured data from PDF, DOCX, Markdown, and other document formats.
---

# document

Process and transform documents between formats, extract key information, and generate summaries.

## When to use

- The user has a PDF, DOCX, or other document that needs parsing or conversion.
- Structured data extraction from unstructured documents is needed.
- Document summarization or key-point extraction is requested.

## Instructions

1. **Identify format**: Determine the input document type (PDF, DOCX, MD, HTML, TXT, CSV, etc.).
2. **Conversion strategy**:
   - For PDF → Markdown: use Docling (`docling convert`), `pdftotext`, or `pandoc`.
   - For DOCX → Markdown: use `pandoc -f docx -t markdown`.
   - For HTML → Markdown: use `pandoc` or readability extraction.
3. **Content extraction**: Parse the converted text for:
   - Headings and section structure
   - Tables (preserve as Markdown tables)
   - Lists and enumerated items
   - Code blocks and technical content
   - Metadata (author, date, version)
4. **Summarization**: When requested, produce a hierarchical summary:
   - One-line TL;DR
   - Key findings (3–5 bullets)
   - Detailed section-by-section breakdown
5. **Structured output**: When extracting data, output as JSON, CSV, or Markdown table as appropriate.
6. Preserve original document structure and formatting where possible.
7. Flag any content that couldn't be parsed reliably.
