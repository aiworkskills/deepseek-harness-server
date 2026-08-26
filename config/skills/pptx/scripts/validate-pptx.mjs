// 生成后校验 .pptx 包结构与 XML 合法性（内存解压，无需落盘）
// CLI: node validate-pptx.mjs workspace/out/汇报.pptx [--json] [--expected-slides=10]
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';

const XML_PART = /\.(xml|rels)$/i;

/** @typedef {{ code: string, part?: string, message: string }} PptxIssue */
/** @typedef {{ ok: boolean, errors: PptxIssue[], warnings: PptxIssue[], summary: Record<string, number|string> }} PptxValidation */

function resolveRelTarget(baseRelsPath, target) {
  if (target.startsWith('http')) return null;
  if (target.startsWith('/')) return target.slice(1);
  const base = baseRelsPath.replace('/_rels/', '/').replace('.rels', '');
  const baseDir = base.includes('/') ? `${base.slice(0, base.lastIndexOf('/') + 1)}` : '';
  if (target.startsWith('../')) {
    const parts = `${baseDir}${target}`.split('/');
    const stack = [];
    for (const p of parts) {
      if (p === '..') stack.pop();
      else if (p && p !== '.') stack.push(p);
    }
    return stack.join('/');
  }
  return `${baseDir}${target}`;
}

/** 轻量 XML 合法性检查（不依赖外部解析库） */
export function assertWellFormedXml(xml, partName = 'part') {
  let s = xml.replace(/<\?xml[\s\S]*?\?>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!\[CDATA\[([\s\S]*?)]]>/g, (_, c) => c.replace(/[<>]/g, ''));

  const stack = [];
  const tagRe = /<\/?([A-Za-z_][\w:.-]*)(?:\s[^>]*)?\/?>/g;
  let m;
  while ((m = tagRe.exec(s)) !== null) {
    const full = m[0];
    const tag = m[1];
    if (full.startsWith('<?') || full.startsWith('<!')) continue;
    if (full.endsWith('/>')) continue;
    if (full.startsWith('</')) {
      if (!stack.length || stack[stack.length - 1] !== tag) {
        throw new Error(`${partName}: mismatched tag </${tag}>, expected </${stack[stack.length - 1] || '?'}>`);
      }
      stack.pop();
    } else {
      stack.push(tag);
    }
  }
  if (stack.length) {
    throw new Error(`${partName}: unclosed tag <${stack[stack.length - 1]}>`);
  }
}

function listSlideParts(files) {
  return [...files]
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
}

function detectImageFormat(buf) {
  if (!buf?.length) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  return null;
}

function formatMatchesExt(format, ext) {
  const e = (ext || '').toLowerCase();
  if (format === 'jpeg') return e === 'jpeg' || e === 'jpg';
  return e === format;
}

/**
 * @param {string} pptxPath
 * @param {{ expectedSlides?: number, strict?: boolean }} [options]
 * @returns {Promise<PptxValidation>}
 */
export async function validatePptx(pptxPath, options = {}) {
  /** @type {PptxIssue[]} */
  const errors = [];
  /** @type {PptxIssue[]} */
  const warnings = [];

  if (!pptxPath || !existsSync(pptxPath)) {
    return {
      ok: false,
      errors: [{ code: 'FILE_MISSING', message: `文件不存在: ${pptxPath}` }],
      warnings,
      summary: {},
    };
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(readFileSync(pptxPath));
  } catch (e) {
    return {
      ok: false,
      errors: [{ code: 'ZIP_INVALID', message: `无法读取 zip: ${e.message}` }],
      warnings,
      summary: {},
    };
  }

  const fileSet = new Set(
    Object.keys(zip.files).filter((f) => !zip.files[f].dir),
  );

  const parts = {};
  for (const name of fileSet) {
    parts[name] = await zip.file(name).async('string');
  }

  // XML / rels 合法性
  for (const name of fileSet) {
    if (!XML_PART.test(name)) continue;
    try {
      assertWellFormedXml(parts[name], name);
    } catch (e) {
      errors.push({ code: 'XML_MALFORMED', part: name, message: e.message });
    }
  }

  // slide 根节点
  for (const sf of listSlideParts(fileSet)) {
    if (!parts[sf].includes('</p:sld>')) {
      errors.push({ code: 'SLIDE_INCOMPLETE', part: sf, message: '缺少 </p:sld>' });
    }
  }

  // Content_Types
  const ctPath = '[Content_Types].xml';
  if (!parts[ctPath]) {
    errors.push({ code: 'CT_MISSING', part: ctPath, message: '缺少 [Content_Types].xml' });
  } else {
    const overrides = [...parts[ctPath].matchAll(/PartName="([^"]+)"/g)].map((m) => m[1].slice(1));
    const seen = new Set();
    for (const p of overrides) {
      if (seen.has(p)) {
        errors.push({ code: 'CT_DUPLICATE', part: ctPath, message: `重复 PartName: /${p}` });
      }
      seen.add(p);
      if (!fileSet.has(p)) {
        const issue = { code: 'CT_ORPHAN', part: ctPath, message: `声明了不存在的 part: /${p}` };
        // Some producers leave optional, unused overrides (notably slideMaster entries).
        // They are useful diagnostics but should not reject an otherwise consistent package.
        (options.strict ? errors : warnings).push(issue);
      }
    }
    for (const sf of listSlideParts(fileSet)) {
      if (!overrides.includes(sf)) {
        errors.push({ code: 'CT_MISSING_SLIDE', part: sf, message: 'slide 未写入 Content_Types' });
      }
    }
    if (parts[ctPath].includes('image/.jpg')) {
      warnings.push({
        code: 'CT_INVALID_JPG',
        part: ctPath,
        message: 'ContentType image/.jpg 无效，应为 image/jpeg',
      });
    }
  }

  // 媒体：扩展名须与文件头一致（否则 WPS 报内容异常）
  for (const name of fileSet) {
    if (!name.startsWith('ppt/media/')) continue;
    const buf = await zip.file(name).async('nodebuffer');
    if (!buf.length) {
      errors.push({ code: 'MEDIA_EMPTY', part: name, message: '媒体文件为空' });
      continue;
    }
    const ext = name.split('.').pop()?.toLowerCase();
    const format = detectImageFormat(buf);
    if (!format) continue;
    if (!formatMatchesExt(format, ext)) {
      errors.push({
        code: 'MEDIA_FORMAT_MISMATCH',
        part: name,
        message: `扩展名 .${ext} 与真实格式 ${format} 不一致`,
      });
    }
  }

  // rels 目标存在性（跳过 package 根 _rels/.rels 的解析方式差异）
  for (const rf of fileSet) {
    if (!rf.endsWith('.rels') || rf === '_rels/.rels') continue;
    for (const m of parts[rf].matchAll(/Target="([^"]+)"/g)) {
      const resolved = resolveRelTarget(rf, m[1]);
      if (resolved && !fileSet.has(resolved)) {
        errors.push({
          code: 'REL_TARGET_MISSING',
          part: rf,
          message: `Target 不存在: ${m[1]} -> ${resolved}`,
        });
      }
    }
  }

  // presentation 与 slide 一致性
  const presPath = 'ppt/presentation.xml';
  const presRelsPath = 'ppt/_rels/presentation.xml.rels';
  const slideFiles = listSlideParts(fileSet);
  const slideCount = slideFiles.length;

  if (parts[presPath] && parts[presRelsPath]) {
    const presRids = [...parts[presPath].matchAll(/r:id="([^"]+)"/gi)].map((m) => m[1]);
    for (const rid of presRids) {
      if (!parts[presRelsPath].includes(`Id="${rid}"`)) {
        errors.push({
          code: 'PRES_RID_MISSING',
          part: presPath,
          message: `presentation.xml 引用 ${rid}，但 presentation.xml.rels 中不存在`,
        });
      }
    }

    const sldRids = [...parts[presPath].matchAll(/<p:sldId[^>]*r:id="([^"]+)"/gi)].map((m) => m[1]);
    const slideRels = [...parts[presRelsPath].matchAll(
      /Type="[^"]*relationships\/slide"[^>]*Target="([^"]+)"/gi,
    )].map((m) => m[1]);

    if (sldRids.length !== slideCount) {
      errors.push({
        code: 'SLIDE_COUNT_MISMATCH',
        part: presPath,
        message: `sldIdLst=${sldRids.length} 与 slide 文件数=${slideCount} 不一致`,
      });
    }

    for (const rid of sldRids) {
      const rel = parts[presRelsPath].match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`));
      if (!rel) {
        errors.push({ code: 'SLDID_NO_REL', part: presPath, message: `sldId ${rid} 无对应 Relationship` });
      } else if (!fileSet.has(`ppt/${rel[1]}`)) {
        errors.push({ code: 'SLDID_TARGET_MISSING', part: presPath, message: `sldId ${rid} -> ${rel[1]} 文件缺失` });
      }
    }

    for (const t of slideRels) {
      if (!fileSet.has(`ppt/${t}`)) {
        errors.push({ code: 'PRES_REL_ORPHAN', part: presRelsPath, message: `slide rel 指向缺失文件: ${t}` });
      }
    }

    for (const sf of slideFiles) {
      const short = sf.replace(/^ppt\//, '');
      if (!slideRels.includes(short)) {
        warnings.push({ code: 'SLIDE_NO_PRES_REL', part: sf, message: 'slide 文件未出现在 presentation.xml.rels' });
      }
    }
  }

  // notesSlide 双向引用
  const slideSet = new Set(slideFiles.map((f) => f.replace(/^ppt\//, '')));
  const notesPaths = [...fileSet].filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(f));
  for (const notesPath of notesPaths) {
    const name = notesPath.split('/').pop();
    const relsPath = `ppt/notesSlides/_rels/${name}.rels`;
    const relsXml = parts[relsPath];
    if (!relsXml) {
      errors.push({ code: 'NOTES_NO_RELS', part: notesPath, message: 'notesSlide 缺少 rels' });
      continue;
    }
    const slideTarget = relsXml
      .match(/relationships\/slide"[^>]*Target="([^"]+)"/i)?.[1]
      ?.replace(/^\.\.\//, '');
    if (!slideTarget || !slideSet.has(slideTarget)) {
      errors.push({
        code: 'NOTES_BAD_SLIDE',
        part: relsPath,
        message: `notesSlide 指向无效 slide: ${slideTarget || '(none)'}`,
      });
    }
  }

  for (const sf of slideFiles) {
    const relsPath = sf.replace('slides/', 'slides/_rels/') + '.rels';
    const relsXml = parts[relsPath];
    if (!relsXml) continue;
    const slideShort = sf.replace(/^ppt\//, '');
    for (const m of relsXml.matchAll(/relationships\/notesSlide"[^>]*Target="([^"]+)"/gi)) {
      const notesName = m[1].split('/').pop();
      const notesPath = `ppt/notesSlides/${notesName}`;
      const notesRelsPath = `ppt/notesSlides/_rels/${notesName}.rels`;
      if (!parts[notesPath]) {
        errors.push({ code: 'SLIDE_NOTES_MISSING', part: relsPath, message: `引用不存在的 ${notesName}` });
        continue;
      }
      const back = parts[notesRelsPath]
        ?.match(/relationships\/slide"[^>]*Target="([^"]+)"/i)?.[1]
        ?.replace(/^\.\.\//, '');
      if (back !== slideShort) {
        errors.push({
          code: 'NOTES_BIDIRECTIONAL',
          part: relsPath,
          message: `${notesName} 未回指 ${slideShort}（实际 ${back || '?'}）`,
        });
      }
    }
  }

  // docProps 页数
  const appPath = 'docProps/app.xml';
  if (parts[appPath]) {
    const declared = parts[appPath].match(/<Slides>(\d+)<\/Slides>/i)?.[1];
    if (declared && Number(declared) !== slideCount) {
      warnings.push({
        code: 'APP_SLIDES_COUNT',
        part: appPath,
        message: `docProps Slides=${declared}，实际 ${slideCount}`,
      });
    }
  }

  if (options.expectedSlides != null && slideCount !== options.expectedSlides) {
    errors.push({
      code: 'EXPECTED_SLIDES',
      message: `期望 ${options.expectedSlides} 页，实际 ${slideCount} 页`,
    });
  }

  const summary = {
    path: pptxPath,
    parts: fileSet.size,
    slides: slideCount,
    errors: errors.length,
    warnings: warnings.length,
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary,
  };
}

export function formatValidationReport(result) {
  const lines = [];
  lines.push(result.ok ? '[pptx-validate] OK' : '[pptx-validate] FAILED');
  lines.push(`  slides=${result.summary.slides ?? '?'} parts=${result.summary.parts ?? '?'}`);
  for (const e of result.errors) {
    lines.push(`  ERROR ${e.code}${e.part ? ` (${e.part})` : ''}: ${e.message}`);
  }
  for (const w of result.warnings) {
    lines.push(`  WARN  ${w.code}${w.part ? ` (${w.part})` : ''}: ${w.message}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const strict = args.includes('--strict');
  const expectedArg = args.find((a) => a.startsWith('--expected-slides='));
  const expectedSlides = expectedArg ? Number(expectedArg.split('=')[1]) : undefined;
  const pptxPath = args.find((a) => !a.startsWith('--'));

  if (!pptxPath) {
    console.error('用法: node validate-pptx.mjs workspace/out/汇报.pptx [--expected-slides=10] [--json] [--strict]');
    process.exit(1);
  }

  const result = await validatePptx(pptxPath, { expectedSlides, strict });
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatValidationReport(result));
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
