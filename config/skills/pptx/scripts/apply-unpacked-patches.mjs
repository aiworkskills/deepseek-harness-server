// 对解压目录中的 slide XML 原位打补丁（不删页、不重排；裁剪见 compose-slides-from-spec.mjs）
// 用法: node apply-unpacked-patches.mjs <pptJobDir>/ppt-work <pptJobDir>/ppt-fill-spec.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyTextPatches,
  parsePlaceholdersForSlide,
  parseRelsXml,
  replacePictureInUnpacked,
  suggestTextPatches,
} from './ooxml-fill.mjs';

function loadSpec(specPath) {
  return JSON.parse(readFileSync(specPath, 'utf8'));
}

function validateTextPatches(slideNum, patches, textSlots) {
  if (!patches?.length) {
    throw new Error(`slide${slideNum} 的 textPatches 不能为空`);
  }
  const validShapeIndexes = new Set(textSlots.map((slot) => slot.shapeIndex));
  for (const patch of patches) {
    if (Number.isInteger(patch.shapeIndex) && !validShapeIndexes.has(patch.shapeIndex)) {
      throw new Error(`slide${slideNum} 的 shapeIndex=${patch.shapeIndex} 不存在，请重新运行 inspect-template.mjs`);
    }
    if (!Number.isInteger(patch.shapeIndex) && !patch.match) {
      throw new Error(`slide${slideNum} 的 textPatch 必须提供 shapeIndex 或 match: ${JSON.stringify(patch)}`);
    }
    if (patch.match && !Number.isInteger(patch.shapeIndex)) {
      const matched = textSlots.some((slot) => String(slot.sampleText ?? '').includes(String(patch.match)));
      if (!matched) {
        throw new Error(`slide${slideNum} 的 match 未命中文字框: ${patch.match}`);
      }
    }
  }
}

export function applyUnpackedPatches(unpackedDir, spec) {
  const slides = spec.slides || [];
  if (!slides.length) throw new Error('slides 不能为空');

  for (const slideSpec of slides) {
    const slideNum = slideSpec.sourceSlideIndex;
    if (!slideNum) {
      console.warn('[pptx-patch] 跳过无 sourceSlideIndex 的 slide spec');
      continue;
    }

    const slidePath = join(unpackedDir, 'ppt/slides', `slide${slideNum}.xml`);
    const relsPath = join(unpackedDir, 'ppt/slides/_rels', `slide${slideNum}.xml.rels`);
    if (!existsSync(slidePath)) {
      console.warn(`[pptx-patch] slide${slideNum} 不存在，已跳过`);
      continue;
    }

    let xml = readFileSync(slidePath, 'utf8');
    const relsXml = existsSync(relsPath) ? readFileSync(relsPath, 'utf8') : '';
    const rels = parseRelsXml(relsXml);
    const ph = parsePlaceholdersForSlide(xml, '', rels);
    const hasTextPatches = Array.isArray(slideSpec.textPatches);
    const patches = hasTextPatches
      ? slideSpec.textPatches
      : suggestTextPatches(slideSpec, ph.textSlots);
    if (hasTextPatches) validateTextPatches(slideNum, patches, ph.textSlots);

    xml = applyTextPatches(xml, patches, ph.textSlots);
    writeFileSync(slidePath, xml, 'utf8');

    const images = slideSpec.images
      || (slideSpec.image?.path ? [{ index: 0, path: slideSpec.image.path }] : []);
    for (const img of images) {
      replacePictureInUnpacked(unpackedDir, slideNum, img.index ?? 0, img.path);
    }
  }
}

async function main() {
  const unpackedDir = process.argv[2];
  const specPath = process.argv[3];
  if (!unpackedDir || !specPath) {
    console.error('用法: node apply-unpacked-patches.mjs <解压目录> <ppt-fill-spec.json>');
    process.exit(1);
  }
  applyUnpackedPatches(unpackedDir, loadSpec(specPath));
  console.log(`ARC_AI_PPTX_PATCHED: ${unpackedDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
