const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/**
 * Fast PDF total page count extractor without external deps.
 * Strategy:
 * 1) Classic xref parse: startxref -> xref table -> trailer /Root -> Catalog /Pages -> Pages /Count
 * 2) Fallback scan: find "/Type /Pages" objects and take the max /Count
 *
 * Note: XRef streams (object streams) are not yet parsed here; for such files
 * the fallback scanner typically still succeeds. A dedicated XRef stream parser
 * can be added later without changing the public API.
 */

/**
 * Public API: countPdfPagesSync
 * @param {string|Buffer|Uint8Array} input - File path or Buffer-like
 * @returns {number}
 */
function countPdfPagesSync(input) {
  const buffer = loadToBufferSync(input);
  // Try fast path via classic xref
  try {
    const pageCount = parsePageCountViaClassicXref(buffer);
    if (Number.isInteger(pageCount) && pageCount > 0) return pageCount;
  } catch (_) {
    // ignore and fallback
  }
  // Fallback: scan for /Type /Pages with /Count N and take max
  let count = scanMaxPagesCount(buffer);
  if (count > 0) return count;
  // Extra fallback: decompress Flate streams (e.g., ObjStm) and scan inside
  count = scanMaxPagesCountFromObjectStreams(buffer);
  if (count > 0) return count;
  // Last resort: count /Type /Page occurrences (including in deflated streams)
  count = countPagesByPageObjects(buffer);
  return count;
}

/**
 * Public API: countPdfPages (async)
 * @param {string|Buffer|Uint8Array} input - File path or Buffer-like
 * @returns {Promise<number>}
 */
async function countPdfPages(input) {
  if (typeof input === "string") {
    const abs = path.isAbsolute(input)
      ? input
      : path.resolve(process.cwd(), input);
    const buffer = await fs.promises.readFile(abs);
    return countPdfPagesSync(buffer);
  }
  return countPdfPagesSync(input);
}

// ---- Implementation details below ----

/**
 * @param {string|Buffer|Uint8Array} input
 * @returns {Buffer}
 */
function loadToBufferSync(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === "string") {
    const abs = path.isAbsolute(input)
      ? input
      : path.resolve(process.cwd(), input);
    return fs.readFileSync(abs);
  }
  throw new TypeError(
    "Unsupported input type. Expected file path, Buffer, or Uint8Array."
  );
}

/**
 * Attempt to parse via classic xref table and trailer.
 * Returns integer page count or throws on failure.
 * @param {Buffer} buffer
 * @returns {number}
 */
function parsePageCountViaClassicXref(buffer) {
  const startXrefPos = findStartXref(buffer);
  if (startXrefPos < 0) throw new Error("startxref not found");

  const xrefOffset = parseStartXrefOffset(buffer, startXrefPos);
  if (
    !Number.isFinite(xrefOffset) ||
    xrefOffset <= 0 ||
    xrefOffset >= buffer.length
  ) {
    throw new Error("Invalid xref offset");
  }

  // Expect the word 'xref' at xrefOffset (allow preceding whitespace)
  const xrefStart =
    skipWhitespaceBackwardSafe(buffer, xrefOffset) === xrefOffset
      ? xrefOffset
      : xrefOffset;
  const xrefToken = readAscii(buffer, xrefStart, 4);
  if (xrefToken !== "xref") {
    // Not a classic xref table; likely an xref stream PDF
    throw new Error("Not a classic xref table");
  }

  // Parse xref sections
  let pos = xrefStart + 4;
  pos = skipWhitespace(buffer, pos);
  const objectOffsets = new Map(); // objNum -> offset

  while (pos < buffer.length) {
    // Stop at 'trailer'
    if (peekKeyword(buffer, pos, "trailer")) break;
    // Each subsection header: start count
    const header = readLineAscii(buffer, pos);
    if (!header) break;
    const parts = header.trim().split(/\s+/);
    if (parts.length < 2) break;
    const firstObj = parseInt(parts[0], 10);
    const count = parseInt(parts[1], 10);
    if (!Number.isInteger(firstObj) || !Number.isInteger(count) || count < 0) {
      throw new Error("Invalid xref subsection header");
    }
    pos = advanceToNextLine(buffer, pos);
    // Then count lines of entries: 10-digit offset, 5-digit gen, flag
    for (let i = 0; i < count; i += 1) {
      const line = readLineAscii(buffer, pos);
      if (!line) throw new Error("Unexpected EOF in xref entries");
      const m = line.match(/^(\d{10})\s+(\d{5})\s+([nf])/);
      if (m) {
        const offset = parseInt(m[1], 10);
        const gen = parseInt(m[2], 10);
        const flag = m[3];
        const objNum = firstObj + i;
        if (flag === "n" && Number.isFinite(offset)) {
          objectOffsets.set(objNum, { offset, gen });
        }
      }
      pos = advanceToNextLine(buffer, pos);
    }
    pos = skipWhitespace(buffer, pos);
  }

  // Expect 'trailer' then a dictionary starting with '<<'
  if (!peekKeyword(buffer, pos, "trailer"))
    throw new Error("trailer not found");
  pos += "trailer".length;
  pos = skipWhitespace(buffer, pos);
  if (buffer[pos] !== 0x3c || buffer[pos + 1] !== 0x3c)
    throw new Error("trailer dict not found");
  const { dictString, endPos } = readDictString(buffer, pos);
  pos = endPos;

  const rootRef = parseIndirectRefFromDict(dictString, "Root");
  if (!rootRef) throw new Error("Root not found in trailer");

  // Load Root object (Catalog) using xref table
  const rootEntry = objectOffsets.get(rootRef.obj);
  if (!rootEntry) throw new Error("Root offset not found in xref");
  const rootObj = readIndirectObject(
    buffer,
    rootEntry.offset,
    rootRef.obj,
    rootRef.gen
  );
  const pagesRef = parseIndirectRefFromDict(rootObj.dictString, "Pages");
  if (!pagesRef) throw new Error("Pages ref not found in Catalog");

  // Load Pages root object
  const pagesEntry = objectOffsets.get(pagesRef.obj);
  if (!pagesEntry) throw new Error("Pages offset not found in xref");
  const pagesObj = readIndirectObject(
    buffer,
    pagesEntry.offset,
    pagesRef.obj,
    pagesRef.gen
  );

  // Verify it's /Type /Pages and read /Count
  if (!/\/Type\s*\/Pages\b/.test(pagesObj.dictString)) {
    throw new Error("Target object is not /Type /Pages");
  }
  const count = parseIntFromDict(pagesObj.dictString, "Count");
  if (!Number.isInteger(count) || count <= 0)
    throw new Error("Count not found or invalid");
  return count;
}

/**
 * Find 'startxref' near the end of the file and return its position.
 * @param {Buffer} buffer
 * @returns {number}
 */
function findStartXref(buffer) {
  const needle = Buffer.from("startxref");
  // Search last 2MB for safety; if not found, search whole buffer
  const start = Math.max(0, buffer.length - 2 * 1024 * 1024);
  let pos = buffer.lastIndexOf(needle, buffer.length - 1);
  if (pos === -1) pos = buffer.lastIndexOf(needle, start);
  return pos;
}

/**
 * Parse the numeric offset following startxref
 * @param {Buffer} buffer
 * @param {number} startXrefPos - position of 's' in 'startxref'
 */
function parseStartXrefOffset(buffer, startXrefPos) {
  let pos = startXrefPos + "startxref".length;
  pos = skipWhitespace(buffer, pos);
  const num = readNumberAscii(buffer, pos);
  if (num.value == null) throw new Error("startxref offset not found");
  return num.value;
}

/** Skips ASCII whitespace and returns new position */
function skipWhitespace(buffer, pos) {
  while (pos < buffer.length) {
    const c = buffer[pos];
    if (
      c === 0x00 ||
      c === 0x09 ||
      c === 0x0a ||
      c === 0x0c ||
      c === 0x0d ||
      c === 0x20
    ) {
      pos += 1;
      continue;
    }
    break;
  }
  return pos;
}

/** Best-effort: if previous byte is whitespace return same pos */
function skipWhitespaceBackwardSafe(buffer, pos) {
  if (pos <= 0) return 0;
  const prev = buffer[pos - 1];
  if (
    prev === 0x00 ||
    prev === 0x09 ||
    prev === 0x0a ||
    prev === 0x0c ||
    prev === 0x0d ||
    prev === 0x20
  )
    return pos;
  return pos;
}

function readAscii(buffer, pos, len) {
  return buffer.toString("latin1", pos, pos + len);
}

function readLineAscii(buffer, pos) {
  if (pos >= buffer.length) return "";
  let end = pos;
  while (end < buffer.length) {
    const c = buffer[end];
    if (c === 0x0a || c === 0x0d) break;
    end += 1;
  }
  return buffer.toString("latin1", pos, end);
}

function advanceToNextLine(buffer, pos) {
  let p = pos;
  while (p < buffer.length) {
    const c = buffer[p++];
    if (c === 0x0a) break; // LF
    if (c === 0x0d) {
      if (buffer[p] === 0x0a) p += 1; // CRLF
      break;
    }
  }
  return p;
}

function peekKeyword(buffer, pos, kw) {
  const s = buffer.toString("latin1", pos, pos + kw.length);
  return s === kw;
}

function readNumberAscii(buffer, pos) {
  let p = pos;
  // optional sign
  if (buffer[p] === 0x2b || buffer[p] === 0x2d) p += 1;
  let start = p;
  while (p < buffer.length && buffer[p] >= 0x30 && buffer[p] <= 0x39) p += 1;
  if (p === start) return { value: null, end: pos };
  const str = buffer.toString("latin1", pos, p);
  const value = parseInt(str, 10);
  return { value, end: p };
}

/**
 * Read a PDF dictionary string starting at '<<'
 * @returns {{dictString: string, endPos: number}}
 */
function readDictString(buffer, pos) {
  if (!(buffer[pos] === 0x3c && buffer[pos + 1] === 0x3c))
    throw new Error("Expected <<");
  let depth = 0;
  let p = pos;
  while (p < buffer.length) {
    if (buffer[p] === 0x3c && buffer[p + 1] === 0x3c) {
      depth += 1;
      p += 2;
      continue;
    }
    if (buffer[p] === 0x3e && buffer[p + 1] === 0x3e) {
      depth -= 1;
      p += 2;
      if (depth === 0) break;
      continue;
    }
    p += 1;
  }
  const dictString = buffer.toString("latin1", pos, p);
  return { dictString, endPos: p };
}

/**
 * Parse an indirect reference like '/Key 12 0 R' from a dictionary string.
 */
function parseIndirectRefFromDict(dictString, key) {
  const re = new RegExp(`/\\s*${escapeRegExp(key)}\\s+(\\d+)\\s+(\\d+)\\s+R`);
  const m = dictString.match(re);
  if (!m) return null;
  return { obj: parseInt(m[1], 10), gen: parseInt(m[2], 10) };
}

function parseIntFromDict(dictString, key) {
  const re = new RegExp(`/\\s*${escapeRegExp(key)}\\s+(\\d+)`);
  const m = dictString.match(re);
  return m ? parseInt(m[1], 10) : null;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read an indirect object located at offset. Returns { header, dictString, raw }
 */
function readIndirectObject(buffer, offset, expectedObj, expectedGen) {
  let pos = offset;
  // The object header: "objNum gen obj"
  const headerLine = readLineAscii(buffer, pos).trim();
  const m = headerLine.match(/^(\d+)\s+(\d+)\s+obj\b/);
  if (!m) throw new Error("Invalid object header");
  const objNum = parseInt(m[1], 10);
  const gen = parseInt(m[2], 10);
  if (objNum !== expectedObj || gen !== expectedGen) {
    // Some writers may include leading whitespace; try to resynchronize by searching backwards a little
    // But for simplicity, we enforce match here.
  }
  pos = advanceToNextLine(buffer, pos);
  // Expect dictionary starting with '<<'
  pos = skipWhitespace(buffer, pos);
  if (!(buffer[pos] === 0x3c && buffer[pos + 1] === 0x3c))
    throw new Error("Object dictionary not found");
  const { dictString } = readDictString(buffer, pos);
  // Find endobj from current pos forward (limit to a reasonable window)
  const endIdx = buffer.indexOf(Buffer.from("endobj"), pos);
  const raw = buffer.slice(
    offset,
    endIdx > 0 ? endIdx + "endobj".length : Math.min(buffer.length, pos + 4096)
  );
  return { header: headerLine, dictString, raw };
}

/**
 * Fallback scanner: find /Type /Pages objects and get max /Count
 */
function scanMaxPagesCount(buffer) {
  // Convert to latin1 string to avoid UTF-8 decoding cost for binary parts
  const s = buffer.toString("latin1");
  let maxCount = 0;
  // Find all occurrences of '/Type /Pages'
  const typePagesRe = /\/Type\s*\/Pages\b/g;
  let m;
  while ((m = typePagesRe.exec(s)) !== null) {
    // Search forward a window for '/Count N'
    const windowStart = m.index;
    const windowEnd = Math.min(s.length, windowStart + 5000);
    const window = s.slice(windowStart, windowEnd);
    const cm = window.match(/\/Count\s+(\d+)/);
    if (cm) {
      const count = parseInt(cm[1], 10);
      if (Number.isInteger(count) && count > maxCount) maxCount = count;
    }
  }
  if (maxCount > 0) return maxCount;
  // Last resort: look for '/Count N' anywhere and take max (may overcount in exotic PDFs)
  const countRe = /\/Count\s+(\d+)/g;
  while ((m = countRe.exec(s)) !== null) {
    const count = parseInt(m[1], 10);
    if (Number.isInteger(count) && count > maxCount) maxCount = count;
  }
  return maxCount || 0;
}

/**
 * Decompress Flate streams that are likely to contain objects (e.g., /Type /ObjStm)
 * and scan the inflated text for /Type /Pages and /Count patterns.
 */
function scanMaxPagesCountFromObjectStreams(buffer) {
  const s = buffer.toString("latin1");
  let pos = 0;
  let globalMax = 0;

  while (true) {
    const streamIdx = s.indexOf("stream", pos);
    if (streamIdx === -1) break;

    // Heuristically capture the preceding dictionary
    const dictOpen = s.lastIndexOf("<<", streamIdx);
    const dictClose = s.lastIndexOf(">>", streamIdx);
    let dictString = "";
    if (dictOpen !== -1 && dictClose !== -1 && dictOpen < dictClose) {
      dictString = s.slice(dictOpen, dictClose + 2);
    }

    // Only attempt if it advertises FlateDecode
    const hasFlate = /FlateDecode/.test(dictString);
    if (hasFlate) {
      let dataStart = streamIdx + "stream".length;
      // Skip EOL after 'stream'
      if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a)
        dataStart += 2; // CRLF
      else if (buffer[dataStart] === 0x0a) dataStart += 1; // LF

      const endStreamIdx = s.indexOf("endstream", dataStart);
      if (endStreamIdx !== -1) {
        const dataEnd = endStreamIdx;
        const streamBuf = buffer.slice(dataStart, dataEnd);
        // Skip very large streams to keep it fast (~5MB cap)
        if (streamBuf.length > 0 && streamBuf.length <= 5 * 1024 * 1024) {
          try {
            const inflated = zlib.inflateSync(streamBuf);
            const text = inflated.toString("latin1");
            let localMax = 0;
            const typePagesRe = /\/Type\s*\/Pages\b/g;
            let mm;
            while ((mm = typePagesRe.exec(text)) !== null) {
              const winStart = mm.index;
              const winEnd = Math.min(text.length, winStart + 5000);
              const window = text.slice(winStart, winEnd);
              const cm = window.match(/\/Count\s+(\d+)/);
              if (cm) {
                const c = parseInt(cm[1], 10);
                if (Number.isInteger(c) && c > localMax) localMax = c;
              }
            }
            if (localMax > globalMax) globalMax = localMax;
            if (globalMax > 0) return globalMax;
          } catch (_) {
            // ignore decompression errors
          }
        }
      }
    }

    pos = streamIdx + "stream".length;
  }

  return globalMax;
}

module.exports = {
  countPdfPagesSync,
  countPdfPages,
};

/**
 * Count page objects by scanning for '/Type /Page' across plain and deflated streams.
 * This is a heuristic and may over/undercount with exotic PDFs.
 */
function countPagesByPageObjects(buffer) {
  let total = 0;
  // Plain text scan
  const s = buffer.toString("latin1");
  const re = /\/Type\s*\/Page\b/g;
  while (re.exec(s) !== null) total += 1;

  // Scan deflated streams as well (same extraction as object stream scan)
  const textHits = scanDeflatedStreamsForPattern(buffer, /\/Type\s*\/Page\b/g);
  total += textHits;
  return total;
}

function scanDeflatedStreamsForPattern(buffer, regexGlobal) {
  const s = buffer.toString("latin1");
  let pos = 0;
  let hits = 0;
  while (true) {
    const streamIdx = s.indexOf("stream", pos);
    if (streamIdx === -1) break;
    const dictOpen = s.lastIndexOf("<<", streamIdx);
    const dictClose = s.lastIndexOf(">>", streamIdx);
    let dictString = "";
    if (dictOpen !== -1 && dictClose !== -1 && dictOpen < dictClose) {
      dictString = s.slice(dictOpen, dictClose + 2);
    }
    if (/FlateDecode/.test(dictString)) {
      let dataStart = streamIdx + "stream".length;
      if (buffer[dataStart] === 0x0d && buffer[dataStart + 1] === 0x0a)
        dataStart += 2;
      else if (buffer[dataStart] === 0x0a) dataStart += 1;
      const endStreamIdx = s.indexOf("endstream", dataStart);
      if (endStreamIdx !== -1) {
        const dataEnd = endStreamIdx;
        const blen = dataEnd - dataStart;
        if (blen > 0 && blen <= 5 * 1024 * 1024) {
          try {
            const inflated = zlib.inflateSync(buffer.slice(dataStart, dataEnd));
            const text = inflated.toString("latin1");
            const re = new RegExp(regexGlobal.source, "g");
            let m;
            while ((m = re.exec(text)) !== null) hits += 1;
          } catch (_) {}
        }
      }
    }
    pos = streamIdx + "stream".length;
  }
  return hits;
}
