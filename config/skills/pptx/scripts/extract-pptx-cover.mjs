// 从 .pptx 提取/渲染第一页封面图
// 用法: node extract-pptx-cover.mjs <pptx> <out.png> [unpackedWorkDir]
// stdout: JSON { ok, source?, message? }
import JSZip from 'jszip';
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const EMBEDDED_THUMBNAIL_PATHS = [
  'docProps/thumbnail.jpeg',
  'docProps/thumbnail.jpg',
  'docProps/thumbnail.png',
];

function resolveSofficeCandidates() {
  const fromEnv = process.env.PPT_COVER_SOFFICE?.trim();
  const list = [];
  if (fromEnv) list.push(fromEnv);
  list.push('soffice', 'soffice.exe', 'libreoffice', 'libreoffice.exe');
  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    );
  }
  return [...new Set(list)];
}

async function extractEmbeddedThumbnail(pptxPath, outPath) {
  const zip = await JSZip.loadAsync(readFileSync(pptxPath));
  for (const part of EMBEDDED_THUMBNAIL_PATHS) {
    const entry = zip.file(part);
    if (!entry || entry.dir) continue;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, await entry.async('nodebuffer'));
    return true;
  }
  return false;
}

function pickFirstPng(dir, baseName) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => /\.png$/i.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!files.length) return null;
  const preferred = files.find((f) => /-0?1\.png$/i.test(f) || /^slide1/i.test(f));
  return join(dir, preferred || files[0]);
}

async function renderWithLibreOffice(pptxPath, outPath) {
  const tmpDir = join(dirname(outPath), 'lo-cover-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  try {
    for (const bin of resolveSofficeCandidates()) {
      try {
        await execFileAsync(bin, [
          '--headless',
          '--nologo',
          '--nofirststartwizard',
          '--convert-to', 'png',
          '--outdir', tmpDir,
          resolve(pptxPath),
        ], { timeout: 120_000, windowsHide: true });
        const png = pickFirstPng(tmpDir, basename(pptxPath, '.pptx'));
        if (png && existsSync(png)) {
          mkdirSync(dirname(outPath), { recursive: true });
          copyFileSync(png, outPath);
          return true;
        }
      } catch {
        // try next candidate
      }
    }
    return false;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function pickSlide1EmbeddedImage(unpackedWorkDir) {
  if (!unpackedWorkDir || !existsSync(unpackedWorkDir)) return null;
  const slide1MediaDir = join(unpackedWorkDir, 'ppt', 'media');
  if (!existsSync(slide1MediaDir)) return null;
  const slide1Xml = join(unpackedWorkDir, 'ppt', 'slides', 'slide1.xml');
  if (!existsSync(slide1Xml)) return null;
  const xml = readFileSync(slide1Xml, 'utf8');
  const relsPath = join(unpackedWorkDir, 'ppt', 'slides', '_rels', 'slide1.xml.rels');
  if (!existsSync(relsPath)) return null;
  const rels = readFileSync(relsPath, 'utf8');
  const relIds = [...xml.matchAll(/r:embed="([^"]+)"/g)].map((m) => m[1]);
  for (const relId of relIds) {
    const relMatch = rels.match(new RegExp(`Id="${relId}"[^>]*Target="([^"]+)"`, 'i'));
    if (!relMatch) continue;
    const target = relMatch[1].replace(/^\.\.\//, 'ppt/');
    const abs = join(unpackedWorkDir, target);
    if (existsSync(abs)) return abs;
  }
  return null;
}

async function main() {
  const pptxPath = process.argv[2];
  const outPath = process.argv[3];
  const unpackedWorkDir = process.argv[4];
  if (!pptxPath || !outPath) {
    console.error('用法: node extract-pptx-cover.mjs <pptx> <out.png> [unpackedWorkDir]');
    process.exit(1);
  }
  if (!existsSync(pptxPath)) {
    console.log(JSON.stringify({ ok: false, message: `文件不存在: ${pptxPath}` }));
    process.exit(0);
  }

  mkdirSync(dirname(outPath), { recursive: true });

  if (await extractEmbeddedThumbnail(pptxPath, outPath)) {
    console.log(JSON.stringify({ ok: true, source: 'embedded', coverPath: outPath }));
    return;
  }

  if (await renderWithLibreOffice(pptxPath, outPath)) {
    console.log(JSON.stringify({ ok: true, source: 'libreoffice', coverPath: outPath }));
    return;
  }

  const slide1Image = pickSlide1EmbeddedImage(unpackedWorkDir);
  if (slide1Image) {
    copyFileSync(slide1Image, outPath);
    console.log(JSON.stringify({ ok: true, source: 'slide1-image', coverPath: outPath }));
    return;
  }

  console.log(JSON.stringify({ ok: false, message: '未能生成封面（无内置缩略图、LibreOffice 不可用、第1页无嵌入图）' }));
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, message: e instanceof Error ? e.message : String(e) }));
  process.exit(0);
});
