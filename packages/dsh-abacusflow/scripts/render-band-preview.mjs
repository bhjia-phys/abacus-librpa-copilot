#!/usr/bin/env node
/**
 * Render a real band chart to SVG/HTML so the axis ticks can be checked visually.
 *
 *   node scripts/render-band-preview.mjs <task-dir> <out-dir> <out.html> [--theme dark]
 *
 * <out-dir> is the ABACUS output folder name inside the task (e.g. OUT.NiO_DZP_bands).
 * This runs the *real* reader and mirrors the geometry and typography of BandChart in
 * lib/client.js (plot area, nice ticks, merged high-symmetry labels, one path per channel,
 * clipping at the window), so it shows what the panel draws — without a browser session or
 * React. For the panel itself, use scripts/screenshots.mjs.
 *
 * It exists because "the labels are in the payload" and "the labels appear on the axis" are
 * different claims, and only the second one matters.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readBands, compactBands } from '../lib/host/bands.js';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [taskDir, outDir, outHtml] = positional;
const dark = process.argv.includes('--dark') || process.argv.includes('--theme=dark') || process.argv.slice(2).join(' ').includes('--theme dark');
if (!taskDir || !outDir || !outHtml) {
  console.error('usage: node scripts/render-band-preview.mjs <task-dir> <out-dir> <out.html> [--theme dark]');
  process.exit(2);
}

const bands = compactBands(readBands(resolve(taskDir), { outDir }));
const channel = (bands.abacus || [])[0] ?? (bands.librpa || [])[0];
if (!channel) {
  console.error('no band channel found');
  process.exit(1);
}

const kpath = channel.kpath;
const energies = channel.energies;
const nBand = channel.nBand || (energies[0] ? energies[0].length : 0);
const kTicks = channel.kTicks || [];

// Same geometry as BandChart in lib/client.js (at a fixed 760-px container width).
const width = 760;
const height = 380;
const padL = 46;
const padR = 10;
const padT = 18;
const padB = 28;
const plotW = width - padL - padR;
const plotH = height - padT - padB;

const kMin = Math.min(...kpath);
const kMax = Math.max(...kpath);
const flat = energies.flat().filter((v) => Number.isFinite(v));
const lo = Number(process.env.E_MIN ?? Math.max(Math.min(...flat), -10));
const hi = Number(process.env.E_MAX ?? Math.min(Math.max(...flat), 10));
const span = hi - lo || 1;
const sx = (k) => padL + ((k - kMin) / (kMax - kMin || 1)) * plotW;
const sy = (e) => padT + (1 - (e - lo) / span) * plotH;

function niceStep(range, target) {
  const rough = Math.abs(range) / Math.max(1, target);
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-12))));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * magnitude >= rough) return m * magnitude;
  return 10 * magnitude;
}

let d = '';
const margin = span * 0.5;
for (let band = 0; band < nBand; band += 1) {
  let pen = false;
  for (let i = 0; i < energies.length && i < kpath.length; i += 1) {
    const e = energies[i][band];
    if (!Number.isFinite(e) || e < lo - margin || e > hi + margin) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${sx(kpath[i]).toFixed(1)},${sy(e).toFixed(1)}`;
    pen = true;
  }
}

const step = niceStep(span, Math.max(4, Math.round(plotH / 40)));
const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
const grid = [];
for (let e = Math.ceil(lo / step) * step; e <= hi + step * 1e-6; e += step) {
  grid.push(
    `<line class="grid" x1="${padL}" x2="${padL + plotW}" y1="${sy(e).toFixed(1)}" y2="${sy(e).toFixed(1)}"/>` +
      `<text x="${padL - 6}" y="${(sy(e) + 3.5).toFixed(1)}" text-anchor="end">${e.toFixed(digits)}</text>`,
  );
}

// High-symmetry labels as written in the KPT; labels closer than 18 px merge into "A|B".
const sorted = kTicks.filter((t) => Number.isFinite(t.position)).sort((a, b) => a.position - b.position);
const merged = [];
for (const t of sorted) {
  const x = sx(t.position);
  const last = merged[merged.length - 1];
  if (last && x - last.x < 18) {
    if (!last.labels.includes(t.label)) last.labels.push(t.label);
  } else merged.push({ x, labels: [t.label] });
}
const tickLines = sorted.map((t) => `<line class="kline" x1="${sx(t.position).toFixed(1)}" x2="${sx(t.position).toFixed(1)}" y1="${padT}" y2="${padT + plotH}"/>`).join('\n');
const tickLabels = merged.map((m) => `<text class="ticklabel" x="${m.x.toFixed(1)}" y="${padT + plotH + 17}" text-anchor="middle">${m.labels.join('|')}</text>`).join('\n');

const c = dark
  ? { bg: '#151517', fill: 'rgba(249,250,251,.04)', grid: 'rgba(255,255,255,.06)', kline: 'rgba(255,255,255,.12)', text: '#adb2b8', strong: '#f9fafb', line: 'rgba(249,250,251,.72)' }
  : { bg: '#ffffff', fill: 'rgba(15,17,21,.04)', grid: 'rgba(0,0,0,.04)', kline: 'rgba(0,0,0,.1)', text: '#81858c', strong: '#0f1115', line: 'rgba(15,17,21,.72)' };

const html = `<!doctype html><meta charset="utf-8">
<style>
body { margin: 0; background: ${c.bg}; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
.wrap { padding: 16px; }
.chart { width: ${width}px; display: block; }
.chart text { font: 400 11px ui-monospace, Consolas, monospace; fill: ${c.text}; }
.chart .title { font: 500 11px -apple-system, "Segoe UI", sans-serif; fill: ${c.text}; }
.chart .ticklabel { font: 600 12px -apple-system, "Segoe UI", sans-serif; fill: ${c.strong}; }
.chart .grid { stroke: ${c.grid}; }
.chart .kline { stroke: ${c.kline}; stroke-dasharray: 2 3; }
.cap { font: 12px ui-monospace, Consolas, monospace; color: ${c.text}; margin-top: 6px; }
</style>
<div class="wrap">
<svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<defs><clipPath id="plot"><rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}"/></clipPath></defs>
<rect x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" rx="4" fill="${c.fill}"/>
${grid.join('\n')}
<text class="title" x="${padL - 6}" y="11" text-anchor="end">E / eV</text>
${tickLines}
${tickLabels}
<g clip-path="url(#plot)"><path d="${d}" fill="none" stroke="${c.line}" stroke-width="1.1" stroke-linejoin="round"/></g>
</svg>
<div class="cap">${channel.file} · ${channel.nKpoint} k 点 · ${nBand} 条能带 · 刻度 ${kTicks.length} 个 · 窗口 ${lo}…${hi} eV</div>
</div>
`;

writeFileSync(resolve(outHtml), html, 'utf8');
console.log(`wrote ${outHtml}`);
console.log(`ticks: ${kTicks.map((t) => t.label).join(' ')}`);
