// 解析模板每页 textSlots（live parse，用于核对 shapeIndex / sampleText）
// 用法: node inspect-template.mjs <pptJobDir>/ppt-template-4.pptx
//       node inspect-template.mjs <pptJobDir>/ppt-template-4.pptx --slide=3
import JSZip from 'jszip';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePlaceholdersForSlide, parseRelsXml, listSlidePaths, listPictureSlotsForSlide } from './ooxml-fill.mjs';

async function inspectPptx(pptxPath, { slideFilter } = {}) {
  if (!existsSync(pptxPath)) throw new Error(`文件不存在: ${pptxPath}`);
  const zip = await JSZip.loadAsync(readFileSync(pptxPath));
  const paths = listSlidePaths(zip);
  const report = [];

  for (const slidePath of paths) {
    const slideIndex = Number(slidePath.match(/(\d+)/)[1]);
    if (slideFilter && slideIndex !== slideFilter) continue;

    const relsPath = `ppt/slides/_rels/slide${slideIndex}.xml.rels`;
    const slideXml = await zip.file(slidePath).async('string');
    const relsXml = zip.file(relsPath) ? await zip.file(relsPath).async('string') : '';
    const rels = parseRelsXml(relsXml);

    let layoutXml = '';
    let layoutRels = [];
    const layoutRel = rels.find((r) => /slideLayout/i.test(r.type));
    if (layoutRel) {
      const layoutPart = layoutRel.target.startsWith('ppt/')
        ? layoutRel.target
        : `ppt/${layoutRel.target.replace(/^\.\.\//, '')}`;
      const layoutName = layoutPart.split('/').pop();
      const layoutRelsPath = `ppt/slideLayouts/_rels/${layoutName}.rels`;
      if (zip.file(layoutPart)) layoutXml = await zip.file(layoutPart).async('string');
      if (zip.file(layoutRelsPath)) {
        layoutRels = parseRelsXml(await zip.file(layoutRelsPath).async('string'));
      }
    }

    const ph = parsePlaceholdersForSlide(slideXml, layoutXml, rels, layoutRels);

    report.push({
      slideIndex,
      slidePart: `ppt/slides/slide${slideIndex}.xml`,
      textSlotCount: ph.textSlots.length,
      pictureSlotCount: ph.pictureSlots.length,
      textSlots: ph.textSlots.map((s) => ({
        shapeIndex: s.shapeIndex,
        sampleText: s.sampleText,
        role: s.role,
        phType: s.phType,
      })),
      pictureSlots: ph.pictureSlots,
    });
  }
  return report;
}

async function main() {
  const pptxPath = process.argv[2];
  if (!pptxPath) {
    console.error('用法: node inspect-template.mjs <模板.pptx> [--slide=N]');
    process.exit(1);
  }
  const slideArg = process.argv.find((a) => a.startsWith('--slide='));
  const slideFilter = slideArg ? Number(slideArg.split('=')[1]) : null;
  const report = await inspectPptx(pptxPath, { slideFilter: slideFilter || undefined });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

export { inspectPptx };
