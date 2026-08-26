// 从 spec 文件或 stdin 读 JSON，生成 .docx。
// 用法: node generate-docx.mjs workspace/out/方案.docx workspace/tmp/doc-fill-spec.json
// paragraphs[] 支持: string | bullet | image | caption | quote | callout | table | { text/runs }
import {
  Document, Packer, Paragraph, TextRun, LineRuleType,
  AlignmentType, Header, Footer, PageNumber,
  Table, TableRow, TableCell, WidthType, BorderStyle,
  VerticalAlign, ShadingType, ImageRun
} from 'docx';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, extname } from 'node:path';

async function fetchImageBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const ab = await resp.arrayBuffer();
  return Buffer.from(ab);
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const GRID_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
const STRONG_BORDER = { style: BorderStyle.SINGLE, size: 6, color: '000000' };

function alignOf(v, fallback = AlignmentType.JUSTIFIED) {
  if (v === 'center') return AlignmentType.CENTER;
  if (v === 'right') return AlignmentType.RIGHT;
  if (v === 'left') return AlignmentType.LEFT;
  return fallback;
}

function cellText(cell) {
  if (cell == null) return '';
  if (typeof cell === 'string' || typeof cell === 'number') return String(cell);
  if (cell.text != null) return String(cell.text);
  if (Array.isArray(cell.runs)) return cell.runs.map((r) => r.text || '').join('');
  return '';
}

function itemTextLen(p) {
  if (typeof p === 'string') return p.length;
  if (p?.type === 'bullet' || p?.type === 'image' || p?.type === 'caption' || p?.type === 'quote' || p?.type === 'callout') {
    return (p.text?.length || 10);
  }
  if (p?.type === 'table') {
    let n = (p.caption?.length || 0);
    for (const row of p.rows || []) {
      for (const c of row) n += cellText(c).length;
    }
    for (const h of p.headers || []) n += cellText(h).length;
    return n || 20;
  }
  if (p?.text) return p.text.length;
  if (Array.isArray(p?.runs)) return p.runs.reduce((s, r) => s + (r.text?.length || 0), 0);
  return 0;
}

function flattenSections(sections) {
  const out = [];
  for (const section of sections || []) {
    out.push({ heading: section.heading, level: section.level, paragraphs: [] });
    const target = out[out.length - 1];
    for (const p of section.paragraphs || []) {
      if (p && typeof p === 'object' && p.heading && Array.isArray(p.paragraphs)) {
        out.push({ heading: p.heading, level: p.level || 2, paragraphs: p.paragraphs });
      } else {
        target.paragraphs.push(p);
      }
    }
    if (!section.heading && target.paragraphs.length === 0) out.pop();
  }
  return out;
}

function validateSpec(spec) {
  const errors = [];
  const sections = spec.sections || [];
  if (!spec.title) errors.push('缺少 title');
  if (sections.length === 0) errors.push('sections 为空');

  let bodyCount = 0;
  for (const [i, section] of sections.entries()) {
    for (const p of section.paragraphs || []) {
      if (p && typeof p === 'object' && p.heading && Array.isArray(p.paragraphs)) {
        errors.push(`sections[${i}] 的 paragraphs 内嵌套了子章节「${p.heading}」——须改为扁平 sections（见 SKILL §3.2）`);
      }
      if (p?.type === 'table') {
        const rows = p.rows || [];
        const headers = p.headers || [];
        if (headers.length === 0 && rows.length === 0) {
          errors.push(`表格「${p.caption || '(无标题)'}」缺少 headers/rows`);
        }
        if (rows.some((r) => !Array.isArray(r) || r.length === 0)) {
          errors.push(`表格「${p.caption || '(无标题)'}」存在空行`);
        }
      }
    }
    const paras = section.paragraphs || [];
    const textLen = paras.reduce((n, p) => n + itemTextLen(p), 0);
    if (section.heading && textLen < 20 && !paras.some((p) => p?.type === 'table')) {
      errors.push(`章节「${section.heading}」正文过短（${textLen} 字），疑似骨架/占位`);
    }
    bodyCount += textLen;
  }
  if (bodyCount < 500) {
    errors.push(`全文有效正文不足 500 字（当前约 ${bodyCount} 字），禁止交付骨架文档`);
  }
  return errors;
}

function textRunsFromCell(cell, defaults = {}) {
  if (typeof cell === 'string' || typeof cell === 'number') {
    return [new TextRun({
      text: String(cell),
      size: defaults.size || 22,
      bold: defaults.bold || false,
      font: { name: defaults.font || '宋体' }
    })];
  }
  if (Array.isArray(cell?.runs)) {
    return cell.runs.map((r) => new TextRun({
      text: r.text || '',
      bold: r.bold || false,
      italic: r.italic || false,
      size: r.size || defaults.size || 22,
      color: r.color || '000000',
      font: { name: r.font || defaults.font || '宋体' }
    }));
  }
  return [new TextRun({
    text: cell.text || '',
    size: cell.size || defaults.size || 22,
    bold: cell.bold ?? defaults.bold ?? false,
    font: { name: cell.font || defaults.font || '宋体' }
  })];
}

function captionParagraph(text, position = 'above') {
  return new Paragraph({
    children: [new TextRun({
      text,
      size: 21,
      bold: true,
      font: { name: '黑体' }
    })],
    alignment: AlignmentType.CENTER,
    spacing: {
      before: position === 'below' ? 120 : 200,
      after: position === 'above' ? 80 : 200
    }
  });
}

function tableCellBorders(style, role) {
  // role: header | body | lastRow
  if (style === 'grid') {
    return { top: GRID_BORDER, bottom: GRID_BORDER, left: GRID_BORDER, right: GRID_BORDER };
  }
  if (style === 'plain') {
    if (role === 'header') return { top: STRONG_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };
    if (role === 'lastRow') return { top: NO_BORDER, bottom: STRONG_BORDER, left: NO_BORDER, right: NO_BORDER };
    return { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };
  }
  // threeLine（默认）：三线表
  if (role === 'header') {
    return { top: STRONG_BORDER, bottom: STRONG_BORDER, left: NO_BORDER, right: NO_BORDER };
  }
  if (role === 'lastRow') {
    return { top: NO_BORDER, bottom: STRONG_BORDER, left: NO_BORDER, right: NO_BORDER };
  }
  return { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };
}

function buildTableRows(headers, rows, style, columnWidths) {
  const colCount = headers.length || (rows[0]?.length || 1);
  const widths = columnWidths?.length === colCount
    ? columnWidths
    : Array.from({ length: colCount }, () => Math.floor(100 / colCount));

  const mkCell = (cell, colIndex, rowRole, isHeader) => new TableCell({
    children: [new Paragraph({
      children: textRunsFromCell(cell, { bold: isHeader, size: 22 }),
      alignment: alignOf(typeof cell === 'object' ? cell.alignment : undefined, AlignmentType.CENTER)
    })],
    verticalAlign: VerticalAlign.CENTER,
    width: { size: widths[colIndex], type: WidthType.PERCENTAGE },
    borders: tableCellBorders(style, rowRole),
    shading: isHeader && style !== 'plain'
      ? { fill: 'E8EEF4', type: ShadingType.CLEAR }
      : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 }
  });

  const tableRows = [];
  if (headers.length) {
    tableRows.push(new TableRow({
      children: headers.map((h, i) => mkCell(h, i, 'header', true))
    }));
  }
  rows.forEach((row, ri) => {
    const isLast = ri === rows.length - 1;
    tableRows.push(new TableRow({
      children: row.map((c, i) => mkCell(c, i, isLast ? 'lastRow' : 'body', false))
    }));
  });
  return tableRows;
}

function tableFromItem(p) {
  const style = p.style || 'threeLine';
  let headers = (p.headers || []).map(cellText);
  let rows = (p.rows || []).map((row) => row.map((c) => c));

  if (!headers.length && p.headerRow && rows.length) {
    headers = rows[0].map(cellText);
    rows = rows.slice(1);
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: buildTableRows(headers, rows, style, p.columnWidths)
  });
}

async function paragraphFromItem(p, lineSpacing) {
  if (typeof p === 'string') {
    return new Paragraph({
      children: [new TextRun({ text: p, size: 24, font: { name: '宋体' } })],
      alignment: AlignmentType.JUSTIFIED,
      indent: { firstLine: 480 },
      spacing: { after: 120, line: lineSpacing, lineRule: LineRuleType.AUTO }
    });
  }
  if (p.type === 'bullet') {
    return new Paragraph({
      children: [new TextRun({
        text: p.text,
        size: p.size || 24,
        bold: p.bold || false,
        color: p.color || '000000',
        font: { name: '宋体' }
      })],
      bullet: { level: p.level || 0 },
      spacing: { after: 60, line: 360, lineRule: LineRuleType.AUTO }
    });
  }
  if (p.type === 'caption') {
    return captionParagraph(p.text, p.position || 'below');
  }
  if (p.type === 'image') {
    const children = [];
    if (p.src) {
      try {
        const imgBuf = await fetchImageBuffer(p.src);
        const ext = extname(new URL(p.src).pathname).toLowerCase() || '.png';
        const imgType = ext === '.jpg' || ext === '.jpeg' ? 'jpg' : ext === '.gif' ? 'gif' : ext === '.svg' ? 'svg' : 'png';
        const imgRun = new ImageRun({
          data: imgBuf,
          transformation: { width: p.width || 520, height: p.height || 340 },
          type: imgType
        });
        children.push(imgRun);
      } catch (e) {
        console.warn(`[docx] image fetch failed for ${p.src}: ${e.message}, falling back to text`);
        children.push(new TextRun({
          text: p.text || '[图片加载失败]',
          italics: true, size: 22, color: '999999', font: { name: '宋体' }
        }));
      }
    } else {
      children.push(new TextRun({
        text: p.text || '[效果图]',
        italics: true, size: 22, color: '999999', font: { name: '宋体' }
      }));
    }
    return new Paragraph({
      children,
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: p.caption ? 80 : 200 }
    });
  }
  if (p.type === 'quote') {
    return new Paragraph({
      children: [new TextRun({
        text: p.text,
        size: p.size || 24,
        italics: true,
        color: p.color || '555555',
        font: { name: '楷体' }
      })],
      indent: { left: 720, right: 720 },
      border: { left: { style: BorderStyle.SINGLE, size: 12, color: '1F4E79', space: 8 } },
      spacing: { before: 120, after: 120, line: lineSpacing, lineRule: LineRuleType.AUTO }
    });
  }
  if (p.type === 'callout') {
    return new Paragraph({
      children: [new TextRun({
        text: p.text,
        size: p.size || 24,
        bold: p.bold || false,
        font: { name: '宋体' }
      })],
      shading: { fill: p.fill || 'F5F7FA', type: ShadingType.CLEAR },
      indent: { left: 240, right: 240 },
      spacing: { before: 120, after: 120, line: lineSpacing, lineRule: LineRuleType.AUTO }
    });
  }

  const runs = [];
  if (Array.isArray(p.runs)) {
    for (const r of p.runs) {
      runs.push(new TextRun({
        text: r.text || '',
        bold: r.bold || false,
        italic: r.italic || false,
        size: r.size || 24,
        color: r.color || '000000',
        font: { name: r.font || '宋体' }
      }));
    }
  } else {
    runs.push(new TextRun({
      text: p.text || '',
      bold: p.bold || false,
      size: p.size || 24,
      color: p.color || '000000',
      font: { name: '宋体' }
    }));
  }
  return new Paragraph({
    children: runs,
    alignment: alignOf(p.alignment),
    indent: p.noIndent ? undefined : { firstLine: 480 },
    spacing: { after: p.after || 120, line: p.lineSpacing || lineSpacing, lineRule: LineRuleType.AUTO }
  });
}

async function blocksFromItem(p, lineSpacing) {
  if (p?.type === 'table') {
    const blocks = [];
    if (p.caption) blocks.push(captionParagraph(p.caption, 'above'));
    blocks.push(tableFromItem(p));
    return blocks;
  }
  if (p?.type === 'image' && p.caption) {
    return [
      await paragraphFromItem({ ...p, caption: undefined }, lineSpacing),
      captionParagraph(p.caption, 'below')
    ];
  }
  return [await paragraphFromItem(p, lineSpacing)];
}

async function toDocumentChildren(item, lineSpacing) {
  const out = [];

  if (item.title) {
    out.push(new Paragraph({
      children: [new TextRun({ text: item.title, bold: true, size: 44, font: { name: '黑体' } })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 600, after: 200, line: 480, lineRule: LineRuleType.AUTO }
    }));
  }
  if (item.subtitle) {
    out.push(new Paragraph({
      children: [new TextRun({ text: item.subtitle, size: 28, color: '666666', font: { name: '宋体' } })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 600, line: 360, lineRule: LineRuleType.AUTO }
    }));
  }

  for (const section of flattenSections(item.sections)) {
    if (section.heading) {
      const level = section.level || 1;
      const [hSize, hBefore, hAfter] = level === 1 ? [32, 360, 200] : level === 2 ? [28, 240, 120] : [24, 200, 100];
      out.push(new Paragraph({
        children: [new TextRun({ text: section.heading, bold: true, size: hSize, font: { name: '黑体' } })],
        spacing: { before: hBefore, after: hAfter, line: 400, lineRule: LineRuleType.AUTO }
      }));
    }
    for (const p of section.paragraphs || []) {
      out.push(...await blocksFromItem(p, lineSpacing));
    }
  }

  return out;
}

function buildHeaderFooter(spec) {
  const headers = {};
  const footers = {};

  if (spec.header?.text) {
    headers.default = new Header({
      children: [new Paragraph({
        children: [new TextRun({
          text: spec.header.text,
          size: spec.header.size || 18,
          color: spec.header.color || '666666',
          font: { name: spec.header.font || '宋体' }
        })],
        alignment: alignOf(spec.header.alignment, AlignmentType.CENTER),
        spacing: { after: 120 }
      })]
    });
  }

  if (spec.footer?.text || spec.footer?.pageNumber) {
    const runs = [];
    if (spec.footer.text) {
      runs.push(new TextRun({
        text: spec.footer.text,
        size: spec.footer.size || 18,
        color: spec.footer.color || '666666',
        font: { name: spec.footer.font || '宋体' }
      }));
    }
    if (spec.footer.pageNumber) {
      if (runs.length) runs.push(new TextRun({ text: '  ' }));
      runs.push(new TextRun({ text: '第 ', size: 18, font: { name: '宋体' } }));
      runs.push(new TextRun({ children: [PageNumber.CURRENT], size: 18, font: { name: '宋体' } }));
      runs.push(new TextRun({ text: ' 页', size: 18, font: { name: '宋体' } }));
    }
    footers.default = new Footer({
      children: [new Paragraph({
        children: runs,
        alignment: alignOf(spec.footer.alignment, AlignmentType.CENTER)
      })]
    });
  }

  return {
    headers: Object.keys(headers).length ? headers : undefined,
    footers: Object.keys(footers).length ? footers : undefined
  };
}

function readSpec(specPath) {
  if (specPath && existsSync(specPath)) return readFileSync(specPath, 'utf8');
  return null;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

async function main() {
  const outPath = process.argv[2];
  const specPath = process.argv[3];
  if (!outPath) {
    console.error('用法: node generate-docx.mjs <输出路径.docx> [spec.json]');
    process.exit(1);
  }
  const raw = readSpec(specPath) ?? await readStdin();
  const spec = JSON.parse(raw || '{}');

  const validationErrors = validateSpec(spec);
  if (validationErrors.length) {
    console.error('[docx-validate] FAILED');
    for (const e of validationErrors) console.error('  ERROR:', e);
    process.exit(1);
  }

  const lineSpacing = spec.lineSpacing || 360;
  const children = await toDocumentChildren(spec, lineSpacing);
  const { headers, footers } = buildHeaderFooter(spec);

  const doc = new Document({
    creator: 'ArcAI 设计协作助手',
    title: spec.title || '方案设计',
    description: spec.description || '',
    styles: {
      default: {
        document: {
          run: { font: { name: '宋体' }, size: 24 }
        }
      }
    },
    sections: [{
      properties: {
        page: {
          margin: { top: 1440, bottom: 1440, left: 1800, right: 1800 },
          size: { width: 11906, height: 16838 }
        }
      },
      headers,
      footers,
      children
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, buffer);
  console.log('ARC_AI_ARTIFACT_PATH: ' + outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
