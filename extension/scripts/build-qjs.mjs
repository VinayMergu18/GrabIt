import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const backgroundDir = fileURLToPath(new URL('./background/', import.meta.url));
const outputFile = fileURLToPath(new URL('./background/qjs.bundle.js', import.meta.url));
const wasmFile = new URL('../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm', import.meta.url);

await mkdir(backgroundDir, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('./background/qjs-entry.mjs', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outfile: outputFile
});
await copyFile(wasmFile, new URL('./background/emscripten-module.wasm', import.meta.url));
