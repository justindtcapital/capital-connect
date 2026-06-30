import type { Contact } from "@/lib/types";
import { EXPORT_COLUMNS } from "@/lib/csv-export";

// A minimal, dependency-free .xlsx (Office Open XML) writer. Produces a genuine
// Excel workbook — a ZIP archive of XML parts — so files open without the
// "format and extension don't match" warning you'd get from an HTML/.xls hack.
// All cells are written as inline strings, which is plenty for a contact export.

const enc = new TextEncoder();

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Strip control characters that are illegal in XML 1.0 (Excel rejects them).
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

// 0-based column index → spreadsheet column letter (0 → A, 26 → AA).
function colLetter(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(headers: string[], rows: string[][]): string {
  const cell = (col: number, rowNum: number, text: string) =>
    `<c r="${colLetter(col)}${rowNum}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(
      text
    )}</t></is></c>`;

  const headerRow = `<row r="1">${headers.map((h, i) => cell(i, 1, h)).join("")}</row>`;
  const bodyRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 2}">${r.map((v, ci) => cell(ci, ri + 2, v ?? "")).join("")}</row>`
    )
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${headerRow}${bodyRows}</sheetData></worksheet>`
  );
}

// --- Minimal ZIP writer (store/no-compression) -----------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function zip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) =>
    new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = concat([
      u32(0x04034b50), // local file header signature
      u16(20), // version needed
      u16(0), // flags
      u16(0), // compression: stored
      u16(0), // mod time
      u16(0), // mod date
      u32(crc),
      u32(size), // compressed size
      u32(size), // uncompressed size
      u16(nameBytes.length),
      u16(0), // extra length
      nameBytes,
      entry.data,
    ]);
    chunks.push(local);

    central.push(
      concat([
        u32(0x02014b50), // central directory header signature
        u16(20), // version made by
        u16(20), // version needed
        u16(0), // flags
        u16(0), // compression
        u16(0), // mod time
        u16(0), // mod date
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBytes.length),
        u16(0), // extra length
        u16(0), // comment length
        u16(0), // disk number start
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(offset), // local header offset
        nameBytes,
      ])
    );

    offset += local.length;
  }

  const centralBytes = concat(central);
  const end = concat([
    u32(0x06054b50), // end of central directory signature
    u16(0), // disk number
    u16(0), // disk with central directory
    u16(entries.length),
    u16(entries.length),
    u32(centralBytes.length),
    u32(offset), // offset of central directory
    u16(0), // comment length
  ]);

  return concat([...chunks, centralBytes, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// --- Public API ------------------------------------------------------------

export function contactsToXlsx(contacts: Contact[]): Uint8Array {
  const headers = EXPORT_COLUMNS.map((c) => c.header);
  const rows = contacts.map((c) => EXPORT_COLUMNS.map((col) => col.value(c) ?? ""));

  const files: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
          `</Types>`
      ),
    },
    {
      name: "_rels/.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`
      ),
    },
    {
      name: "xl/workbook.xml",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<sheets><sheet name="Contacts" sheetId="1" r:id="rId1"/></sheets></workbook>`
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
          `</Relationships>`
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: enc.encode(sheetXml(headers, rows)),
    },
  ];

  return zip(files);
}

export function downloadXlsx(filename: string, data: Uint8Array): void {
  const blob = new Blob([data as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
