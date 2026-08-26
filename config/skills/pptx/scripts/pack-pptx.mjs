// 将解压目录打包为 .pptx 并校验
// 用法: node pack-pptx.mjs <pptJobDir>/ppt-work workspace/out/汇报.pptx
import JSZip from 'jszip';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { validatePptx, formatValidationReport } from './validate-pptx.mjs';
import { validateUnpacked, formatUnpackedReport } from './validate-unpacked.mjs';

function walkFiles(dir, base, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, base, out);
    else out.push({ abs: p, rel: relative(base, p).split(sep).join('/') });
  }
  return out;
}

export async function packPptx(dir, outPath) {
  if (!existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
  const zip = new JSZip();
  for (const { abs, rel } of walkFiles(dir, dir)) {
    zip.file(rel, readFileSync(abs));
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  writeFileSync(outPath, buf);
  return outPath;
}

async function main() {
  const dir = process.argv[2];
  const outPath = process.argv[3];
  if (!dir || !outPath) {
    console.error('用法: node pack-pptx.mjs <解压目录> <输出.pptx>');
    process.exit(1);
  }
  const preCheck = await validateUnpacked(dir);
  console.log(formatUnpackedReport(preCheck));
  if (!preCheck.ok) process.exit(1);

  const result = await packPptx(dir, outPath);
  const validation = await validatePptx(result);
  console.log(formatValidationReport(validation));
  if (!validation.ok) process.exit(1);
  console.log(`ARC_AI_ARTIFACT_PATH: ${result}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
