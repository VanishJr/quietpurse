/**
 * PDF bytes written by hand, the way every workbook in xlsx.test.ts is built in
 * code: no PDF file enters this repository, and no real statement enters it in any
 * form. Every coordinate and every string a test passes in is a literal chosen to
 * exercise a rule, so the fixture is reproducible and demonstrably free of anyone's
 * bank data.
 *
 * What it therefore proves: that the reader turns coordinates into rows. It is a
 * regression pin and NOT evidence that a template is right, because the fixture is
 * written to match the template. The evidence for a template is a manual check
 * against a real document.
 *
 * The font is a Type0/Identity-H with a ToUnicode map and no embedded program.
 * Nothing here renders, and text extraction reads ToUnicode, so a fixture can carry
 * the Cyrillic column headings some templates in the tree are written against. A
 * WinAnsi Type1 font could not carry them.
 */

export interface PlacedText {
  x: number;
  y: number;
  text: string;
  /** the point size; only the line grouping cares, through the baselines it sets */
  size?: number;
}

const utf16be = (s: string): string =>
  [...s]
    .map((c) => c.codePointAt(0)!)
    .flatMap((n) => (n > 0xffff ? [0xd800 + ((n - 0x10000) >> 10), 0xdc00 + ((n - 0x10000) & 0x3ff)] : [n]))
    .map((n) => n.toString(16).padStart(4, '0'))
    .join('');

/** code === the UTF-16 unit, so the CMap below is what makes the text readable. */
const toUnicodeCMap = (used: Set<string>): string => {
  const codes = [...used].sort();
  const chunks: string[] = [];
  for (let i = 0; i < codes.length; i += 100) {
    const block = codes.slice(i, i + 100);
    chunks.push(
      `${block.length} beginbfchar\n${block.map((c) => `<${c}> <${c}>`).join('\n')}\nendbfchar`,
    );
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...chunks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');
};

const contentStream = (texts: PlacedText[]): string =>
  texts
    .map(
      (t) =>
        `BT /F1 ${t.size ?? 9} Tf 1 0 0 1 ${t.x} ${t.y} Tm <${utf16be(t.text)}> Tj ET`,
    )
    .join('\n');

interface Options {
  /**
   * A trailer /Encrypt with a password nobody has. pdfjs refuses before it decrypts
   * anything, which is the arm the "password-protected" refusal is written for.
   */
  encrypted?: boolean;
  /** raw page content instead of placed text: a page that draws and says nothing */
  raw?: string;
}

/**
 * One page per array. Coordinates are PDF user units from the bottom left, which is
 * the coordinate system the templates are measured in.
 */
export function buildPdf(pages: PlacedText[][], options: Options = {}): Buffer {
  const used = new Set<string>();
  for (const page of pages) {
    for (const t of page) {
      for (const unit of utf16be(t.text).match(/.{4}/g) ?? []) used.add(unit);
    }
  }

  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);

  const catalog = add('');
  const pagesObj = add('');
  const font = add(
    `<< /Type /Font /Subtype /Type0 /BaseFont /Helvetica /Encoding /Identity-H /DescendantFonts [${objects.length + 1} 0 R] /ToUnicode ${objects.length + 2} 0 R >>`,
  );
  add(
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Helvetica /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 500 >>',
  );
  const cmap = toUnicodeCMap(used);
  add(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`);

  const pageIds: number[] = [];
  for (const page of pages) {
    const content = options.raw ?? contentStream(page);
    const contentId = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595.28 841.88] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let at = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const buf = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(buf);
    at += buf.length;
  });

  const encrypt = options.encrypted
    ? ` /Encrypt << /Filter /Standard /V 1 /R 2 /O <${'a1'.repeat(32)}> /U <${'b2'.repeat(32)}> /P -1 >> /ID [<${'c3'.repeat(16)}> <${'c3'.repeat(16)}>]`
    : '';
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encrypt} >>`,
    'startxref',
    String(at),
    '%%EOF',
  ].join('\n');
  parts.push(Buffer.from(`${xref}\n`));
  return Buffer.concat(parts);
}

/**
 * The same document inside a signed container: a bank's own export can be a CMS
 * envelope carrying the statement, so `%PDF-` sits at an offset rather than at 0. It
 * is not valid CMS and does not need to be. What a fixture has to carry is the shape
 * the sniffer classifies on and the bytes it used to be refused for.
 *
 * The NUL that makes it binary sits in the preamble, ahead of the document, and that
 * placement is the fixture's whole job: after a realistic inner PDF the first NUL
 * falls past NUL_SCAN_BYTES, and a container the NUL scan would not have refused is
 * classified the same whether the new branch sits above that scan or below it. The
 * real containers carry their first NUL at 406, ahead of `%PDF-` at 71.
 *
 * `filler` is how far in the document starts, so a case can put the header past
 * pdfjs's own 1024-byte header search.
 */
export function buildSignedContainer(inner: Buffer, filler = 32): Buffer {
  const body = Buffer.concat([
    // 1.2.840.113549.1.7.2, CMS signedData, at byte 5 as in the real documents
    Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]),
    Buffer.alloc(filler),
    inner,
    // certificates and signerInfos follow the content in CMS, which is why a
    // container does not end at %%EOF
    Buffer.alloc(512, 0x5a),
  ]);
  // SEQUENCE, long form with three length bytes, and the length is the true one: the
  // real containers are one complete DER value with nothing appended after it
  const length = [(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff];
  return Buffer.concat([Buffer.from([0x30, 0x83, ...length]), body]);
}

/**
 * Where a container's own bytes begin: after the tag, the long-form marker and three
 * length bytes. A body under 64 KiB puts a NUL in that length field by arithmetic, so
 * a test asking whether the fixture is binary before the document has to start
 * looking past it or it is reading the fixture's size rather than its shape.
 */
export const CONTAINER_HEADER_BYTES = 5;

/** A page that draws a filled rectangle and carries no text at all: a "scan". */
export const buildImagePdf = (): Buffer =>
  buildPdf([[]], { raw: '0.2 0.2 0.2 rg 50 50 500 700 re f' });
