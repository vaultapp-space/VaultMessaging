import { describe, test, expect } from 'vitest';

import { stripJpegExif, stripPngMetadata } from '../src/lib/chat/metadata.js';

// ─── builders ───────────────────────────────────────────────
// Real byte structures rather than fixtures, so the tests state exactly what
// shape they expect and fail informatively when the parser drifts.

function jpegSegment(marker, payload = []) {
  const length = payload.length + 2; // length field includes itself
  return [marker >> 8, marker & 0xff, length >> 8, length & 0xff, ...payload];
}

function buildJpeg({ withExif = true, withComment = false } = {}) {
  const bytes = [0xff, 0xd8]; // SOI

  if (withExif) {
    // APP1 carrying the EXIF magic plus a fake GPS payload.
    const exif = [...new TextEncoder().encode('Exif\0\0GPS:51.5074,-0.1278')];
    bytes.push(...jpegSegment(0xffe1, exif));
  }
  if (withComment) {
    bytes.push(...jpegSegment(0xfffe, [...new TextEncoder().encode('a comment')]));
  }

  // A quantisation table, which must be preserved — dropping it breaks decode.
  bytes.push(...jpegSegment(0xffdb, new Array(64).fill(1)));
  // Start of scan, then entropy-coded data to the end.
  bytes.push(...jpegSegment(0xffda, [0x01, 0x01]));
  bytes.push(0x12, 0x34, 0x56, 0x78);
  bytes.push(0xff, 0xd9); // EOI

  return new Uint8Array(bytes).buffer;
}

function pngChunk(type, data = []) {
  const len = data.length;
  return [
    (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...new TextEncoder().encode(type),
    ...data,
    0, 0, 0, 0, // CRC placeholder
  ];
}

function buildPng({ metadataChunks = ['tEXt'] } = {}) {
  const bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // signature
  bytes.push(...pngChunk('IHDR', new Array(13).fill(0)));
  for (const type of metadataChunks) {
    bytes.push(...pngChunk(type, [...new TextEncoder().encode('Software\0Photoshop /home/alice/secret')]));
  }
  bytes.push(...pngChunk('IDAT', [1, 2, 3, 4]));
  bytes.push(...pngChunk('IEND'));
  return new Uint8Array(bytes).buffer;
}

const asText = (buffer) => new TextDecoder('latin1').decode(new Uint8Array(buffer));

// ─── JPEG ───────────────────────────────────────────────────

describe('stripJpegExif', () => {
  test('removes the APP1 EXIF segment', () => {
    const original = buildJpeg({ withExif: true });
    expect(asText(original)).toContain('GPS:51.5074');

    const stripped = stripJpegExif(original);

    expect(asText(stripped)).not.toContain('GPS:51.5074');
    expect(asText(stripped)).not.toContain('Exif');
  });

  test('the result is smaller than the original', () => {
    const original = buildJpeg({ withExif: true });
    expect(stripJpegExif(original).byteLength).toBeLessThan(original.byteLength);
  });

  test('preserves the SOI and EOI markers', () => {
    const stripped = new Uint8Array(stripJpegExif(buildJpeg()));

    expect([stripped[0], stripped[1]]).toEqual([0xff, 0xd8]);
    expect([stripped[stripped.length - 2], stripped[stripped.length - 1]]).toEqual([0xff, 0xd9]);
  });

  test('preserves segments needed to decode the image', () => {
    // Dropping the quantisation table would produce an unopenable file.
    const stripped = new Uint8Array(stripJpegExif(buildJpeg()));
    let foundDqt = false;
    for (let i = 0; i < stripped.length - 1; i += 1) {
      if (stripped[i] === 0xff && stripped[i + 1] === 0xdb) { foundDqt = true; break; }
    }
    expect(foundDqt).toBe(true);
  });

  test('preserves the entropy-coded image data', () => {
    const stripped = new Uint8Array(stripJpegExif(buildJpeg()));
    const tail = Array.from(stripped.slice(-6));
    expect(tail).toEqual([0x12, 0x34, 0x56, 0x78, 0xff, 0xd9]);
  });

  test('a JPEG without EXIF is passed through intact', () => {
    const original = buildJpeg({ withExif: false });
    expect(new Uint8Array(stripJpegExif(original))).toEqual(new Uint8Array(original));
  });

  test('non-JPEG input is returned unchanged', () => {
    // Better to send an un-stripped file than a corrupted one.
    const notJpeg = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
    expect(new Uint8Array(stripJpegExif(notJpeg))).toEqual(new Uint8Array(notJpeg));
  });

  test('truncated input does not throw', () => {
    for (const bytes of [[], [0xff], [0xff, 0xd8], [0xff, 0xd8, 0xff], [0xff, 0xd8, 0xff, 0xe1, 0x00]]) {
      expect(() => stripJpegExif(new Uint8Array(bytes).buffer)).not.toThrow();
    }
  });

  test('a segment claiming a length past the buffer does not throw', () => {
    // Hostile or corrupt input must not crash the composer.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x01, 0x02]);
    expect(() => stripJpegExif(bytes.buffer)).not.toThrow();
  });
});

// ─── PNG ────────────────────────────────────────────────────

describe('stripPngMetadata', () => {
  test('removes tEXt chunks', () => {
    const original = buildPng({ metadataChunks: ['tEXt'] });
    expect(asText(original)).toContain('/home/alice/secret');

    const stripped = stripPngMetadata(original);

    expect(asText(stripped)).not.toContain('/home/alice/secret');
    expect(asText(stripped)).not.toContain('tEXt');
  });

  test('removes every metadata chunk type it claims to', () => {
    for (const type of ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']) {
      const stripped = stripPngMetadata(buildPng({ metadataChunks: [type] }));
      expect(asText(stripped)).not.toContain(type);
      expect(asText(stripped)).not.toContain('/home/alice/secret');
    }
  });

  test('preserves the signature, header, image data and end chunk', () => {
    const stripped = stripPngMetadata(buildPng());
    const bytes = new Uint8Array(stripped);

    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(asText(stripped)).toContain('IHDR');
    expect(asText(stripped)).toContain('IDAT');
    expect(asText(stripped)).toContain('IEND');
  });

  test('a PNG without metadata is passed through intact', () => {
    const original = buildPng({ metadataChunks: [] });
    expect(new Uint8Array(stripPngMetadata(original))).toEqual(new Uint8Array(original));
  });

  test('strips several metadata chunks at once', () => {
    const stripped = stripPngMetadata(buildPng({ metadataChunks: ['tEXt', 'iTXt', 'eXIf'] }));
    expect(asText(stripped)).not.toContain('/home/alice/secret');
    expect(asText(stripped)).toContain('IDAT');
  });

  test('non-PNG input is returned unchanged', () => {
    const notPng = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;
    expect(new Uint8Array(stripPngMetadata(notPng))).toEqual(new Uint8Array(notPng));
  });

  test('a JPEG is not mistaken for a PNG', () => {
    const jpeg = buildJpeg();
    expect(new Uint8Array(stripPngMetadata(jpeg))).toEqual(new Uint8Array(jpeg));
  });

  test('truncated input does not throw', () => {
    for (const n of [0, 1, 7, 8, 9, 15]) {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(Math.max(0, n)).fill(0)]);
      expect(() => stripPngMetadata(bytes.slice(0, n).buffer)).not.toThrow();
      expect(() => stripPngMetadata(bytes.buffer)).not.toThrow();
    }
  });

  test('a chunk claiming a length past the buffer does not throw', () => {
    const bytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0xff, 0xff, 0xff, 0xff, // absurd chunk length
      0x74, 0x45, 0x58, 0x74, // 'tEXt'
    ]);
    expect(() => stripPngMetadata(bytes.buffer)).not.toThrow();
  });
});
