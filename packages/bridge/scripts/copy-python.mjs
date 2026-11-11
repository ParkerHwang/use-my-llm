import { copyFile, mkdir } from 'node:fs/promises';
const source = new URL('../src/providers/google_sdk.py', import.meta.url);
const destination = new URL('../dist/providers/google_sdk.py', import.meta.url);
await mkdir(new URL('../dist/providers/', import.meta.url), { recursive: true });
await copyFile(source, destination);
