// OOXML slide 文本/图片 patch 工具（解压目录原位编辑）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, extname, basename } from 'node:path';

export function parseRelsXml(xml) {
  const rels = [];
  const re = /<Relationship\b([^>]*)\/>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const id = attrs.match(/\bId="([^"]+)"/i)?.[1];
    const type = attrs.match(/\bType="([^"]+)"/i)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/i)?.[1];
    if (id && type && target) {
      rels.push({ id, type, target: target.replace(/^\.\.\//, '') });
    }
  }
  return rels;
}

export function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeMediaPath(target) {
  let t = target.replace(/\\/g, '/').replace(/^\.\.\//, '');
  if (!t.startsWith('ppt/')) t = `ppt/${t}`;
  return t;
}

function relTargetFromMediaPath(mediaPath) {
  return `../${mediaPath.replace(/^ppt\//, '')}`;
}

function detectImageFormat(buf) {
  if (!buf?.length) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  return null;
}

function extForFormat(format) {
  if (format === 'jpeg') return 'jpeg';
  if (format === 'png') return 'png';
  if (format === 'gif') return 'gif';
  return null;
}

function formatMatchesExt(format, ext) {
  const e = (ext || '').toLowerCase();
  if (format === 'jpeg') return e === 'jpeg' || e === 'jpg';
  return e === format;
}

function mapPhTypeToRole(phType) {
  const t = (phType || '').toLowerCase();
  if (t === 'title' || t === 'ctrtitle') return 'title';
  if (t === 'subtitle') return 'subtitle';
  if (t === 'body') return 'body';
  if (t === 'dt') return 'date';
  if (t === 'sldnum') return 'slideNumber';
  return 'other';
}

function maxFontPt(block) {
  const sizes = [...block.matchAll(/<a:sz val="(\d+)"/gi)].map((m) => Number(m[1]) / 100);
  return sizes.length ? Math.max(...sizes) : 0;
}

function shapeTextPreview(block) {
  return [...block.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi)]
    .map((m) => m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    .join('')
    .trim()
    .slice(0, 120);
}

function isImageMediaTarget(target) {
  const t = String(target || '').replace(/\\/g, '/').replace(/^\.\.\//, '');
  return /^media\/[^/]+\.(png|jpe?g|gif|webp|bmp|tiff?|emf|wmf)$/i.test(t);
}

/** 按 XML 中出现顺序收集 r:embed 指向 ppt/media 的图片 */
function listImageEmbedsInXml(xml, rels) {
  const slots = [];
  const seenRelIds = new Set();
  const re = /r:embed="([^"]+)"/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const relId = m[1];
    if (seenRelIds.has(relId)) continue;
    const rel = rels.find((r) => r.id === relId);
    if (!rel || !isImageMediaTarget(rel.target)) continue;
    seenRelIds.add(relId);
    const target = rel.target.replace(/^\.\.\//, '');
    slots.push({
      relId,
      mediaPath: normalizeMediaPath(target),
      relsTarget: `../${target}`,
    });
  }
  return slots;
}

/** slide 内 p:pic / p:sp blipFill 等 + 关联 layout 上的示例图 */
export function listPictureSlotsForSlide(slideXml, rels = [], layoutXml = '', layoutRels = []) {
  const slideEmbeds = listImageEmbedsInXml(slideXml, rels);
  const layoutEmbeds = layoutXml ? listImageEmbedsInXml(layoutXml, layoutRels) : [];
  const pictureSlots = [
    ...slideEmbeds.map((slot, picIndex) => ({ ...slot, picIndex, slotSource: 'slide' })),
    ...layoutEmbeds.map((slot, i) => ({
      ...slot,
      picIndex: slideEmbeds.length + i,
      slotSource: 'layout',
    })),
  ];
  return pictureSlots;
}

/** 从 slide/layout XML 提取文本框与图片占位 */
export function parsePlaceholdersForSlide(slideXml, layoutXml = '', rels = [], layoutRels = []) {
  const spBlocks = listSpBlocks(slideXml);
  const textSlots = spBlocks
    .map((block, shapeIndex) => {
      if (!/<p:txBody>/i.test(block)) return null;
      const phType = block.match(/<p:ph\b[^>]*type="([^"]*)"/i)?.[1] || null;
      return {
        shapeIndex,
        phType,
        role: mapPhTypeToRole(phType),
        maxFontPt: maxFontPt(block),
        sampleText: shapeTextPreview(block),
      };
    })
    .filter(Boolean);

  // 无 p:ph 时按字号推断 title / body
  if (!textSlots.some((s) => s.role === 'title' || s.role === 'body')) {
    const sorted = [...textSlots].sort((a, b) => b.maxFontPt - a.maxFontPt);
    if (sorted[0]) sorted[0].role = 'title';
    if (sorted[1] && sorted[1].role === 'other') sorted[1].role = 'subtitle';
    if (sorted[2] && sorted[2].role === 'other') sorted[2].role = 'body';
    else if (sorted[1] && sorted[1].role === 'other') sorted[1].role = 'body';
  }

  const pictureSlots = listPictureSlotsForSlide(slideXml, rels, layoutXml, layoutRels);

  return { textSlots, pictureSlots };
}

function extractXmlElement(xml, tag) {
  const re = new RegExp(`<${tag}\\b`, 'i');
  const m = re.exec(xml);
  if (!m) return '';
  const start = m.index;
  const tagEnd = xml.indexOf('>', start);
  if (tagEnd < 0) return '';
  if (xml[tagEnd - 1] === '/') return xml.slice(start, tagEnd + 1);

  let depth = 1;
  let i = tagEnd + 1;
  const openRe = new RegExp(`<${tag}\\b`, 'gi');
  const closeTag = `</${tag}>`;
  while (i < xml.length && depth > 0) {
    const nextOpenIdx = (() => { openRe.lastIndex = i; const o = openRe.exec(xml); return o ? o.index : -1; })();
    const nextCloseIdx = xml.indexOf(closeTag, i);
    if (nextCloseIdx < 0) break;
    if (nextOpenIdx >= 0 && nextOpenIdx < nextCloseIdx) {
      depth += 1;
      i = nextOpenIdx + 1;
    } else {
      depth -= 1;
      i = nextCloseIdx + closeTag.length;
      if (depth === 0) return xml.slice(start, i);
    }
  }
  return '';
}

function extractTxBody(spBlock) {
  const start = spBlock.search(/<p:txBody>/i);
  if (start < 0) return '';
  const end = spBlock.indexOf('</p:txBody>', start);
  if (end < 0) return '';
  return spBlock.slice(start, end + '</p:txBody>'.length);
}

function isSpOpenTagAt(xml, i) {
  return /^<p:sp(?:\s|\/>|>)/i.test(xml.slice(i));
}

function listSpBlockRanges(slideXml) {
  const ranges = [];
  const re = /<p:sp\b/gi;
  let m;
  while ((m = re.exec(slideXml)) !== null) {
    if (!isSpOpenTagAt(slideXml, m.index)) continue;
    const start = m.index;
    let depth = 0;
    let i = start;
    while (i < slideXml.length) {
      if (isSpOpenTagAt(slideXml, i)) {
        depth += 1;
        i = slideXml.indexOf('>', i) + 1;
        continue;
      }
      if (slideXml.slice(i).startsWith('</p:sp>')) {
        depth -= 1;
        i += '</p:sp>'.length;
        if (depth === 0) {
          ranges.push({ start, end: i, block: slideXml.slice(start, i) });
          break;
        }
        continue;
      }
      i += 1;
    }
  }
  return ranges;
}

function listSpBlocks(slideXml) {
  return listSpBlockRanges(slideXml).map((r) => r.block);
}

function resolveShapeIndex(slots, role) {
  if (!slots?.length) return null;
  const hit = slots.find((s) => s.role === role);
  if (hit) return hit.shapeIndex;

  const sorted = [...slots].sort((a, b) => b.maxFontPt - a.maxFontPt);
  if (role === 'title') return sorted[0]?.shapeIndex ?? null;
  if (role === 'subtitle') return sorted[1]?.shapeIndex ?? null;
  if (role === 'body') return sorted[2]?.shapeIndex ?? sorted[1]?.shapeIndex ?? null;
  if (role === 'date') {
    const dt = slots.find((s) => s.phType === 'dt');
    if (dt) return dt.shapeIndex;
  }
  return null;
}

function findShapeBlock(slideXml, role, placeholders) {
  const blocks = listSpBlocks(slideXml);
  const slots = placeholders?.textSlots || [];

  const shapeIndex = resolveShapeIndex(slots, role);
  if (shapeIndex != null && blocks[shapeIndex]) return blocks[shapeIndex];

  for (const block of blocks) {
    const ph = block.match(/<p:ph\b[^>]*type="([^"]*)"/i)?.[1];
    const r = mapPhTypeToRole(ph);
    if (r === role) return block;
  }

  const withText = blocks.filter((b) => /<p:txBody>/i.test(b));
  const sorted = withText
    .map((b) => ({ b, pt: maxFontPt(b) }))
    .sort((a, c) => c.pt - a.pt);
  if (role === 'title' && sorted[0]) return sorted[0].b;
  if (role === 'subtitle' && sorted[1]) return sorted[1].b;
  if (role === 'body' && sorted[2]) return sorted[2].b;
  if (role === 'body' && sorted[1] && sorted[1].pt < sorted[0]?.pt * 0.85) return sorted[1].b;
  return null;
}

function findShapeBlockByIndex(slideXml, shapeIndex) {
  const blocks = listSpBlocks(slideXml);
  return shapeIndex != null ? blocks[shapeIndex] ?? null : null;
}

function replaceShapeText(spBlock, text) {
  const txBody = extractTxBody(spBlock);
  if (!txBody) return spBlock;

  let replaced = false;
  const newTxBody = txBody.replace(/<a:t(\b[^>]*)>[\s\S]*?<\/a:t>/gi, (full, attrs) => {
    if (replaced) return `<a:t${attrs}></a:t>`;
    replaced = true;
    return `<a:t${attrs}>${escapeXml(text)}</a:t>`;
  });
  if (!replaced) return spBlock;
  return spBlock.replace(txBody, newTxBody);
}

function replaceShapeBullets(spBlock, bullets) {
  const txBody = extractTxBody(spBlock);
  if (!txBody) return spBlock;

  const bodyPr = extractXmlElement(txBody, 'a:bodyPr');
  const lstStyle = extractXmlElement(txBody, 'a:lstStyle');
  const firstP = extractXmlElement(txBody, 'a:p');
  const pPr = extractXmlElement(firstP, 'a:pPr')
    || '<a:pPr><a:buChar char="•"/></a:pPr>';
  const rPr = extractXmlElement(firstP, 'a:rPr')
    || '<a:rPr lang="zh-CN"/>';

  const lines = (bullets || []).map((b) => String(b ?? ''));
  const paras = lines.map(
    (b) => `<a:p>${pPr}<a:r>${rPr}<a:t>${escapeXml(b)}</a:t></a:r></a:p>`,
  ).join('');
  const newTxBody = `<p:txBody>${bodyPr}${lstStyle}${paras}</p:txBody>`;
  return spBlock.replace(txBody, newTxBody);
}

function normalizeBulletLines(bullets) {
  if (!bullets?.length) return [];
  return bullets.map((b) => {
    if (b == null) return '';
    if (typeof b === 'string') return b;
    if (typeof b === 'object') {
      const parts = [b.label, b.title, b.desc, b.text].filter(Boolean);
      return parts.join(' ').trim();
    }
    return String(b);
  }).filter(Boolean);
}

function formatListItem(item, { toc = false } = {}) {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'object') {
    const label = item.label || item.title || '';
    const desc = item.desc || item.text || '';
    if (toc) return label || desc;
    if (label && desc) return `${label} ${desc}`.trim();
    return label || desc;
  }
  return String(item);
}

const NAV_SAMPLE_RE = /^(CONTENTS|PPT模板|目录)$/i;
const PLACEHOLDER_SAMPLE_RE = /^(please enter text here\.?|单击此处输入标题|标题添加|添加标题|YOUR TITLE HERE|请您单击此处输入文本内容|添加标题内容详写内容|\s*)$/i;

function isNavSample(text) {
  return NAV_SAMPLE_RE.test(String(text ?? '').trim());
}

function isPlaceholderSample(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  return PLACEHOLDER_SAMPLE_RE.test(t);
}

function isSectionHeaderSample(text) {
  const t = String(text ?? '').trim();
  if (!t || isNavSample(t) || isPlaceholderSample(t)) return false;
  return !/YOUR TITLE HERE/i.test(t);
}

function patchShapeByIndex(slideXml, shapeIndex, patchFn) {
  const ranges = listSpBlockRanges(slideXml);
  const range = ranges[shapeIndex];
  if (!range) return slideXml;
  const patched = patchFn(range.block);
  return slideXml.slice(0, range.start) + patched + slideXml.slice(range.end);
}

function patchShape(slideXml, role, placeholders, patchFn) {
  const block = findShapeBlock(slideXml, role, placeholders);
  if (!block) return slideXml;
  return slideXml.replace(block, patchFn(block));
}

function pickCoverSlots(slots) {
  const title = slots.find((s) => s.role === 'title' && s.sampleText)
    || slots.find((s) => s.role === 'title')
    || slots.find((s) => s.shapeIndex === 0);
  const subtitle = slots.find((s) => s.role === 'subtitle')
    || slots.find((s) => s.shapeIndex === 1);
  return { title, subtitle };
}

function pickSectionSlots(slots) {
  const headers = slots
    .filter((s) => s.role === 'other' && isSectionHeaderSample(s.sampleText))
    .sort((a, b) => b.shapeIndex - a.shapeIndex);
  const title = headers[0]
    || slots.find((s) => s.role === 'title' && !isPlaceholderSample(s.sampleText))
    || slots.find((s) => s.role === 'title');
  const subtitle = slots.find((s) => /YOUR TITLE HERE/i.test(s.sampleText || ''))
    || slots.find((s) => s.role === 'subtitle' && !isPlaceholderSample(s.sampleText))
    || slots.find((s) => s.role === 'subtitle');
  return { title, subtitle };
}

function pickTocSlots(slots) {
  return slots
    .filter((s) => s.role === 'other' && isSectionHeaderSample(s.sampleText))
    .sort((a, b) => a.shapeIndex - b.shapeIndex);
}

function pickContentTitleSlot(slots) {
  const bySample = slots.find((s) =>
    /单击此处输入标题|^添加标题$/i.test(String(s.sampleText || '').trim()),
  );
  if (bySample) return bySample;
  const bodyAsTitle = slots.find((s) => s.role === 'body' && /标题添加/i.test(s.sampleText || ''));
  if (bodyAsTitle) return bodyAsTitle;
  const titled = slots.find((s) => s.role === 'title' && !isPlaceholderSample(s.sampleText));
  if (titled) return titled;
  return slots.find((s) => s.role === 'title')
    || slots.find((s) => s.role === 'body' && !isPlaceholderSample(s.sampleText));
}

function pickContentColumnSlots(slots) {
  return slots
    .filter((s) => /^标题添加$/i.test(String(s.sampleText || '').trim()))
    .sort((a, b) => a.shapeIndex - b.shapeIndex);
}

function pickContentDetailSlots(slots) {
  return slots
    .filter((s) => /添加标题内容详写|请您单击此处输入文本内容/i.test(s.sampleText || ''))
    .sort((a, b) => a.shapeIndex - b.shapeIndex);
}

function pickContentBodySlot(slots, titleSlot) {
  const detail = pickContentDetailSlots(slots).find((s) => s.shapeIndex !== titleSlot?.shapeIndex);
  if (detail) return detail;
  const body = slots.find((s) => s.role === 'body' && s.shapeIndex !== titleSlot?.shapeIndex);
  if (body) return body;
  return titleSlot;
}

function pushTextPatch(patches, slot, text) {
  if (slot != null && text != null && String(text) !== '') {
    patches.push({ shapeIndex: slot.shapeIndex, text: String(text) });
  }
}

function resolvePatchShapeIndex(patch, slots, usedShapeIndexes) {
  if (patch.shapeIndex != null) return patch.shapeIndex;
  if (!patch.match) return null;
  const m = String(patch.match);
  const hit = slots.find((s) => {
    if (usedShapeIndexes?.has(s.shapeIndex)) return false;
    const sample = String(s.sampleText ?? '');
    return sample.includes(m) || sample.trim() === m.trim();
  });
  return hit?.shapeIndex ?? null;
}

/** 将 title/subtitle/bullets 等语义字段转为 shapeIndex 级 patch（无 textPatches 时自动推断） */
export function suggestTextPatches(spec, slots) {
  const patches = [];
  const role = spec.role || 'content';
  const bulletLines = normalizeBulletLines(spec.bullets || (role === 'toc' ? null : spec.items));

  if (role === 'cover' || role === 'closing') {
    const { title, subtitle } = pickCoverSlots(slots);
    pushTextPatch(patches, title, spec.title);
    pushTextPatch(patches, subtitle, spec.subtitle);
    if (spec.date) {
      const dt = slots.find((s) => s.phType === 'dt' || s.role === 'date');
      pushTextPatch(patches, dt, spec.date);
    }
    return patches;
  }

  if (role === 'section') {
    const { title, subtitle } = pickSectionSlots(slots);
    pushTextPatch(patches, title, spec.title);
    pushTextPatch(patches, subtitle, spec.subtitle);
    return patches;
  }

  if (role === 'toc') {
    if (spec.title) {
      const navTitle = slots.find((s) => /CONTENTS/i.test(s.sampleText || ''));
      pushTextPatch(patches, navTitle, spec.title);
    }
    if (spec.subtitle) {
      const navSub = slots.find((s) => /PPT模板/i.test(s.sampleText || ''))
        || slots.find((s) => s.role === 'subtitle' && !isPlaceholderSample(s.sampleText));
      pushTextPatch(patches, navSub, spec.subtitle);
    }
    const tocSlots = pickTocSlots(slots);
    const lines = (spec.items || []).map((item) => formatListItem(item, { toc: true })).filter(Boolean);
    for (let i = 0; i < lines.length && i < tocSlots.length; i++) {
      pushTextPatch(patches, tocSlots[i], lines[i]);
    }
    return patches;
  }

  const titleSlot = spec.title ? pickContentTitleSlot(slots) : null;
  const bodySlot = bulletLines.length ? pickContentBodySlot(slots, titleSlot) : null;
  const sameSlot = titleSlot && bodySlot && titleSlot.shapeIndex === bodySlot.shapeIndex;

  if (sameSlot && spec.title && bulletLines.length) {
    patches.push({ shapeIndex: titleSlot.shapeIndex, bullets: [spec.title, ...bulletLines] });
    return patches;
  }

  pushTextPatch(patches, titleSlot, spec.title);
  if (spec.subtitle) {
    const sub = slots.find((s) => s.role === 'subtitle' && !isPlaceholderSample(s.sampleText));
    pushTextPatch(patches, sub, spec.subtitle);
  }
  if (spec.date) {
    const dt = slots.find((s) => s.phType === 'dt' || s.role === 'date');
    pushTextPatch(patches, dt, spec.date);
  }

  if (!bulletLines.length) return patches;

  const columns = pickContentColumnSlots(slots);
  if (columns.length >= 2) {
    const used = new Set(titleSlot ? [titleSlot.shapeIndex] : []);
    const freeCols = columns.filter((c) => !used.has(c.shapeIndex));
    for (let i = 0; i < bulletLines.length && i < freeCols.length; i++) {
      pushTextPatch(patches, freeCols[i], bulletLines[i]);
    }
    if (bulletLines.length > freeCols.length && freeCols.length) {
      patches.push({ shapeIndex: freeCols[freeCols.length - 1].shapeIndex, bullets: bulletLines.slice(freeCols.length) });
    } else if (bulletLines.length > freeCols.length && !freeCols.length && titleSlot) {
      patches.push({ shapeIndex: titleSlot.shapeIndex, bullets: bulletLines });
    }
    return patches;
  }

  const detailSlots = pickContentDetailSlots(slots);
  if (detailSlots.length >= bulletLines.length) {
    for (let i = 0; i < bulletLines.length; i++) {
      pushTextPatch(patches, detailSlots[i], bulletLines[i]);
    }
    return patches;
  }

  const body = pickContentBodySlot(slots, titleSlot);
  if (body) {
    if (bulletLines.length === 1) {
      pushTextPatch(patches, body, bulletLines[0]);
    } else {
      patches.push({ shapeIndex: body.shapeIndex, bullets: bulletLines });
    }
  }
  return patches;
}

/** 按 shapeIndex / match 精确写入（主路径；spec.textPatches 优先） */
export function applyTextPatches(slideXml, patches, slots) {
  let xml = slideXml;
  const usedMatchSlots = new Set();
  for (const patch of patches || []) {
    const shapeIndex = resolvePatchShapeIndex(patch, slots, usedMatchSlots);
    if (shapeIndex == null) {
      console.warn(`[pptx-fill] textPatch 未命中 shape: ${JSON.stringify(patch)}`);
      continue;
    }
    if (patch.match != null && patch.shapeIndex == null) {
      usedMatchSlots.add(shapeIndex);
    }
    if (patch.bullets?.length) {
      xml = patchShapeByIndex(xml, shapeIndex, (b) => replaceShapeBullets(b, patch.bullets));
    } else if (patch.text != null) {
      xml = patchShapeByIndex(xml, shapeIndex, (b) => replaceShapeText(b, patch.text));
    }
  }
  return xml;
}

export function applySlideContent(slideXml, spec, placeholders) {
  const slots = placeholders?.textSlots || [];
  const patches = spec.textPatches?.length ? spec.textPatches : suggestTextPatches(spec, slots);
  return applyTextPatches(slideXml, patches, slots);
}

/** 对单个 slide XML 字符串应用 textPatches（解压编辑流程） */
export function patchSlideXml(slideXml, textPatches, rels = []) {
  const placeholders = parsePlaceholdersForSlide(slideXml, '', rels);
  return applyTextPatches(slideXml, textPatches, placeholders.textSlots);
}

export function listSlidePaths(zip) {
  return Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f) && !zip.files[f].dir)
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
}

/** 解压目录中原位换图（不经过 zip 内存流） */
export function replacePictureInUnpacked(unpackedDir, slideNum, picIndex, imagePath) {
  if (!imagePath || !existsSync(imagePath)) {
    console.warn(`[pptx-fill] 图片不存在，已跳过: ${imagePath}`);
    return;
  }
  const slidePath = `${unpackedDir}/ppt/slides/slide${slideNum}.xml`.replace(/\\/g, '/');
  const relsPath = `${unpackedDir}/ppt/slides/_rels/slide${slideNum}.xml.rels`.replace(/\\/g, '/');
  if (!existsSync(slidePath)) return;

  const slideXml = readFileSync(slidePath, 'utf8');
  let relsXml = existsSync(relsPath) ? readFileSync(relsPath, 'utf8') : '';
  const rels = parseRelsXml(relsXml);

  let layoutXml = '';
  let layoutRels = [];
  let layoutRelsPath = '';
  const layoutRel = rels.find((r) => /slideLayout/i.test(r.type));
  if (layoutRel) {
    const layoutPart = layoutRel.target.startsWith('ppt/')
      ? layoutRel.target
      : `ppt/${layoutRel.target.replace(/^\.\.\//, '')}`;
    const layoutName = layoutPart.split('/').pop();
    const layoutPath = `${unpackedDir}/${layoutPart}`.replace(/\\/g, '/');
    layoutRelsPath = `${unpackedDir}/ppt/slideLayouts/_rels/${layoutName}.rels`.replace(/\\/g, '/');
    if (existsSync(layoutPath)) layoutXml = readFileSync(layoutPath, 'utf8');
    if (existsSync(layoutRelsPath)) layoutRels = parseRelsXml(readFileSync(layoutRelsPath, 'utf8'));
  }

  const slots = listPictureSlotsForSlide(slideXml, rels, layoutXml, layoutRels);
  const slot = slots[picIndex];
  if (!slot) {
    console.warn(`[pptx-fill] slide${slideNum} 无第 ${picIndex} 张图，已跳过`);
    return;
  }
  const embed = slot.relId;
  const relSource = slot.slotSource === 'layout' ? layoutRels : rels;
  const rel = relSource.find((r) => r.id === embed);
  if (!rel) return;

  const buf = readFileSync(imagePath);
  const format = detectImageFormat(buf);
  if (!format) {
    console.warn(`[pptx-fill] 无法识别图片格式，已跳过: ${imagePath}`);
    return;
  }

  let mediaPath = normalizeMediaPath(rel.target);
  const curExt = mediaPath.split('.').pop() || '';
  if (!formatMatchesExt(format, curExt)) {
    const newExt = extForFormat(format);
    mediaPath = mediaPath.replace(/\.[^./\\]+$/, `.${newExt}`);
    const newTarget = relTargetFromMediaPath(mediaPath);
    const targetRelsPath = slot.slotSource === 'layout' ? layoutRelsPath : relsPath;
    const targetRelsXml = slot.slotSource === 'layout'
      ? readFileSync(targetRelsPath, 'utf8')
      : relsXml;
    const updatedRelsXml = targetRelsXml.replace(
      new RegExp(`(<Relationship\\b[^>]*Id="${embed}"[^>]*Target=")[^"]+(")`, 'i'),
      `$1${newTarget}$2`,
    );
    writeFileSync(targetRelsPath, updatedRelsXml, 'utf8');
  }

  const absMedia = `${unpackedDir}/${mediaPath}`.replace(/\\/g, '/');
  mkdirSync(dirname(absMedia), { recursive: true });
  writeFileSync(absMedia, buf);
}
