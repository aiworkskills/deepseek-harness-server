// 解压 .pptx 到目录（Agent 可直接读改 XML）
// 用法: node unpack-pptx.mjs <pptJobDir>/ppt-template-5.pptx <pptJobDir>/ppt-work
import JSZip from 'jszip';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export async function unpackPptx(pptxPath, outDir) {
  if (!existsSync(pptxPath)) throw new Error(`文件不存在: ${pptxPath}`);
  const zip = await JSZip.loadAsync(readFileSync(pptxPath));
  mkdirSync(outDir, { recursive: true });
  for (const [name, entry] of Object.entries(zip.files)) {
    const target = join(outDir, name);
    if (entry.dir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, await entry.async('nodebuffer'));
  }
  return outDir;
}

async function main() {
  const pptxPath = process.argv[2];
  const outDir = process.argv[3];
  if (!pptxPath || !outDir) {
    console.error('用法: node unpack-pptx.mjs <模板.pptx> <解压目录>');
    process.exit(1);
  }
  await unpackPptx(pptxPath, outDir);
  console.log(`ARC_AI_PPTX_UNPACKED: ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
