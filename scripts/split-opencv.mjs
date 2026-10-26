#!/usr/bin/env node
// Splits the upstream single-file OpenCV.js build (public/vendor/opencv.js, wasm embedded as base64) into
//   public/vendor/opencv-<ver>.js    the Emscripten glue (~220 KB), wasm reference replaced by a file name
//   public/vendor/opencv-<ver>.wasm  the raw module (7.5 MB; 2.3 MB gzip instead of 3.4 MB as base64)
// public/scan-worker.js loads the pair through Cache Storage and compiles with WebAssembly.instantiateStreaming.
// Re-run after replacing opencv.js, then update OPENCV_VERSION / *_SIZE in scan-worker.js.
//   node scripts/split-opencv.mjs [version]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] || "4.9.0";
const src = readFileSync(path.join(root, "public/vendor/opencv.js"), "utf8");
const re = /wasmBinaryFile="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/;
const m = re.exec(src);
if (!m) throw new Error("no embedded wasm found in opencv.js");
const wasm = Buffer.from(m[1], "base64");
if (wasm.readUInt32BE(0) !== 0x0061736d) throw new Error("embedded data is not a wasm module");
const js = src.slice(0, m.index) + `wasmBinaryFile="opencv-${version}.wasm"` + src.slice(m.index + m[0].length);
writeFileSync(path.join(root, `public/vendor/opencv-${version}.wasm`), wasm);
writeFileSync(path.join(root, `public/vendor/opencv-${version}.js`), js);
console.log(`opencv-${version}.js ${Buffer.byteLength(js)} bytes, opencv-${version}.wasm ${wasm.length} bytes`);
