import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { validatePptx } from '../validate-pptx.mjs';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, '../../../../../../');
const scriptsDir = resolve(repoRoot, 'agent-runtime/.pi/skills/pptx/scripts');
const assetsDir = resolve(repoRoot, 'agent-runtime/.pi/skills/pptx/assets');
const templatePptx = join(assetsDir, '商务工作汇报.pptx');
const wenyiPptx = join(assetsDir, '文艺风.pptx');
const imageJpg = resolve(repoRoot, 'mpportal/static/images/assets/banner-bg.jpg');

async function runScript(script, args) {
  return execFileAsync(process.execPath, [resolve(scriptsDir, script), ...args], {
    cwd: resolve(repoRoot, 'agent-runtime'),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function makeTempDir() {
  return mkdtemp(join(tmpdir(), 'imgec-pptx-test-'));
}

async function writeSpec(dir, spec, name = 'fill-spec.json') {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(spec, null, 2), 'utf8');
  return path;
}

async function copyTemplate(dir) {
  const path = join(dir, 'template.pptx');
  await copyFile(templatePptx, path);
  return path;
}

test('builtin template unpack, patch, compose, and pack roundtrip', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const source = await copyTemplate(dir);
  const work = join(dir, 'ppt-work');
  const outPath = join(dir, 'output.pptx');
  await runScript('unpack-pptx.mjs', [source, work]);
  const spec = await writeSpec(dir, {
    slides: [{
      sourceSlideIndex: 4,
      textPatches: [{ match: '添加标题文本', text: '测试标题替换' }],
      images: [{ index: 0, path: imageJpg }],
    }],
  });

  await runScript('apply-unpacked-patches.mjs', [work, spec]);
  await runScript('compose-slides-from-spec.mjs', [work, spec]);
  await runScript('validate-unpacked.mjs', [work, '--expected-slides=1']);
  await runScript('pack-pptx.mjs', [work, outPath]);

  const slideXml = await readFile(join(work, 'ppt/slides/slide1.xml'), 'utf8');
  assert.match(slideXml, /测试标题替换/);
  const mediaFiles = await readdir(join(work, 'ppt/media'));
  assert.ok(mediaFiles.some((name) => /\.jpe?g$/i.test(name)));

  const result = await validatePptx(outPath, { expectedSlides: 1 });
  assert.equal(result.ok, true);
});

test('textPatches rejects mappings without shapeIndex or match', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const source = await copyTemplate(dir);
  const work = join(dir, 'ppt-work');
  await runScript('unpack-pptx.mjs', [source, work]);
  const spec = await writeSpec(dir, {
    slides: [{
      sourceSlideIndex: 4,
      textPatches: [{ text: 'Should fail without a target' }],
    }],
  });

  await assert.rejects(
    runScript('apply-unpacked-patches.mjs', [work, spec]),
    /shapeIndex 或 match/,
  );
});

test('duplicate match textPatches fill successive slots on toc page', async (t) => {
  const dir = await makeTempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const source = join(dir, 'template.pptx');
  await copyFile(wenyiPptx, source);
  const work = join(dir, 'ppt-work');
  await runScript('unpack-pptx.mjs', [source, work]);
  const spec = await writeSpec(dir, {
    slides: [{
      sourceSlideIndex: 2,
      textPatches: [
        { match: '添加标题文本', text: '目录项一' },
        { match: '添加标题文本', text: '目录项二' },
        { match: '添加标题文本', text: '目录项三' },
        { match: '添加标题文本', text: '目录项四' },
      ],
    }],
  });

  await runScript('apply-unpacked-patches.mjs', [work, spec]);
  const slideXml = await readFile(join(work, 'ppt/slides/slide2.xml'), 'utf8');
  for (const text of ['目录项一', '目录项二', '目录项三', '目录项四']) {
    assert.match(slideXml, new RegExp(text));
  }
  assert.doesNotMatch(slideXml, /添加标题文本/);
});

test('inspect-template reads builtin template slide slots', async () => {
  const { stdout } = await runScript('inspect-template.mjs', [templatePptx, '--slide=4']);
  const slides = JSON.parse(stdout);
  assert.equal(slides.length, 1);
  assert.ok(slides[0].textSlots.some((slot) => slot.shapeIndex === 0));
  assert.equal(slides[0].pictureSlots[0].picIndex, 0);
});
