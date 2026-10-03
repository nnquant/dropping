import { decompress as decompressZstd } from 'fzstd';
import type { Compressors } from 'hyparquet';
// Deep imports on purpose: the hyparquet-compressors entry point compiles snappy WebAssembly when it
// loads, which the app's CSP blocks (and which would blank the whole window). Snappy falls back to
// hyparquet's built-in pure-JS decoder.
import { decompressBrotli } from 'hyparquet-compressors/src/brotli.js';
import { gunzip } from 'hyparquet-compressors/src/gzip.js';
import { decompressLz4, decompressLz4Raw } from 'hyparquet-compressors/src/lz4.js';

export const compressors: Compressors = {
  GZIP: (input, length) => gunzip(input, new Uint8Array(length)),
  BROTLI: decompressBrotli,
  ZSTD: input => decompressZstd(input),
  LZ4: decompressLz4,
  LZ4_RAW: decompressLz4Raw,
};
