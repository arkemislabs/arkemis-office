# Third-party software

The MIT licence in `LICENSE` covers the original Arkemis Office code. Everything listed here keeps
its own licence and copyright.

## Upstream sources this suite translates (ArtCraft)

Large parts of Quill, Grid, Prism and PDF (`folio`) are JavaScript translations of storytold's
ArtCraft apps, which are dual-licensed **MIT OR Apache-2.0**. This project uses them under the MIT
option. Their MIT notices are kept in `LICENSES/upstream/`:

| Upstream | Arkemis app | Notice |
|---|---|---|
| [storytold/wordcraft](https://github.com/storytold/wordcraft) | Quill | `LICENSES/upstream/wordcraft-LICENSE-MIT.txt` |
| [storytold/gridcraft](https://github.com/storytold/gridcraft) | Grid | `LICENSES/upstream/gridcraft-LICENSE-MIT.txt` |
| [storytold/deckcraft](https://github.com/storytold/deckcraft) | Prism | `LICENSES/upstream/deckcraft-LICENSE-MIT.txt` |
| [storytold/printcraft](https://github.com/storytold/printcraft) (PdfCraft) | PDF | `LICENSES/upstream/pdfcraft-LICENSE-MIT.txt` |

Translated modules name their upstream source file and pinned commit in their header. Specific
adaptations and their exact source paths are also recorded in
`assets/third-party-licenses/artcraft-reference.txt` and `assets/third-party-licenses/wordcraft-*.txt`.
The hyphenation patterns in `assets/hyphenation/` are wordcraft's, unmodified, with their licence
headers inside each file. ArtCraft's name, wordmark and logos are ArtCraft trademarks and are not
used by this project. Slate has no ArtCraft upstream.

## Runtime libraries

| Package | Licence | Used for |
|---|---|---|
| Electron (Chromium, Node.js) | MIT (Chromium: BSD-style and others) | desktop runtime; its `LICENSE` and `LICENSES.chromium.html` ship with the runtime |
| React, React DOM | MIT | user interface |
| TipTap / ProseMirror | MIT | Slate's note editor |
| lucide-react | ISC | some interface icons |
| docx | MIT | DOCX export |
| mammoth | BSD-2-Clause | DOCX import |
| ExcelJS, ssf | MIT, Apache-2.0 | XLSX import/export, number formats |
| PptxGenJS | MIT | PPTX export |
| JSZip | MIT (dual MIT OR GPL-3.0; used under MIT) | ZIP containers |
| fast-xml-parser | MIT | XML parsing |
| pdf-lib, @pdf-lib/fontkit | MIT | PDF writing and font embedding |
| pdfjs-dist (PDF.js) | Apache-2.0 | PDF rendering |
| @embedpdf/pdfium 2.15.1 | MIT (bundled PDFium: BSD-style and Apache-2.0) | PDF source text editing |
| PKI.js 4.0.1, ASN1.js 4.0.0 | BSD-3-Clause | offline PDF signature integrity checks |
| nspell 2.1.5 | MIT | spell checking |
| dictionary-en 4.0.0 | MIT AND BSD (SCOWL word lists, Ispell affix rules) | the en_US Hunspell dictionary |
| tesseract.js 7.0.0 | Apache-2.0 | OCR of scanned PDF pages |
| tessdata_fast `eng.traineddata` | Apache-2.0 | the English OCR model, in `assets/ocr/` with its `LICENSE` |
| regenerator-runtime | MIT | runtime helper |

`npm run build` writes the licence file of every package bundled into the app to
`assets/third-party-licenses/`, and packaging ships that folder. `package-lock.json` records the
resolved versions; run `npm ls --all` for the full dependency tree.

Notes on specific components:

- PDF signature verification uses local WebCrypto and the certificates embedded in the PDF. It
  does not establish a trusted certification path or check revocation.
- Spell checking runs in a local worker; the user dictionary stays in the app's preferences and
  nothing is sent anywhere.

## Trademarks

The suite is an independent implementation. Microsoft, Office, Word, Excel, PowerPoint, OneNote
and Acrobat are trademarks of their respective owners. No Microsoft or Adobe code, icons or
branded interface assets are included.
