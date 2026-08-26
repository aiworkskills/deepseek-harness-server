// 按 ppt-fill-spec 重排并裁剪 slide（模板 20 页 → 输出 10 页）
// 用法: node compose-slides-from-spec.mjs <pptJobDir>/ppt-work <pptJobDir>/ppt-fill-spec.json
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseRelsXml } from './ooxml-fill.mjs';

const SLIDE_PART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const SLIDE_CT = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const NOTES_CT = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

function loadSpec(specPath) {
  return JSON.parse(readFileSync(specPath, 'utf8'));
}

function listSlideNums(unpackedDir) {
  const slidesDir = join(unpackedDir, 'ppt/slides');
  return readdirSync(slidesDir)
    .filter((f) => /^slide\d+\.xml$/i.test(f))
    .map((f) => Number(f.match(/(\d+)/)[1]))
    .sort((a, b) => a - b);
}

function copySlideBundle(unpackedDir, fromNum, toNum, stagingDir) {
  const fromXml = join(unpackedDir, 'ppt/slides', `slide${fromNum}.xml`);
  const fromRels = join(unpackedDir, 'ppt/slides/_rels', `slide${fromNum}.xml.rels`);
  const toXml = join(stagingDir, `slide${toNum}.xml`);
  const toRelsDir = join(stagingDir, '_rels');
  mkdirSync(toRelsDir, { recursive: true });
  copyFileSync(fromXml, toXml);
  if (existsSync(fromRels)) {
    let relsXml = readFileSync(fromRels, 'utf8');
    relsXml = relsXml.replace(
      /<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*\/>/gi,
      '',
    );
    writeFileSync(join(toRelsDir, `slide${toNum}.xml.rels`), relsXml, 'utf8');
  }
}

function nextRelId(rels) {
  let max = 0;
  for (const r of rels) {
    const n = Number(String(r.id).replace(/\D/g, ''));
    if (n > max) max = n;
  }
  return `rId${max + 1}`;
}

function buildSlideMaps(unpackedDir) {
  const presPath = join(unpackedDir, 'ppt/presentation.xml');
  const presRelsPath = join(unpackedDir, 'ppt/_rels/presentation.xml.rels');
  const presXml = readFileSync(presPath, 'utf8');
  const presRels = parseRelsXml(readFileSync(presRelsPath, 'utf8'));

  const slideRels = presRels.filter(
    (r) => r.type === SLIDE_PART && /^slides\/slide\d+\.xml$/i.test(r.target),
  );
  const ridToSlide = new Map(slideRels.map((r) => [r.id, Number(r.target.match(/(\d+)/)[1])]));
  const slideToRid = new Map(slideRels.map((r) => [Number(r.target.match(/(\d+)/)[1]), r.id]));

  const sldEntries = [...presXml.matchAll(/<p:sldId\b([^>]*)\/>/gi)].map((m) => {
    const attrs = m[1];
    const id = attrs.match(/\bid="(\d+)"/i)?.[1];
    const rId = attrs.match(/\br:id="([^"]+)"/i)?.[1];
    const slideNum = ridToSlide.get(rId);
    return { id, rId, slideNum };
  });

  const slideToSldId = new Map(
    sldEntries.filter((e) => e.slideNum != null).map((e) => [e.slideNum, { id: e.id, rId: e.rId }]),
  );

  return { presXml, presRels, presRelsPath, slideToSldId, slideToRid };
}

function syncPresentation(unpackedDir, plan) {
  const { presXml, presRels, presRelsPath, slideToSldId } = buildSlideMaps(unpackedDir);
  const nonSlideRels = presRels.filter((r) => r.type !== SLIDE_PART);

  const newSlideRels = [];
  const sldIdParts = [];
  let nextId = 256;
  for (let i = 0; i < plan.length; i++) {
    const source = plan[i];
    const orig = slideToSldId.get(source);
    const sldId = orig?.id || String(nextId + i);
    const relId = nextRelId([...nonSlideRels, ...newSlideRels]);
    newSlideRels.push({
      id: relId,
      type: SLIDE_PART,
      target: `slides/slide${i + 1}.xml`,
    });
    sldIdParts.push(`<p:sldId id="${sldId}" r:id="${relId}"/>`);
  }

  const newPresXml = presXml.replace(
    /<p:sldIdLst>[\s\S]*?<\/p:sldIdLst>/,
    `<p:sldIdLst>${sldIdParts.join('')}</p:sldIdLst>`,
  );

  const relLines = [...nonSlideRels, ...newSlideRels]
    .map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`)
    .join('');
  const newPresRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relLines}</Relationships>`;

  writeFileSync(join(unpackedDir, 'ppt/presentation.xml'), newPresXml, 'utf8');
  writeFileSync(presRelsPath, newPresRels, 'utf8');
}

function syncContentTypes(unpackedDir, outputCount) {
  const ctPath = join(unpackedDir, '[Content_Types].xml');
  let ct = readFileSync(ctPath, 'utf8');

  ct = ct.replace(/<Override PartName="\/ppt\/slides\/slide\d+\.xml" ContentType="[^"]+"\/>/gi, '');
  ct = ct.replace(/<Override PartName="\/ppt\/notesSlides\/notesSlide\d+\.xml" ContentType="[^"]+"\/>/gi, '');

  const slideOverrides = Array.from({ length: outputCount }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${SLIDE_CT}"/>`,
  ).join('');

  ct = ct.replace('</Types>', `${slideOverrides}</Types>`);
  writeFileSync(ctPath, ct, 'utf8');
}

function syncDocProps(unpackedDir, outputCount) {
  const appPath = join(unpackedDir, 'docProps/app.xml');
  if (!existsSync(appPath)) return;
  let xml = readFileSync(appPath, 'utf8');
  xml = xml.replace(/<Slides>\d+<\/Slides>/, `<Slides>${outputCount}</Slides>`);
  writeFileSync(appPath, xml, 'utf8');
}

function removeOrphanNotes(unpackedDir) {
  const notesDir = join(unpackedDir, 'ppt/notesSlides');
  if (!existsSync(notesDir)) return;
  for (const name of readdirSync(notesDir)) {
    if (!/^notesSlide\d+\.xml$/i.test(name)) continue;
    rmSync(join(notesDir, name), { force: true });
    rmSync(join(notesDir, '_rels', `${name}.rels`), { force: true });
  }
}

export function composeSlidesFromSpec(unpackedDir, spec) {
  const plan = (spec.slides || [])
    .map((s) => s.sourceSlideIndex)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!plan.length) throw new Error('spec.slides 须含 sourceSlideIndex');

  const templateNums = listSlideNums(unpackedDir);
  const templateCount = templateNums.length;
  const outputCount = plan.length;

  const isSequentialFull =
    outputCount === templateCount && plan.every((src, i) => src === i + 1);
  if (isSequentialFull) {
    console.log(`[pptx-compose] 跳过：输出 ${outputCount} 页与模板顺序一致`);
    return { skipped: true, outputCount };
  }

  const stagingDir = join(unpackedDir, '_compose_staging');
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  for (let i = 0; i < outputCount; i++) {
    const source = plan[i];
    if (!existsSync(join(unpackedDir, 'ppt/slides', `slide${source}.xml`))) {
      throw new Error(`sourceSlideIndex ${source} 不存在（模板共 ${templateCount} 页）`);
    }
    copySlideBundle(unpackedDir, source, i + 1, stagingDir);
  }

  const slidesDir = join(unpackedDir, 'ppt/slides');
  const relsDir = join(slidesDir, '_rels');
  for (const num of templateNums) {
    rmSync(join(slidesDir, `slide${num}.xml`), { force: true });
    rmSync(join(relsDir, `slide${num}.xml.rels`), { force: true });
  }

  for (const name of readdirSync(stagingDir)) {
    if (name === '_rels') continue;
    copyFileSync(join(stagingDir, name), join(slidesDir, name));
  }
  for (const name of readdirSync(join(stagingDir, '_rels'))) {
    copyFileSync(join(stagingDir, '_rels', name), join(relsDir, name));
  }
  rmSync(stagingDir, { recursive: true, force: true });

  syncPresentation(unpackedDir, plan);
  removeOrphanNotes(unpackedDir);
  syncContentTypes(unpackedDir, outputCount);
  syncDocProps(unpackedDir, outputCount);

  console.log(`[pptx-compose] ${templateCount} 页 → ${outputCount} 页`);
  return { skipped: false, templateCount, outputCount, plan };
}

async function main() {
  const unpackedDir = process.argv[2];
  const specPath = process.argv[3];
  if (!unpackedDir || !specPath) {
    console.error('用法: node compose-slides-from-spec.mjs <解压目录> <ppt-fill-spec.json>');
    process.exit(1);
  }
  composeSlidesFromSpec(unpackedDir, loadSpec(specPath));
  console.log(`ARC_AI_PPTX_COMPOSED: ${unpackedDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
