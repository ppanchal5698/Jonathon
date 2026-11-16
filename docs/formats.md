# Supported formats

Detection uses **content and extension together**. A file whose content does not match its extension is preserved and
marked `unsupported`. Every original is kept byte-for-byte, whatever its status.

| Format | Extensions | Extractor | Locators kept | Notes | Status |
|---|---|---|---|---|---|
| Plain text | `.txt`, `.text`, `.log` | built-in | line / line range | UTF-8 | fixture-tested |
| Markdown | `.md`, `.markdown`, pasted text | built-in | heading path, line range | | fixture-tested |
| PDF (text layer) | `.pdf` | `unpdf` (pdf.js) in a worker thread | page | Pages without text are reported; all-image PDFs → `needs_ocr` | fixture-tested |
| Word | `.docx` | `mammoth` → HTML → blocks | heading path, paragraph #, table # | Images dropped; macros never run; zip-bomb checks | fixture-tested |
| Excel | `.xlsx` | `exceljs` | sheet, cell range (`A2:D26`) | **Formulas not evaluated**: cached values used, with a warning | fixture-tested |
| CSV | `.csv` | `papaparse` | cell range | Formula-like cells kept as text, with a warning | fixture-tested |
| JSON | `.json` | built-in | JSON pointer | | fixture-tested |
| HTML | `.html`, `.htm` | `node-html-parser` | heading path, paragraph #, table # | Scripts, styles, iframes, forms and images removed; nothing fetched | fixture-tested |
| PowerPoint | `.pptx` | slide XML via `jszip` | slide #, speaker notes | Text only | fixture-tested |
| Email | `.eml` | built-in (basic MIME) | headers / body line range | Attachments inside the email are **not** extracted (warning); upload them separately | fixture-tested |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.tif` | none | n/a | → `needs_ocr`; OCR is not configured on this host (Tesseract not installed) | preserved only |
| Scanned PDF | `.pdf` without text | none | n/a | → `needs_ocr` | preserved only |
| Macro-enabled Office | `.docm`, `.xlsm`, `.pptm`, … | none | n/a | Refused for parsing | preserved only |
| Executables and scripts | `.exe`, `.js`, `.ps1`, … | none | n/a | Never executed | preserved only |
| Audio / video | any | none | n/a | **No transcription**. Upload an existing transcript as text instead | preserved only |

"Fixture-tested" means automated tests run the real parser on generated sample files (`packages/core/test/ingestion.test.ts`).
Real-world documents vary, so check the extraction preview of important files.

Limits: upload size `JONATHON_MAX_UPLOAD_MB` (default 50 MB), parser time `JONATHON_PARSER_TIMEOUT_MS` (default 60 s), parser
heap 768 MB, Office archives at most 250 MB uncompressed and 20,000 entries.
