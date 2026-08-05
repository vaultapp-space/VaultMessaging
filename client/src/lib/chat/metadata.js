// ============================================================
// Vault — Image Metadata Stripping
// ============================================================
// Removes EXIF and textual metadata from images before they are encrypted
// and sent.
//
// This is a privacy control, not a formatting nicety. A camera photo carries
// GPS coordinates, capture timestamp, device make and serial number in its
// APP1/EXIF segment — an app that goes to the trouble of end-to-end
// encrypting the bytes and then ships the sender's exact location inside them
// has not protected anything. Screenshots and edited PNGs similarly carry
// tEXt/iTXt chunks naming the software and often the source path.
//
// Both functions are total: anything that is not a well-formed image of the
// expected type is returned unchanged rather than corrupted, because a
// mangled attachment is worse than an un-stripped one.

export function stripJpegExif(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xFFD8) {
    return arrayBuffer; // Not a JPEG
  }
  
  let offset = 2;
  const length = view.byteLength;
  const newSegments = [new Uint8Array(arrayBuffer.slice(0, 2))]; // Start with SOI (FFD8)
  
  while (offset < length) {
    if (offset + 2 > length) break;
    const marker = view.getUint16(offset);
    
    if ((marker & 0xFF00) === 0xFF00) {
      if (marker === 0xFFD9) {
        // EOI (End of Image)
        newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
        break;
      }
      
      if (offset + 4 > length) {
        newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
        break;
      }
      const segmentLength = view.getUint16(offset + 2) + 2;
      if (offset + segmentLength > length) {
        newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
        break;
      }
      
      // If it is APP1 (EXIF / Metadata / GPS) marker FFE1, skip it!
      if (marker === 0xFFE1) {
        // Skip segment
      } else {
        // Keep segment
        newSegments.push(new Uint8Array(arrayBuffer.slice(offset, offset + segmentLength)));
      }
      offset += segmentLength;
    } else {
      // SOS or entropy-coded data, runs to the end
      newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
      break;
    }
  }
  
  const totalLength = newSegments.reduce((sum, seg) => sum + seg.length, 0);
  const cleanBuffer = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const seg of newSegments) {
    cleanBuffer.set(seg, writeOffset);
    writeOffset += seg.length;
  }
  return cleanBuffer.buffer;
}

export function stripPngMetadata(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 8 || view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) {
    return arrayBuffer; // Not a PNG
  }
  
  let offset = 8;
  const length = view.byteLength;
  const newSegments = [new Uint8Array(arrayBuffer.slice(0, 8))]; // PNG Signature
  
  while (offset < length) {
    if (offset + 12 > length) {
      newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
      break;
    }
    const chunkLength = view.getUint32(offset);
    const chunkType = String.fromCharCode(
      view.getUint8(offset + 4),
      view.getUint8(offset + 5),
      view.getUint8(offset + 6),
      view.getUint8(offset + 7)
    );
    
    const fullChunkLength = 12 + chunkLength;
    if (offset + fullChunkLength > length) {
      newSegments.push(new Uint8Array(arrayBuffer.slice(offset)));
      break;
    }
    
    // List of metadata chunk types to skip
    const metadataChunks = ['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'dIHg'];
    
    if (metadataChunks.includes(chunkType)) {
      // Skip metadata chunk
    } else {
      // Keep chunk
      newSegments.push(new Uint8Array(arrayBuffer.slice(offset, offset + fullChunkLength)));
    }
    
    offset += fullChunkLength;
  }
  
  const totalLength = newSegments.reduce((sum, seg) => sum + seg.length, 0);
  const cleanBuffer = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const seg of newSegments) {
    cleanBuffer.set(seg, writeOffset);
    writeOffset += seg.length;
  }
  return cleanBuffer.buffer;
}
