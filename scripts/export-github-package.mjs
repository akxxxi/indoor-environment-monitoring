import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone exporter: no Git repository, npm install, or network is required.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(root, 'tmp', 'github');
const archivePath = join(outputDir, 'classroom-environment-monitor-source.zip');
const manifestPath = join(outputDir, 'classroom-environment-monitor-source.manifest.json');
const excludedDirectories = new Set([
  '.git', '.agents', '.codex', '.aws', '.npm-cache', 'node_modules', 'dist',
  'coverage', 'test-results', 'playwright-report', '.test-data', 'tmp', 'data',
]);
const privateFiles = new Set([
  'Docs/求职项目经历与学习指南.md',
  'Docs/答辩讲稿与问答.md',
]);

function excluded(path, directory) {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1);
  const lower = name.toLowerCase();
  if (normalized === 'Docs/个人材料' || normalized.startsWith('Docs/个人材料/')) return true;
  if (privateFiles.has(normalized)) return true;
  if (directory) return excludedDirectories.has(lower);
  if (lower === '.env.example' || (lower.startsWith('.env.') && lower.endsWith('.example'))) return false;
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  if (/\.(?:db|sqlite|sqlite3)(?:-(?:shm|wal))?$/i.test(name)) return true;
  if (/\.(?:docx?|log|pem|key|pfx|p12|zip)$/i.test(name)) return true;
  if (/^(?:credentials?|secrets?)(?:\.|$)/i.test(name)) return true;
  return lower === '.ds_store' || lower === 'thumbs.db' || name.startsWith('~$');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// ZIP32 with UTF-8 filenames; fixed metadata makes unchanged input reproducible.
function createZip(files) {
  if (files.length > 65535) throw new Error('Too many files for ZIP32');
  const entries = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const filename = Buffer.from(file.path, 'utf8');
    const compressed = deflateRawSync(file.content);
    const crc = crc32(file.content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x21, 12); // 1980-01-01
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.content.length, 22);
    header.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    header.copy(record, 6, 4, 30);
    record.writeUInt32LE(offset, 42);
    entries.push(header, filename, compressed);
    central.push(record, filename);
    offset += header.length + filename.length + compressed.length;
    if (offset > 0xffffffff) throw new Error('Archive exceeds ZIP32 size limit');
  }
  const directory = Buffer.concat(central);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(files.length, 8);
  footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(directory.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...entries, directory, footer]);
}

async function collect(directory, files) {
  const children = await readdir(directory, { withFileTypes: true });
  children.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const child of children) {
    const absolute = join(directory, child.name);
    const path = relative(root, absolute).replaceAll('\\', '/');
    if (excluded(path, child.isDirectory())) continue;
    if (child.isSymbolicLink()) throw new Error(`Refusing symbolic link: ${path}`);
    if (child.isDirectory()) {
      await collect(absolute, files);
    } else if (child.isFile()) {
      const content = await readFile(absolute);
      if (content.length > 50 * 1024 * 1024) throw new Error(`File exceeds export limit of 50 MiB: ${path}`);
      files.push({ path, content });
    }
  }
}

async function main() {
  if (process.argv.length > 2) {
    if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) {
      console.log('Usage: node scripts/export-github-package.mjs\nOutput: tmp/github/*-source.zip and *.manifest.json\nUses explicit exclusions; .gitignore changes must also be reflected here.');
      return;
    }
    throw new Error('This exporter takes no arguments. Use --help for usage.');
  }
  const files = [];
  await collect(root, files);
  const manifest = files.map(({ path, content }) => ({
    path,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  }));
  const manifestContent = Buffer.from(`${JSON.stringify({ files: manifest }, null, 2)}\n`);
  files.push({ path: 'PUBLISH-MANIFEST.json', content: manifestContent });
  const archive = createZip(files);
  await mkdir(outputDir, { recursive: true });
  await writeFile(archivePath, archive);
  await writeFile(manifestPath, manifestContent);
  console.log(`Exported ${manifest.length} source files plus PUBLISH-MANIFEST.json`);
  console.log(`Archive: ${archivePath}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Archive SHA-256: ${createHash('sha256').update(archive).digest('hex')}`);
  console.log('Review the manifest before publishing. This command does not publish to GitHub.');
}

main().catch((error) => {
  console.error(`Export failed: ${error.message}`);
  process.exitCode = 1;
});
