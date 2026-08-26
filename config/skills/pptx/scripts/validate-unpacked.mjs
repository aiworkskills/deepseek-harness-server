// 打包前校验解压目录：XML 合法性、文本损坏、rels 引用、页数一致
// CLI: node validate-unpacked.mjs <pptJobDir>/ppt-work [--json]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { join, relative, sep } = path;
import { assertWellFormedXml } from './validate-pptx.mjs';

const XML_PART = /\.(xml|rels)$/i;

function walkFiles(dir, base, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkFiles(p, base, out);
    else out.push({ abs: p, rel: relative(base, p).split(sep).join('/') });
  }
  return out;
}

function resolveRelTarget(baseRelsPath, target) {
  if (!target || target.startsWith('http')) return null;
  if (target.startsWith('/')) return target.slice(1);
  if (baseRelsPath === '_rels/.rels') return target.replace(/^\.\//, '');
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

function listSlideParts(fileSet) {
  return [...fileSet]
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
}

function checkSlideTextContent(slidePart, xml, errors, warnings) {
  for (const m of xml.matchAll(/<a:t\b([^>]*)>([\s\S]*?)<\/a:t>/gi)) {
    const text = m[2];
    // 补丁写坏时会把 XML 标签串进文本框
    if (/<\/a:t>|<a:t\b|<p:sp\b|<\/a:r>/i.test(text)) {
      errors.push({
        code: 'TEXT_XML_FRAGMENT',
        part: slidePart,
        message: `文本框含 XML 碎片 — 检查 textPatches / apply-unpacked-patches.mjs`,
      });
      continue;
    }
    const decoded = text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');
    if (/^\?{4,}$/.test(decoded.trim())) {
      errors.push({
        code: 'TEXT_ENCODING_CORRUPT',
        part: slidePart,
        message: `疑似中文编码损坏（连续问号）: "${decoded.slice(0, 30)}" — spec 须 UTF-8 文件路径，禁止 Get-Content 管道`,
      });
    }
  }
}

/**
 * @param {string} dir
 * @param {{ expectedSlides?: number }} [options]
 */
export async function validateUnpacked(dir, options = {}) {
  /** @type {{ code: string, part?: string, message: string }[]} */
  const errors = [];
  /** @type {{ code: string, part?: string, message: string }[]} */
  const warnings = [];

  if (!dir || !existsSync(dir)) {
    return {
      ok: false,
      errors: [{ code: 'DIR_MISSING', message: `目录不存在: ${dir}` }],
      warnings,
      summary: {},
    };
  }

  const files = walkFiles(dir, dir);
  const fileSet = new Set(files.map((f) => f.rel));
  const parts = {};

  for (const req of ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml']) {
    if (!fileSet.has(req)) {
      errors.push({ code: 'REQUIRED_PART_MISSING', part: req, message: `缺少必需文件: ${req}` });
    }
  }

  for (const { rel, abs } of files) {
    if (!XML_PART.test(rel)) continue;
    try {
      parts[rel] = readFileSync(abs, 'utf8');
      assertWellFormedXml(parts[rel], rel);
    } catch (e) {
      errors.push({ code: 'XML_MALFORMED', part: rel, message: e.message });
    }
  }

  const slideParts = listSlideParts(fileSet);
  for (const sp of slideParts) {
    const xml = parts[sp];
    if (xml) checkSlideTextContent(sp, xml, errors, warnings);
  }

  const presRelsPath = 'ppt/_rels/presentation.xml.rels';
  const presPath = 'ppt/presentation.xml';
  if (parts[presPath] && parts[presRelsPath]) {
    const sldIdCount = (parts[presPath].match(/<p:sldId\b/gi) || []).length;
    if (sldIdCount !== slideParts.length) {
      errors.push({
        code: 'SLIDE_COUNT_MISMATCH',
        part: presPath,
        message: `presentation 登记 ${sldIdCount} 页，实际 slide 文件 ${slideParts.length} 个`,
      });
    }
    const slideRelTargets = [...parts[presRelsPath].matchAll(/Type="[^"]*\/slide"[^>]*Target="([^"]+)"/gi)]
      .map((m) => m[1].replace(/^\.\.\//, ''));
    for (const target of slideRelTargets) {
      const part = target.startsWith('slides/') ? `ppt/${target}` : target;
      if (!fileSet.has(part)) {
        errors.push({
          code: 'PRES_SLIDE_MISSING',
          part: presRelsPath,
          message: `presentation 引用不存在的 slide: ${target}`,
        });
      }
    }
  }

  for (const relPath of [...fileSet].filter((f) => f.endsWith('.rels'))) {
    const xml = parts[relPath];
    if (!xml) continue;
    for (const m of xml.matchAll(/Target="([^"]+)"/g)) {
      const resolved = resolveRelTarget(relPath, m[1]);
      if (!resolved || resolved.startsWith('http')) continue;
      if (!fileSet.has(resolved)) {
        errors.push({
          code: 'RELS_TARGET_MISSING',
          part: relPath,
          message: `rels 指向缺失文件: ${m[1]} → ${resolved}`,
        });
      }
    }
  }

  const ct = parts['[Content_Types].xml'];
  if (ct) {
    for (const sp of slideParts) {
      const partName = `/${sp}`;
      if (!ct.includes(`PartName="${partName}"`)) {
        warnings.push({
          code: 'CONTENT_TYPES_SLIDE',
          part: sp,
          message: `[Content_Types].xml 未登记 ${partName}`,
        });
      }
    }
  }

  if (options.expectedSlides != null && slideParts.length !== options.expectedSlides) {
    errors.push({
      code: 'EXPECTED_SLIDES',
      message: `期望 ${options.expectedSlides} 页，目录内 ${slideParts.length} 个 slide 文件`,
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      dir,
      parts: fileSet.size,
      slides: slideParts.length,
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}

export function formatUnpackedReport(result) {
  const lines = [];
  lines.push(result.ok ? '[pptx-unpacked-validate] OK' : '[pptx-unpacked-validate] FAILED');
  lines.push(`  slides=${result.summary.slides ?? '?'} parts=${result.summary.parts ?? '?'}`);
  for (const e of result.errors) {
    lines.push(`  ERROR ${e.code}${e.part ? ` (${e.part})` : ''}: ${e.message}`);
  }
  for (const w of result.warnings) {
    lines.push(`  WARN  ${w.code}${w.part ? ` (${w.part})` : ''}: ${w.message}`);
  }
  if (!result.ok) {
    lines.push('  → 请修正 slide XML / spec 后重跑 apply-unpacked-patches，再 pack');
  }
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const expectedArg = args.find((a) => a.startsWith('--expected-slides='));
  const expectedSlides = expectedArg ? Number(expectedArg.split('=')[1]) : undefined;
  const dir = args.find((a) => !a.startsWith('--'));

  if (!dir) {
    console.error('用法: node validate-unpacked.mjs <解压目录> [--expected-slides=N] [--json]');
    process.exit(1);
  }

  const result = await validateUnpacked(dir, { expectedSlides });
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatUnpackedReport(result));
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
