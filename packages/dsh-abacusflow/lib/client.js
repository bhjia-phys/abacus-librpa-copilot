/* global window, document, localStorage, fetch, ResizeObserver, console, navigator, HTMLTextAreaElement, Event */
/**
 * dsh-abacusflow — browser half.
 *
 * Dialect: the DSH 0.2 client module loader. The shell evaluates this file as a script
 * whose only dependency is `require('react')`; there is no antd, no three.js, no recharts
 * in the profile, so every chart is hand-written SVG and the structure viewer is a
 * hand-written canvas 2D projection. That constraint is what keeps the plugin installable
 * with zero npm packages.
 *
 * Information architecture (UI.md at the repository root is the design of record):
 *
 *   places     运行 · k 收敛研究 · 对比篮 · 数据库
 *   run page   header → pipeline (ABACUS producers ──▶ LibRPA consumers) → 结果 | 阶段
 *   agent dock pinned under the scroller; it only ever composes a message for the agent
 *
 * Mount points (see the AITP plugin for the same pattern on this DSH build):
 *   sidebar.panellist        the sidebar icon
 *   main                     the full page
 *   sidebar.right.pane.tab   the right dock (needs the sidebarRightTabs service)
 *
 * Host data service: /abacusflow/api/{ping,scan,task-bundle,bands,file,file-size,
 * library/search,library/match,kstudy,kcompare,research-context}
 */
window.__ModuleLoader__.load({
  id: '@local/abacusflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    const PANEL_KEY = 'abacusflow';
    const API = '/abacusflow/api';
    const ROOT_STORAGE_KEY = 'abacusflow:root';
    const UI_STORAGE_KEY = 'abacusflow:ui';

    /**
     * The plugin's Cordis context, captured in `apply`.
     *
     * PanelRoot reads `ctx.get('sessions')` through this to post questions into the live
     * session. Module-level rather than prop-threaded because panes are mounted by the shell
     * at several slots and none of them receive the context.
     */
    let pluginContext = null;

    // =====================================================================
    // styles
    // =====================================================================
    //
    // Tokens are declared on `.af-root`, not `:root`. DSH defines its `--dsw-alias-*` tokens
    // on `body` (and `body[data-ds-dark-theme]`), so an alias declared on `:root` resolves
    // where those tokens do not exist yet and silently falls back to the hard-coded value.
    // Declared on the panel root, every alias picks up the live theme in light and dark.
    //
    // Dark mode is DSH's own switch: the theme service resolves light/dark/system and sets
    // `body[data-ds-dark-theme]`. A `prefers-color-scheme` media query would fight a user who
    // picked "light" on a dark OS, so the fallbacks below follow the same attribute.
    //
    // Scales (UI.md §7): type 16 / 13 / 12 / 11 px; spacing 4 / 8 / 12 / 16 / 24 / 32 px;
    // radius 6 / 8 / 12 px.

    const CSS = `
      .af-root {
        --af-bg: var(--dsw-alias-bg-base, #ffffff);
        --af-surface: var(--dsw-alias-bg-layer-1, #ffffff);
        --af-fg: var(--dsw-alias-label-primary, #0f1115);
        --af-fg-2: var(--dsw-alias-label-secondary, #61666b);
        --af-fg-3: var(--dsw-alias-label-tertiary, #81858c);
        --af-line-soft: var(--dsw-alias-border-l1, rgba(0, 0, 0, .04));
        --af-line: var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));
        --af-line-strong: var(--dsw-alias-border-l3, rgba(0, 0, 0, .12));
        --af-hover: var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, .06));
        --af-pressed: var(--dsw-alias-interactive-bg-active, rgba(38, 49, 72, .1));
        --af-accent: var(--dsw-alias-state-business-primary, #4176e6);
        --af-primary: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #0f1115));
        --af-on-primary: var(--dsw-alias-label-primary-foreground, #ffffff);
        --af-ok: var(--dsw-alias-state-success-primary, #22c55e);
        --af-warn: var(--dsw-alias-state-warn-primary, #f59e0b);
        --af-warn-text: var(--dsw-alias-state-warn-label, #dd8629);
        --af-err: var(--dsw-alias-state-error-primary, #ec1313);

        /* derived: every value below follows the live theme because its inputs do */
        --af-fill: color-mix(in srgb, var(--af-fg) 4%, transparent);
        --af-fill-2: color-mix(in srgb, var(--af-fg) 8%, transparent);
        --af-accent-soft: color-mix(in srgb, var(--af-accent) 12%, transparent);
        --af-ok-soft: color-mix(in srgb, var(--af-ok) 13%, transparent);
        --af-warn-soft: color-mix(in srgb, var(--af-warn) 15%, transparent);
        --af-err-soft: color-mix(in srgb, var(--af-err) 11%, transparent);
        --af-run: var(--af-accent);
        --af-idle: var(--af-fg-3);

        /* producers: ink for ABACUS, accent for LibRPA, a blue-green mix for the database */
        --af-abacus: var(--af-fg-2);
        --af-librpa: var(--af-accent);
        --af-db: color-mix(in srgb, var(--af-accent) 45%, var(--af-ok));

        /* chart series (band kinds); spin 2 and k-mesh series are mixed from these */
        --af-c-abacus: color-mix(in srgb, var(--af-fg) 72%, transparent);
        --af-c-ks: color-mix(in srgb, var(--af-accent) 55%, var(--af-bg));
        --af-c-exx: color-mix(in srgb, var(--af-accent) 50%, var(--af-err));
        --af-c-qsgw: var(--af-accent);

        --af-font: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
        --af-mono: var(--ds-font-family-code, var(--dsh-font-family-code-default, ui-monospace, "SF Mono", "JetBrains Mono", Consolas, monospace));
        --af-t-title: 600 16px/24px var(--af-font);
        --af-t-section: 600 13px/20px var(--af-font);
        --af-t-body: 400 13px/20px var(--af-font);
        --af-t-caption: 400 12px/18px var(--af-font);
        --af-t-micro: 500 11px/14px var(--af-font);
        --af-t-num: 400 12px/18px var(--af-mono);

        --af-s1: 4px;
        --af-s2: 8px;
        --af-s3: 12px;
        --af-s4: 16px;
        --af-s5: 24px;
        --af-s6: 32px;
        --af-r1: 6px;
        --af-r2: var(--dsw-radius-sm, 8px);
        --af-r3: var(--dsw-radius-md, 12px);

        display: flex; flex-direction: column; height: 100%; min-height: 0; position: relative;
        background: var(--af-bg); color: var(--af-fg); font: var(--af-t-body);
        -webkit-font-smoothing: antialiased;
      }
      body[data-ds-dark-theme] .af-root {
        --af-bg: var(--dsw-alias-bg-base, #151517);
        --af-surface: var(--dsw-alias-bg-layer-1, #232324);
        --af-fg: var(--dsw-alias-label-primary, #f9fafb);
        --af-fg-2: var(--dsw-alias-label-secondary, #cfd3d6);
        --af-fg-3: var(--dsw-alias-label-tertiary, #adb2b8);
        --af-line-soft: var(--dsw-alias-border-l1, rgba(255, 255, 255, .06));
        --af-line: var(--dsw-alias-border-l2, rgba(255, 255, 255, .12));
        --af-line-strong: var(--dsw-alias-border-l3, rgba(255, 255, 255, .16));
        --af-hover: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .08));
        --af-pressed: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, .14));
        --af-accent: var(--dsw-alias-state-business-primary, #7aaaff);
        --af-primary: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #f9fafb));
        --af-on-primary: var(--dsw-alias-label-primary-foreground, #0f1115);
        --af-err: var(--dsw-alias-state-error-primary, #f25a5a);
      }
      .af-root *, .af-root *::before, .af-root *::after { box-sizing: border-box; }
      /* Zero-specificity reset: any component class (e.g. .af-btn-primary) must win over it. */
      :where(.af-root) :where(button, input, select, textarea) { font: inherit; color: inherit; }
      .af-root :focus-visible { outline: 2px solid var(--af-accent); outline-offset: 1px; }

      /* ---- toolbar: places on one row, the scan path on its own full-width row ---- */
      .af-toolbar {
        display: flex; flex-wrap: wrap; align-items: center; gap: var(--af-s2);
        padding: var(--af-s2) var(--af-s3); border-bottom: 1px solid var(--af-line-soft); flex: none;
      }
      .af-toolbar-title {
        display: inline-flex; align-items: center; gap: 6px; font: var(--af-t-section); white-space: nowrap;
        margin-right: var(--af-s2);
      }
      .af-toolbar-row { display: flex; align-items: center; gap: var(--af-s2); flex: 1 1 100%; min-width: 0; }
      .af-input {
        flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 var(--af-s2);
        border: 1px solid var(--af-line); border-radius: var(--af-r1);
        background: var(--af-bg); color: var(--af-fg); font: var(--af-t-num);
      }
      .af-input:focus { outline: none; border-color: var(--af-accent); box-shadow: 0 0 0 2px var(--af-accent-soft); }
      .af-input::placeholder { color: var(--af-fg-3); }
      .af-input-text { font: var(--af-t-body); }
      .af-input-num { flex: none; width: 76px; text-align: right; }
      .af-select {
        height: 24px; padding: 0 var(--af-s1); border: 1px solid var(--af-line); border-radius: var(--af-r1);
        background: var(--af-bg); color: var(--af-fg); font: var(--af-t-caption); max-width: 100%;
      }

      /* ---- buttons ---- */
      .af-btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px; flex: none;
        height: 28px; padding: 0 var(--af-s3); border: 1px solid var(--af-line); border-radius: var(--af-r1);
        background: var(--af-bg); color: var(--af-fg); font: var(--af-t-body); white-space: nowrap; cursor: pointer;
      }
      .af-btn:hover { background: var(--af-hover); }
      .af-btn:active { background: var(--af-pressed); }
      .af-btn:disabled { opacity: .45; cursor: default; background: var(--af-bg); }
      .af-btn-primary { background: var(--af-primary); border-color: var(--af-primary); color: var(--af-on-primary); }
      .af-btn-primary:hover, .af-btn-primary:active { background: var(--af-primary); opacity: .86; }
      .af-btn-primary:disabled { background: var(--af-primary); }
      .af-btn-ghost { border-color: transparent; background: transparent; color: var(--af-fg-2); }
      .af-btn-ghost:hover { color: var(--af-fg); }
      .af-btn-sm { height: 24px; padding: 0 var(--af-s2); font: var(--af-t-caption); gap: 4px; }
      .af-btn-icon { width: 28px; padding: 0; }
      .af-btn-icon.af-btn-sm { width: 24px; }
      .af-btn svg { flex: none; }

      /* ---- tab rows (places, run views, stage tabs): one scrollable row, never wraps ---- */
      .af-tabs {
        display: flex; align-items: center; gap: 2px; min-width: 0; flex: 0 1 auto;
        overflow-x: auto; scrollbar-width: none;
      }
      .af-tabs::-webkit-scrollbar { display: none; }
      .af-tab {
        display: inline-flex; align-items: center; gap: 6px; flex: none; height: 28px; padding: 0 var(--af-s3);
        border: 0; border-radius: var(--af-r1); background: none; color: var(--af-fg-2);
        font: var(--af-t-body); white-space: nowrap; cursor: pointer;
      }
      .af-tab:hover { background: var(--af-hover); color: var(--af-fg); }
      .af-tab[data-active] { background: var(--af-fill-2); color: var(--af-fg); font-weight: 600; }
      .af-tab-count {
        min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px; text-align: center;
        background: var(--af-accent); color: var(--af-on-primary); font: var(--af-t-micro); line-height: 16px;
      }
      body[data-ds-dark-theme] .af-tab-count { color: var(--af-bg); }

      /* ---- segmented control (chart options) ---- */
      .af-seg { display: inline-flex; flex: none; gap: 2px; padding: 2px; border-radius: var(--af-r1); background: var(--af-fill); }
      .af-seg button {
        height: 22px; padding: 0 var(--af-s2); border: 0; border-radius: 4px; background: none;
        color: var(--af-fg-2); font: var(--af-t-caption); white-space: nowrap; cursor: pointer;
      }
      .af-seg button:hover { color: var(--af-fg); }
      .af-seg button[data-active] {
        background: var(--af-bg); color: var(--af-fg); font-weight: 600;
        box-shadow: 0 0 0 1px var(--af-line), 0 1px 2px rgba(0, 0, 0, .06);
      }
      .af-seg button:disabled { opacity: .4; cursor: default; }

      /* ---- layout ---- */
      .af-body { display: flex; flex: 1; min-height: 0; }
      .af-rail {
        width: 272px; flex: none; display: flex; flex-direction: column; min-height: 0;
        border-right: 1px solid var(--af-line-soft);
      }
      .af-rail-scroll { flex: 1; overflow: auto; padding: 0 0 var(--af-s4); }
      .af-content { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
      .af-content-scroll { flex: 1; overflow: auto; min-height: 0; }
      .af-page { padding: var(--af-s4) var(--af-s5) var(--af-s6); max-width: 1180px; }
      .af-root[data-narrow] .af-page { padding: var(--af-s3) var(--af-s3) var(--af-s5); }

      /* ---- rail: default-root line, runs, the open run's stages ---- */
      .af-defroot {
        display: flex; align-items: center; gap: 6px; padding: var(--af-s2) var(--af-s3) 2px;
        font: var(--af-t-caption); color: var(--af-fg-3);
      }
      .af-defroot-tag {
        flex: none; padding: 0 6px; border-radius: 999px; background: var(--af-fill-2);
        color: var(--af-fg-2); font: var(--af-t-micro); line-height: 16px;
      }
      .af-defroot-path {
        flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font-family: var(--af-mono); font-size: 11px;
      }
      .af-summary { padding: 0 var(--af-s3) var(--af-s1); font: var(--af-t-caption); color: var(--af-fg-3); }
      .af-summary b { color: var(--af-fg-2); font-weight: 600; font-variant-numeric: tabular-nums; }
      .af-group {
        display: flex; align-items: baseline; gap: 6px; padding: var(--af-s4) var(--af-s3) var(--af-s1);
        font: var(--af-t-micro); color: var(--af-fg-3); letter-spacing: .02em;
      }
      .af-group > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .af-group-count { flex: none; font-variant-numeric: tabular-nums; font-weight: 400; }
      .af-run {
        display: block; width: 100%; padding: 6px var(--af-s3) 7px; border: 0; border-left: 2px solid transparent;
        background: none; text-align: left; cursor: pointer;
      }
      .af-run:hover { background: var(--af-hover); }
      .af-run[data-active] { background: var(--af-fill); border-left-color: var(--af-accent); }
      .af-run-name {
        display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font: var(--af-t-body); font-weight: 500;
      }
      .af-run-meta {
        display: flex; align-items: center; gap: 6px; margin-top: 2px; min-width: 0;
        font: var(--af-t-caption); color: var(--af-fg-3);
      }
      .af-fp { display: inline-flex; align-items: center; gap: 2px; flex: none; }
      .af-fp-arrow { color: var(--af-fg-3); margin: 0 2px; display: inline-flex; }
      .af-task {
        display: flex; align-items: center; gap: 6px; width: 100%; padding: 2px var(--af-s3) 2px 22px;
        border: 0; border-left: 2px solid transparent; background: none; text-align: left; cursor: pointer;
        font: var(--af-t-caption); line-height: 20px; color: var(--af-fg-2);
      }
      .af-task:hover { background: var(--af-hover); color: var(--af-fg); }
      .af-task[data-active] {
        border-left-color: var(--af-accent); background: var(--af-accent-soft); color: var(--af-fg); font-weight: 600;
      }
      .af-task-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .af-task-branch { color: var(--af-fg-3); font-weight: 400; }

      /* ---- run picker (narrow dock) ---- */
      .af-picker { position: relative; flex: none; padding: var(--af-s2) var(--af-s3); border-bottom: 1px solid var(--af-line-soft); }
      .af-picker-btn {
        display: flex; align-items: center; gap: var(--af-s2); width: 100%; padding: 6px var(--af-s2);
        border: 1px solid var(--af-line); border-radius: var(--af-r2); background: var(--af-bg); cursor: pointer; text-align: left;
      }
      .af-picker-btn:hover { background: var(--af-hover); }
      .af-picker-main { flex: 1; min-width: 0; }
      .af-picker-pop {
        position: absolute; left: var(--af-s3); right: var(--af-s3); top: calc(100% - 4px); z-index: 30;
        max-height: 62vh; overflow: auto; padding: var(--af-s1) 0; border: 1px solid var(--af-line);
        border-radius: var(--af-r2); background: var(--af-bg);
        box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, .14));
      }

      /* ---- state and producer badges ---- */
      .af-state { display: inline-flex; align-items: center; gap: 4px; flex: none; font: var(--af-t-caption); color: var(--af-fg-2); white-space: nowrap; }
      .af-state svg { flex: none; display: block; }
      .af-glyph-ok { color: var(--af-ok); }
      .af-glyph-unconv { color: var(--af-warn); }
      .af-glyph-run { color: var(--af-run); }
      .af-glyph-none { color: var(--af-idle); }
      .af-glyph-err { color: var(--af-err); }
      .af-glyph-partial { color: var(--af-fg-2); }
      .af-prod {
        display: inline-flex; align-items: center; gap: 4px; flex: none; height: 18px; padding: 0 6px;
        border-radius: 4px; font: var(--af-t-micro); white-space: nowrap;
      }
      .af-prod[data-p="abacus"] { color: var(--af-abacus); background: color-mix(in srgb, var(--af-abacus) 11%, transparent); }
      .af-prod[data-p="librpa"] { color: var(--af-librpa); background: color-mix(in srgb, var(--af-librpa) 12%, transparent); }
      .af-prod[data-p="db"] { color: var(--af-db); background: color-mix(in srgb, var(--af-db) 13%, transparent); }
      .af-prod-stage { color: var(--af-fg-2); font-weight: 400; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }

      /* ---- run header ---- */
      .af-head { display: flex; flex-direction: column; gap: 6px; padding-bottom: var(--af-s4); min-width: 0; }
      .af-title { margin: 0; font: var(--af-t-title); overflow-wrap: anywhere; }
      .af-subline { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
      .af-chip {
        display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 8px; border-radius: 999px;
        background: var(--af-fill); color: var(--af-fg-2); font: var(--af-t-caption); white-space: nowrap;
      }
      .af-chip-link { border: 0; cursor: pointer; }
      .af-chip-link:hover { background: var(--af-fill-2); color: var(--af-fg); }
      .af-linklike { display: inline-flex; padding: 0; border: 0; background: none; cursor: pointer; border-radius: 4px; }
      .af-linklike:hover .af-prod { box-shadow: 0 0 0 1px currentColor; }
      .af-path {
        display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        font: 400 11px/16px var(--af-mono); color: var(--af-fg-3);
      }

      /* ---- pipeline ---- */
      .af-pipe {
        display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(64px, auto) minmax(0, 1fr); gap: 0;
        padding: var(--af-s3); border-radius: var(--af-r3); background: var(--af-fill);
      }
      .af-pipe[data-single] { grid-template-columns: minmax(0, 1fr); }
      .af-root[data-narrow] .af-pipe { grid-template-columns: minmax(0, 1fr); }
      .af-lane { display: flex; flex-direction: column; gap: var(--af-s3); min-width: 0; }
      .af-lane-head { display: flex; align-items: center; gap: 6px; font: var(--af-t-micro); color: var(--af-fg-3); }
      .af-branch { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .af-branch[data-linked] .af-branch-name { color: var(--af-accent); }
      .af-branch-name { font: 400 11px/14px var(--af-mono); color: var(--af-fg-3); overflow-wrap: anywhere; }
      .af-chain { display: flex; align-items: stretch; flex-wrap: wrap; row-gap: 6px; min-width: 0; }
      .af-link { display: inline-flex; align-items: center; flex: none; padding: 0 3px; color: var(--af-fg-3); }
      .af-node {
        display: flex; flex-direction: column; gap: 2px; flex: 1 1 128px; min-width: 0; max-width: 260px;
        padding: 6px var(--af-s2) 7px; border: 1px solid var(--af-line); border-radius: var(--af-r2);
        background: var(--af-bg); text-align: left; cursor: pointer;
      }
      .af-node:hover { border-color: var(--af-line-strong); background: var(--af-bg); }
      .af-node[data-active] { border-color: var(--af-accent); box-shadow: 0 0 0 1px var(--af-accent); }
      .af-node[data-quiet] { background: transparent; border-style: dashed; }
      .af-node-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
      .af-node-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--af-t-body); font-weight: 600; }
      .af-node-facts {
        min-width: 0; overflow: hidden; font: var(--af-t-caption); color: var(--af-fg-2); overflow-wrap: anywhere;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      }
      .af-node-plot { margin-left: auto; flex: none; color: var(--af-accent); display: inline-flex; }
      .af-edge {
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
        padding: var(--af-s2); min-width: 0; text-align: center; color: var(--af-fg-2); font: var(--af-t-micro);
      }
      .af-edge[data-kind="layout"], .af-edge[data-kind="unresolved"] { color: var(--af-fg-3); }
      .af-edge-arrow { color: var(--af-accent); display: inline-flex; }
      .af-edge[data-kind="layout"] .af-edge-arrow, .af-edge[data-kind="unresolved"] .af-edge-arrow { color: var(--af-fg-3); }
      .af-edge-label { max-width: 160px; overflow-wrap: anywhere; }
      .af-root[data-narrow] .af-edge { flex-direction: row; justify-content: flex-start; padding: var(--af-s2) 0; text-align: left; }
      .af-root[data-narrow] .af-edge-arrow { transform: rotate(90deg); }
      .af-root[data-narrow] .af-edge-label { max-width: none; }
      /* Narrow: stages become chips (glyph + name), so the plot stays near the top of a dock;
         each stage's facts are one click away in its stage view and in the tooltip. */
      .af-root[data-narrow] .af-chain { align-items: center; row-gap: 6px; }
      .af-root[data-narrow] .af-lane { gap: var(--af-s2); }
      .af-stage-chip {
        display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; height: 26px; padding: 0 9px;
        border: 1px solid var(--af-line); border-radius: 999px; background: var(--af-bg); cursor: pointer;
        font: var(--af-t-caption); color: var(--af-fg); white-space: nowrap;
      }
      .af-stage-chip:hover { border-color: var(--af-line-strong); }
      .af-stage-chip[data-active] { border-color: var(--af-accent); box-shadow: 0 0 0 1px var(--af-accent); }
      .af-stage-chip[data-quiet] { border-style: dashed; background: transparent; color: var(--af-fg-2); }
      .af-stage-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      .af-loop { display: inline-flex; align-items: center; gap: 4px; font: var(--af-t-caption); color: var(--af-fg-2); }

      /* ---- sections: grouped by space and weight, not by boxes ---- */
      .af-section { padding-top: var(--af-s5); min-width: 0; }
      .af-section-head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px var(--af-s2); margin-bottom: var(--af-s3); min-width: 0; }
      .af-section-title { margin: 0; font: var(--af-t-section); }
      .af-section-meta { font: var(--af-t-caption); color: var(--af-fg-3); min-width: 0; }
      .af-section-actions { margin-left: auto; display: flex; align-items: center; flex-wrap: wrap; gap: var(--af-s2); }
      /* A collapsible header reads as a control: pointer, hover tint, focus ring. */
      .af-section-head-btn { cursor: pointer; border-radius: var(--af-r2); padding: 3px 4px; margin-left: -4px; }
      .af-section-head-btn:hover { background: var(--af-bg-hover, rgba(127,127,127,.08)); }
      .af-section-head-btn:focus-visible { outline: 2px solid var(--af-brand); outline-offset: 1px; }
      .af-section-head-btn .af-section-title { user-select: none; }

      /* ---- database assets (figures + curves fetched on demand) ---- */
      .af-lib-assets { display: flex; flex-direction: column; gap: var(--af-s4); margin-top: var(--af-s3); }
      .af-lib-assets-head {
        display: flex; align-items: center; gap: var(--af-s2); flex-wrap: wrap;
        font: var(--af-t-caption); color: var(--af-fg-3); margin-bottom: var(--af-s2);
      }
      .af-seg { display: flex; gap: 4px; margin-left: auto; }
      .af-lib-img {
        display: block; max-width: 100%; height: auto; border: 1px solid var(--af-border);
        border-radius: var(--af-r2); background: #fff;
      }
      .af-subhead { margin: var(--af-s4) 0 var(--af-s2); font: var(--af-t-micro); color: var(--af-fg-3); letter-spacing: .02em; }
      .af-viewbar { display: flex; align-items: center; gap: var(--af-s2); flex-wrap: wrap; padding-top: var(--af-s4); }
      .af-controls { display: flex; align-items: center; flex-wrap: wrap; gap: var(--af-s2) var(--af-s3); margin-bottom: var(--af-s3); }
      .af-control { display: inline-flex; align-items: center; gap: 6px; font: var(--af-t-caption); color: var(--af-fg-3); }
      .af-toggles { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: var(--af-s3); }
      .af-toggle {
        display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 var(--af-s2);
        border: 1px solid var(--af-line); border-radius: 999px; background: var(--af-bg);
        color: var(--af-fg-2); font: var(--af-t-caption); white-space: nowrap; cursor: pointer;
      }
      .af-toggle:hover { border-color: var(--af-line-strong); }
      .af-toggle[aria-pressed="true"] { color: var(--af-fg); border-color: var(--af-line-strong); background: var(--af-fill); }
      .af-toggle[aria-pressed="false"] svg { opacity: .35; }
      .af-toggle:disabled { opacity: .45; cursor: default; }
      .af-grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--af-s5); }
      .af-root[data-narrow] .af-grid-2 { grid-template-columns: minmax(0, 1fr); gap: var(--af-s4); }

      /* ---- data ---- */
      .af-kv { display: grid; grid-template-columns: minmax(88px, max-content) minmax(0, 1fr); gap: 4px var(--af-s4); margin: 0; font: var(--af-t-caption); }
      .af-kv dt { color: var(--af-fg-3); }
      .af-kv dd { margin: 0; color: var(--af-fg); overflow-wrap: anywhere; }
      .af-mono { font-family: var(--af-mono); font-size: 12px; }
      .af-num { font-family: var(--af-mono); font-variant-numeric: tabular-nums; }
      .af-dim { color: var(--af-fg-3); }
      .af-table-wrap { overflow: auto; min-width: 0; }
      .af-table { width: 100%; border-collapse: collapse; font: var(--af-t-caption); }
      .af-table th {
        position: sticky; top: 0; z-index: 1; padding: 0 var(--af-s2) 6px; text-align: left; white-space: nowrap;
        font: var(--af-t-micro); color: var(--af-fg-3); background: var(--af-bg); border-bottom: 1px solid var(--af-line);
      }
      .af-table td { padding: 6px var(--af-s2); border-bottom: 1px solid var(--af-line-soft); vertical-align: middle; }
      .af-table td:first-child, .af-table th:first-child { padding-left: 0; }
      .af-table .af-num { text-align: right; white-space: nowrap; }
      .af-table td.af-val { font: 600 13px/20px var(--af-mono); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
      .af-table tbody tr:hover td { background: var(--af-hover); }
      .af-table tr[data-converged] td { font-weight: 600; }
      .af-table tr[data-sel] td { background: var(--af-accent-soft); }
      .af-table tr.af-row-sep td { padding-top: var(--af-s4); border-bottom-color: var(--af-line); color: var(--af-fg-3); font: var(--af-t-micro); }
      .af-src { font: 400 11px/16px var(--af-mono); color: var(--af-fg-3); overflow-wrap: anywhere; }
      /* Narrow: each ledger row stacks (producer + quantity | value, then the source line). */
      .af-root[data-narrow] .af-ledger thead { display: none; }
      .af-root[data-narrow] .af-ledger tr {
        display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--af-s2); row-gap: 2px;
        padding: var(--af-s2) 0; border-bottom: 1px solid var(--af-line-soft);
      }
      .af-root[data-narrow] .af-ledger td { display: block; padding: 0; border: 0; min-width: 0; }
      .af-root[data-narrow] .af-ledger td:nth-child(1), .af-root[data-narrow] .af-ledger td:nth-child(2) { grid-column: 1; }
      .af-root[data-narrow] .af-ledger td:nth-child(3) { grid-column: 2; grid-row: 1 / span 2; align-self: center; }
      .af-root[data-narrow] .af-ledger td:nth-child(4) { grid-column: 1 / -1; }
      .af-root[data-narrow] .af-ledger tr.af-row-sep { display: block; padding-top: var(--af-s4); }
      .af-root[data-narrow] .af-ledger tbody tr:hover td { background: none; }
      .af-pill-list { display: flex; flex-wrap: wrap; gap: 4px; }
      .af-pill { padding: 1px 6px; border-radius: 4px; background: var(--af-fill); color: var(--af-fg-2); font: 400 11px/18px var(--af-mono); }
      .af-pill[data-ok="false"] { color: var(--af-warn-text); background: var(--af-warn-soft); }

      /* ---- notes and empty states ---- */
      .af-note {
        display: flex; align-items: flex-start; gap: var(--af-s2); padding: var(--af-s2) var(--af-s3);
        border-radius: var(--af-r2); background: var(--af-fill); color: var(--af-fg-2); font: var(--af-t-caption);
      }
      .af-note + .af-note { margin-top: 6px; }
      .af-note[data-tone="warn"] { background: var(--af-warn-soft); color: var(--af-fg); }
      .af-note[data-tone="err"] { background: var(--af-err-soft); color: var(--af-fg); }
      .af-note svg { flex: none; margin-top: 2px; }
      .af-notes { display: flex; flex-direction: column; gap: 4px; padding-top: var(--af-s2); font: var(--af-t-caption); color: var(--af-fg-3); }
      .af-notes > div { display: flex; gap: 6px; align-items: flex-start; }
      .af-notes svg { flex: none; margin-top: 3px; }
      .af-empty { padding: var(--af-s5) var(--af-s3); text-align: center; color: var(--af-fg-3); font: var(--af-t-body); }
      .af-empty-title { display: block; color: var(--af-fg-2); font-weight: 600; margin-bottom: 2px; }
      .af-error {
        margin: var(--af-s3); padding: var(--af-s2) var(--af-s3); border-radius: var(--af-r2);
        background: var(--af-err-soft); color: var(--af-fg); font: var(--af-t-caption);
      }
      .af-hint { color: var(--af-fg-3); font: var(--af-t-caption); }

      /* ---- charts ---- */
      .af-chart-wrap { position: relative; min-width: 0; }
      .af-chart { display: block; width: 100%; overflow: visible; }
      .af-chart text { font: 400 11px var(--af-mono); fill: var(--af-fg-3); }
      .af-chart .af-axis-title { font: 500 11px var(--af-font); fill: var(--af-fg-2); }
      .af-chart .af-tick-label { font: 600 12px var(--af-font); fill: var(--af-fg); }
      .af-chart .af-plot-bg { fill: var(--af-fill); }
      .af-chart .af-grid { stroke: var(--af-line-soft); stroke-width: 1; }
      .af-chart .af-axis { stroke: var(--af-line-strong); stroke-width: 1; }
      .af-chart .af-kline { stroke: var(--af-line); stroke-width: 1; stroke-dasharray: 2 3; }
      .af-chart .af-ref-label {
        font: 500 10px var(--af-font); paint-order: stroke; stroke: var(--af-bg); stroke-width: 3px; stroke-linejoin: round;
      }
      .af-chart .af-marker { stroke: var(--af-accent); stroke-width: 1; stroke-dasharray: 3 3; }
      .af-chart .af-point { cursor: pointer; }
      .af-chart-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: var(--af-s2); font: var(--af-t-caption); color: var(--af-fg-2); min-width: 0; }
      .af-legend { display: flex; flex-wrap: wrap; gap: 4px var(--af-s3); padding-top: var(--af-s2); font: var(--af-t-caption); color: var(--af-fg-2); }
      .af-legend-item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
      .af-legend-group { display: inline-flex; align-items: center; gap: 4px var(--af-s3); flex-wrap: wrap; }

      /* ---- structure ---- */
      .af-struct { position: relative; }
      .af-struct canvas {
        display: block; width: 100%; border-radius: var(--af-r3); cursor: grab; background: var(--af-fill); touch-action: none;
      }
      .af-struct canvas:active { cursor: grabbing; }
      .af-struct-caption { display: flex; flex-wrap: wrap; gap: 4px var(--af-s4); padding-top: var(--af-s2); font: var(--af-t-caption); color: var(--af-fg-2); }

      /* ---- library records ---- */
      .af-lib-record { border-bottom: 1px solid var(--af-line-soft); }
      .af-lib-record-head {
        display: flex; align-items: center; gap: var(--af-s2); flex-wrap: wrap; width: 100%; padding: 6px 0;
        border: 0; background: none; text-align: left; cursor: pointer; font: var(--af-t-caption);
      }
      .af-lib-record-head:hover { background: var(--af-hover); }
      .af-lib-id { font: 600 12px/18px var(--af-mono); }
      .af-lib-detail { display: flex; flex-direction: column; gap: 2px; padding: 0 0 var(--af-s2) var(--af-s3); border-left: 2px solid var(--af-line); margin-bottom: var(--af-s2); }
      .af-conf { font: var(--af-t-micro); padding: 1px 6px; border-radius: 999px; background: var(--af-fill); color: var(--af-fg-2); }
      .af-conf[data-c="high"] { color: var(--af-fg); background: var(--af-ok-soft); }
      .af-conf[data-c="medium"] { background: var(--af-warn-soft); }

      /* ---- files ---- */
      .af-file-row {
        display: flex; align-items: center; gap: var(--af-s3); width: 100%; padding: 4px var(--af-s2);
        border: 0; border-radius: var(--af-r1); background: none; text-align: left; cursor: pointer;
      }
      .af-file-row:hover { background: var(--af-hover); }
      .af-file-row[data-active] { background: var(--af-fill-2); font-weight: 600; }
      .af-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 400 12px/18px var(--af-mono); }
      .af-file-meta { flex: none; color: var(--af-fg-3); font: 400 11px/18px var(--af-mono); }
      .af-pre {
        margin: var(--af-s2) 0 0; padding: var(--af-s3); max-height: 420px; overflow: auto; border-radius: var(--af-r2);
        background: var(--af-fill); font: 400 11px/16px var(--af-mono); white-space: pre; tab-size: 2;
      }

      /* ---- agent dock: pinned under the scroller, visibly a different kind of action ---- */
      .af-agent {
        flex: none; display: flex; flex-direction: column; gap: 6px; min-width: 0;
        padding: var(--af-s2) var(--af-s3) var(--af-s3); border-top: 1px solid var(--af-line); background: var(--af-bg);
      }
      .af-agent-head { display: flex; align-items: center; gap: var(--af-s2); min-width: 0; font: var(--af-t-caption); color: var(--af-fg-3); }
      .af-agent-label { display: inline-flex; align-items: center; gap: 4px; flex: none; color: var(--af-fg); font-weight: 600; }
      .af-agent-ctx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .af-ask-row { display: flex; align-items: center; gap: var(--af-s2); min-width: 0; }
      .af-ask-quick { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
      .af-ask-quick .af-btn { color: var(--af-fg-2); }
      .af-agent-status { margin-left: auto; color: var(--af-fg-3); font: var(--af-t-caption); }
      .af-root[data-narrow] .af-ask-quick { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
      .af-root[data-narrow] .af-ask-quick::-webkit-scrollbar { display: none; }
      .af-agent-foot { color: var(--af-fg-3); font: var(--af-t-caption); text-align: right; }
      .af-handoff {
        display: flex; flex-direction: column; gap: var(--af-s2); max-height: 52vh; overflow: auto;
        padding: var(--af-s3); border: 1px solid var(--af-line); border-radius: var(--af-r3); background: var(--af-bg);
      }
      .af-handoff-intents { display: flex; flex-wrap: wrap; gap: 6px; }
      .af-textarea {
        width: 100%; min-height: 180px; resize: vertical; padding: var(--af-s2);
        border: 1px solid var(--af-line); border-radius: var(--af-r2); background: var(--af-fill);
        color: var(--af-fg); font: 400 11px/16px var(--af-mono);
      }
      .af-textarea:focus { outline: none; border-color: var(--af-accent); }
      .af-research { display: flex; align-items: flex-start; gap: 6px; font: var(--af-t-caption); color: var(--af-fg-2); }

      /* ---- spinner ---- */
      .af-spin {
        display: inline-block; width: 12px; height: 12px; border-radius: 50%; flex: none;
        border: 2px solid var(--af-line); border-top-color: var(--af-accent);
        animation: af-spin .7s linear infinite; vertical-align: -2px; margin-right: 6px;
      }
      @keyframes af-spin { to { transform: rotate(360deg); } }
    `;

    // =====================================================================
    // pure logic
    // =====================================================================

    /* @pure-begin
     * Everything between @pure-begin and @pure-end is plain JavaScript: no React, no DOM, no
     * storage, no network. test/client-pure.test.mjs evaluates this region directly, so the
     * logic that decides what the panel *claims* — stage states, lineage, alignment, which
     * file a number came from, the message handed to the agent — is tested by behaviour.
     */

    const KIND_LABEL = { abacus: 'ABACUS', librpa: 'LibRPA', coupled: 'ABACUS+LibRPA' };
    const PRODUCER_LABEL = { abacus: 'ABACUS', librpa: 'LibRPA', db: '数据库' };
    const ROLE_LABEL = { producer: 'ABACUS · 产出', coupled: 'ABACUS → LibRPA · 同目录', consumer: 'LibRPA · 消费' };

    /** Shown wherever curves from both producers share one axis. Never replaced by a shift. */
    const ENERGY_ZERO_NOTE =
      '能量零点：ABACUS 用绝对 eV，LibRPA 用它自己的内部零点。曲线形状可比，绝对位置不一定对齐；面板不做任何平移。';

    function isNum(value) {
      return typeof value === 'number' && Number.isFinite(value);
    }

    function fmtNum(value, digits) {
      if (!isNum(value)) return '—';
      return value.toFixed(digits === undefined ? 6 : digits);
    }

    function fmtEv(value, digits) {
      return isNum(value) ? `${value.toFixed(digits === undefined ? 3 : digits)} eV` : '—';
    }

    function fmtMeV(value) {
      if (!isNum(value)) return '—';
      const mev = value * 1000;
      // Sub-meV differences keep two decimals, so a real −0.08 meV never prints as "-0.0".
      return `${mev >= 0 ? '+' : ''}${mev.toFixed(Math.abs(mev) < 1 ? 2 : 1)} meV`;
    }

    function fmtBytes(bytes) {
      if (!isNum(bytes)) return '—';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
      return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
    }

    function fmtAge(seconds) {
      if (!isNum(seconds) || seconds < 0) return '';
      if (seconds < 90) return `${Math.round(seconds)} 秒`;
      if (seconds < 5400) return `${Math.round(seconds / 60)} 分钟`;
      if (seconds < 172800) return `${Math.round(seconds / 3600)} 小时`;
      return `${Math.round(seconds / 86400)} 天`;
    }

    function splitRel(rel) {
      return String(rel || '').split('/').filter((part) => part && part !== '.');
    }

    function baseName(path) {
      const parts = String(path || '').split(/[\\/]+/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : '';
    }

    /** Join a run-relative path onto an absolute root, keeping the root's own separator. */
    function joinPath(root, rel) {
      const base = String(root || '');
      if (!rel) return base;
      const sep = base.includes('\\') ? '\\' : '/';
      return `${base.replace(/[\\/]+$/, '')}${sep}${splitRel(rel).join(sep)}`;
    }

    /** Natural order: 01_scf < 02_export < 03_bands, k444 < k666, keep_6 < keep_10. */
    function natCompare(a, b) {
      const ax = String(a).match(/\d+|\D+/g) || [];
      const bx = String(b).match(/\d+|\D+/g) || [];
      const n = Math.min(ax.length, bx.length);
      for (let i = 0; i < n; i += 1) {
        const x = ax[i];
        const y = bx[i];
        if (x === y) continue;
        if (/^\d/.test(x) && /^\d/.test(y)) {
          const d = Number(x) - Number(y);
          if (d !== 0) return d;
          continue;
        }
        return x < y ? -1 : 1;
      }
      return ax.length - bx.length;
    }

    // ---------------------------------------------------------------- runs ---

    /** Run names in this researcher's archive carry a date stamp; stage folders do not. */
    const DATE_TOKEN_RE = /(?:19|20)\d{6}/;
    /** Folder names that are stages or branches of one run rather than runs of their own. */
    const ROLE_SEGMENT_RE =
      /^(?:\d{1,2}[-_]|producer|consumer|qsgw|g0w0|gw[-_]|librpa|abacus|scf|nscf|bands?(?:$|[-_])|export|input|validation|runs?$|work$|base|frozen|headonly|refresh|keep|sweep|iter)/i;

    /**
     * Decide whether the scan root is itself one run (its children are `producer/`, `qsgw/`,
     * `01_scf` …) or a collection of runs (its children are dated run folders).
     *
     * This only decides grouping in the list; it makes no physics claim, and the run header
     * says the grouping is by folder.
     */
    function rootIsRun(tasks) {
      const firsts = [...new Set((tasks || []).map((t) => splitRel(t.relPath)[0]).filter(Boolean))];
      if (firsts.length === 0) return true;
      if (firsts.some((segment) => DATE_TOKEN_RE.test(segment))) return false;
      const role = firsts.filter((segment) => ROLE_SEGMENT_RE.test(segment)).length;
      return role / firsts.length >= 0.6;
    }

    function stageRole(task) {
      if (task && task.kind === 'librpa') return 'consumer';
      if (task && task.kind === 'coupled') return 'coupled';
      return 'producer';
    }

    const ROLE_ORDER = { producer: 0, coupled: 1, consumer: 2 };

    function compareStages(a, b) {
      const role = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
      if (role !== 0) return role;
      const branch = natCompare(a.branch, b.branch);
      if (branch !== 0) return branch;
      return natCompare(a.name, b.name);
    }

    /**
     * Group scanned tasks into runs of ordered stages: producers (by branch, natural order)
     * before same-directory pairs before consumers. Nothing here reads a file; it is the
     * layout the scan already reported, put in pipeline order.
     */
    function groupRuns(tasks, rootPath) {
      const list = Array.isArray(tasks) ? tasks : [];
      const whole = rootIsRun(list);
      const rootName = baseName(rootPath) || '（扫描根目录）';
      const byKey = new Map();
      for (const task of list) {
        const segments = splitRel(task.relPath);
        const atRoot = whole || segments.length === 0;
        const key = atRoot ? '.' : segments[0];
        const rest = atRoot ? segments : segments.slice(1);
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            name: key === '.' ? rootName : key,
            relPath: key === '.' ? '' : key,
            absPath: key === '.' ? String(rootPath || '') : joinPath(rootPath, key),
            stages: [],
          });
        }
        byKey.get(key).stages.push({
          id: task.id,
          task,
          rel: rest.join('/'),
          role: stageRole(task),
          name: rest.length > 0 ? rest[rest.length - 1] : '（运行根目录）',
          branch: rest.length > 1 ? rest.slice(0, -1).join('/') : '',
        });
      }
      const runs = [...byKey.values()];
      for (const run of runs) {
        run.stages.sort(compareStages);
        run.counts = { producer: 0, coupled: 0, consumer: 0 };
        for (const stage of run.stages) run.counts[stage.role] += 1;
      }
      runs.sort((a, b) => natCompare(a.name, b.name));
      return runs;
    }

    /** Lanes for the pipeline: one per role present, each holding its branches in order. */
    function lanesOf(run) {
      const lanes = [];
      for (const role of ['producer', 'coupled', 'consumer']) {
        const stages = (run ? run.stages : []).filter((stage) => stage.role === role);
        if (stages.length === 0) continue;
        const branches = [];
        for (const stage of stages) {
          let branch = branches.find((b) => b.name === stage.branch);
          if (!branch) {
            branch = { name: stage.branch, stages: [] };
            branches.push(branch);
          }
          branch.stages.push(stage);
        }
        lanes.push({ role, branches });
      }
      return lanes;
    }

    // -------------------------------------------------------------- states ---

    function qsgwIterations(bundle) {
      const qsgw = bundle && bundle.librpa && bundle.librpa.qsgw;
      return qsgw && qsgw.iterations ? qsgw.iterations : null;
    }

    function qsgwRows(bundle) {
      const iterations = qsgwIterations(bundle);
      return iterations && Array.isArray(iterations.rows) ? iterations.rows : [];
    }

    function qsgwConvergedIter(bundle) {
      const iterations = qsgwIterations(bundle);
      return iterations && isNum(iterations.convergedIter) ? iterations.convergedIter : null;
    }

    function lastRow(rows, field) {
      for (let i = rows.length - 1; i >= 0; i -= 1) if (isNum(rows[i][field])) return rows[i];
      return null;
    }

    /** Only these ABACUS calculations have an SCF verdict worth calling "converged". */
    const CONVERGING_CALCS = /^(scf|relax|cell-relax|md)$/i;

    /**
     * The one state a stage shows everywhere: list, pipeline, header, ledger.
     *
     * Starts from the host's status code (the same one the agent tools report) and refines it
     * with convergence evidence once the stage bundle is loaded. The six codes map to six
     * glyph shapes, so colour is never the only carrier.
     *
     * @returns {{ code:'ok'|'unconv'|'run'|'none'|'err'|'partial', label:string, detail:string }}
     */
    function stageState(task, bundle) {
      const status = (bundle && bundle.status) || (task && task.status) || null;
      const code = status ? status.code : null;
      const reason = (status && status.reason) || '';
      const rows = qsgwRows(bundle);
      const convergedIter = qsgwConvergedIter(bundle);
      const lastDelta = lastRow(rows, 'max_delta_eV');

      if (code === 'ERROR') return { code: 'err', label: '出错', detail: reason || '日志出现错误签名' };
      if (code === 'RUNNING') {
        const age = task && isNum(task.ageSeconds) ? task.ageSeconds : null;
        if (age !== null && age > 6 * 3600) {
          return { code: 'run', label: '运行中', detail: `日志没有结束标记，已 ${fmtAge(age)}无更新` };
        }
        return { code: 'run', label: '运行中', detail: reason || '日志没有结束标记' };
      }
      if (code === 'FINISHED_UNCONVERGED') {
        return { code: 'unconv', label: '未收敛', detail: reason || '运行结束，但 SCF 没有收敛' };
      }
      if (code === 'NO_OUTPUT') {
        if (rows.length > 0) {
          const first = rows[0].iter;
          const last = rows[rows.length - 1].iter;
          return {
            code: 'partial',
            label: '证据不全',
            detail: `没有可判定的运行日志，但 qsgw_iterations.dat 有 ${rows.length} 行（第 ${first}–${last} 次）`,
          };
        }
        return { code: 'none', label: '无输出', detail: reason || '没有找到输出' };
      }
      if (code === 'FINISHED') {
        if (rows.length > 0 && convergedIter === null) {
          return {
            code: 'unconv',
            label: '未收敛',
            detail: `QSGW 迭代表没有一行达到收敛判据${lastDelta ? `（第 ${lastDelta.iter} 次 max ΔE = ${lastDelta.max_delta_eV.toPrecision(3)} eV）` : ''}`,
          };
        }
        if (convergedIter !== null) return { code: 'ok', label: '已收敛', detail: `QSGW 第 ${convergedIter} 次迭代收敛` };
        const abacus = bundle && bundle.abacus;
        if (abacus && abacus.log && abacus.log.scfConverged === true && CONVERGING_CALCS.test(String(abacus.calculation || ''))) {
          return { code: 'ok', label: '已收敛', detail: `SCF 收敛（${(abacus.log.iterations || []).length} 条迭代记录）` };
        }
        return { code: 'ok', label: '已完成', detail: reason || '运行正常结束' };
      }
      if (!status) return { code: 'none', label: '未判定', detail: '还没有读取状态' };
      return { code: 'none', label: status.label || '未判定', detail: reason };
    }

    // ------------------------------------------------------------- lineage ---

    /** Resolve `a/b` + `../c` without touching the filesystem. */
    function resolveRel(baseRel, rel) {
      const out = splitRel(baseRel);
      for (const part of String(rel || '').replace(/\\/g, '/').split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
          if (out.length === 0) return null;
          out.pop();
        } else {
          out.push(part);
        }
      }
      return out.join('/');
    }

    /**
     * Which producer a consumer read, and how we know.
     *
     * Evidence, strongest first: LibRPA's `input_dir` resolving into a producer branch of the
     * same run (cluster paths are mapped by the run folder name, which the pull keeps); the
     * same directory (`coupled`); a layout guess. A guess is labelled as one.
     *
     * @returns {{ kind:'input_dir'|'same_dir'|'unresolved'|'layout'|'none', branch:string|null,
     *             text:string, raw:string|null, runRel:string|null }|null}
     */
    function lineageOf(stage, bundle, run) {
      if (!stage) return null;
      if (stage.role === 'coupled') {
        return { kind: 'same_dir', branch: null, text: '同目录：ABACUS 产出直接被 LibRPA 读取', raw: null, runRel: stage.rel };
      }
      if (stage.role !== 'consumer') return null;
      const producers = (run ? run.stages : []).filter((s) => s.role === 'producer');
      const params = bundle && bundle.librpa && bundle.librpa.input && bundle.librpa.input.params;
      const raw = params && params.input_dir ? String(params.input_dir) : null;

      const layout = () => {
        const branches = [...new Set(producers.map((s) => s.branch))];
        if (producers.length === 0) {
          return { kind: 'none', branch: null, text: '本运行里没有 ABACUS 产出阶段', raw, runRel: null };
        }
        return {
          kind: 'layout',
          branch: branches.length === 1 ? branches[0] : null,
          text: branches.length === 1 ? `按目录布局推断 → ${branches[0] || '产出阶段'}` : '按目录布局推断（有多个产出分支，无法确定哪一个）',
          raw,
          runRel: null,
        };
      };

      if (!raw) return bundle ? layout() : null;

      const norm = raw.replace(/\\/g, '/').replace(/\/+$/, '');
      let runRel = null;
      if (!/^(?:[a-zA-Z]:|\/)/.test(norm)) {
        const stageDir = splitRel(stage.rel).join('/');
        runRel = resolveRel(stageDir, norm);
      } else if (run && run.name) {
        const marker = `/${run.name}/`;
        const at = norm.indexOf(marker);
        if (at >= 0) runRel = norm.slice(at + marker.length);
        else if (norm.endsWith(`/${run.name}`)) runRel = '';
      }

      if (runRel === null) {
        const fallback = layout();
        return {
          ...fallback,
          kind: producers.length > 0 ? 'unresolved' : fallback.kind,
          text: `input_dir 指向本运行之外（${raw}）`,
        };
      }

      let best = null;
      for (const producer of producers) {
        const candidates = [producer.rel, producer.branch].filter(Boolean);
        for (const prefix of candidates) {
          if (runRel === prefix || runRel.startsWith(`${prefix}/`)) {
            if (!best || prefix.length > best.prefix.length) best = { prefix, branch: producer.branch || producer.rel };
          }
        }
      }
      if (best) {
        return { kind: 'input_dir', branch: best.branch, text: `input_dir → ${best.branch}`, raw, runRel };
      }
      return {
        kind: producers.length > 0 ? 'unresolved' : 'none',
        branch: null,
        text: `input_dir → ${runRel || '.'}（本地没有对应的产出阶段）`,
        raw,
        runRel,
      };
    }

    // -------------------------------------------------------------- series ---

    const MESH_CUBE_RE = /(^|[-_.])k(\d)\2\2(?=$|[-_.])/i;
    const MESH_TRIPLE_RE = /(^|[-_.])k?(\d{1,2})x(\d{1,2})x(\d{1,2})(?=$|[-_.])/i;

    /** `si-qsgw-k444-headwing` → { mesh:[4,4,4], label:'k444', key:'si-qsgw-k*-headwing' }. */
    function meshToken(name) {
      const text = String(name || '');
      let m = MESH_CUBE_RE.exec(text);
      if (m) {
        const d = Number(m[2]);
        const start = m.index + m[1].length;
        return {
          mesh: [d, d, d],
          label: `k${m[2]}${m[2]}${m[2]}`,
          key: `${text.slice(0, start)}k*${text.slice(start + m[0].length - m[1].length)}`,
        };
      }
      m = MESH_TRIPLE_RE.exec(text);
      if (m) {
        const mesh = [Number(m[2]), Number(m[3]), Number(m[4])];
        const start = m.index + m[1].length;
        return { mesh, label: mesh.join('×'), key: `${text.slice(0, start)}k*${text.slice(start + m[0].length - m[1].length)}` };
      }
      return null;
    }

    /**
     * Runs whose names differ only by a k-mesh token form a k-convergence series — the
     * comparison (b) object. A single member is not a series.
     */
    function detectSeries(runs) {
      const groups = new Map();
      for (const run of runs || []) {
        const token = meshToken(run.name);
        if (!token) continue;
        if (!groups.has(token.key)) groups.set(token.key, []);
        groups.get(token.key).push({ runKey: run.key, name: run.name, mesh: token.mesh, label: token.label });
      }
      const out = [];
      for (const [key, members] of groups) {
        const distinct = new Set(members.map((m) => m.mesh.join('x')));
        if (distinct.size < 2) continue;
        members.sort((a, b) => a.mesh[0] * a.mesh[1] * a.mesh[2] - b.mesh[0] * b.mesh[1] * b.mesh[2]);
        out.push({ key, label: key.replace('k*', `{${members.map((m) => m.label).join(',')}}`), members });
      }
      return out.sort((a, b) => natCompare(a.key, b.key));
    }

    // --------------------------------------------------------------- bands ---

    /** Relative k-path tolerance for "the same path" (cumulative length, any units). */
    const KPATH_REL_TOL = 1e-3;
    /** LibRPA KS must reproduce ABACUS within this many eV before index alignment is allowed. */
    const KS_IDENTITY_TOL_EV = 0.01;

    function samePath(a, b) {
      const ka = (a && a.kpath) || [];
      const kb = (b && b.kpath) || [];
      if (ka.length === 0 || ka.length !== kb.length) return false;
      const scale = Math.max(Math.abs(ka[ka.length - 1]), Math.abs(kb[kb.length - 1]), 1e-9);
      for (let i = 0; i < ka.length; i += 1) {
        if (Math.abs(ka[i] - kb[i]) > KPATH_REL_TOL * scale) return false;
      }
      return true;
    }

    /** Point-by-point eigenvalue agreement of two channels on the same k-point sequence. */
    function eigenIdentity(a, b) {
      const ea = (a && a.energies) || [];
      const eb = (b && b.energies) || [];
      if (ea.length === 0 || ea.length !== eb.length) return null;
      const nBand = Math.min(a.nBand || (ea[0] || []).length, b.nBand || (eb[0] || []).length);
      let maxAbs = 0;
      let count = 0;
      for (let k = 0; k < ea.length; k += 1) {
        const ra = ea[k] || [];
        const rb = eb[k] || [];
        for (let n = 0; n < nBand; n += 1) {
          if (!isNum(ra[n]) || !isNum(rb[n])) continue;
          const d = Math.abs(ra[n] - rb[n]);
          if (d > maxAbs) maxAbs = d;
          count += 1;
        }
      }
      return count > 0 ? { maxAbs, count, nKpoint: ea.length, nBand } : null;
    }

    /**
     * How (and whether) `channel` may be drawn on `reference`'s k axis.
     *
     *   same   identical k path → drawn as is
     *   index  same point count, different length convention, *and* `proof` shows LibRPA KS
     *          reproduces ABACUS → drawn at the reference's k positions by index
     *   none   anything else → not overlaid, with the reason
     *
     * Nothing is interpolated or resampled.
     */
    function alignChannel(reference, channel, proof) {
      if (!reference || !channel) return { mode: 'none', reason: '缺少数据' };
      if (reference === channel || samePath(reference, channel)) return { mode: 'same', reason: 'k 路径相同' };
      const nRef = (reference.kpath || []).length;
      const nCh = (channel.kpath || []).length;
      if (nRef !== nCh) return { mode: 'none', reason: `k 点数不同（${nRef} vs ${nCh}）` };
      if (proof && proof.maxAbs <= KS_IDENTITY_TOL_EV) {
        return {
          mode: 'index',
          reason: `LibRPA KS 与 ABACUS 在 ${proof.nKpoint}×${proof.nBand} 个值上一致（max |Δ| = ${proof.maxAbs.toFixed(3)} eV），按 k 点序号对齐`,
        };
      }
      if (proof) {
        return { mode: 'none', reason: `点数相同，但 LibRPA KS 与 ABACUS 不一致（max |Δ| = ${proof.maxAbs.toFixed(3)} eV），不能确认是同一条路径` };
      }
      return { mode: 'none', reason: '点数相同但路径长度约定不同，且没有 KS 本征值可核对' };
    }

    function niceStep(span, target) {
      const rough = Math.abs(span) / Math.max(1, target || 5);
      const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1e-12))));
      for (const m of [1, 2, 2.5, 5, 10]) if (m * magnitude >= rough) return m * magnitude;
      return 10 * magnitude;
    }

    function ticksFor(lo, hi, target) {
      if (!isNum(lo) || !isNum(hi) || hi <= lo) return { step: 1, ticks: [] };
      const step = niceStep(hi - lo, target || 5);
      const ticks = [];
      for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
      return { step, ticks };
    }

    /**
     * Default energy window: ± `half` eV around a Fermi level read from a file, clipped to
     * the data. ABACUS energies are absolute (NiO E_F ≈ 15.4 eV), so centring on 0 eV — the
     * old default — cut the conduction bands off.
     */
    function defaultWindow(extent, reference, half) {
      const h = isNum(half) ? half : 6;
      if (!extent || !isNum(extent.min) || !isNum(extent.max)) return { lo: -10, hi: 10, centred: false };
      if (isNum(reference)) {
        const lo = Math.max(reference - h, extent.min);
        const hi = Math.min(reference + h, extent.max);
        if (hi - lo > 0.2) return { lo, hi, centred: true };
      }
      return { lo: Math.max(extent.min, -10), hi: Math.min(extent.max, 10), centred: false };
    }

    /** Last E_Fermi an ABACUS log printed, or null. */
    function abacusFermi(bundle) {
      const log = bundle && bundle.abacus && bundle.abacus.log;
      const rows = log && Array.isArray(log.iterations) ? log.iterations : [];
      const row = lastRow(rows, 'eFermiEv');
      return row ? row.eFermiEv : null;
    }

    /** LibRPA's own Fermi level for one QSGW iteration, from qsgw_iterations.dat. */
    function librpaFermi(bundle, iteration) {
      const rows = qsgwRows(bundle);
      if (rows.length === 0) return null;
      const row = iteration === null || iteration === undefined
        ? lastRow(rows, 'efermi_eV')
        : rows.find((r) => r.iter === iteration && isNum(r.efermi_eV));
      return row ? { energy: row.efermi_eV, iter: row.iter } : null;
    }

    /**
     * Which stages to plot for comparison (a), best first.
     *
     * ABACUS source: a finished producer whose k points are an explicit line path, preferring
     * the branch the consumer read (lineage), then any such producer. LibRPA source: consumers
     * and same-directory stages that left output, finished before broken.
     */
    function rankBandSources(run, bundles, states, lineageById) {
      const stages = run ? run.stages : [];
      const linkedBranches = new Set();
      for (const stage of stages) {
        const link = lineageById && lineageById[stage.id];
        if (link && link.branch && (link.kind === 'input_dir' || link.kind === 'layout')) linkedBranches.add(link.branch);
      }
      const stateRank = { ok: 0, unconv: 1, partial: 2, run: 3, err: 4, none: 9 };
      const isPath = (stage) => {
        const b = bundles && bundles[stage.id];
        const kpt = b && b.abacus && b.abacus.kpt;
        // A band calculation lists its k points as a line path; a mesh export does not.
        if (kpt) return kpt.mode === 'explicit' && (!kpt.kMode || /^line/i.test(kpt.kMode));
        return Boolean(stage.task.hasBands);
      };
      const abacus = stages
        .filter((s) => s.role === 'producer' && isPath(s) && (states[s.id] || {}).code !== 'none')
        .map((s) => ({ stage: s, score: (linkedBranches.has(s.branch) ? 0 : 10) + (stateRank[(states[s.id] || {}).code] ?? 5) }))
        .sort((a, b) => a.score - b.score || compareStages(a.stage, b.stage))
        .map((x) => x.stage);
      const librpa = stages
        .filter((s) => (s.role === 'consumer' || s.role === 'coupled') && (states[s.id] || {}).code !== 'none')
        .map((s) => ({ stage: s, score: stateRank[(states[s.id] || {}).code] ?? 5 }))
        .sort((a, b) => a.score - b.score || compareStages(a.stage, b.stage))
        .map((x) => x.stage);
      return { abacus, librpa };
    }

    const BAND_COLORS = ['var(--af-c-qsgw)', 'var(--af-c-exx)', 'var(--af-ok)', 'var(--af-warn)', 'var(--af-db)', 'var(--af-c-abacus)', 'var(--af-err)', 'var(--af-c-ks)'];

    /**
     * Turn the host's band payload into drawable channels.
     *
     * `taskLabel` tags every channel with where it came from, because the comparison basket
     * mixes channels from several tasks and the legend has to say which is which. The key
     * includes the label (and the LibRPA iteration), so `QSGW spin 1` from two runs — or two
     * iterations of one run — can never collapse into one entry.
     */
    function buildBandChannels(data, taskLabel) {
      if (!data) return [];
      const out = [];
      const prefix = taskLabel ? `${taskLabel} · ` : '';
      const nAbacus = (data.abacus || []).length;
      for (const c of data.abacus || []) {
        out.push({
          key: `${taskLabel ?? ''}::abacus-${c.file}-${c.spin}`,
          label: `${prefix}ABACUS ${c.file}${nAbacus > 1 ? ` (spin ${c.spin})` : ''}`,
          shortLabel: `KS s${c.spin}`,
          taskLabel: taskLabel ?? '',
          source: 'abacus',
          kind: 'KS',
          spin: c.spin,
          iter: null,
          file: c.file,
          kpath: c.kpath || [],
          kTicks: c.kTicks || [],
          energies: c.energies || [],
          nBand: c.nBand,
          nKpoint: c.nKpoint,
          minEnergyEv: c.minEnergyEv,
          maxEnergyEv: c.maxEnergyEv,
        });
      }
      for (const c of data.librpa || []) {
        out.push({
          key: `${taskLabel ?? ''}::librpa-${c.kind}-${c.spin}-i${c.iter ?? 'latest'}`,
          label: `${prefix}LibRPA ${c.kind} spin ${c.spin}${c.iter !== null && c.iter !== undefined ? ` · 第 ${c.iter} 次` : ''}`,
          shortLabel: `${c.kind} s${c.spin}${c.iter !== null && c.iter !== undefined ? ` #${c.iter}` : ''}`,
          taskLabel: taskLabel ?? '',
          source: 'librpa',
          kind: c.kind,
          spin: c.spin,
          iter: c.iter ?? null,
          file: c.file,
          kpath: c.kpath || [],
          kTicks: c.kTicks || [],
          energies: c.energies || [],
          nBand: c.nBand,
          nKpoint: c.nKpoint,
          minEnergyEv: c.minEnergyEv,
          maxEnergyEv: c.maxEnergyEv,
        });
      }
      return out;
    }

    /** Line style per (producer, kind, spin): shape carries the identity, not only colour. */
    function bandStyle(channel) {
      const spin2 = channel.spin === 2;
      if (channel.source === 'abacus') {
        return { color: spin2 ? 'color-mix(in srgb, var(--af-c-abacus) 55%, var(--af-bg))' : 'var(--af-c-abacus)', dash: null, width: 1.1 };
      }
      const byKind = {
        KS: { color: 'var(--af-c-ks)', dash: '5 3', width: 1.1 },
        EXX: { color: 'var(--af-c-exx)', dash: '1.5 2.5', width: 1.2 },
        QSGW: { color: 'var(--af-c-qsgw)', dash: null, width: 1.5 },
      };
      const base = byKind[channel.kind] || { color: 'var(--af-c-qsgw)', dash: null, width: 1.3 };
      return spin2 ? { ...base, color: `color-mix(in srgb, ${base.color} 55%, var(--af-bg))` } : base;
    }

    // ----------------------------------------------------------- key numbers ---

    function abacusGapRow(stage, bundle) {
      const abacus = bundle && bundle.abacus;
      const rows = abacus && abacus.log && Array.isArray(abacus.log.iterations) ? abacus.log.iterations : [];
      const row = lastRow(rows, 'gapEv');
      if (!row) return null;
      const kpt = abacus.kpt;
      const sampling = kpt && kpt.mode === 'explicit' && isNum(kpt.nkpts)
        ? `${kpt.nkpts} 个显式 k 点`
        : kpt && Array.isArray(kpt.grid) ? `${kpt.grid.join('×')} 网格` : '';
      return {
        producer: 'abacus',
        stage: stage.rel || stage.name,
        stageId: stage.id,
        quantity: `KS 能隙 E_gap(k) · ${abacus.calculation || '?'}${sampling ? ` · ${sampling}` : ''}`,
        valueEv: row.gapEv,
        source: `${abacus.outputDir ? `${abacus.outputDir}/` : ''}${abacus.logFile || '日志'}`,
        state: null,
        note: '',
      };
    }

    function librpaGapRows(stage, bundle, iteration) {
      const rows = qsgwRows(bundle);
      if (rows.length === 0) return [];
      const librpa = bundle.librpa;
      const source = `${String(librpa.outputDir || 'librpa.d').replace(/\/+$/, '')}/qsgw_iterations.dat`;
      const convergedIter = qsgwConvergedIter(bundle);
      const out = [];
      const first = rows.find((r) => isNum(r.gap_eV)) || null;
      if (first) {
        out.push({
          producer: 'librpa', stage: stage.rel || stage.name, stageId: stage.id,
          quantity: `能隙 · 第 ${first.iter} 次（迭代起点）`, valueEv: first.gap_eV, source, state: null, note: '',
        });
      }
      let pick = iteration !== null && iteration !== undefined ? rows.find((r) => r.iter === iteration && isNum(r.gap_eV)) : null;
      if (!pick) pick = lastRow(rows, 'gap_eV');
      if (pick && pick !== first) {
        const delta = isNum(pick.max_delta_eV) ? `max ΔE ${pick.max_delta_eV.toPrecision(3)} eV` : '';
        out.push({
          producer: 'librpa', stage: stage.rel || stage.name, stageId: stage.id,
          quantity: `QSGW 能隙 · 第 ${pick.iter} 次`,
          valueEv: pick.gap_eV,
          source,
          state: convergedIter === null ? 'unconv' : 'ok',
          note: convergedIter === null ? `未收敛${delta ? `，${delta}` : ''}` : `第 ${convergedIter} 次收敛`,
        });
      }
      return out;
    }

    function libraryGapRows(matches, limit) {
      const out = [];
      for (const record of (matches || []).slice(0, limit || 3)) {
        const pairs = [['GW', record.gwGapEv], ['EXX', record.exxGapEv], ['DFT', record.dftGapEv]].filter(([, v]) => isNum(v));
        for (const [label, value] of pairs) {
          out.push({
            producer: 'db',
            stage: record.id,
            stageId: null,
            quantity: `${label} 能隙 · ${record.formula || record.material || ''}`,
            valueEv: value,
            source: `LibRPA-database · ${record.id}`,
            state: null,
            note: record.confidence === 'high' ? '按 STRU 组成匹配' : record.confidence === 'medium' ? '按目录名匹配，请确认' : '弱匹配',
            // The record's own scope statement: shown on hover, too long for the table.
            detail: record.scope || '',
            confidence: record.confidence || null,
          });
        }
      }
      return out;
    }

    /**
     * Every gap the run's files state, each with the file it came from. Nothing is derived
     * from band indices: ABACUS rows are its own `E_gap(k)` log lines, LibRPA rows are
     * `qsgw_iterations.dat`, database rows are the published summary.
     */
    function gapLedger(run, bundles, iteration, matches) {
      const rows = [];
      for (const stage of run ? run.stages : []) {
        const bundle = bundles && bundles[stage.id];
        if (!bundle) continue;
        if (stage.role === 'producer' || stage.role === 'coupled') {
          const row = abacusGapRow(stage, bundle);
          if (row) rows.push(row);
        }
        if (stage.role === 'consumer' || stage.role === 'coupled') rows.push(...librpaGapRows(stage, bundle, iteration));
      }
      rows.push(...libraryGapRows(matches, 2));
      return rows;
    }

    /**
     * Merge adjacent ledger rows that state the same quantity with the same value from the
     * same kind of file — eight `frozen`/`refresh` variants reporting one 0.558 eV KS gap read
     * better as one row naming all eight stages. Differing values are never merged.
     */
    function collapseLedger(rows) {
      const out = [];
      for (const row of rows || []) {
        const last = out[out.length - 1];
        if (
          last &&
          last.producer === row.producer &&
          row.producer !== 'db' &&
          last.quantity === row.quantity &&
          last.source === row.source &&
          last.state === row.state &&
          isNum(last.valueEv) && isNum(row.valueEv) &&
          Math.abs(last.valueEv - row.valueEv) < 5e-5
        ) {
          last.stages.push(row.stage);
          last.stage = `${last.stages[0]} 等 ${last.stages.length} 个阶段`;
          continue;
        }
        out.push({ ...row, stages: [row.stage] });
      }
      return out;
    }

    // ------------------------------------------------------- agent messages ---

    /**
     * Build the context block a panel question carries.
     *
     * Deliberately explicit about paths and numbers: the agent acts on files, so a vague
     * "this calculation" would force it to search. Everything here is what the panel is
     * already showing, so the question and the screen cannot disagree.
     */
    function buildAskContext(bundle, extra) {
      const task = bundle && bundle.task ? bundle.task : null;
      if (!task) return '';
      const lines = [];
      lines.push('【来自 ABACUS 面板】');
      lines.push(`任务：${task.absPath}`);
      lines.push(`类型：${KIND_LABEL[task.kind] || task.kind}${bundle.status ? `，状态 ${bundle.status.label}` : ''}`);
      if (bundle.abacus) {
        const a = bundle.abacus;
        if (a.calculation) lines.push(`计算：${a.calculation}${a.basisType ? ` / ${a.basisType}` : ''}`);
        if (a.outputDir) lines.push(`输出目录：${a.outputDir}`);
        if (a.stru) lines.push(`结构：${a.stru.natom} 原子，${(a.stru.species || []).map((s) => s.label).join('/')}`);
      }
      if (bundle.librpa) {
        const rows = qsgwRows(bundle);
        lines.push(`LibRPA：${bundle.librpa.task || '?'}${rows.length ? `，qsgw_iterations.dat ${rows.length} 行` : ''}`);
      }
      if (extra) lines.push(extra);
      lines.push('');
      return lines.join('\n');
    }

    /**
     * Shorten a long path for a one-line label, keeping the *tail*.
     *
     * A UNC run path carries its meaning in the last segments
     * (…/from-dongfang/nio-matched-dzp-k666-20261016-r1); truncating from the right would
     * keep only the useless prefix. `direction: rtl` is not a fix — it reorders the
     * backslashes and produced garbled text in the real panel.
     */
    function tailPath(value, maxLength = 52) {
      const text = String(value ?? '');
      if (text.length <= maxLength) return text;
      const tail = text.slice(-(maxLength - 1));
      // Prefer to start at a separator so the label does not begin mid-name.
      const cut = tail.search(/[\\/]/);
      return `…${cut > 0 && cut < 12 ? tail.slice(cut) : tail}`;
    }

    /** What a researcher hands to the agent from a run, offered as one-click intents. */
    function handoffIntents(summary) {
      const s = summary || {};
      const out = [{ id: 'assess', label: '判断能否作为结果使用', text: '请判断这个运行的结果能不能用：逐个阶段核对状态与证据，指出还缺什么。' }];
      if (s.unconverged > 0) out.push({ id: 'unconv', label: '诊断未收敛', text: '有阶段没有收敛。请读日志和迭代表，说明原因，并给出下一步（参数、续算还是换策略）。' });
      if (s.missing > 0) out.push({ id: 'missing', label: '补齐缺失的阶段', text: '有阶段没有输出或证据不全。请确认它们是没跑、没拉回来，还是跑失败了，并说明怎么补。' });
      if (s.hasQsgw && !s.inSeries) out.push({ id: 'kconv', label: '设计 k 收敛研究', text: '请为这个体系设计 k 网格收敛研究：要跑哪些网格、比较哪个量、用什么判据。' });
      if (s.hasLibrary) out.push({ id: 'library', label: '与数据库对照', text: '请把本运行的能隙与 LibRPA 数据库里匹配到的记录对照，解释差异来自哪里（基组、k 网格、方法版本）。' });
      if (s.research) out.push({ id: 'note', label: '记录到 research.md', text: '请用 AITP 的 research_* 工具把这个运行的结论和证据链接记到对应课题的 research.md。' });
      return out;
    }

    /**
     * The run-level message for the agent: what was computed, where the files are, what is
     * missing or suspicious, and what the researcher wants settled. Every number keeps its
     * source file; the AITP line appears only when a research.md was actually found, and says
     * how it was found.
     */
    function buildHandoffMessage(input) {
      const { run, stages, ledger, research, intent, note } = input || {};
      const lines = [];
      lines.push('【来自 ABACUS 面板 · 交给 Agent】');
      if (intent && intent.text) lines.push(`想解决的问题：${intent.text}`);
      if (run) {
        lines.push(`运行：${run.name}`);
        lines.push(`目录：${run.absPath}`);
      }
      const list = stages || [];
      if (list.length > 0) {
        lines.push('阶段（产出 → 消费）：');
        for (const item of list) {
          const facts = [item.facts, item.lineage].filter(Boolean).join(' · ');
          lines.push(`- [${PRODUCER_LABEL[item.producer] || item.producer}] ${item.rel || item.name} · ${item.state.label}${item.state.detail ? `（${item.state.detail}）` : ''}${facts ? ` · ${facts}` : ''}`);
        }
      }
      const numbers = (ledger || []).filter((row) => isNum(row.valueEv));
      if (numbers.length > 0) {
        lines.push('关键数值（括号内为来源文件）：');
        for (const row of numbers) {
          lines.push(`- ${PRODUCER_LABEL[row.producer]} ${row.stage} · ${row.quantity}：${row.valueEv.toFixed(3)} eV（${row.source}）${row.note ? ` · ${row.note}` : ''}`);
        }
      }
      const issues = list.filter((item) => item.state && item.state.code !== 'ok');
      if (issues.length > 0) {
        lines.push('缺失或可疑：');
        for (const item of issues) lines.push(`- ${item.rel || item.name}：${item.state.label}${item.state.detail ? `，${item.state.detail}` : ''}`);
      }
      if (research && research.found) {
        lines.push(`研究笔记：最近的 research.md（从运行目录向上查找得到，不是 AITP 声明的关联）：${research.path}`);
      }
      if (note && String(note).trim()) lines.push(`补充：${String(note).trim()}`);
      lines.push('约束：这条消息来自只读面板。提交作业、改写输入或删除文件之前，请先向我确认。');
      return lines.join('\n');
    }

    /* @pure-end */

    // =====================================================================
    // io: host api, per-browser storage, the agent conversation
    // =====================================================================

    function injectCss() {
      const existing = document.getElementById('abacusflow-css');
      if (existing) {
        // A reloaded bundle must not keep the previous stylesheet.
        if (existing.textContent !== CSS) existing.textContent = CSS;
        return;
      }
      const style = document.createElement('style');
      style.id = 'abacusflow-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    function api(path) {
      return fetch(API + path, { headers: { accept: 'application/json' } }).then((response) => {
        if (!response.ok) {
          return response.text().then((body) => {
            let message = body;
            try {
              const parsed = JSON.parse(body);
              message = parsed.error || parsed.message || body;
            } catch {
              /* keep raw text */
            }
            const error = new Error(`${response.status} ${message}`);
            error.status = response.status;
            throw error;
          });
        }
        return response.json();
      });
    }

    function readStoredRoot() {
      try {
        // A whitespace-only value must not shadow the configured default.
        return (localStorage.getItem(ROOT_STORAGE_KEY) || '').trim();
      } catch {
        return '';
      }
    }

    function storeRoot(value) {
      try {
        localStorage.setItem(ROOT_STORAGE_KEY, value);
      } catch {
        /* private mode */
      }
    }

    /** Forget the pinned path so the plugin's configured default applies again. */
    function clearStoredRoot() {
      try {
        localStorage.removeItem(ROOT_STORAGE_KEY);
      } catch {
        /* private mode */
      }
    }

    /**
     * Where the user was: place, run per scan root, run view, stage tab, k-study path.
     * Per-browser convenience only; the panel works the same with storage blocked.
     */
    function readUiState() {
      try {
        const parsed = JSON.parse(localStorage.getItem(UI_STORAGE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function writeUiState(state) {
      try {
        localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state));
      } catch {
        /* private mode */
      }
    }

    /**
     * Ask the agent a question about the current task, from inside the panel.
     *
     * Uses the session's `beginSubmission`, so the text arrives as a real user message and
     * the agent can then act on it — edit an INPUT, look at a file, check a run. That is the
     * point of asking from the panel rather than in the composer: the question carries the
     * task context, so the user never has to describe which calculation they mean.
     *
     * `beginSubmission` returns a handle immediately; acceptance is not delivery. The
     * `onRetire` callback fires when the Host settles the submission, so a rejection that
     * happens later is reported rather than silently dropped.
     *
     * Falls back to prefilling the composer when no session is bound, because losing the
     * text would be worse than needing one more click.
     *
     * @param {object|null} session the `ISession` face from `sessions.binding(id).session`
     * @param {string} text
     * @param {(outcome:'accepted'|'failed', detail?:string)=>void} [onOutcome]
     * @returns {'submitted'|'prefilled'|'failed'}
     */
    function askAgent(session, text, onOutcome) {
      if (session && typeof session.beginSubmission === 'function') {
        try {
          const handle = session.beginSubmission({
            mode: 'queue',
            text,
            attachments: [],
            onRetire: (retirement) => {
              if (retirement && retirement.reason === 'failed') {
                console.error('[abacusflow] submission was rejected by the host');
                if (onOutcome) onOutcome('failed', 'Host 拒绝了这条消息');
              } else if (onOutcome) {
                onOutcome('accepted');
              }
            },
          });
          if (handle) return 'submitted';
        } catch (error) {
          console.error('[abacusflow] beginSubmission threw:', error);
        }
      }
      return prefillComposer(text) ? 'prefilled' : 'failed';
    }

    /** Put text into the chat composer without sending it. */
    function prefillComposer(text) {
      const textarea = document.querySelector('textarea[data-dsh-composer], .dsh-composer textarea, textarea:not(.af-textarea)');
      if (!textarea) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(textarea, text);
      else textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      try {
        textarea.setSelectionRange(text.length, text.length);
      } catch {
        /* some inputs reject selection */
      }
      return true;
    }

    // ---------------------------------------------------------------- caches ---
    //
    // Bundles and band channels are cached per scan generation: a rescan clears them, so a
    // refreshed run is re-read, while switching between runs and views costs nothing. The
    // host keeps its own stat-stamped caches underneath.

    const bundleCache = new Map();
    const bandCache = new Map();
    let cacheGeneration = 0;

    function clearClientCaches() {
      bundleCache.clear();
      bandCache.clear();
      matchCache.clear();
      cacheGeneration += 1;
    }

    function cached(map, key, load) {
      const hit = map.get(key);
      if (hit) return hit;
      const promise = load().catch((error) => {
        map.delete(key);
        throw error;
      });
      map.set(key, promise);
      return promise;
    }

    function fetchBundle(task, fresh) {
      const key = task.id;
      if (fresh) bundleCache.delete(key);
      return cached(bundleCache, key, () => api(`/task-bundle?id=${encodeURIComponent(task.id)}`));
    }

    /** Two-step band loading: `only=inventory` (~2 KB) first, then one channel at a time. */
    function fetchBands(taskId, only, iteration) {
      const iter = iteration === null || iteration === undefined ? '' : `&iter=${encodeURIComponent(iteration)}`;
      const key = `${taskId}#${only}#${iteration ?? 'latest'}`;
      return cached(bandCache, key, () => api(`/bands?id=${encodeURIComponent(taskId)}${iter}&only=${encodeURIComponent(only)}`));
    }

    const matchCache = new Map();

    /** Database match for a stage with a STRU; shared by the ledger, the handoff and the library. */
    function fetchMatch(taskId) {
      return cached(matchCache, taskId, () => api(`/library/match?id=${encodeURIComponent(taskId)}`));
    }

    // ---------------------------------------------------------------- basket ---

    /**
     * Channels collected from several runs, drawn on one axis: the ad-hoc, cross-run
     * comparison (two materials, two variants). The ABACUS-vs-LibRPA comparison inside one run
     * no longer needs it — that overlay is on by default in the run's results.
     */
    const compareBasket = [];
    const compareListeners = new Set();

    function useCompareBasket() {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force((n) => n + 1);
        compareListeners.add(listener);
        return () => compareListeners.delete(listener);
      }, []);
      return compareBasket;
    }

    function addToCompare(channels) {
      let added = 0;
      for (const channel of channels) {
        if (compareBasket.some((c) => c.key === channel.key)) continue;
        compareBasket.push({ ...channel });
        added += 1;
      }
      if (added > 0) compareListeners.forEach((listener) => listener());
      return added;
    }

    function removeFromCompare(key) {
      const index = compareBasket.findIndex((c) => c.key === key);
      if (index >= 0) {
        compareBasket.splice(index, 1);
        compareListeners.forEach((listener) => listener());
      }
    }

    function clearCompare() {
      compareBasket.length = 0;
      compareListeners.forEach((listener) => listener());
    }

    // ----------------------------------------------------------------- hooks ---

    /** The element's content width, tracked with ResizeObserver. */
    function useWidth(fallback) {
      const ref = useRef(null);
      const [width, setWidth] = useState(fallback || 0);
      useEffect(() => {
        const node = ref.current;
        if (!node) return undefined;
        setWidth(Math.round(node.getBoundingClientRect().width) || fallback || 0);
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) setWidth(Math.round(entry.contentRect.width));
        });
        observer.observe(node);
        return () => observer.disconnect();
      }, []);
      return [ref, width];
    }

    /**
     * Load a JSON resource keyed by `key`; a stale response (key changed meanwhile) is dropped.
     * `key === null` means "nothing to load".
     */
    function useApi(key, load) {
      const [state, setState] = useState({ key: null, data: null, error: null, loading: false });
      useEffect(() => {
        if (key === null || key === undefined) {
          setState({ key: null, data: null, error: null, loading: false });
          return undefined;
        }
        let live = true;
        setState((prev) => ({ key, data: prev.key === key ? prev.data : null, error: null, loading: true }));
        Promise.resolve()
          .then(load)
          .then((data) => {
            if (live) setState({ key, data, error: null, loading: false });
          })
          .catch((error) => {
            if (live) setState({ key, data: null, error: String((error && error.message) || error), loading: false });
          });
        return () => {
          live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [key]);
      return state;
    }

    /**
     * Bundles for every stage of the open run, three requests at a time, so the pipeline can
     * show each stage's real state and what it produced. ~11–60 KiB and ~50–250 ms per stage
     * on the sample data; the host caches them by file stamps.
     */
    function useStageBundles(stages, refreshTick) {
      const [state, setState] = useState({ byId: {}, errors: {} });
      const ids = stages.map((s) => s.id).join('|');
      useEffect(() => {
        let live = true;
        setState({ byId: {}, errors: {} });
        const queue = stages.slice();
        // Consumers first: their lineage decides which producer the plot uses.
        queue.sort((a, b) => (a.role === 'producer' ? 1 : 0) - (b.role === 'producer' ? 1 : 0));
        let next = 0;
        const worker = async () => {
          while (live && next < queue.length) {
            const stage = queue[next];
            next += 1;
            try {
              const bundle = await fetchBundle(stage.task, false);
              if (live) setState((prev) => ({ ...prev, byId: { ...prev.byId, [stage.id]: bundle } }));
            } catch (error) {
              if (live) setState((prev) => ({ ...prev, errors: { ...prev.errors, [stage.id]: String(error.message || error) } }));
            }
          }
        };
        worker();
        worker();
        worker();
        return () => {
          live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ids, cacheGeneration]);

      // A stage the host reports as running is re-read every 10 s while the run is open.
      useEffect(() => {
        if (!refreshTick) return;
        const running = stages.filter((s) => {
          const b = state.byId[s.id];
          return b && b.status && b.status.code === 'RUNNING';
        });
        for (const stage of running) {
          fetchBundle(stage.task, true)
            .then((bundle) => setState((prev) => ({ ...prev, byId: { ...prev.byId, [stage.id]: bundle } })))
            .catch(() => {
              /* keep the last good bundle */
            });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [refreshTick]);

      return state;
    }

    /** A ticking counter while the document is visible, for polling running stages. */
    function useVisibleTick(intervalMs, enabled) {
      const [tick, setTick] = useState(0);
      useEffect(() => {
        if (!enabled) return undefined;
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.hidden) return;
          setTick((n) => n + 1);
        }, intervalMs);
        return () => clearInterval(timer);
      }, [intervalMs, enabled]);
      return tick;
    }

    /**
     * Band channels wanted by a plot: `[{ id, taskId, only, iteration, label }]`. Each request
     * is cached, so toggling a channel off and on again does not refetch.
     */
    function useBandRequests(requests) {
      const [state, setState] = useState({});
      const signature = requests.map((r) => `${r.id}=${r.taskId}#${r.only}#${r.iteration ?? 'latest'}`).join('|');
      useEffect(() => {
        let live = true;
        for (const request of requests) {
          setState((prev) => (prev[request.id] && prev[request.id].sig === sigOf(request)
            ? prev
            : { ...prev, [request.id]: { sig: sigOf(request), loading: true, data: null, error: null } }));
          fetchBands(request.taskId, request.only, request.iteration)
            .then((data) => {
              if (!live) return;
              setState((prev) => ({ ...prev, [request.id]: { sig: sigOf(request), loading: false, data, error: null } }));
            })
            .catch((error) => {
              if (!live) return;
              setState((prev) => ({ ...prev, [request.id]: { sig: sigOf(request), loading: false, data: null, error: String(error.message || error) } }));
            });
        }
        return () => {
          live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [signature]);
      const out = {};
      for (const request of requests) {
        const entry = state[request.id];
        out[request.id] = entry && entry.sig === sigOf(request) ? entry : { loading: true, data: null, error: null };
      }
      return out;
    }

    function sigOf(request) {
      return `${request.taskId}#${request.only}#${request.iteration ?? 'latest'}`;
    }

    // =====================================================================
    // primitives
    // =====================================================================

    function cx(...names) {
      return names.filter(Boolean).join(' ');
    }

    /** 16-px inline icons; strokes follow `currentColor`. */
    const ICONS = {
      chevronRight: ['M6 3.5 10.5 8 6 12.5'],
      chevronLeft: ['M10 3.5 5.5 8 10 12.5'],
      chevronDown: ['M3.5 6 8 10.5 12.5 6'],
      arrowRight: ['M2.5 8h10', 'M9 4.5 12.5 8 9 11.5'],
      refresh: ['M13.2 8a5.2 5.2 0 1 1-1.5-3.7', 'M13.2 2.8v2.6h-2.6'],
      send: ['M2.6 7.6 13.4 2.6 9.2 13.4 7.6 9.4z', 'M7.6 9.4 13.4 2.6'],
      plus: ['M8 3.2v9.6', 'M3.2 8h9.6'],
      close: ['M4.2 4.2l7.6 7.6', 'M11.8 4.2l-7.6 7.6'],
      info: ['M8 7.2v4', 'M8 4.8h.01', 'M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4z'],
      warn: ['M8 2.2 14.2 13H1.8z', 'M8 6.4v3.2', 'M8 11.2h.01'],
      loop: ['M2.8 8a5.2 5.2 0 0 1 9-3.6l1.4 1.4', 'M13.2 2.6v3.2H10', 'M13.2 8a5.2 5.2 0 0 1-9 3.6l-1.4-1.4', 'M2.8 13.4v-3.2H6'],
      plot: ['M2.5 13.5h11', 'M2.5 13.5v-11', 'M4.5 10.5c2-5 4-5 6 0 1 2.4 2 2.4 3 0'],
      book: ['M3 2.8h6.6a2 2 0 0 1 2 2v8.4H5a2 2 0 0 1-2-2z', 'M3 11.2a2 2 0 0 1 2-2h6.6'],
      basket: ['M2.4 6h11.2l-1.3 7H3.7z', 'M5.6 6 8 2.6 10.4 6'],
      agent: ['M8 2.2v1.6', 'M4.4 5.2h7.2a1.4 1.4 0 0 1 1.4 1.4v4.6a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 11.2V6.6a1.4 1.4 0 0 1 1.4-1.4z', 'M6.2 8.6h.01', 'M9.8 8.6h.01'],
      folder: ['M2.2 4.4a1.2 1.2 0 0 1 1.2-1.2h2.8l1.4 1.6h5a1.2 1.2 0 0 1 1.2 1.2v6.4a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2z'],
      copy: ['M5.4 5.4h7.2v7.2H5.4z', 'M3.4 10.6V3.4h7.2'],
      search: ['M7 12.2A5.2 5.2 0 1 0 7 1.8a5.2 5.2 0 0 0 0 10.4z', 'M10.8 10.8l3.4 3.4'],
      layers: ['M8 2.2 14 5.4 8 8.6 2 5.4z', 'M2 8.2 8 11.4l6-3.2', 'M2 11 8 14.2 14 11'],
    };

    function Icon16(props) {
      const size = props.size || 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: props.style,
        },
        (ICONS[props.name] || []).map((d, i) => h('path', { key: i, d })),
      );
    }

    /**
     * One glyph shape per state, so state never rests on colour alone:
     * check-in-circle, triangle, half-filled ring, hollow ring, ×-in-square, dashed ring.
     */
    function StateGlyph(props) {
      const code = props.code || 'none';
      const size = props.size || 12;
      const common = { width: size, height: size, viewBox: '0 0 12 12', className: `af-glyph-${code}`, 'aria-hidden': 'true' };
      const knock = { stroke: 'var(--af-bg)', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' };
      switch (code) {
        case 'ok':
          return h('svg', common,
            h('circle', { cx: 6, cy: 6, r: 5.6, style: { fill: 'currentColor' } }),
            h('path', { d: 'M3.5 6.2 5.2 7.9 8.6 4.3', style: knock }));
        case 'unconv':
          return h('svg', common,
            h('path', { d: 'M6 .7 11.5 10.8H.5Z', style: { fill: 'currentColor' } }),
            h('path', { d: 'M6 4.3v3.1', style: knock }),
            h('circle', { cx: 6, cy: 9.1, r: 0.8, style: { fill: 'var(--af-bg)' } }));
        case 'run':
          return h('svg', common,
            h('circle', { cx: 6, cy: 6, r: 4.9, style: { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 } }),
            h('path', { d: 'M6 1.1A4.9 4.9 0 0 1 6 10.9Z', style: { fill: 'currentColor' } }));
        case 'err':
          return h('svg', common,
            h('rect', { x: 0.6, y: 0.6, width: 10.8, height: 10.8, rx: 2.4, style: { fill: 'currentColor' } }),
            h('path', { d: 'M4 4l4 4M8 4 4 8', style: knock }));
        case 'partial':
          return h('svg', common,
            h('circle', { cx: 6, cy: 6, r: 4.9, style: { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeDasharray: '2.1 1.7' } }),
            h('circle', { cx: 6, cy: 6, r: 1.7, style: { fill: 'currentColor' } }));
        default:
          return h('svg', common, h('circle', { cx: 6, cy: 6, r: 4.9, style: { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 } }));
      }
    }

    function StateBadge(props) {
      const state = props.state;
      if (!state) return null;
      return h(
        'span',
        { className: 'af-state', 'data-s': state.code, title: state.detail ? `${state.label}：${state.detail}` : state.label },
        h(StateGlyph, { code: state.code }),
        props.compact ? null : h('span', { className: 'af-state-label' }, state.label),
      );
    }

    /** Producer identity: square = ABACUS, circle = LibRPA, diamond = database. */
    function ProducerGlyph(props) {
      const p = props.producer;
      const style = { fill: 'currentColor' };
      return h(
        'svg',
        { width: 8, height: 8, viewBox: '0 0 8 8', 'aria-hidden': 'true' },
        p === 'librpa'
          ? h('circle', { cx: 4, cy: 4, r: 3.4, style })
          : p === 'db'
            ? h('path', { d: 'M4 .4 7.6 4 4 7.6.4 4Z', style })
            : h('rect', { x: 0.8, y: 0.8, width: 6.4, height: 6.4, rx: 1.2, style }),
      );
    }

    function ProducerTag(props) {
      return h(
        'span',
        { className: 'af-prod', 'data-p': props.producer, title: props.title },
        h(ProducerGlyph, { producer: props.producer }),
        PRODUCER_LABEL[props.producer] || props.producer,
        props.stage ? h('span', { className: 'af-prod-stage' }, `· ${props.stage}`) : null,
      );
    }

    function producerOf(stage) {
      return stage && stage.role === 'consumer' ? 'librpa' : 'abacus';
    }

    /**
     * A titled block.
     *
     * `collapsible` makes the header a toggle whose state is remembered per `persistKey` in
     * the browser. The results page has more material than any single reading needs, so the
     * detail blocks start closed (`defaultOpen={false}`) and the reader opens what they came
     * for; the primary plot stays open.
     */
    function Section(props) {
      const { collapsible, defaultOpen = true, persistKey } = props;
      const storageKey = persistKey ? `abacusflow:section:${persistKey}` : null;
      const [open, setOpen] = useState(() => {
        if (!collapsible) return true;
        if (storageKey) {
          try {
            const stored = localStorage.getItem(storageKey);
            if (stored === '1') return true;
            if (stored === '0') return false;
          } catch {
            /* private mode */
          }
        }
        return defaultOpen;
      });
      const toggle = () => {
        if (!collapsible) return;
        const next = !open;
        setOpen(next);
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, next ? '1' : '0');
          } catch {
            /* private mode */
          }
        }
      };
      return h(
        'section',
        { className: 'af-section', id: props.id },
        h(
          'div',
          {
            className: `af-section-head${collapsible ? ' af-section-head-btn' : ''}`,
            onClick: collapsible ? toggle : undefined,
            role: collapsible ? 'button' : undefined,
            tabIndex: collapsible ? 0 : undefined,
            'aria-expanded': collapsible ? (open ? 'true' : 'false') : undefined,
            onKeyDown: collapsible
              ? (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    toggle();
                  }
                }
              : undefined,
          },
          collapsible ? h(Icon16, { name: open ? 'chevronDown' : 'chevronRight', size: 12 }) : null,
          h('h3', { className: 'af-section-title' }, props.title),
          props.meta ? h('span', { className: 'af-section-meta' }, props.meta) : null,
          props.actions ? h('div', { className: 'af-section-actions' }, props.actions) : null,
        ),
        collapsible ? (open ? props.children : null) : props.children,
      );
    }

    function Empty(props) {
      return h(
        'div',
        { className: 'af-empty' },
        props.title ? h('span', { className: 'af-empty-title' }, props.title) : null,
        props.children,
      );
    }

    function Note(props) {
      const tone = props.tone || 'info';
      return h(
        'div',
        { className: 'af-note', 'data-tone': tone },
        h(Icon16, { name: tone === 'info' ? 'info' : 'warn', size: 14 }),
        h('div', { style: { minWidth: 0 } }, props.children),
      );
    }

    function Spinner() {
      return h('span', { className: 'af-spin', 'aria-hidden': 'true' });
    }

    function Loading(props) {
      return h('div', { className: 'af-empty' }, h(Spinner), props.children || '读取中…');
    }

    function Seg(props) {
      return h(
        'div',
        { className: 'af-seg', role: 'group', 'aria-label': props.label },
        props.options.map((option) =>
          h(
            'button',
            {
              key: String(option.value),
              type: 'button',
              'data-active': option.value === props.value ? 'true' : undefined,
              'aria-pressed': option.value === props.value ? 'true' : 'false',
              disabled: option.disabled,
              title: option.title,
              onClick: () => props.onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    function Btn(props) {
      const { kind, size, icon, children, className, ...rest } = props;
      return h(
        'button',
        {
          type: 'button',
          className: cx('af-btn', kind && `af-btn-${kind}`, size === 'sm' && 'af-btn-sm', !children && icon && 'af-btn-icon', className),
          ...rest,
        },
        icon ? h(Icon16, { name: icon, size: size === 'sm' ? 14 : 16 }) : null,
        children,
      );
    }

    function KV(props) {
      return h(
        'dl',
        { className: 'af-kv' },
        props.rows.filter(Boolean).flatMap(([key, value], index) => [
          h('dt', { key: `k${index}` }, key),
          h('dd', { key: `v${index}` }, value === null || value === undefined || value === '' ? '—' : value),
        ]),
      );
    }

    function LineSwatch(props) {
      return h(
        'svg',
        { width: 18, height: 6, 'aria-hidden': 'true', style: { flex: 'none' } },
        h('line', { x1: 1, y1: 3, x2: 17, y2: 3, style: { stroke: props.color, strokeWidth: Math.max(1.6, props.width || 1.6), strokeDasharray: props.dash || undefined } }),
      );
    }

    // =====================================================================
    // charts
    // =====================================================================

    let chartSerial = 0;
    function useChartId() {
      const ref = useRef(null);
      if (ref.current === null) {
        chartSerial += 1;
        ref.current = `afc${chartSerial}`;
      }
      return ref.current;
    }

    /**
     * Line chart for convergence traces. The SVG takes the container's real width, so tick
     * text is never stretched. A record missing from the sequence breaks the line rather than
     * drawing a segment that was never computed.
     *
     * series: [{ name, color, dash, points:[{x,y}] }]
     */
    function LineChart(props) {
      const series = props.series || [];
      const height = props.height || 170;
      const [ref, width] = useWidth(480);
      const w = Math.max(220, width || 480);
      const padL = 54;
      const padR = 12;
      const padT = props.yLabel ? 18 : 8;
      const padB = 26;
      const clip = useChartId();

      const all = series.flatMap((s) => s.points || []).filter((p) => isNum(p.x) && isNum(p.y));
      let body = null;
      if (all.length === 0) {
        body = h('div', { className: 'af-empty' }, props.empty || '暂无数据');
      } else {
        let xMin = Math.min(...all.map((p) => p.x));
        let xMax = Math.max(...all.map((p) => p.x));
        if (xMax === xMin) {
          xMin -= 0.5;
          xMax += 0.5;
        }
        let yMin = Math.min(...all.map((p) => p.y));
        let yMax = Math.max(...all.map((p) => p.y));
        if (yMax === yMin) {
          const pad = Math.abs(yMax) > 1e-12 ? Math.abs(yMax) * 0.05 : 0.5;
          yMin -= pad;
          yMax += pad;
        } else {
          const pad = (yMax - yMin) * 0.08;
          yMin -= pad;
          yMax += pad;
        }
        const plotW = w - padL - padR;
        const plotH = height - padT - padB;
        const sx = (x) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
        const sy = (y) => padT + (1 - (y - yMin) / (yMax - yMin)) * plotH;
        const yTicks = ticksFor(yMin, yMax, Math.max(3, Math.round(plotH / 34))).ticks;
        const integerX = all.every((p) => Number.isInteger(p.x));
        let xTicks = ticksFor(xMin, xMax, Math.max(2, Math.round(plotW / 70))).ticks;
        if (integerX) xTicks = xTicks.filter((t) => Number.isInteger(t));
        const fy = props.formatY || ((v) => String(Number(v.toPrecision(4))));
        const fx = props.formatX || ((v) => String(v));
        const showPoints = all.length <= 60;

        body = h(
          'svg',
          { className: 'af-chart', width: w, height, viewBox: `0 0 ${w} ${height}`, role: 'img', 'aria-label': props.ariaLabel },
          h('defs', null, h('clipPath', { id: clip }, h('rect', { x: padL, y: padT, width: plotW, height: plotH }))),
          h('rect', { className: 'af-plot-bg', x: padL, y: padT, width: plotW, height: plotH, rx: 4 }),
          yTicks.map((t) =>
            h('g', { key: `y${t}` },
              h('line', { className: 'af-grid', x1: padL, x2: padL + plotW, y1: sy(t), y2: sy(t) }),
              h('text', { x: padL - 6, y: sy(t) + 3.5, textAnchor: 'end' }, fy(t))),
          ),
          xTicks.map((t) => h('text', { key: `x${t}`, x: sx(t), y: height - padB + 15, textAnchor: 'middle' }, fx(t))),
          props.yLabel ? h('text', { className: 'af-axis-title', x: padL, y: 11, textAnchor: 'start' }, props.yLabel) : null,
          props.xLabel ? h('text', { className: 'af-axis-title', x: padL + plotW, y: height - 2, textAnchor: 'end' }, props.xLabel) : null,
          isNum(props.markerX) && props.markerX >= xMin && props.markerX <= xMax
            ? h('line', { className: 'af-marker', x1: sx(props.markerX), x2: sx(props.markerX), y1: padT, y2: padT + plotH })
            : null,
          h(
            'g',
            { clipPath: `url(#${clip})` },
            series.map((s, index) => {
              const pts = (s.points || []).filter((p) => isNum(p.x) && isNum(p.y));
              if (pts.length === 0) return null;
              let d = '';
              let prev = null;
              for (const p of pts) {
                d += `${prev === null || p.x - prev > 1.5 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)} `;
                prev = p.x;
              }
              return h('path', {
                key: `s${index}`,
                d,
                style: { fill: 'none', stroke: s.color || BAND_COLORS[index % BAND_COLORS.length], strokeWidth: s.width || 1.6, strokeDasharray: s.dash || undefined },
                strokeLinejoin: 'round',
                strokeLinecap: 'round',
              });
            }),
          ),
          showPoints
            ? series.map((s, index) =>
                (s.points || []).filter((p) => isNum(p.x) && isNum(p.y)).map((p) =>
                  h('circle', {
                    key: `p${index}-${p.x}`,
                    className: props.onPickX ? 'af-point' : undefined,
                    cx: sx(p.x),
                    cy: sy(p.y),
                    r: props.markerX === p.x ? 3.6 : 2.2,
                    style: { fill: props.markerX === p.x ? (s.color || 'var(--af-accent)') : 'var(--af-bg)', stroke: s.color || BAND_COLORS[index % BAND_COLORS.length], strokeWidth: 1.3 },
                    onClick: props.onPickX ? () => props.onPickX(p.x) : undefined,
                  }, h('title', null, `${s.name}：${fx(p.x)} → ${fy(p.y)}`)),
                ),
              )
            : null,
        );
      }

      return h(
        'div',
        { className: 'af-chart-wrap', ref },
        body,
        series.length > 1 && all.length > 0
          ? h(
              'div',
              { className: 'af-legend' },
              series.map((s, i) =>
                h('span', { key: `l${i}`, className: 'af-legend-item' },
                  h(LineSwatch, { color: s.color || BAND_COLORS[i % BAND_COLORS.length], dash: s.dash }),
                  s.name),
              ),
            )
          : null,
      );
    }

    /**
     * Merge high-symmetry labels that would collide on screen into "A|B", keeping each
     * label's own grid line. Labels are drawn as written in the KPT file (G stays G).
     */
    function layoutTicks(ticks, sx, minGap) {
      const placed = [];
      const sorted = (ticks || []).filter((t) => isNum(t.position)).slice().sort((a, b) => a.position - b.position);
      for (const tick of sorted) {
        const x = sx(tick.position);
        const last = placed[placed.length - 1];
        if (last && x - last.x < minGap) {
          if (!last.labels.includes(tick.label)) last.labels.push(tick.label);
        } else {
          placed.push({ x, labels: [tick.label] });
        }
      }
      return { lines: sorted.map((t) => sx(t.position)), labels: placed };
    }

    /**
     * E(k) plot.
     *
     * `series` arrive already aligned onto the reference k axis (alignChannel decides how);
     * each series is drawn as ONE <path> holding every band as a sub-path, which keeps
     * 80 bands × several channels cheap to redraw when the window moves. Lines are clipped
     * at the window edge instead of being stopped short of it.
     */
    function BandChart(props) {
      const { series, ticks, xMin, xMax, lo, hi } = props;
      const height = props.height || 380;
      const [ref, width] = useWidth(640);
      const w = Math.max(260, width || 640);
      const padL = 46;
      const padR = 10;
      const padT = 18;
      const padB = 28;
      const plotW = w - padL - padR;
      const plotH = height - padT - padB;
      const clip = useChartId();
      const span = hi - lo || 1;
      const sx = (k) => padL + ((k - xMin) / (xMax - xMin || 1)) * plotW;
      const sy = (e) => padT + (1 - (e - lo) / span) * plotH;

      const paths = useMemo(() => {
        const out = [];
        const margin = span * 0.5;
        for (const s of series || []) {
          const xs = s.xs || [];
          const energies = s.energies || [];
          const nBand = s.nBand || (energies[0] ? energies[0].length : 0);
          let d = '';
          for (let band = 0; band < nBand; band += 1) {
            let pen = false;
            for (let i = 0; i < energies.length && i < xs.length; i += 1) {
              const e = energies[i] ? energies[i][band] : undefined;
              if (!isNum(e) || e < lo - margin || e > hi + margin) {
                pen = false;
                continue;
              }
              d += `${pen ? 'L' : 'M'}${sx(xs[i]).toFixed(1)},${sy(e).toFixed(1)}`;
              pen = true;
            }
          }
          if (d) out.push({ key: s.key, d, color: s.color, dash: s.dash, width: s.width });
        }
        return out;
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [series, lo, hi, w, height, xMin, xMax]);

      const yt = ticksFor(lo, hi, Math.max(4, Math.round(plotH / 40)));
      const digits = yt.step < 0.1 ? 2 : yt.step < 1 ? 1 : 0;
      const kt = layoutTicks(ticks, sx, 18);

      return h(
        'div',
        { className: 'af-chart-wrap', ref },
        h(
          'svg',
          { className: 'af-chart', width: w, height, viewBox: `0 0 ${w} ${height}`, role: 'img', 'aria-label': props.ariaLabel || '能带图' },
          h('defs', null, h('clipPath', { id: clip }, h('rect', { x: padL, y: padT, width: plotW, height: plotH }))),
          h('rect', { className: 'af-plot-bg', x: padL, y: padT, width: plotW, height: plotH, rx: 4 }),
          yt.ticks.map((t) =>
            h('g', { key: `y${t}` },
              h('line', { className: 'af-grid', x1: padL, x2: padL + plotW, y1: sy(t), y2: sy(t) }),
              h('text', { x: padL - 6, y: sy(t) + 3.5, textAnchor: 'end' }, t.toFixed(digits))),
          ),
          h('text', { className: 'af-axis-title', x: padL - 6, y: 11, textAnchor: 'end' }, 'E / eV'),
          kt.lines.map((x, i) => h('line', { key: `kl${i}`, className: 'af-kline', x1: x, x2: x, y1: padT, y2: padT + plotH })),
          kt.labels.map((label, i) =>
            h('text', { key: `kt${i}`, className: 'af-tick-label', x: label.x, y: padT + plotH + 17, textAnchor: 'middle' }, label.labels.join('|')),
          ),
          kt.labels.length === 0
            ? h('text', { className: 'af-axis-title', x: padL + plotW, y: padT + plotH + 17, textAnchor: 'end' }, 'k 路径（无高对称点标签）')
            : null,
          h(
            'g',
            { clipPath: `url(#${clip})` },
            paths.map((p) =>
              h('path', {
                key: p.key,
                d: p.d,
                style: { fill: 'none', stroke: p.color, strokeWidth: p.width || 1.2, strokeDasharray: p.dash || undefined },
                strokeLinejoin: 'round',
              }),
            ),
            (props.refLines || []).filter((r) => isNum(r.energy) && r.energy >= lo && r.energy <= hi).map((r, i) =>
              h('g', { key: `r${i}` },
                h('line', { x1: padL, x2: padL + plotW, y1: sy(r.energy), y2: sy(r.energy), style: { stroke: r.color, strokeWidth: 1, strokeDasharray: '6 4', opacity: 0.9 } }),
                h('text', { className: 'af-ref-label', x: padL + plotW - 4, y: sy(r.energy) - 4 - i * 0, textAnchor: 'end', style: { fill: r.color } }, r.label)),
            ),
          ),
        ),
      );
    }

    // =====================================================================
    // structure viewer (canvas 2D projection — no three.js)
    // =====================================================================

    function StructureViewer(props) {
      const scene = props.scene;
      const canvasRef = useRef(null);
      const wrapRef = useRef(null);
      const stateRef = useRef({ yaw: -0.55, pitch: -0.35, zoom: 1, dragging: false, lastX: 0, lastY: 0 });
      const [size, setSize] = useState({ w: 480, h: 360 });

      // Track the container width so the canvas stays sharp and laid out.
      useEffect(() => {
        const node = wrapRef.current;
        if (!node || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const w = Math.max(240, Math.round(entry.contentRect.width));
            setSize({ w, h: Math.min(460, Math.max(260, Math.round(w * 0.68))) });
          }
        });
        observer.observe(node);
        return () => observer.disconnect();
      }, []);

      const draw = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas || !scene) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = window.devicePixelRatio || 1;
        const w = size.w;
        const ht = size.h;
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(ht * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${ht}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, ht);

        const atoms = scene.atoms || [];
        const cell = scene.cell;

        // Centre on the atom cloud (or the cell centre when empty).
        let cx0 = 0;
        let cy0 = 0;
        let cz0 = 0;
        if (atoms.length > 0) {
          for (const a of atoms) {
            cx0 += a.cartesian[0];
            cy0 += a.cartesian[1];
            cz0 += a.cartesian[2];
          }
          cx0 /= atoms.length;
          cy0 /= atoms.length;
          cz0 /= atoms.length;
        } else if (cell) {
          cx0 = (cell[0][0] + cell[1][0] + cell[2][0]) / 2;
          cy0 = (cell[0][1] + cell[1][1] + cell[2][1]) / 2;
          cz0 = (cell[0][2] + cell[1][2] + cell[2][2]) / 2;
        }

        // Fit: the largest distance from the centre sets the scale.
        let extent = 1;
        const consider = (p) => {
          const d = Math.hypot(p[0] - cx0, p[1] - cy0, p[2] - cz0);
          if (d > extent) extent = d;
        };
        const corner = (a, b, c) => [
          a * cell[0][0] + b * cell[1][0] + c * cell[2][0],
          a * cell[0][1] + b * cell[1][1] + c * cell[2][1],
          a * cell[0][2] + b * cell[1][2] + c * cell[2][2],
        ];
        if (cell) {
          for (const a of [0, 1]) for (const b of [0, 1]) for (const c of [0, 1]) consider(corner(a, b, c));
        }
        for (const a of atoms) consider(a.cartesian);

        const { yaw, pitch, zoom } = stateRef.current;
        const cosY = Math.cos(yaw);
        const sinY = Math.sin(yaw);
        const cosP = Math.cos(pitch);
        const sinP = Math.sin(pitch);
        const project = (p) => {
          const x = p[0] - cx0;
          const y = p[1] - cy0;
          const z = p[2] - cz0;
          // yaw about y, then pitch about x
          const x1 = x * cosY + z * sinY;
          const z1 = -x * sinY + z * cosY;
          const y2 = y * cosP - z1 * sinP;
          const z2 = y * sinP + z1 * cosP;
          const scale = (Math.min(w, ht) * 0.42 * zoom) / extent;
          return { x: w / 2 + x1 * scale, y: ht / 2 - y2 * scale, z: z2 };
        };

        if (cell) {
          const edges = [];
          for (const b of [0, 1]) for (const c of [0, 1]) edges.push([corner(0, b, c), corner(1, b, c)]);
          for (const a of [0, 1]) for (const c of [0, 1]) edges.push([corner(a, 0, c), corner(a, 1, c)]);
          for (const a of [0, 1]) for (const b of [0, 1]) edges.push([corner(a, b, 0), corner(a, b, 1)]);
          ctx.save();
          ctx.strokeStyle = 'rgba(140,150,165,.72)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          for (const [p, q] of edges) {
            const a = project(p);
            const b = project(q);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
          ctx.restore();
        }

        // Bonds behind atoms.
        ctx.save();
        ctx.strokeStyle = 'rgba(150,158,170,.85)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        for (const bond of scene.bonds || []) {
          const a = atoms[bond.i];
          const b = atoms[bond.j];
          if (!a || !b) continue;
          const pa = project(a.cartesian);
          const pb = project(b.cartesian);
          ctx.beginPath();
          ctx.moveTo(pa.x, pa.y);
          ctx.lineTo(pb.x, pb.y);
          ctx.stroke();
        }
        ctx.restore();

        // Atoms, painted back to front.
        const painted = atoms.map((atom) => ({ atom, p: project(atom.cartesian) })).sort((u, v) => u.p.z - v.p.z);
        for (const item of painted) {
          const depthScale = 1 + Math.max(-0.22, Math.min(0.22, -item.p.z * 0.018));
          const r = Math.max(2.4, Math.min(22, (item.atom.radius || 1.2) * 5.2 * depthScale * Math.min(2.6, zoom)));
          ctx.beginPath();
          ctx.arc(item.p.x, item.p.y, r, 0, Math.PI * 2);
          ctx.fillStyle = item.atom.color || '#b0b0b0';
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = 'rgba(40,46,56,.45)';
          ctx.stroke();
          // Highlight so dark elements stay visible on a dark background.
          ctx.beginPath();
          ctx.arc(item.p.x - r * 0.28, item.p.y - r * 0.3, r * 0.34, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,.26)';
          ctx.fill();
        }

        if (painted.length <= 60) {
          ctx.save();
          ctx.font = '10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          for (const item of painted) {
            const r = Math.max(2.4, Math.min(22, (item.atom.radius || 1.2) * 5.2 * Math.min(2.6, zoom)));
            if (r < 7) continue;
            ctx.fillStyle = 'rgba(20,24,30,.78)';
            ctx.fillText(item.atom.element, item.p.x, item.p.y + 0.5);
          }
          ctx.restore();
        }
      }, [scene, size]);

      useEffect(() => {
        draw();
      }, [draw]);

      const onPointerDown = (event) => {
        stateRef.current.dragging = true;
        stateRef.current.lastX = event.clientX;
        stateRef.current.lastY = event.clientY;
        if (event.currentTarget.setPointerCapture) {
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            /* some browsers refuse; dragging still works */
          }
        }
      };
      const onPointerMove = (event) => {
        const state = stateRef.current;
        if (!state.dragging) return;
        state.yaw += (event.clientX - state.lastX) * 0.01;
        state.pitch = Math.max(-1.45, Math.min(1.45, state.pitch + (event.clientY - state.lastY) * 0.01));
        state.lastX = event.clientX;
        state.lastY = event.clientY;
        draw();
      };
      const onPointerUp = () => {
        stateRef.current.dragging = false;
      };
      const onWheel = (event) => {
        event.preventDefault();
        const state = stateRef.current;
        state.zoom = Math.max(0.25, Math.min(8, state.zoom * (event.deltaY > 0 ? 0.92 : 1.08)));
        draw();
      };
      const onReset = () => {
        stateRef.current = { yaw: -0.55, pitch: -0.35, zoom: 1, dragging: false, lastX: 0, lastY: 0 };
        draw();
      };

      if (!scene || !scene.atoms || scene.atoms.length === 0) {
        return h(Empty, { title: '没有可显示的结构' }, '这个阶段没有可解析的 STRU。');
      }

      return h(
        'div',
        { className: 'af-struct', ref: wrapRef },
        h('canvas', {
          ref: canvasRef,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerLeave: onPointerUp,
          onWheel,
          onDoubleClick: onReset,
          title: '拖动旋转 · 滚轮缩放 · 双击复位',
        }),
        h(
          'div',
          { className: 'af-struct-caption' },
          h('span', null, `分子式 ${scene.formula || '—'}`),
          h('span', null, `原子 ${scene.natom}`),
          h('span', null, `体积 ${scene.volume ? scene.volume.toFixed(3) : '—'} Å³`),
          h('span', null, `成键 ${(scene.bonds || []).length}`),
          scene.connectivityLimited ? h('span', { style: { color: 'var(--af-warn-text)' } }, '原子过多，已跳过成键分析') : null,
        ),
        (scene.warnings || []).length > 0 ? h('div', { className: 'af-notes' }, scene.warnings.map((w, i) => h('div', { key: i }, w))) : null,
      );
    }

    // =====================================================================
    // runs: list, picker, pipeline, header
    // =====================================================================

    function kptText(kpt) {
      if (!kpt) return '';
      if (kpt.mode === 'explicit' && isNum(kpt.nkpts)) {
        return kpt.kMode && /^line/i.test(kpt.kMode) ? `${kpt.nkpts} 点 k 路径` : `${kpt.nkpts} 个显式 k 点`;
      }
      if (Array.isArray(kpt.grid)) return `k ${kpt.grid.join('×')}`;
      return '';
    }

    /** What a stage produced, in one line, from its own files only. */
    function stageFacts(stage, bundle) {
      if (!bundle) return stage.task.outputDir || '读取中…';
      const parts = [];
      const a = bundle.abacus;
      const l = bundle.librpa;
      if (a) {
        const p = a.effectiveParams || (a.input && a.input.params) || {};
        if (a.calculation) parts.push(a.calculation);
        const k = kptText(a.kpt);
        if (k) parts.push(k);
        if (p.nbands) parts.push(`${p.nbands} 带`);
        if (String(p.nspin) === '2') parts.push('nspin 2');
        if (String(p.lspinorb) === '1') parts.push('SOC');
        if (a.outputDir) parts.push(a.outputDir);
      }
      if (l) {
        const rows = qsgwRows(bundle);
        parts.push(l.task || 'LibRPA');
        if (rows.length) parts.push(`迭代表 ${rows.length} 行`);
        if (!a) parts.push(l.outputDir || 'librpa.d');
      }
      return parts.join(' · ');
    }

    function runCountsText(run) {
      const c = run.counts;
      const parts = [];
      if (c.producer) parts.push(`${c.producer} 产出`);
      if (c.coupled) parts.push(`${c.coupled} 同目录`);
      if (c.consumer) parts.push(`${c.consumer} 消费`);
      return parts.join(' → ');
    }

    /** One glyph per stage, producers before consumers: a run's state at a glance. */
    function RunFingerprint(props) {
      const { run, states } = props;
      const max = 12;
      const out = [];
      let previous = null;
      run.stages.slice(0, max).forEach((stage, index) => {
        if (previous && previous !== stage.role) {
          out.push(h('span', { key: `a${index}`, className: 'af-fp-arrow' }, h(Icon16, { name: 'chevronRight', size: 10 })));
        }
        const state = (states && states[stage.id]) || stageState(stage.task, null);
        out.push(h('span', { key: stage.id, title: `${stage.rel || stage.name}：${state.label}` }, h(StateGlyph, { code: state.code, size: 10 })));
        previous = stage.role;
      });
      if (run.stages.length > max) out.push(h('span', { key: 'more' }, `+${run.stages.length - max}`));
      return h('span', { className: 'af-fp' }, out);
    }

    function RunList(props) {
      const { runs, series, activeRunKey, activeSeriesKey, runStates, statesByRun, activeStageId, onRun, onStage, onSeries } = props;
      return h(
        React.Fragment,
        null,
        h('div', { className: 'af-group' }, h('span', null, '运行'), h('span', { className: 'af-group-count' }, String(runs.length))),
        runs.map((run) => {
          const active = run.key === activeRunKey;
          return h(
            React.Fragment,
            { key: run.key },
            h(
              'button',
              { type: 'button', className: 'af-run', 'data-active': active ? 'true' : undefined, title: run.absPath, onClick: () => onRun(run.key) },
              h('span', { className: 'af-run-name' }, run.name),
              h('span', { className: 'af-run-meta' }, h(RunFingerprint, { run, states: (statesByRun && statesByRun[run.key]) || (active ? runStates : null) }), h('span', null, runCountsText(run))),
            ),
            active && onStage
              ? run.stages.map((stage) =>
                  h(
                    'button',
                    {
                      key: stage.id,
                      type: 'button',
                      className: 'af-task',
                      'data-active': stage.id === activeStageId ? 'true' : undefined,
                      title: stage.task.absPath,
                      onClick: () => onStage(stage.id),
                    },
                    h(StateBadge, { state: (runStates && runStates[stage.id]) || stageState(stage.task, null), compact: true }),
                    h('span', { className: 'af-task-name' }, stage.branch ? h('span', { className: 'af-task-branch' }, `${stage.branch}/`) : null, stage.name),
                  ),
                )
              : null,
          );
        }),
        series && series.length > 0
          ? h(
              React.Fragment,
              null,
              h('div', { className: 'af-group' }, h('span', null, 'k 网格系列'), h('span', { className: 'af-group-count' }, String(series.length))),
              series.map((s) =>
                h(
                  'button',
                  { key: s.key, type: 'button', className: 'af-run', 'data-active': s.key === activeSeriesKey ? 'true' : undefined, onClick: () => onSeries(s.key) },
                  h('span', { className: 'af-run-name' }, s.key),
                  h('span', { className: 'af-run-meta' }, h(Icon16, { name: 'layers', size: 12 }), s.members.map((m) => m.label).join(' · ')),
                ),
              ),
            )
          : null,
      );
    }

    /** The narrow-dock replacement for the rail: the current run, opening the same list. */
    function RunPicker(props) {
      const [open, setOpen] = useState(false);
      const run = props.runs.find((r) => r.key === props.activeRunKey) || null;
      return h(
        'div',
        { className: 'af-picker' },
        h(
          'button',
          { type: 'button', className: 'af-picker-btn', onClick: () => setOpen(!open), 'aria-expanded': open ? 'true' : 'false' },
          h(
            'span',
            { className: 'af-picker-main' },
            h('span', { className: 'af-run-name' }, run ? run.name : props.runs.length ? '选择运行' : '没有运行'),
            run ? h('span', { className: 'af-run-meta' }, h(RunFingerprint, { run, states: props.runStates }), h('span', null, runCountsText(run))) : null,
          ),
          h(Icon16, { name: 'chevronDown', size: 14 }),
        ),
        open
          ? h(
              'div',
              { className: 'af-picker-pop' },
              h(RunList, {
                ...props,
                onStage: null,
                onRun: (key) => {
                  setOpen(false);
                  props.onRun(key);
                },
                onSeries: (key) => {
                  setOpen(false);
                  props.onSeries(key);
                },
              }),
            )
          : null,
      );
    }

    function StageNode(props) {
      const { stage, state, bundle, active, plotted, onClick } = props;
      const rows = qsgwRows(bundle);
      return h(
        'button',
        {
          type: 'button',
          className: 'af-node',
          'data-active': active ? 'true' : undefined,
          'data-quiet': state && state.code === 'none' ? 'true' : undefined,
          title: `${stage.task.absPath}\n${state ? `${state.label}：${state.detail}` : ''}`,
          onClick,
        },
        h(
          'span',
          { className: 'af-node-top' },
          h(StateBadge, { state, compact: true }),
          h('span', { className: 'af-node-name' }, stage.name),
          rows.length > 1 ? h('span', { className: 'af-loop', title: `QSGW 自洽：迭代表 ${rows.length} 行` }, h(Icon16, { name: 'loop', size: 12 })) : null,
          plotted ? h('span', { className: 'af-node-plot', title: '这个阶段的数据正画在下方能带图里' }, h(Icon16, { name: 'plot', size: 12 })) : null,
        ),
        h('span', { className: 'af-node-facts' }, state ? `${state.label} · ${stageFacts(stage, bundle)}` : stageFacts(stage, bundle)),
      );
    }

    /** Narrow form of a stage: shape-coded state glyph and name; the facts live in the tooltip. */
    function StageChip(props) {
      const { stage, state, bundle, active, plotted, onClick } = props;
      return h(
        'button',
        {
          type: 'button',
          className: 'af-stage-chip',
          'data-active': active ? 'true' : undefined,
          'data-quiet': state && state.code === 'none' ? 'true' : undefined,
          title: `${stage.rel || stage.name}\n${state ? `${state.label}：${state.detail}` : ''}\n${stageFacts(stage, bundle)}`,
          onClick,
        },
        h(StateBadge, { state, compact: true }),
        h('span', { className: 'af-stage-chip-name' }, stage.name),
        plotted ? h('span', { className: 'af-node-plot', title: '画在下方能带图里' }, h(Icon16, { name: 'plot', size: 11 })) : null,
      );
    }

    /**
     * The run as a pipeline: ABACUS producer branches, the lineage edge with its evidence,
     * LibRPA consumers. Arrows inside a branch are drawn only between numbered steps
     * (01_scf → 02_export); variants such as `frozen` / `refresh` are siblings, not a sequence.
     */
    function Pipeline(props) {
      const { run, states, bundles, lineage, proofs, activeStageId, plotted, onSelect, narrow } = props;
      const lanes = lanesOf(run);
      const producer = lanes.find((lane) => lane.role === 'producer');
      const coupled = lanes.find((lane) => lane.role === 'coupled');
      const consumer = lanes.find((lane) => lane.role === 'consumer');
      const consumers = consumer ? consumer.branches.flatMap((b) => b.stages) : [];
      const linked = new Set(consumers.map((s) => lineage[s.id]).filter((l) => l && l.kind === 'input_dir').map((l) => l.branch));

      const node = (stage) =>
        h(narrow ? StageChip : StageNode, {
          key: stage.id,
          stage,
          state: states[stage.id],
          bundle: bundles[stage.id],
          active: stage.id === activeStageId,
          plotted: plotted.has(stage.id),
          onClick: () => onSelect(stage.id),
        });

      const laneView = (lane) =>
        h(
          'div',
          { key: lane.role, className: 'af-lane' },
          h(
            'div',
            { className: 'af-lane-head' },
            h(ProducerTag, { producer: lane.role === 'consumer' ? 'librpa' : 'abacus' }),
            lane.role === 'coupled' ? h(ProducerTag, { producer: 'librpa' }) : null,
            h('span', null, lane.role === 'producer' ? '产出' : lane.role === 'consumer' ? '消费' : '同目录：ABACUS 产出直接被 LibRPA 读取'),
          ),
          lane.branches.map((branch) => {
            const sequential = lane.role === 'producer' && branch.stages.length > 1 && branch.stages.every((s) => /^\d/.test(s.name));
            return h(
              'div',
              { key: branch.name || '.', className: 'af-branch', 'data-linked': linked.has(branch.name) ? 'true' : undefined },
              branch.name ? h('div', { className: 'af-branch-name' }, linked.has(branch.name) ? `${branch.name}  ← 被读取` : branch.name) : null,
              h(
                'div',
                { className: 'af-chain', 'data-loose': sequential ? undefined : 'true', style: sequential ? undefined : { gap: 6 } },
                branch.stages.flatMap((stage, index) =>
                  sequential && index > 0
                    ? [h('span', { key: `l-${stage.id}`, className: 'af-link' }, h(Icon16, { name: 'chevronRight', size: 12 })), node(stage)]
                    : [node(stage)],
                ),
              ),
            );
          }),
        );

      const edgeLines = consumers.map((stage) => {
        const link = lineage[stage.id];
        const proof = proofs[stage.id];
        return { stage, link, proof };
      });
      const strongest = edgeLines.some((e) => e.link && e.link.kind === 'input_dir')
        ? 'input_dir'
        : edgeLines.some((e) => e.link && e.link.kind === 'unresolved') ? 'unresolved' : 'layout';
      const edge = h(
        'div',
        { className: 'af-edge', 'data-kind': strongest },
        h('span', { className: 'af-edge-arrow' }, h(Icon16, { name: 'arrowRight', size: 18 })),
        h(
          'span',
          { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
          edgeLines.map((e) =>
            h(
              'span',
              { key: e.stage.id, className: 'af-edge-label', title: e.link && e.link.raw ? `${e.stage.name} 的 librpa.in：input_dir = ${e.link.raw}` : undefined },
              consumers.length > 1 ? `${e.stage.name}：` : '',
              e.link ? e.link.text : '读取 librpa.in…',
              e.proof ? h('span', { style: { display: 'block', color: 'var(--af-fg-2)' } }, `KS 本征值一致（max |Δ| ${e.proof.maxAbs.toFixed(3)} eV）`) : null,
            ),
          ),
        ),
      );

      if (producer && consumer) {
        return h(
          'div',
          { className: 'af-pipe' },
          laneView(producer),
          edge,
          laneView(consumer),
          coupled ? h('div', { style: { gridColumn: '1 / -1', paddingTop: 'var(--af-s4)' } }, laneView(coupled)) : null,
        );
      }
      return h(
        'div',
        { className: 'af-pipe', 'data-single': 'true' },
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 'var(--af-s4)', minWidth: 0 } },
          [producer, coupled, consumer].filter(Boolean).map(laneView),
          consumer && !producer
            ? h('div', { className: 'af-notes' }, edgeLines.map((e) => h('div', { key: e.stage.id, title: e.link && e.link.raw ? e.link.raw : undefined }, h(Icon16, { name: 'info', size: 12 }), `${e.stage.name}：${e.link ? e.link.text : '读取 librpa.in…'}`)))
            : null,
        ),
      );
    }

    function RunHeader(props) {
      const { run, bundles, series, onOpenSeries } = props;
      const loaded = run.stages.map((s) => bundles[s.id]).filter(Boolean);
      const scene = (loaded.find((b) => b.structureScene && b.structureScene.formula) || {}).structureScene;
      const abacus = (loaded.find((b) => b.abacus && b.abacus.calculation) || {}).abacus;
      const librpa = (loaded.find((b) => b.librpa && b.librpa.task) || {}).librpa;
      const params = abacus ? abacus.effectiveParams || (abacus.input && abacus.input.params) || {} : {};
      const chips = [];
      if (scene) chips.push(h('span', { key: 'm', className: 'af-chip', title: '来自 STRU' }, `${scene.formula} · ${scene.natom} 原子`));
      if (abacus) {
        chips.push(
          h('span', { key: 'a', className: 'af-chip' }, h(ProducerGlyph, { producer: 'abacus' }),
            [
              `ABACUS${abacus.versions && abacus.versions.version ? ` ${abacus.versions.version}` : ''}`,
              abacus.basisType ? String(abacus.basisType).toUpperCase() : null,
              params.dft_functional ? String(params.dft_functional).toUpperCase() : null,
              String(params.nspin) === '2' ? 'nspin 2' : null,
              String(params.lspinorb) === '1' ? 'SOC' : null,
            ].filter(Boolean).join(' · ')),
        );
      }
      if (librpa) chips.push(h('span', { key: 'l', className: 'af-chip' }, h(ProducerGlyph, { producer: 'librpa' }), `LibRPA · ${librpa.task}`));
      chips.push(h('span', { key: 'c', className: 'af-chip', title: '按目录分组：运行 = 扫描根目录下的第一层文件夹' }, runCountsText(run)));
      if (series) {
        chips.push(
          h('button', { key: 's', type: 'button', className: 'af-chip af-chip-link', onClick: () => onOpenSeries(series.key), title: '打开 k 网格系列（比较 b）' },
            h(Icon16, { name: 'layers', size: 12 }), `k 网格系列：${series.members.map((m) => m.label).join(' · ')}`, h(Icon16, { name: 'chevronRight', size: 12 })),
        );
      }
      return h(
        'div',
        { className: 'af-head' },
        h('h2', { className: 'af-title' }, run.name),
        h('div', { className: 'af-subline' }, chips),
        h('span', { className: 'af-path', title: run.absPath }, tailPath(run.absPath, 120)),
      );
    }

    // =====================================================================
    // results — comparison (a): ABACUS vs LibRPA inside one run
    // =====================================================================

    const WINDOW_PRESETS = [
      { value: 3, label: '±3' },
      { value: 6, label: '±6' },
      { value: 12, label: '±12' },
      { value: 'all', label: '全部' },
    ];

    function channelExtent(channels) {
      let min = Infinity;
      let max = -Infinity;
      for (const c of channels) {
        if (isNum(c.minEnergyEv)) min = Math.min(min, c.minEnergyEv);
        if (isNum(c.maxEnergyEv)) max = Math.max(max, c.maxEnergyEv);
      }
      return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
    }

    /** QSGW iteration: a first-class control wherever the iteration changes the answer. */
    function IterationControl(props) {
      const { iterations, value, onChange } = props;
      if (!iterations || iterations.length === 0) return null;
      const latest = iterations[iterations.length - 1];
      const current = value === null || value === undefined ? latest : value;
      const index = iterations.indexOf(current);
      return h(
        'span',
        { className: 'af-control' },
        'QSGW 迭代',
        h(Btn, { size: 'sm', kind: 'ghost', icon: 'chevronLeft', disabled: index <= 0, title: '上一次迭代', 'aria-label': '上一次迭代', onClick: () => onChange(iterations[index - 1]) }),
        h(
          'select',
          {
            className: 'af-select',
            value: value === null || value === undefined ? '' : String(value),
            onChange: (event) => onChange(event.target.value === '' ? null : Number(event.target.value)),
            'aria-label': 'QSGW 迭代',
          },
          h('option', { value: '' }, `最新（第 ${latest} 次）`),
          iterations.map((it) => h('option', { key: it, value: String(it) }, `第 ${it} 次`)),
        ),
        h(Btn, { size: 'sm', kind: 'ghost', icon: 'chevronRight', disabled: index < 0 || index >= iterations.length - 1, title: '下一次迭代', 'aria-label': '下一次迭代', onClick: () => onChange(iterations[index + 1]) }),
      );
    }

    function RangeInputs(props) {
      const { range, onChange } = props;
      const [lo, setLo] = useState('');
      const [hi, setHi] = useState('');
      useEffect(() => {
        setLo(isNum(range.lo) ? range.lo.toFixed(1) : '');
        setHi(isNum(range.hi) ? range.hi.toFixed(1) : '');
      }, [range.lo, range.hi]);
      const commit = () => {
        const a = Number(lo);
        const b = Number(hi);
        if (isNum(a) && isNum(b) && b > a) onChange(a, b);
      };
      const field = (value, set, label) =>
        h('input', {
          className: 'af-input af-input-num',
          type: 'number',
          step: 0.5,
          value,
          'aria-label': label,
          onChange: (event) => set(event.target.value),
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === 'Enter') commit();
          },
        });
      return h('span', { className: 'af-control' }, field(lo, setLo, '能量下限（eV）'), '–', field(hi, setHi, '能量上限（eV）'), 'eV');
    }

    function sourceSelect(producer, stages, value, onChange) {
      if (stages.length < 2) return null;
      return h(
        'label',
        { className: 'af-control' },
        h(ProducerTag, { producer }),
        h(
          'select',
          { className: 'af-select', value, onChange: (event) => onChange(event.target.value), 'aria-label': `${PRODUCER_LABEL[producer]} 来源阶段` },
          stages.map((s) => h('option', { key: s.id, value: s.id }, s.rel || s.name)),
        ),
      );
    }

    /**
     * Comparison (a), on by default: ABACUS KS bands from the run's band stage and LibRPA
     * QSGW bands from its consumer, on one axis — no basket to assemble.
     *
     * Alignment follows alignChannel: identical paths are drawn as is; ABACUS and LibRPA
     * measure path length differently, so their curves share an axis only after LibRPA's KS
     * eigenvalues are shown to reproduce the ABACUS ones point by point. Nothing is shifted;
     * each producer's Fermi level is drawn as its own reference line.
     */
    function BandOverlay(props) {
      const { run, bundles, states, lineage, iteration, onIteration, narrow, onProof, onPlotted, onIterations } = props;
      const sources = useMemo(() => rankBandSources(run, bundles, states, lineage), [run, bundles, states, lineage]);
      const [pickA, setPickA] = useState(null);
      const [pickL, setPickL] = useState(null);
      const [spin, setSpin] = useState(1);
      const [show, setShow] = useState({ abacus: true, KS: false, EXX: false, QSGW: true });
      const [win, setWin] = useState({ mode: 'auto', half: 6, lo: null, hi: null });

      const stageA = sources.abacus.find((s) => s.id === pickA) || sources.abacus[0] || null;
      const stageL = sources.librpa.find((s) => s.id === pickL) || sources.librpa[0] || null;

      const invA = useApi(stageA ? `inv:${stageA.id}:${cacheGeneration}` : null, () => fetchBands(stageA.id, 'inventory', null));
      const invL = useApi(stageL ? `inv:${stageL.id}:${cacheGeneration}` : null, () => fetchBands(stageL.id, 'inventory', null));

      const availability = (invL.data && invL.data.availability) || [];
      const abacusInA = (invA.data && invA.data.abacus) || [];
      const abacusInL = (invL.data && invL.data.abacus) || [];
      // A same-directory stage can carry its own ABACUS band files; use them when no separate
      // producer band stage exists.
      const abacusStage = abacusInA.length > 0 ? stageA : abacusInL.length > 0 ? stageL : null;
      const abacusList = abacusInA.length > 0 ? abacusInA : abacusInL;
      const spins = [...new Set([...abacusList.map((c) => c.spin), ...availability.map((a) => a.spin)])].filter(isNum).sort((a, b) => a - b);
      const activeSpin = spins.includes(spin) ? spin : spins[0] || 1;
      const iterations = [...new Set(availability.filter((a) => a.spin === activeSpin).flatMap((a) => a.iterations || []))].sort((a, b) => a - b);
      const has = (kind) => availability.some((a) => a.kind === kind && a.spin === activeSpin);

      // ABACUS is always loaded when present: it is the k axis (and its ticks) for everything.
      // LibRPA KS is loaded whenever an ABACUS axis exists, because it is the alignment proof.
      const requests = [];
      if (abacusStage) requests.push({ id: 'A', taskId: abacusStage.id, only: 'abacus', iteration: null });
      for (const kind of ['KS', 'EXX', 'QSGW']) {
        if (!stageL || !has(kind)) continue;
        if (show[kind] || (kind === 'KS' && abacusStage)) requests.push({ id: kind, taskId: stageL.id, only: `${kind}:${activeSpin}`, iteration });
      }
      const loaded = useBandRequests(requests);

      const labelA = abacusStage ? abacusStage.rel || abacusStage.name : '';
      const labelL = stageL ? stageL.rel || stageL.name : '';
      // Channels are rebuilt only when a response object changes, so the chart's path cache
      // and the KS identity check (29 120 values on NiO) do not rerun on every render.
      const dataA = loaded.A && loaded.A.data;
      const dataKS = loaded.KS && loaded.KS.data;
      const dataEXX = loaded.EXX && loaded.EXX.data;
      const dataQSGW = loaded.QSGW && loaded.QSGW.data;
      const refA = useMemo(
        () => (dataA ? buildBandChannels({ abacus: dataA.abacus }, labelA).find((c) => c.spin === activeSpin) || null : null),
        [dataA, labelA, activeSpin],
      );
      const pickKind = (data, kind) => (data ? buildBandChannels({ librpa: data.librpa }, labelL).find((c) => c.kind === kind) || null : null);
      const chKS = useMemo(() => pickKind(dataKS, 'KS'), [dataKS, labelL]); // eslint-disable-line react-hooks/exhaustive-deps
      const chEXX = useMemo(() => pickKind(dataEXX, 'EXX'), [dataEXX, labelL]); // eslint-disable-line react-hooks/exhaustive-deps
      const chQSGW = useMemo(() => pickKind(dataQSGW, 'QSGW'), [dataQSGW, labelL]); // eslint-disable-line react-hooks/exhaustive-deps
      const chL = { KS: chKS, EXX: chEXX, QSGW: chQSGW };
      const reference = refA || chQSGW || chKS || chEXX || null;
      const proof = useMemo(() => (refA && chKS ? eigenIdentity(refA, chKS) : null), [refA, chKS]);

      useEffect(() => {
        if (proof && stageL && abacusStage && abacusStage.id !== stageL.id && onProof) onProof(stageL.id, proof);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [proof && proof.maxAbs, stageL && stageL.id, abacusStage && abacusStage.id]);

      const showKey = `${show.abacus}|${show.KS}|${show.EXX}|${show.QSGW}`;
      const { drawn, skipped, indexReason } = useMemo(() => {
        const visible = [];
        if (refA && show.abacus) visible.push(refA);
        for (const kind of ['KS', 'EXX', 'QSGW']) if (show[kind] && chL[kind]) visible.push(chL[kind]);
        const outDrawn = [];
        const outSkipped = [];
        let reason = null;
        for (const channel of visible) {
          const alignment = alignChannel(reference, channel, channel.source === 'librpa' && refA ? proof : null);
          if (alignment.mode === 'none') {
            outSkipped.push({ channel, reason: alignment.reason });
            continue;
          }
          if (alignment.mode === 'index') reason = alignment.reason;
          outDrawn.push({
            key: channel.key,
            channel,
            xs: alignment.mode === 'same' ? channel.kpath : reference.kpath,
            energies: channel.energies,
            nBand: channel.nBand,
            ...bandStyle(channel),
          });
        }
        return { drawn: outDrawn, skipped: outSkipped, indexReason: reason };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [refA, chKS, chEXX, chQSGW, reference, proof, showKey]);

      const plottedIds = [...new Set(drawn.map((d) => (d.channel.source === 'abacus' ? abacusStage && abacusStage.id : stageL && stageL.id)).filter(Boolean))].join('|');
      useEffect(() => {
        if (onPlotted) onPlotted(plottedIds ? plottedIds.split('|') : []);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [plottedIds]);
      const iterationKey = iterations.join(',');
      useEffect(() => {
        if (onIterations) onIterations(iterations);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [iterationKey]);

      const tickSource = [reference, ...drawn.map((d) => d.channel)].find(
        (c) => c && (c.kTicks || []).length > 0 && (c === reference || samePath(c, reference)),
      );
      const ticks = tickSource ? tickSource.kTicks : [];
      const extent = channelExtent(drawn.map((d) => d.channel));
      // A same-directory stage has its own ABACUS log even when it left no ABACUS band file:
      // its E_F is a file-derived reference for the window, labelled as coming from ABACUS.
      const fermiStage = abacusStage || (stageL && stageL.role === 'coupled' ? stageL : null);
      const fermiA = fermiStage ? abacusFermi(bundles[fermiStage.id]) : null;
      const fermiLabel = fermiStage ? `${fermiStage.rel || fermiStage.name}${abacusStage ? '' : '（同目录）'}` : '';
      const shownIter = chL.QSGW ? chL.QSGW.iter : chL.KS ? chL.KS.iter : null;
      const fermiL = stageL ? librpaFermi(bundles[stageL.id], shownIter) : null;
      const drawsAbacus = drawn.some((d) => d.channel.source === 'abacus');
      const drawsLibrpa = drawn.some((d) => d.channel.source === 'librpa');
      const refLines = [];
      if (isNum(fermiA) && drawn.length > 0) refLines.push({ energy: fermiA, label: `E_F · ABACUS ${fermiStage.name}`, color: 'var(--af-c-abacus)' });
      if (fermiL && drawsLibrpa) refLines.push({ energy: fermiL.energy, label: `E_F · LibRPA 第 ${fermiL.iter} 次`, color: 'var(--af-c-qsgw)' });
      const centre = isNum(fermiA)
        ? { energy: fermiA, source: `ABACUS ${fermiLabel} 日志` }
        : fermiL ? { energy: fermiL.energy, source: `LibRPA qsgw_iterations.dat 第 ${fermiL.iter} 次` } : null;
      const mixesProducers = (drawsAbacus && drawsLibrpa) || (isNum(fermiA) && drawsLibrpa);
      let range;
      if (win.mode === 'manual' && isNum(win.lo) && isNum(win.hi) && win.hi > win.lo) range = { lo: win.lo, hi: win.hi };
      else if (win.mode === 'all' && extent) range = { lo: extent.min, hi: extent.max };
      else range = defaultWindow(extent, centre ? centre.energy : null, win.half);

      if (!stageA && !stageL) {
        const anyBundle = run.stages.some((s) => bundles[s.id]);
        if (!anyBundle) return h(Loading, null, '读取各阶段…');
        return h(
          Empty,
          { title: '这个运行里没有可画的能带' },
          '没有以显式 k 路径计算的 ABACUS 阶段，也没有留下输出的 LibRPA 阶段。各阶段的收敛与输入在上方流水线里逐个查看。',
        );
      }

      // Narrow docks drop the stage names here; the notes under the plot still name every file.
      const toggles = [
        { id: 'abacus', available: Boolean(abacusStage), producer: 'abacus', label: narrow ? 'ABACUS KS' : `ABACUS KS · ${labelA}`, style: bandStyle({ source: 'abacus', spin: activeSpin }), loading: loaded.A && loaded.A.loading },
        ...['KS', 'EXX', 'QSGW'].map((kind) => ({
          id: kind,
          available: has(kind),
          producer: 'librpa',
          label: narrow ? `LibRPA ${kind}` : `LibRPA ${kind} · ${labelL}`,
          style: bandStyle({ source: 'librpa', kind, spin: activeSpin }),
          loading: show[kind] && loaded[kind] && loaded[kind].loading,
        })),
      ].filter((t) => t.available);

      const loadingInventory = (stageA && invA.loading) || (stageL && invL.loading);
      const pending = requests.some((r) => loaded[r.id] && loaded[r.id].loading);
      const errors = [invA.error, invL.error, ...requests.map((r) => loaded[r.id] && loaded[r.id].error)].filter(Boolean);

      let chart;
      if (drawn.length > 0 && reference) {
        chart = h(BandChart, {
          series: drawn,
          ticks,
          xMin: reference.kpath[0],
          xMax: reference.kpath[reference.kpath.length - 1],
          lo: range.lo,
          hi: range.hi,
          refLines,
          height: narrow ? 300 : 380,
          ariaLabel: `${run.name} 能带对比`,
        });
      } else if (loadingInventory || pending) {
        chart = h(Loading, null, loadingInventory ? '读取能带清单…' : '载入能带数据…');
      } else {
        chart = h(Empty, { title: '没有画出任何曲线' }, toggles.length ? '在上方打开至少一个通道。' : '这两个阶段都没有能带文件。');
      }

      const notes = [];
      for (const d of drawn) {
        const c = d.channel;
        notes.push({
          icon: 'layers',
          text: `${PRODUCER_LABEL[c.source]} · ${c.taskLabel} · ${c.file}${c.iter !== null && c.iter !== undefined ? `（第 ${c.iter} 次迭代）` : ''} · ${c.nKpoint} k × ${c.nBand} 带`,
        });
      }
      if (indexReason) notes.push({ icon: 'info', text: `k 轴：${indexReason}；LibRPA 曲线画在 ABACUS ${labelA} 的 k 轴上。` });
      else if (drawn.length > 1) notes.push({ icon: 'info', text: 'k 轴：所有曲线的 k 路径相同。' });
      for (const s of skipped) notes.push({ icon: 'warn', text: `未叠加：${PRODUCER_LABEL[s.channel.source]} ${s.channel.kind} — ${s.reason}` });
      if (mixesProducers) notes.push({ icon: 'info', text: ENERGY_ZERO_NOTE });
      if (win.mode === 'auto') {
        notes.push({
          icon: 'info',
          text: centre && range.centred
            ? `窗口：以 E_F（${centre.source}，${centre.energy.toFixed(3)} eV）为中心 ±${win.half} eV。`
            : '没有可用的费米能参考，窗口按 0 eV 附近取。',
        });
      }
      for (const w of [...((invA.data && invA.data.warnings) || []), ...((invL.data && invL.data.warnings) || [])]) notes.push({ icon: 'warn', text: w });

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'af-controls' },
          sourceSelect('abacus', sources.abacus, stageA ? stageA.id : '', setPickA),
          sourceSelect('librpa', sources.librpa, stageL ? stageL.id : '', setPickL),
          spins.length > 1
            ? h('span', { className: 'af-control' }, '自旋', h(Seg, { label: '自旋', value: activeSpin, options: spins.map((s) => ({ value: s, label: String(s) })), onChange: setSpin }))
            : null,
          h(IterationControl, { iterations, value: iteration, onChange: onIteration }),
          h(
            'span',
            { className: 'af-control' },
            '窗口',
            h(Seg, {
              label: '能量窗口',
              value: win.mode === 'auto' ? win.half : win.mode === 'all' ? 'all' : null,
              options: WINDOW_PRESETS,
              onChange: (value) => setWin(value === 'all' ? { mode: 'all', half: win.half, lo: null, hi: null } : { mode: 'auto', half: value, lo: null, hi: null }),
            }),
          ),
          narrow ? null : h(RangeInputs, { range, onChange: (lo, hi) => setWin({ mode: 'manual', half: win.half, lo, hi }) }),
        ),
        h(
          'div',
          { className: 'af-toggles' },
          toggles.map((t) =>
            h(
              'button',
              {
                key: t.id,
                type: 'button',
                className: 'af-toggle',
                'aria-pressed': show[t.id] ? 'true' : 'false',
                onClick: () => setShow({ ...show, [t.id]: !show[t.id] }),
              },
              h(LineSwatch, { color: t.style.color, dash: t.style.dash, width: t.style.width }),
              t.label,
              t.loading ? h(Spinner) : null,
            ),
          ),
          drawn.length > 0
            ? h(Btn, {
                size: 'sm',
                kind: 'ghost',
                icon: 'basket',
                'aria-label': '加入对比篮',
                title: '把当前画出的曲线放进对比篮，用来和别的运行比较',
                onClick: () => addToCompare(drawn.map((d) => ({
                  ...d.channel,
                  key: `${run.key}/${d.channel.key}`,
                  label: `${run.name} · ${d.channel.label}`,
                  runName: run.name,
                  // Carried so the basket can centre its window on a file-derived Fermi level.
                  fermi: d.channel.source === 'abacus' || !fermiL ? fermiA : fermiL.energy,
                }))),
              }, narrow ? null : '加入对比篮')
            : null,
        ),
        chart,
        errors.length ? h(Note, { tone: 'err' }, errors.join('；')) : null,
        h(
          'div',
          { className: 'af-notes' },
          notes.map((n, i) => h('div', { key: i }, h(Icon16, { name: n.icon, size: 12 }), h('span', null, n.text))),
        ),
      );
    }

    /**
     * Every gap the run's files state, with its producer and source file; then the matched
     * published records — comparison (c) without leaving the run.
     */
    function KeyNumbers(props) {
      const { run, bundles, iteration, onOpenLibrary, onSelectStage } = props;
      const struStage = run.stages.find((s) => s.task.hasStru) || null;
      const match = useApi(struStage ? `match:${struStage.id}:${cacheGeneration}` : null, () => fetchMatch(struStage.id));
      const matches = match.data && match.data.ok ? match.data.matches || [] : [];
      const ledger = gapLedger(run, bundles, iteration, matches);
      const computed = collapseLedger(ledger.filter((row) => row.producer !== 'db'));
      const published = ledger.filter((row) => row.producer === 'db');
      const loadingStages = run.stages.some((s) => !bundles[s.id]);

      const row = (r, i) =>
        h(
          'tr',
          { key: `${r.producer}-${r.stage}-${i}` },
          h('td', null, r.stageId
            ? h('button', { type: 'button', className: 'af-linklike', onClick: () => onSelectStage(r.stageId), title: r.stages && r.stages.length > 1 ? r.stages.join('\n') : '打开这个阶段' }, h(ProducerTag, { producer: r.producer, stage: r.stage }))
            : h(ProducerTag, { producer: r.producer, stage: r.stage })),
          h('td', null, r.quantity),
          h('td', { className: 'af-val' }, r.state === 'unconv' ? h('span', { title: '未收敛', style: { marginRight: 4, display: 'inline-flex', verticalAlign: '-1px' } }, h(StateGlyph, { code: 'unconv', size: 11 })) : null, fmtEv(r.valueEv)),
          h('td', { title: r.detail || undefined }, h('div', { className: 'af-src' }, r.source), r.note ? h('div', { className: 'af-hint' }, r.note) : null),
        );

      let dbLine;
      if (!struStage) dbLine = h('span', { className: 'af-hint' }, '没有 STRU 的阶段，无法按组成匹配数据库。');
      else if (match.loading) dbLine = h('span', { className: 'af-hint' }, h(Spinner), '正在比对 LibRPA-database…');
      else if (match.error) dbLine = h('span', { className: 'af-hint' }, `数据库比对失败：${match.error}`);
      else if (match.data && !match.data.ok) dbLine = h('span', { className: 'af-hint' }, `数据库不可用：${match.data.error || '未配置'}（插件配置 libraryRoot）。`);
      else if (match.data && matches.length === 0) dbLine = h('span', { className: 'af-hint' }, `数据库里没有匹配的材料。已尝试：${(match.data.tried || []).join('、') || '（无候选）'}`);
      else if (match.data) {
        dbLine = h('span', { className: 'af-hint' }, `按 ${(match.data.tried || []).join('、')} 匹配到 ${matches.length} 条记录${match.data.exact ? '（按 STRU 组成确定）' : '（按目录名推测，请自行确认）'}`);
      }

      return h(
        'div',
        null,
        computed.length === 0 && !loadingStages
          ? h(Note, null, '这些文件里没有记录能隙：ABACUS 日志没有 E_gap 行，LibRPA 没有 qsgw_iterations.dat。面板不会用能带序号去估算能隙。')
          : null,
        computed.length === 0 && loadingStages ? h(Loading, null, '读取各阶段…') : null,
        computed.length + published.length > 0
          ? h(
              'div',
              { className: 'af-table-wrap' },
              h(
                'table',
                { className: 'af-table af-ledger' },
                h('thead', null, h('tr', null, h('th', null, '来源'), h('th', null, '量'), h('th', { className: 'af-num' }, '数值'), h('th', null, '文件 / 说明'))),
                h(
                  'tbody',
                  null,
                  computed.map(row),
                  published.length > 0
                    ? h('tr', { className: 'af-row-sep', key: 'sep' }, h('td', { colSpan: 4 }, '已发表 · LibRPA-database（不同基组、k 网格与版本，只作量级参照）'))
                    : null,
                  published.map((r, i) => row(r, i + computed.length)),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'af-controls', style: { marginTop: 'var(--af-s2)', marginBottom: 0 } },
          dbLine,
          matches.length > 0
            ? h(Btn, { size: 'sm', kind: 'ghost', icon: 'book', onClick: () => onOpenLibrary(matches[0].formula || matches[0].material || '') }, `全部 ${matches.length} 条匹配`)
            : null,
        ),
      );
    }

    /** The ABACUS stage whose SCF trace best represents the run (the branch the consumer read). */
    function pickScfStage(run, bundles, lineage) {
      const linked = new Set(Object.values(lineage).filter((l) => l && l.branch).map((l) => l.branch));
      const candidates = run.stages.filter((s) => {
        const a = bundles[s.id] && bundles[s.id].abacus;
        return (s.role === 'producer' || s.role === 'coupled') && a && a.log && (a.log.iterations || []).length > 1;
      });
      candidates.sort((x, y) => (linked.has(y.branch) ? 1 : 0) - (linked.has(x.branch) ? 1 : 0) || compareStages(x, y));
      return candidates[0] || null;
    }

    function scfSeries(log) {
      const byIonic = new Map();
      for (const it of log.iterations || []) {
        if (!byIonic.has(it.ionicStep)) byIonic.set(it.ionicStep, []);
        byIonic.get(it.ionicStep).push(it);
      }
      const steps = [...byIonic.entries()].sort((a, b) => a[0] - b[0]);
      return {
        rho: steps.map(([step, items], i) => ({
          name: `离子步 ${step}`,
          color: BAND_COLORS[i % BAND_COLORS.length],
          points: items.filter((it) => isNum(it.rhoDeviation) && it.rhoDeviation > 0).map((it) => ({ x: it.scfIter, y: Math.log10(it.rhoDeviation) })),
        })).filter((s) => s.points.length > 0),
        energy: steps.map(([step, items], i) => ({
          name: `离子步 ${step}`,
          color: BAND_COLORS[i % BAND_COLORS.length],
          points: items.filter((it) => isNum(it.eKohnShamEv)).map((it) => ({ x: it.scfIter, y: it.eKohnShamEv })),
        })).filter((s) => s.points.length > 0),
        ionicSteps: steps.length,
      };
    }

    function qsgwSeries(rows) {
      return {
        gap: rows.filter((r) => isNum(r.gap_eV)).map((r) => ({ x: r.iter, y: r.gap_eV })),
        delta: rows.filter((r) => isNum(r.max_delta_eV) && r.max_delta_eV > 0).map((r) => ({ x: r.iter, y: Math.log10(r.max_delta_eV) })),
        residual: rows.filter((r) => isNum(r.residual_l2_Ha) && r.residual_l2_Ha > 0).map((r) => ({ x: r.iter, y: Math.log10(r.residual_l2_Ha) })),
      };
    }

    function ConvergenceStrip(props) {
      const { run, bundles, states, lineage, focusL, iteration, bandIterations, onIteration, onOpenStage } = props;
      const scfStage = pickScfStage(run, bundles, lineage);
      const scf = scfStage ? scfSeries(bundles[scfStage.id].abacus.log) : null;
      const lBundle = focusL ? bundles[focusL.id] : null;
      const rows = qsgwRows(lBundle);
      const q = qsgwSeries(rows);
      const latestBand = bandIterations && bandIterations.length ? bandIterations[bandIterations.length - 1] : null;
      const marker = iteration === null || iteration === undefined ? latestBand : iteration;
      const pick = (x) => {
        if (bandIterations && bandIterations.includes(x)) onIteration(x);
      };

      const left = h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { className: 'af-chart-title' },
          scfStage ? h(ProducerTag, { producer: 'abacus', stage: scfStage.rel || scfStage.name }) : h(ProducerTag, { producer: 'abacus' }),
          scfStage ? h(StateBadge, { state: states[scfStage.id] }) : null,
          h('span', null, 'SCF 电荷密度残差'),
          scfStage ? h(Btn, { size: 'sm', kind: 'ghost', onClick: () => onOpenStage(scfStage.id, 'scf') }, '详情') : null,
        ),
        scf && scf.rho.length
          ? h(LineChart, { series: scf.rho, height: 176, yLabel: 'log₁₀ Δρ', xLabel: 'SCF 步', formatY: (v) => v.toFixed(1), empty: '没有 Δρ 记录' })
          : h(Empty, null, run.stages.some((s) => !bundles[s.id]) ? '读取中…' : '这个运行没有多步 SCF 记录（nscf / 导出阶段只有一步）。'),
      );

      const right = h(
        'div',
        { style: { minWidth: 0 } },
        h(
          'div',
          { className: 'af-chart-title' },
          focusL ? h(ProducerTag, { producer: 'librpa', stage: focusL.rel || focusL.name }) : h(ProducerTag, { producer: 'librpa' }),
          focusL ? h(StateBadge, { state: states[focusL.id] }) : null,
          h('span', null, 'QSGW 自洽'),
          focusL && rows.length ? h(Btn, { size: 'sm', kind: 'ghost', onClick: () => onOpenStage(focusL.id, 'qsgw') }, '迭代表') : null,
        ),
        rows.length
          ? h(
              React.Fragment,
              null,
              h(LineChart, {
                series: [{ name: '能隙', color: 'var(--af-c-qsgw)', points: q.gap }],
                height: 128,
                yLabel: '能隙 / eV',
                formatY: (v) => v.toFixed(2),
                markerX: marker,
                onPickX: pick,
                empty: '没有能隙列',
              }),
              h(LineChart, {
                series: [
                  { name: 'max ΔE', color: 'var(--af-c-exx)', points: q.delta },
                  { name: '残差 ‖ΔH‖', color: 'var(--af-c-abacus)', dash: '4 3', points: q.residual },
                ],
                height: 128,
                yLabel: 'log₁₀（eV / Ha）',
                xLabel: '迭代',
                formatY: (v) => v.toFixed(1),
                markerX: marker,
                onPickX: pick,
                empty: '没有 ΔE 记录',
              }),
              h('div', { className: 'af-notes' }, h('div', null, h(Icon16, { name: 'info', size: 12 }), h('span', null, bandIterations && bandIterations.length ? '点击迭代点可切换上方能带图的迭代。' : '这一阶段没有逐次迭代的能带文件。'))),
            )
          : h(Empty, null, focusL ? (bundles[focusL.id] ? '这一阶段没有 qsgw_iterations.dat。' : '读取中…') : '这个运行没有 LibRPA 阶段。'),
      );

      return h('div', { className: 'af-grid-2' }, left, right);
    }

    // =====================================================================
    // stage view: one stage's own evidence
    // =====================================================================

    const STAGE_TABS = {
      producer: [['overview', '概览'], ['inputs', '输入'], ['scf', '收敛'], ['structure', '结构'], ['files', '文件']],
      consumer: [['overview', '概览'], ['inputs', '输入'], ['qsgw', 'QSGW'], ['files', '文件']],
      coupled: [['overview', '概览'], ['inputs', '输入'], ['scf', 'SCF'], ['qsgw', 'QSGW'], ['structure', '结构'], ['files', '文件']],
    };

    function StageOverview(props) {
      const { stage, bundle, state, link } = props;
      const status = bundle.status || stage.task.status || {};
      const abacus = bundle.abacus;
      const librpa = bundle.librpa;
      const build = (librpa && librpa.log && librpa.log.build) || {};
      return h(
        React.Fragment,
        null,
        h(Section, { title: '状态与证据' },
          h(KV, {
            rows: [
              ['状态', h(StateBadge, { state })],
              ['判定', state.detail],
              // The agent tools report the host's label; showing it keeps the two reconcilable.
              ['主机状态', status.code ? `${status.label || '—'}（${status.code}）` : null],
              ['主机判据', status.reason],
              ['证据', (status.evidence || []).join(' · ')],
              ['目录', h('span', { className: 'af-mono' }, stage.task.absPath)],
              ['类型', KIND_LABEL[stage.task.kind] || stage.task.kind],
            ],
          })),
        abacus
          ? h(Section, { title: h(ProducerTag, { producer: 'abacus' }) },
              h(KV, {
                rows: [
                  ['程序', abacus.versions ? `${abacus.versions.version || '?'}${abacus.versions.commit ? ` (${abacus.versions.commit})` : ''}` : null],
                  ['calculation', abacus.calculation],
                  ['基组', abacus.basisType],
                  ['输出目录', h('span', { className: 'af-mono' }, abacus.outputDir || '缺失')],
                  ['日志', h('span', { className: 'af-mono' }, abacus.logFile || '—')],
                  abacus.latname ? ['latname', abacus.latname] : null,
                  abacus.stru ? ['结构', `${abacus.stru.natom} 原子 · ${(abacus.stru.species || []).map((s) => s.label).join('/')} · ${abacus.stru.coordinateMode || '?'}`] : null,
                  isNum(abacus.cellVolumeAngstrom3) ? ['晶胞体积', `${fmtNum(abacus.cellVolumeAngstrom3, 3)} Å³`] : null,
                  abacus.kpt ? ['k 点', abacus.kpt.mode === 'auto'
                    ? `${abacus.kpt.centering || ''} ${(abacus.kpt.grid || []).join('×')} 网格，位移 ${(abacus.kpt.shift || []).join(',')}`
                    : `${abacus.kpt.nkpts || 0} 个显式点（${abacus.kpt.kMode || '?'}）`] : null,
                  abacus.kMeshSource && abacus.kMeshSource.source !== 'KPT' ? ['k 点来源', abacus.kMeshSource.note] : null,
                  abacus.log && abacus.log.scfConverged !== null ? ['SCF 收敛', abacus.log.scfConverged ? '是' : '否'] : null,
                  abacus.log && isNum(abacus.log.maxForce) ? ['末次最大受力', `${fmtNum(abacus.log.maxForce)} eV/Å`] : null,
                ],
              }))
          : null,
        librpa
          ? h(Section, { title: h(ProducerTag, { producer: 'librpa' }) },
              h(KV, {
                rows: [
                  ['任务类型', librpa.task],
                  ['读取的产出', link ? h('span', null, link.text, link.raw ? h('div', { className: 'af-src' }, `input_dir = ${link.raw}`) : null) : null],
                  ['源码哈希', h('span', { className: 'af-mono' }, build['Source code Git hash'] || '—')],
                  ['构建类型', build['Build type']],
                  ['LibRI', build['Use LibRI']],
                  ['GreenX', build['GreenX commit hash']],
                  ['MPI', librpa.log ? `${librpa.log.mpi.tasks ?? '?'} 任务 / ${librpa.log.mpi.nodes ?? '?'} 节点` : null],
                  ['输出目录', h('span', { className: 'af-mono' }, librpa.outputDir || '—')],
                  ['日志', h('span', { className: 'af-mono' }, librpa.logFile || '没有 librpa.out')],
                  ['结束标记', librpa.log ? (librpa.log.finished ? 'libRPA finished successfully' : '未出现') : '没有日志可查'],
                ],
              }))
          : null,
        (bundle.notes || []).length > 0
          ? h(Section, { title: '解析备注' }, h('div', { className: 'af-notes' }, bundle.notes.map((note, i) => h('div', { key: i }, h(Icon16, { name: 'info', size: 12 }), h('span', null, note)))))
          : null,
      );
    }

    function ParamGroups(props) {
      const groups = props.groups || [];
      if (groups.length === 0) return h(Empty, null, '没有可解析的参数');
      return h(
        'div',
        null,
        groups.map((group) =>
          h(
            'div',
            { key: group.category || group.group, style: { marginBottom: 'var(--af-s3)' } },
            h('div', { className: 'af-subhead', style: { marginTop: 0 } }, group.category || group.group),
            h(
              'div',
              { className: 'af-pill-list' },
              group.items.map((item) =>
                h(
                  'span',
                  { key: item.key, className: 'af-pill', title: item.doc || item.key, 'data-ok': item.known ? 'true' : 'false' },
                  `${item.key}=${item.value === '' ? '(flag)' : item.value}${item.unit ? ` ${item.unit}` : ''}`,
                ),
              ),
            ),
          ),
        ),
      );
    }

    function InputsPane(props) {
      const { bundle } = props;
      const abacus = bundle.abacus;
      const librpa = bundle.librpa;
      return h(
        React.Fragment,
        null,
        abacus
          ? h(Section, { title: 'INPUT', meta: '分组显示；橙色是未收录的关键字' },
              h(ParamGroups, { groups: (abacus.paramsSummary && abacus.paramsSummary.groups) || [] }),
              abacus.paramsSummary && (abacus.paramsSummary.unknownKeys || []).length > 0
                ? h('div', { className: 'af-hint' }, `未收录关键字：${abacus.paramsSummary.unknownKeys.join('、')}`)
                : null)
          : null,
        librpa
          ? h(Section, { title: 'librpa.in' }, h(ParamGroups, { groups: (librpa.paramsSummary && librpa.paramsSummary.groups) || [] }))
          : null,
        !abacus && !librpa ? h(Empty, null, '没有输入文件') : null,
      );
    }

    function ScfPane(props) {
      const log = props.bundle.abacus && props.bundle.abacus.log;
      if (!log) return h(Empty, { title: '没有可解析的 ABACUS 日志' }, '这个阶段没有 running_*.log。');
      const iterations = log.iterations || [];
      if (iterations.length === 0) return h(Empty, null, '日志里没有 SCF 迭代记录');
      const series = scfSeries(log);
      const last = iterations[iterations.length - 1];
      return h(
        React.Fragment,
        null,
        h(Section, { title: 'SCF 概况', meta: `${iterations.length} 条记录 / ${series.ionicSteps} 个离子步` },
          h(KV, {
            rows: [
              ['末次 E_KohnSham', `${fmtNum(last.eKohnShamEv)} eV`],
              ['末次 E_Fermi', `${fmtNum(last.eFermiEv)} eV`],
              ['末次 E_gap(k)', `${fmtNum(last.gapEv)} eV`],
              ['末次 Δρ', fmtNum(last.rhoDeviation)],
              ['SCF 收敛', log.scfConverged === null ? '日志里没有结论' : log.scfConverged ? '是' : '否'],
              ['总能量记录', (log.lastTotalEnergyEv || []).length > 0 ? log.lastTotalEnergyEv.map((e) => `步 ${e.ionicStep}: ${fmtNum(e.energyEv)} eV`).join('；') : null],
            ],
          })),
        h('div', { className: 'af-grid-2', style: { paddingTop: 'var(--af-s5)' } },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'af-chart-title' }, 'Kohn-Sham 能量'),
            h(LineChart, { series: series.energy, height: 190, yLabel: 'E_KS / eV', xLabel: 'SCF 步', formatY: (v) => v.toFixed(3), empty: '没有能量记录' })),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'af-chart-title' }, '电荷密度残差'),
            h(LineChart, { series: series.rho, height: 190, yLabel: 'log₁₀ Δρ', xLabel: 'SCF 步', formatY: (v) => v.toFixed(1), empty: '没有 Δρ 记录' }))),
        (log.errors || []).length > 0
          ? h(Section, { title: '错误与警告签名' },
              log.errors.map((error, index) =>
                h(Note, { key: index, tone: 'err' }, h('b', null, `${error.code}：${error.message}`), error.evidence ? h('div', { className: 'af-src' }, error.evidence) : null)))
          : null,
      );
    }

    function QsgwPane(props) {
      const { bundle, iteration } = props;
      const librpa = bundle.librpa;
      if (!librpa) return h(Empty, null, '这个阶段没有 LibRPA 输入');
      const iterations = qsgwIterations(bundle);
      const rows = qsgwRows(bundle);
      const columns = (iterations && iterations.columns) || [];
      const eigenvalues = librpa.qsgw && librpa.qsgw.eigenvalues;
      const convergedIter = qsgwConvergedIter(bundle);
      const q = qsgwSeries(rows);
      const last = rows[rows.length - 1];
      return h(
        React.Fragment,
        null,
        rows.length === 0
          ? h(Empty, { title: '没有 qsgw_iterations.dat' }, '这一阶段不是 QSGW 自洽，或迭代表没有被拉回本地。')
          : h(
              React.Fragment,
              null,
              h(Section, { title: 'QSGW 自洽', meta: `${rows.length} 行 · ${String(librpa.outputDir || 'librpa.d').replace(/\/+$/, '')}/qsgw_iterations.dat` },
                h(KV, {
                  rows: [
                    ['是否收敛', convergedIter === null ? '没有一行达到收敛判据' : `第 ${convergedIter} 次迭代收敛`],
                    ['末次 max ΔE', last && isNum(last.max_delta_eV) ? `${last.max_delta_eV.toPrecision(4)} eV` : null],
                    ['末次残差', last && isNum(last.residual_l2_Ha) ? `${last.residual_l2_Ha.toExponential(3)} Ha` : null],
                    ['末次能隙', last && isNum(last.gap_eV) ? fmtEv(last.gap_eV, 4) : null],
                  ],
                }),
                h('div', { className: 'af-grid-2', style: { paddingTop: 'var(--af-s4)' } },
                  h(LineChart, { series: [{ name: '能隙', color: 'var(--af-c-qsgw)', points: q.gap }], height: 170, yLabel: '能隙 / eV', xLabel: '迭代', formatY: (v) => v.toFixed(2), markerX: iteration }),
                  h(LineChart, {
                    series: [
                      { name: 'max ΔE', color: 'var(--af-c-exx)', points: q.delta },
                      { name: '残差 ‖ΔH‖', color: 'var(--af-c-abacus)', dash: '4 3', points: q.residual },
                    ],
                    height: 170,
                    yLabel: 'log₁₀（eV / Ha）',
                    xLabel: '迭代',
                    formatY: (v) => v.toFixed(1),
                    markerX: iteration,
                  }))),
              h(Section, { title: '迭代表' },
                h('div', { className: 'af-table-wrap', style: { maxHeight: 340 } },
                  h('table', { className: 'af-table' },
                    h('thead', null, h('tr', null, columns.map((column) => h('th', { key: column, className: column === 'iter' ? undefined : 'af-num' }, column)))),
                    h('tbody', null, rows.map((row, index) =>
                      h('tr', { key: index, 'data-converged': row.converged ? 'true' : undefined, 'data-sel': iteration !== null && iteration !== undefined && row.iter === iteration ? 'true' : undefined },
                        columns.map((column) => {
                          const value = row[column];
                          const text = typeof value === 'number'
                            ? Number.isInteger(value) ? String(value) : value.toPrecision(5)
                            : value === undefined || value === null ? '—' : String(value);
                          return h('td', { key: column, className: column === 'iter' ? undefined : 'af-num' }, text);
                        }))))))),
            ),
        eigenvalues
          ? h(Section, { title: 'QSGW 本征值' },
              h(KV, {
                rows: [
                  ['规模', `${eigenvalues.nIter} 次迭代 × ${eigenvalues.nKpoint} k 点 × ${eigenvalues.nBand} 条能带`],
                  ['能量范围', `${fmtNum(eigenvalues.minEnergyEv, 4)} – ${fmtNum(eigenvalues.maxEnergyEv, 4)} eV`],
                ],
              }))
          : null,
        librpa.qsgw && librpa.qsgw.hasMatrices
          ? h(Section, { title: '矩阵转储' }, h('div', { className: 'af-hint' }, `qsgw_matrices.dat：${fmtBytes(librpa.qsgw.matricesBytes)}（只统计大小，不解析）`))
          : null,
      );
    }

    function StructurePane(props) {
      const scene = props.bundle.structureScene;
      if (!scene) return h(Empty, { title: '没有可解析的 STRU' }, 'LibRPA 阶段通常不带 STRU；结构在它读取的 ABACUS 阶段里。');
      return h(
        React.Fragment,
        null,
        h(Section, { title: '晶体结构', meta: '拖动旋转 · 滚轮缩放 · 双击复位' }, h(StructureViewer, { scene })),
        h(Section, { title: '元素组成' },
          h('div', { className: 'af-pill-list' }, Object.entries(scene.counts || {}).map(([element, count]) => h('span', { key: element, className: 'af-pill' }, `${element} × ${count}`)))),
      );
    }

    function FilesPane(props) {
      const { stage, bundle } = props;
      const [active, setActive] = useState(null);
      const [file, setFile] = useState(null);
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState(null);
      const [sizes, setSizes] = useState({});
      const id = stage.id;

      useEffect(() => {
        setActive(null);
        setFile(null);
        setError(null);
        setSizes({});
        // Sizes are requested only here, not during the scan: statting every entry of a task
        // directory is what made scanning slow on a network path.
        let cancelled = false;
        api(`/file-size?id=${encodeURIComponent(id)}`)
          .then((result) => {
            if (!cancelled && result && result.sizes) setSizes(result.sizes);
          })
          .catch(() => {
            /* sizes are cosmetic; the list still works without them */
          });
        return () => {
          cancelled = true;
        };
      }, [id]);

      const open = (name) => {
        setActive(name);
        setLoading(true);
        setError(null);
        api(`/file?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`)
          .then((result) => {
            setFile(result);
            setLoading(false);
          })
          .catch((caught) => {
            setError(String(caught.message || caught));
            setFile(null);
            setLoading(false);
          });
      };

      const files = bundle.files || [];
      return h(
        React.Fragment,
        null,
        h(Section, { title: '文件', meta: `${files.length} 项 · 只读预览` },
          files.map((entry) =>
            h(
              'button',
              { key: entry.name, type: 'button', className: 'af-file-row', 'data-active': active === entry.name ? 'true' : undefined, onClick: () => (entry.isDir ? null : open(entry.name)), disabled: entry.isDir },
              h('span', { className: 'af-file-name' }, entry.isDir ? `${entry.name}/` : entry.name),
              h('span', { className: 'af-file-meta' }, entry.isDir ? '目录' : fmtBytes(sizes[entry.name] ? sizes[entry.name].size : entry.size)),
            ),
          )),
        loading ? h(Loading, null, '读取中…') : null,
        error ? h(Note, { tone: 'err' }, error) : null,
        file ? h(Section, { title: file.name, meta: file.truncated ? '已截断' : null }, h('pre', { className: 'af-pre' }, file.text)) : null,
      );
    }

    function StageView(props) {
      const { stage, bundle, state, link, tab, onTab, error, iteration } = props;
      const tabs = STAGE_TABS[stage.role] || STAGE_TABS.producer;
      const active = tabs.some(([id]) => id === tab) ? tab : 'overview';
      let content;
      if (error) content = h(Note, { tone: 'err' }, error);
      else if (!bundle) content = h(Loading, null, '读取这个阶段…');
      else if (active === 'inputs') content = h(InputsPane, { bundle });
      else if (active === 'scf') content = h(ScfPane, { bundle });
      else if (active === 'qsgw') content = h(QsgwPane, { bundle, iteration });
      else if (active === 'structure') content = h(StructurePane, { bundle });
      else if (active === 'files') content = h(FilesPane, { stage, bundle });
      else content = h(StageOverview, { stage, bundle, state, link });
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'af-head', style: { paddingTop: 'var(--af-s4)', paddingBottom: 'var(--af-s2)' } },
          h('div', { className: 'af-subline' },
            h(ProducerTag, { producer: producerOf(stage) }),
            stage.role === 'coupled' ? h(ProducerTag, { producer: 'librpa' }) : null,
            h('span', { style: { font: 'var(--af-t-section)' } }, stage.rel || stage.name),
            h(StateBadge, { state }),
            state && state.detail ? h('span', { className: 'af-hint' }, state.detail) : null),
          h('span', { className: 'af-path', title: stage.task.absPath }, tailPath(stage.task.absPath, 120)),
        ),
        h(
          'div',
          { className: 'af-tabs', role: 'tablist', 'aria-label': '阶段视图' },
          tabs.map(([id, label]) =>
            h('button', { key: id, type: 'button', role: 'tab', className: 'af-tab', 'data-active': active === id ? 'true' : undefined, 'aria-selected': active === id ? 'true' : 'false', onClick: () => onTab(id) }, label),
          ),
        ),
        content,
      );
    }

    // =====================================================================
    // k 收敛研究 — comparison (b): one material across k meshes
    // =====================================================================

    /** Ordinal colours for an ordered mesh series: pale (coarse) → full accent (fine). */
    function meshColor(index, count) {
      const t = count <= 1 ? 1 : index / (count - 1);
      return `color-mix(in srgb, var(--af-accent) ${Math.round(32 + 68 * t)}%, var(--af-fg) ${Math.round(18 * (1 - t))}%)`;
    }

    function lastFiniteIteration(iterations) {
      for (let i = iterations.length - 1; i >= 0; i -= 1) if (isNum(iterations[i].gapEv)) return iterations[i];
      return null;
    }

    /**
     * Runs that differ only by k mesh, found in the scan. The overlay is drawn only when the
     * k paths are identical; the gap table comes from the host's occupation-based band edges
     * (lib/host/kconvergence.js), never from band indices.
     */
    function SeriesView(props) {
      const { series, runs, narrow } = props;
      const members = series.members.map((m) => ({ ...m, run: runs.find((r) => r.key === m.runKey) })).filter((m) => m.run);
      const variants = useMemo(() => {
        const perRun = members.map((m) => new Set(m.run.stages.filter((s) => s.role !== 'producer').map((s) => s.rel)));
        if (perRun.length === 0) return [];
        return [...perRun[0]].filter((rel) => perRun.every((set) => set.has(rel))).sort(natCompare);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [series.key, runs]);
      const [variant, setVariant] = useState(null);
      const rel = variants.includes(variant) ? variant : variants[0] || null;
      const picked = members.map((m) => ({ member: m, stage: rel === null ? null : m.run.stages.find((s) => s.rel === rel) || null }));
      const withStage = picked.filter((p) => p.stage);
      const requests = withStage.map((p, i) => ({ id: `m${i}`, taskId: p.stage.id, only: 'QSGW:1', iteration: null }));
      const loaded = useBandRequests(requests);
      const ids = withStage.map((p) => p.stage.id).join(',');
      const compare = useApi(ids ? `kc:${ids}:${cacheGeneration}` : null, () => api(`/kcompare?ids=${encodeURIComponent(ids)}&kind=QSGW&spin=1`));
      const [win, setWin] = useState({ mode: 'auto', half: 4, lo: null, hi: null });

      const channels = withStage.map((p, i) => {
        const data = loaded[`m${i}`] && loaded[`m${i}`].data;
        const ch = data ? buildBandChannels({ librpa: data.librpa }, `${p.member.label}/${p.stage.rel}`).find((c) => c.kind === 'QSGW') : null;
        return ch ? { ...ch, meshLabel: p.member.label, color: meshColor(i, withStage.length) } : null;
      });
      const reference = channels.find(Boolean) || null;
      const drawn = [];
      const skipped = [];
      for (const ch of channels) {
        if (!ch) continue;
        const alignment = alignChannel(reference, ch, null);
        if (alignment.mode === 'none') skipped.push({ ch, reason: alignment.reason });
        else drawn.push({ key: ch.key, channel: ch, xs: ch.kpath, energies: ch.energies, nBand: ch.nBand, color: ch.color, dash: null, width: 1.3 });
      }
      const rows = (compare.data && compare.data.rows) || [];
      const refRow = rows.find((r) => isNum(r.vbmEv) && isNum(r.cbmEv));
      const centre = refRow ? (refRow.vbmEv + refRow.cbmEv) / 2 : null;
      const extent = channelExtent(drawn.map((d) => d.channel));
      const range = win.mode === 'manual' && isNum(win.lo) && isNum(win.hi) && win.hi > win.lo
        ? { lo: win.lo, hi: win.hi }
        : win.mode === 'all' && extent ? { lo: extent.min, hi: extent.max } : defaultWindow(extent, centre, win.half);
      const pending = requests.some((r) => loaded[r.id] && loaded[r.id].loading);

      return h(
        React.Fragment,
        null,
        h('div', { className: 'af-controls' },
          variants.length > 1
            ? h('label', { className: 'af-control' }, '比较的阶段',
                h('select', { className: 'af-select', value: rel || '', onChange: (event) => setVariant(event.target.value) }, variants.map((v) => h('option', { key: v, value: v }, v))))
            : rel ? h('span', { className: 'af-control' }, '比较的阶段', h('b', null, rel)) : null,
          h('span', { className: 'af-control' }, '窗口',
            h(Seg, {
              label: '能量窗口',
              value: win.mode === 'auto' ? win.half : win.mode === 'all' ? 'all' : null,
              options: [{ value: 2, label: '±2' }, { value: 4, label: '±4' }, { value: 8, label: '±8' }, { value: 'all', label: '全部' }],
              onChange: (value) => setWin(value === 'all' ? { mode: 'all', half: win.half } : { mode: 'auto', half: value }),
            })),
          narrow ? null : h(RangeInputs, { range, onChange: (lo, hi) => setWin({ mode: 'manual', half: win.half, lo, hi }) })),
        variants.length === 0
          ? h(Empty, { title: '这些运行没有共同的 LibRPA 阶段' }, '系列成员需要有同名的阶段（例如都有 frozen/）才能逐点比较。')
          : drawn.length > 0 && reference
            ? h(BandChart, {
                series: drawn,
                ticks: reference.kTicks || [],
                xMin: reference.kpath[0],
                xMax: reference.kpath[reference.kpath.length - 1],
                lo: range.lo,
                hi: range.hi,
                height: narrow ? 280 : 340,
                ariaLabel: `${series.key} QSGW 能带随 k 网格`,
              })
            : pending ? h(Loading, null, '载入各网格的 QSGW 能带…') : h(Empty, null, '各网格都没有 QSGW 能带文件。'),
        drawn.length > 0
          ? h('div', { className: 'af-legend' }, drawn.map((d) =>
              h('span', { key: d.key, className: 'af-legend-item' }, h(LineSwatch, { color: d.color }), `${d.channel.meshLabel} · QSGW 第 ${d.channel.iter ?? '?'} 次`)))
          : null,
        h('div', { className: 'af-notes' },
          drawn.length > 1 ? h('div', null, h(Icon16, { name: 'info', size: 12 }), h('span', null, 'k 轴：各网格的 k 路径完全相同，逐点叠加。')) : null,
          skipped.map((s) => h('div', { key: s.ch.key }, h(Icon16, { name: 'warn', size: 12 }), h('span', null, `未叠加：${s.ch.meshLabel} — ${s.reason}`))),
          centre !== null && win.mode === 'auto' ? h('div', null, h(Icon16, { name: 'info', size: 12 }), h('span', null, `窗口以 ${refRow.label} 的带隙中点（由占据数确定的 VBM/CBM）为中心。`)) : null),
        h(Section, { title: '各网格的能隙', meta: 'QSGW spin 1 · 每个网格的最新迭代 · 由占据数确定带边' },
          compare.loading ? h(Loading, null, '计算带边…')
            : compare.error ? h(Note, { tone: compare.error.startsWith('404') ? 'info' : 'err' }, compare.error.startsWith('404') ? '宿主没有 /kcompare 接口（插件版本较旧），无法给出各网格能隙。' : compare.error)
              : rows.length === 0 ? h(Empty, null, '没有可比较的行。')
                : h('div', { className: 'af-table-wrap' },
                    h('table', { className: 'af-table' },
                      h('thead', null, h('tr', null,
                        h('th', null, '网格'), h('th', null, '阶段'), h('th', { className: 'af-num' }, '迭代'),
                        h('th', { className: 'af-num' }, '能隙'), h('th', { className: 'af-num' }, '相对首个网格'), h('th', { className: 'af-num' }, '可用 k 点'))),
                      h('tbody', null, rows.map((r, i) => {
                        const p = withStage.find((x) => r.label && r.label.endsWith(x.stage.task.relPath)) || withStage[i];
                        return h('tr', { key: r.label || i },
                          h('td', null, p ? p.member.label : '—'),
                          h('td', null, h('span', { className: 'af-src' }, r.label)),
                          h('td', { className: 'af-num' }, r.iter ?? '—'),
                          h('td', { className: 'af-val' }, fmtEv(r.gapEv, 4)),
                          h('td', { className: 'af-num' }, isNum(r.deltaGapVsReferenceEv) ? fmtMeV(r.deltaGapVsReferenceEv) : '—'),
                          h('td', { className: 'af-num' }, `${r.usableKpoints ?? '—'} / ${r.nKpoint ?? '—'}`));
                      })))),
          compare.data
            ? h('div', { className: 'af-notes' },
                [...(compare.data.notes || []), ...(compare.data.warnings || [])].map((n, i) => h('div', { key: i }, h(Icon16, { name: 'info', size: 12 }), h('span', null, n))),
                h('div', null, h(Icon16, { name: 'info', size: 12 }), h('span', null, '这是固定预算下的敏感性比较；多少 meV 算收敛取决于你的量与容差，面板不下结论。')))
            : null),
      );
    }

    /** The campaign snapshot (snapshot.json) or a `<material>/k444…` tree. */
    function KStudyView(props) {
      const { path, material, onMaterial } = props;
      const study = useApi(path ? `ks:${path}` : null, () => api(`/kstudy?path=${encodeURIComponent(path)}`));
      const setMaterial = onMaterial;
      if (!path) return null;
      if (study.loading) return h(Loading, null, '读取研究…');
      if (study.error) return h(Note, { tone: 'err' }, study.error);
      const data = study.data;
      if (!data) return null;
      const materials = data.materials || [];
      if (materials.length === 0) {
        return h(Empty, { title: '没有找到 k 网格数据' }, (data.warnings || []).join('；') || '路径下既没有 <材料>/k444… 目录，也没有 snapshot.json。');
      }
      const current = materials.find((m) => m.material === material) || materials[0];
      const meshes = current.meshes || [];
      const finals = meshes.map((m) => ({ mesh: m, last: lastFiniteIteration(m.iterations || []) }));
      const perIter = meshes.map((m, i) => ({
        name: `k${String(m.mesh).repeat(3)}${m.complete ? '' : '（未完成）'}`,
        color: meshColor(i, meshes.length),
        dash: m.complete ? null : '4 3',
        points: (m.iterations || []).filter((it) => isNum(it.gapEv)).map((it) => ({ x: it.iter, y: it.gapEv })),
      }));
      // Incomplete meshes stopped after fewer updates: drawn as their own dashed series so the
      // eye does not read a fixed-budget comparison into them.
      const point = (f) => ({ x: f.mesh.mesh, y: f.last.gapEv });
      const vsMesh = [
        { name: '末次能隙（完成的网格）', color: 'var(--af-c-qsgw)', points: finals.filter((f) => f.last && f.mesh.complete).map(point) },
        { name: '未完成的网格', color: 'var(--af-c-exx)', dash: '4 3', points: finals.filter((f) => f.last && !f.mesh.complete).map(point) },
      ].filter((s) => s.points.length > 0);
      const zeroGaps = finals.filter((f) => f.last && f.last.gapEv === 0).map((f) => `k${String(f.mesh.mesh).repeat(3)}`);
      const deltas = (data.deltas || []).filter((d) => d.material === current.material);
      const iterOf = (mesh) => {
        const f = finals.find((x) => x.mesh.mesh === mesh);
        return f && f.last ? f.last.iter : null;
      };

      return h(
        React.Fragment,
        null,
        h('div', { className: 'af-controls' },
          materials.length > 1
            ? h('span', { className: 'af-control' }, '材料', h(Seg, { label: '材料', value: current.material, options: materials.map((m) => ({ value: m.material, label: m.material })), onChange: setMaterial }))
            : null,
          h('span', { className: 'af-hint' }, `来源：${data.source === 'snapshot' ? '分析快照 snapshot.json' : '运行目录树'}${data.observedUtc ? ` · 记录于 ${data.observedUtc}` : ''}`)),
        data.limitation ? h(Note, { tone: 'warn' }, h('b', null, '研究自己记录的适用范围：'), String(data.limitation)) : null,
        zeroGaps.length > 0
          ? h(Note, { tone: 'warn' }, `${current.material} 在 ${zeroGaps.join('、')} 的末次能隙恰为 0 eV。快照只记录了这个数；请结合 max ΔE 判断那次更新是否已经失败，面板不替你判断。`)
          : null,
        h('div', { className: 'af-grid-2', style: { paddingTop: 'var(--af-s4)' } },
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'af-chart-title' }, '末次能隙 vs 网格'),
            h(LineChart, { series: vsMesh, height: 200, yLabel: '能隙 / eV', xLabel: 'k 网格 n（n×n×n）', formatY: (v) => v.toFixed(3), formatX: (v) => `k${String(v).repeat(3)}` })),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'af-chart-title' }, '能隙随 QSGW 更新（每条线一个网格）'),
            h(LineChart, { series: perIter, height: 200, yLabel: '能隙 / eV', xLabel: 'QSGW 更新', formatY: (v) => v.toFixed(3) }))),
        h(Section, { title: '相邻网格能隙差', meta: '差值随网格变细而稳定变小，才是收敛的证据；来回振荡说明还没到位' },
          h('div', { className: 'af-table-wrap' },
            h('table', { className: 'af-table' },
              h('thead', null, h('tr', null,
                h('th', null, '从'), h('th', null, '到'), h('th', { className: 'af-num' }, '粗网格能隙'), h('th', { className: 'af-num' }, '细网格能隙'),
                h('th', { className: 'af-num' }, '差值'), h('th', null, '比较的迭代'))),
              h('tbody', null, deltas.map((d, i) => {
                const a = iterOf(d.coarser);
                const b = iterOf(d.finer);
                const mismatch = a !== null && b !== null && a !== b;
                return h('tr', { key: i },
                  h('td', null, `k${String(d.coarser).repeat(3)}`),
                  h('td', null, `k${String(d.finer).repeat(3)}`),
                  h('td', { className: 'af-num' }, fmtEv(d.coarseGapEv, 4)),
                  h('td', { className: 'af-num' }, fmtEv(d.fineGapEv, 4)),
                  h('td', { className: 'af-val' }, fmtMeV(d.deltaGapEv)),
                  h('td', null, mismatch
                    ? h('span', { className: 'af-state', title: '两个网格停在不同的迭代，差值混合了自洽进度与网格效应' }, h(StateGlyph, { code: 'unconv', size: 11 }), `第 ${a} vs 第 ${b} 次`)
                    : h('span', { className: 'af-hint' }, a !== null ? `都是第 ${a} 次` : '—')));
              }))))),
        (data.warnings || []).length ? h('div', { className: 'af-notes' }, data.warnings.map((w, i) => h('div', { key: i }, h(Icon16, { name: 'warn', size: 12 }), h('span', null, w)))) : null,
      );
    }

    function StudiesPlace(props) {
      const { runs, series, activeSeriesKey, onSeries, kstudyPath, onKstudyPath, narrow } = props;
      const [input, setInput] = useState(kstudyPath || '');
      useEffect(() => setInput(kstudyPath || ''), [kstudyPath]);
      const active = series.find((s) => s.key === activeSeriesKey) || series[0] || null;
      return h(
        'div',
        { className: 'af-page' },
        h('div', { className: 'af-head' },
          h('h2', { className: 'af-title' }, 'k 收敛研究'),
          h('span', { className: 'af-hint' }, '同一材料在不同 k 网格下的一组计算：是一项研究，不是单个任务。面板只报告差值，不判定"已收敛"。')),
        h(Section, { title: '扫描里的 k 网格系列', meta: '运行名只差网格记号（k444 / k666 …）的自动归为一组' },
          series.length === 0
            ? h(Empty, null, '当前扫描结果里没有只差 k 网格的运行。')
            : h(React.Fragment, null,
                series.length > 1
                  ? h('div', { className: 'af-controls' }, h(Seg, { label: '系列', value: active.key, options: series.map((s) => ({ value: s.key, label: s.key })), onChange: onSeries }))
                  : h('div', { className: 'af-controls' }, h('span', { className: 'af-chip' }, h(Icon16, { name: 'layers', size: 12 }), active.label)),
                h(SeriesView, { key: active.key, series: active, runs, narrow }))),
        h(Section, { title: '分析快照 / 运行目录树', meta: '原始 run 已清理时，snapshot.json 是唯一完整的记录' },
          h('div', { className: 'af-toolbar-row', style: { marginBottom: 'var(--af-s3)' } },
            h('input', {
              className: 'af-input',
              placeholder: 'snapshot.json 的路径，或含 <材料>/k444… 的目录',
              value: input,
              onChange: (event) => setInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') onKstudyPath(input.trim());
              },
            }),
            h(Btn, { kind: 'primary', onClick: () => onKstudyPath(input.trim()), disabled: !input.trim() }, '读取')),
          kstudyPath
            ? h(KStudyView, { path: kstudyPath, material: props.kstudyMaterial, onMaterial: props.onKstudyMaterial })
            : h('div', { className: 'af-hint' }, '读取过的路径会记在本浏览器里，下次直接打开。')),
      );
    }

    // =====================================================================
    // 对比篮: hand-picked channels from any runs
    // =====================================================================

    function BasketPlace(props) {
      const basket = useCompareBasket();
      const [refKey, setRefKey] = useState(null);
      const [win, setWin] = useState({ mode: 'auto', half: 6, lo: null, hi: null });
      const narrow = props.narrow;
      if (basket.length === 0) {
        return h('div', { className: 'af-page' },
          h('div', { className: 'af-head' }, h('h2', { className: 'af-title' }, '对比篮')),
          h(Empty, { title: '对比篮是空的' },
            '在运行页的能带对比里点「加入对比篮」，把不同运行（两种材料、两个变体）的曲线放到一起。',
            h('br'),
            '同一运行里 ABACUS 与 LibRPA 的对比不需要它——那张图默认就在运行页。'));
      }
      const reference = basket.find((c) => c.key === refKey) || basket[0];
      const drawn = [];
      const skipped = [];
      basket.forEach((ch, i) => {
        const alignment = alignChannel(reference, ch, null);
        const color = BAND_COLORS[i % BAND_COLORS.length];
        if (alignment.mode === 'none') skipped.push({ ch, reason: alignment.reason, color });
        else drawn.push({ key: ch.key, channel: ch, xs: ch.kpath, energies: ch.energies, nBand: ch.nBand, color, dash: ch.source === 'abacus' ? null : bandStyle(ch).dash, width: 1.3 });
      });
      const extent = channelExtent(drawn.map((d) => d.channel));
      const centre = isNum(reference.fermi) ? reference.fermi : null;
      const range = win.mode === 'manual' && isNum(win.lo) && isNum(win.hi) && win.hi > win.lo
        ? { lo: win.lo, hi: win.hi }
        : win.mode === 'all' && extent ? { lo: extent.min, hi: extent.max } : defaultWindow(extent, centre, win.half);
      const producers = new Set(drawn.map((d) => d.channel.source));
      return h(
        'div',
        { className: 'af-page' },
        h('div', { className: 'af-head' },
          h('h2', { className: 'af-title' }, '对比篮'),
          h('span', { className: 'af-hint' }, `${basket.length} 条曲线，来自 ${new Set(basket.map((c) => c.runName || c.taskLabel)).size} 个运行。跨运行比较；只叠加与参考曲线 k 路径相同的曲线。`)),
        h('div', { className: 'af-controls' },
          h('span', { className: 'af-control' }, '窗口',
            h(Seg, {
              label: '能量窗口',
              value: win.mode === 'auto' ? win.half : win.mode === 'all' ? 'all' : null,
              options: WINDOW_PRESETS,
              onChange: (value) => setWin(value === 'all' ? { mode: 'all', half: win.half } : { mode: 'auto', half: value }),
            })),
          narrow ? null : h(RangeInputs, { range, onChange: (lo, hi) => setWin({ mode: 'manual', half: win.half, lo, hi }) }),
          h(Btn, { size: 'sm', kind: 'ghost', icon: 'close', onClick: clearCompare }, '清空')),
        drawn.length > 0
          ? h(BandChart, {
              series: drawn,
              ticks: reference.kTicks || [],
              xMin: reference.kpath[0],
              xMax: reference.kpath[reference.kpath.length - 1],
              lo: range.lo,
              hi: range.hi,
              height: narrow ? 300 : 380,
              ariaLabel: '对比篮',
            })
          : null,
        h('div', { className: 'af-table-wrap', style: { marginTop: 'var(--af-s3)' } },
          h('table', { className: 'af-table' },
            h('thead', null, h('tr', null, h('th', null, '曲线'), h('th', null, '状态'), h('th', null, ''))),
            h('tbody', null, [...drawn.map((d) => ({ ch: d.channel, color: d.color, reason: null })), ...skipped.map((s) => ({ ch: s.ch, color: s.color, reason: s.reason }))].map((row) =>
              h('tr', { key: row.ch.key },
                h('td', null, h('span', { className: 'af-legend-item' }, h(LineSwatch, { color: row.color }), h(ProducerGlyph, { producer: row.ch.source }), row.ch.label)),
                h('td', null, row.ch.key === reference.key
                  ? h('span', { className: 'af-hint' }, '参考 k 轴')
                  : row.reason ? h('span', { className: 'af-state' }, h(StateGlyph, { code: 'unconv', size: 11 }), `未叠加：${row.reason}`) : h('span', { className: 'af-hint' }, '已叠加')),
                h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
                  row.ch.key !== reference.key ? h(Btn, { size: 'sm', kind: 'ghost', onClick: () => setRefKey(row.ch.key) }, '设为参考') : null,
                  h(Btn, { size: 'sm', kind: 'ghost', icon: 'close', title: '移出对比篮', 'aria-label': '移出对比篮', onClick: () => removeFromCompare(row.ch.key) }))))))),
        producers.size > 1 ? h('div', { className: 'af-notes' }, h('div', null, h(Icon16, { name: 'info', size: 12 }), h('span', null, ENERGY_ZERO_NOTE))) : null,
      );
    }

    // =====================================================================
    // 数据库: the LibRPA-database catalogue
    // =====================================================================

    /**
     * A database record's upstream artefacts: the published figure and the band curves.
     *
     * Nothing here is downloaded until the record is expanded, and even then the figure is a
     * lazy `<img>` and the curves are only parsed if the user opens them. That is the whole
     * point of the metadata-only index: 122 records cost 3.1 MB, and a plot costs 250 KB that
     * you asked for.
     */
    function LibraryAssets(props) {
      const { id } = props;
      const assets = useApi(`assets:${id}`, () => api(`/library/assets?id=${encodeURIComponent(id)}`));
      const [showFigure, setShowFigure] = useState(null);
      const [curve, setCurve] = useState(null);
      const [curveLoading, setCurveLoading] = useState(false);
      const [curveError, setCurveError] = useState(null);

      if (assets.loading) return h('div', { className: 'af-hint' }, h(Spinner), '读取数据库资产目录…');
      if (assets.error) return h(Note, { tone: 'err' }, String(assets.error));
      const data = assets.data;
      if (!data || !data.ok) {
        return h(Note, { tone: 'warn' }, `数据库资产不可用：${(data && data.error) || '未配置'}`);
      }

      const figures = data.figures || [];
      const bandData = data.bandData || [];
      if (figures.length === 0 && bandData.length === 0) {
        return h('div', { className: 'af-hint' }, '这条记录没有上传图或能带数据。');
      }

      const pngs = figures.filter((f) => /\.png$/i.test(f.label));
      const chosen = showFigure ?? (pngs[0] ? pngs[0].label : null);
      const activeFigure = figures.find((f) => f.label === chosen) || pngs[0] || null;

      const loadCurve = (item) => {
        setCurveLoading(true);
        setCurveError(null);
        // Fetched through the host proxy so the browser never talks to the mirror directly.
        fetch(`/abacusflow/api/library/asset?url=${encodeURIComponent(item.url)}`)
          .then((response) => {
            if (!response.ok) throw new Error(`${response.status}`);
            return response.text();
          })
          .then((text) => {
            const parsed = parsePublishedBandCurve(text);
            if (!parsed.rows.length) {
              setCurveError('这个文件里没有可识别的 k/能量列');
              setCurve(null);
            } else {
              setCurve({ label: item.label, ...parsed });
            }
            setCurveLoading(false);
          })
          .catch((error) => {
            setCurveError(String(error.message || error));
            setCurveLoading(false);
          });
      };

      return h(
        'div',
        { className: 'af-lib-assets' },
        figures.length > 0
          ? h(
              'div',
              { className: 'af-lib-figure' },
              h(
                'div',
                { className: 'af-lib-assets-head' },
                h('span', null, '已发表图'),
                pngs.length > 1
                  ? h(
                      'span',
                      { className: 'af-seg' },
                      pngs.map((f) =>
                        h(
                          'button',
                          {
                            key: f.label,
                            type: 'button',
                            className: 'af-toggle',
                            'aria-pressed': activeFigure && f.label === activeFigure.label ? 'true' : 'false',
                            onClick: () => setShowFigure(f.label),
                          },
                          f.label.replace(/^.*_/, '').replace(/\.png$/i, ''),
                        ),
                      ),
                    )
                  : null,
              ),
              activeFigure
                ? h('img', {
                    className: 'af-lib-img',
                    src: `/abacusflow/api/library/asset?url=${encodeURIComponent(activeFigure.url)}`,
                    alt: `${data.id} ${activeFigure.label}`,
                    loading: 'lazy',
                  })
                : null,
              h('div', { className: 'af-hint' },
                '图由数据库上游按需取回（不下载整库）。基组、k 网格与程序版本可能与你本地运行不同，仅作参照。'),
            )
          : null,
        bandData.length > 0
          ? h(
              'div',
              { className: 'af-lib-curves' },
              h(
                'div',
                { className: 'af-lib-assets-head' },
                h('span', null, '能带数据'),
                h(
                  'span',
                  { className: 'af-seg' },
                  bandData.map((item) =>
                    h(
                      'button',
                      {
                        key: item.label,
                        type: 'button',
                        className: 'af-toggle',
                        onClick: () => loadCurve(item),
                      },
                      item.label.replace(/^.*_/, '').replace(/\.dat$/i, ''),
                    ),
                  ),
                ),
              ),
              curveLoading ? h('div', { className: 'af-hint' }, h(Spinner), '取回并解析曲线…') : null,
              curveError ? h(Note, { tone: 'err' }, `解析失败：${curveError}`) : null,
              curve
                ? h(PublishedBandChart, { curve, height: 300 })
                : h('div', { className: 'af-hint' }, '点上面的按钮，按需取回该条记录的能带数据并画出曲线。'),
            )
          : null,
      );
    }

    /**
     * Parse a published database band file.
     *
     * The published `*_KS/EXX/GW.dat` files are whitespace tables whose first column is a
     * k index or path coordinate and whose remaining columns are energies; some carry a
     * header line. This accepts the shape it can prove and says so when it cannot, rather
     * than plotting a wrong column silently.
     *
     * @param {string} text
     * @returns {{ columns:number, rows:number[][], kIndex:number[] }}
     */
    function parsePublishedBandCurve(text) {
      const rows = [];
      for (const raw of String(text ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#') || line.startsWith('!')) continue;
        const values = line.split(/\s+|,/).filter(Boolean).map(Number);
        if (values.length < 2 || values.some((v) => !Number.isFinite(v))) continue;
        rows.push(values);
      }
      if (rows.length === 0) return { columns: 0, rows: [] };
      // Every row must have the same width or the columns mean different things per row.
      const width = rows[0].length;
      if (rows.some((r) => r.length !== width)) return { columns: 0, rows: [] };
      return { columns: width, rows };
    }

    /** Draw a published band curve: k (column 0) against every energy column. */
    function PublishedBandChart(props) {
      const { curve, height } = props;
      const rows = curve.rows || [];
      if (rows.length < 2) return h('div', { className: 'af-empty' }, '曲线数据不足');
      const kValues = rows.map((r) => r[0]);
      const energies = rows.map((r) => r.slice(1));
      const nBand = energies[0].length;
      const flat = energies.flat().filter(Number.isFinite);
      const eMin = Math.min(...flat);
      const eMax = Math.max(...flat);
      const h4 = height || 300;
      const width = 760;
      const padL = 56;
      const padR = 12;
      const padT = 10;
      const padB = 26;
      const kMin = Math.min(...kValues);
      const kMax = Math.max(...kValues);
      const sx = (k) => padL + ((k - kMin) / (kMax - kMin || 1)) * (width - padL - padR);
      const sy = (e) => padT + (1 - (e - eMin) / (eMax - eMin || 1)) * (h4 - padT - padB);
      const paths = [];
      for (let band = 0; band < nBand; band += 1) {
        let d = '';
        let started = false;
        for (let i = 0; i < rows.length; i += 1) {
          const e = energies[i][band];
          if (!Number.isFinite(e)) {
            started = false;
            continue;
          }
          d += `${started ? 'L' : 'M'}${sx(kValues[i]).toFixed(2)},${sy(e).toFixed(2)} `;
          started = true;
        }
        if (d.trim() === '') continue;
        paths.push(h('path', { key: `b${band}`, d, fill: 'none', stroke: 'var(--af-brand)', strokeWidth: 1.1, opacity: 0.9 }));
      }
      return h(
        'div',
        null,
        h(
          'svg',
          { className: 'af-chart', viewBox: `0 0 ${width} ${h4}`, preserveAspectRatio: 'none', style: { height: `${h4}px` } },
          h('line', { className: 'af-axis', x1: padL, x2: width - padR, y1: h4 - padB, y2: h4 - padB }),
          h('line', { className: 'af-axis', x1: padL, x2: padL, y1: padT, y2: h4 - padB }),
          h('text', { x: 4, y: padT + 9 }, 'eV'),
          h('text', { x: padL - 5, y: h4 - padB + 3, textAnchor: 'end' }, eMin.toFixed(1)),
          h('text', { x: padL - 5, y: padT + 9, textAnchor: 'end' }, eMax.toFixed(1)),
          paths,
        ),
        h('div', { className: 'af-hint' },
          `${curve.label} · ${rows.length} 行 × ${nBand} 条能量列（第 1 列作为 k）· 纵轴不重设零点，保持数据库原值`),
      );
    }

    function LibraryRecord(props) {
      const { record, open, onToggle } = props;
      return h(
        'div',
        { className: 'af-lib-record' },
        h(
          'button',
          { type: 'button', className: 'af-lib-record-head', onClick: onToggle, 'aria-expanded': open ? 'true' : 'false' },
          h(Icon16, { name: open ? 'chevronDown' : 'chevronRight', size: 12 }),
          h('span', { className: 'af-lib-id' }, record.id),
          record.dimension ? h('span', { className: 'af-chip' }, record.dimension) : null,
          isNum(record.gwGapEv) ? h('span', { className: 'af-num' }, `GW ${record.gwGapEv.toFixed(3)} eV`) : null,
          isNum(record.exxGapEv) ? h('span', { className: 'af-num af-dim' }, `EXX ${record.exxGapEv.toFixed(3)}`) : null,
          isNum(record.dftGapEv) ? h('span', { className: 'af-num af-dim' }, `DFT ${record.dftGapEv.toFixed(3)}`) : null,
          record.confidence
            ? h('span', { className: 'af-conf', 'data-c': record.confidence }, record.confidence === 'high' ? '按 STRU 确定' : record.confidence === 'medium' ? '按目录名，可能' : '弱候选')
            : null,
        ),
        open
          ? h('div', { className: 'af-lib-detail' },
              record.scope ? h('div', { className: 'af-hint' }, `适用范围：${record.scope}`) : null,
              record.scientificStatus ? h('div', { className: 'af-hint' }, `科学状态：${record.scientificStatus}`) : null,
              record.species && record.species.length ? h('div', { className: 'af-hint' }, `物种：${record.species.map((s) => `${s.element}${s.nao ? ` (${s.nao})` : ''}`).join(' · ')}`) : null,
              record.abacusCommit || record.librpaCommit ? h('div', { className: 'af-hint' }, `来源版本：ABACUS ${record.abacusCommit || '未记录'} / LibRPA ${record.librpaCommit || '未记录'}`) : null,
              record.path ? h('div', { className: 'af-src' }, record.path) : null,
              // Mounted only while open: the asset listing (and any figure) is fetched on
              // demand, so a list of 100 records costs nothing until one is opened.
              h(LibraryAssets, { id: record.id }))
          : null,
      );
    }

    function LibraryPlace(props) {
      const { initialQuery, matchStage, runName } = props;
      const [query, setQuery] = useState(initialQuery || '');
      const [submitted, setSubmitted] = useState(initialQuery || '');
      const [expanded, setExpanded] = useState(null);
      useEffect(() => {
        setQuery(initialQuery || '');
        setSubmitted(initialQuery || '');
      }, [initialQuery]);
      const search = useApi(`lib:${submitted}`, () => api(`/library/search${submitted ? `?q=${encodeURIComponent(submitted)}` : ''}`));
      const match = useApi(matchStage ? `match:${matchStage.id}:${cacheGeneration}` : null, () => fetchMatch(matchStage.id));
      const matches = match.data && match.data.ok ? match.data.matches || [] : [];
      const records = (search.data && search.data.records) || [];
      const row = (record, prefix) =>
        h(LibraryRecord, {
          key: `${prefix}:${record.id}`,
          record,
          open: expanded === `${prefix}:${record.id}`,
          onToggle: () => setExpanded(expanded === `${prefix}:${record.id}` ? null : `${prefix}:${record.id}`),
        });
      return h(
        'div',
        { className: 'af-page' },
        h('div', { className: 'af-head' },
          h('h2', { className: 'af-title' }, 'LibRPA 数据库'),
          h('span', { className: 'af-hint' }, '已发表的 GW 记录（AroundPeking/LibRPA-database）。只作参照：基组、k 网格和程序版本都可能与你的运行不同。')),
        matchStage
          ? h(Section, { title: `与当前运行匹配：${runName}`, meta: match.data && match.data.tried ? `已尝试：${match.data.tried.join('、')}` : null },
              match.loading ? h(Loading, null, '比对中…')
                : match.data && !match.data.ok ? h(Note, { tone: 'warn' }, `数据库不可用：${match.data.error || '未配置'}。在插件配置里设置 libraryRoot。`)
                  : matches.length === 0 ? h(Empty, null, '没有匹配的记录') : matches.map((r) => row(r, 'm')))
          : null,
        h(Section, { title: '检索', meta: search.data ? `共 ${search.data.total || 0} 条` : null },
          h('div', { className: 'af-toolbar-row', style: { marginBottom: 'var(--af-s3)' } },
            h('input', {
              className: 'af-input af-input-text',
              placeholder: '材料 / 编号 / 维度，例如 NiO、Bi2Se3、2d',
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') setSubmitted(query.trim());
              },
            }),
            h(Btn, { icon: 'search', onClick: () => setSubmitted(query.trim()) }, '检索'),
            h(Btn, { kind: 'ghost', onClick: () => { setQuery(''); setSubmitted(''); } }, '全部')),
          search.data && (search.data.formulas || []).length
            ? h('div', { className: 'af-pill-list', style: { marginBottom: 'var(--af-s3)' } },
                search.data.formulas.map((formula) => h('button', { key: formula, type: 'button', className: 'af-toggle', 'aria-pressed': submitted === formula ? 'true' : 'false', onClick: () => { setQuery(formula); setSubmitted(formula); } }, formula)))
            : null,
          search.loading ? h(Loading, null, '读取数据库…')
            : search.error ? h(Note, { tone: 'err' }, search.error)
              : search.data && !search.data.ok ? h(Note, { tone: 'warn' }, `数据库不可用：${search.data.error || '未配置'}。在插件配置里设置 libraryRoot（数据库检出目录）。`)
                : records.length === 0 ? h(Empty, null, '没有匹配的记录') : records.slice(0, 100).map((r) => row(r, 's'))),
      );
    }

    // =====================================================================
    // agent dock (AITP-facing module)
    // =====================================================================
    //
    // The only place this panel acts, and all it does is compose a message for the agent.
    // Everything that touches AITP — the research.md lookup and the handoff intents — lives in
    // this section, so the panel is fully usable when AITP is absent or changes its layout.
    // AITP exposes agent tools only; the seam is the conversation:
    //
    //   panel (inspect) → message → agent → research_* / abacus_* tools → files → rescan

    /**
     * Nearest research.md above a stage, found by the host walking up the directory tree.
     * A missing route (older host) or a failed lookup degrades to "nothing claimed".
     */
    function useResearchContext(taskId) {
      return useApi(taskId ? `rc:${taskId}` : null, () =>
        api(`/research-context?id=${encodeURIComponent(taskId)}`).catch(() => ({ found: false, unavailable: true })),
      );
    }

    function HandoffSheet(props) {
      const { handoff, onSend } = props;
      const intents = handoffIntents(handoff.summary);
      const [intentId, setIntentId] = useState(intents[0].id);
      const [note, setNote] = useState('');
      const intent = intents.find((i) => i.id === intentId) || intents[0];
      const research = handoff.research && handoff.research.data;
      const composed = buildHandoffMessage({
        run: handoff.run,
        stages: handoff.items,
        ledger: handoff.ledger,
        research,
        intent,
        note,
      });
      const [draft, setDraft] = useState(composed);
      const [edited, setEdited] = useState(false);
      useEffect(() => {
        if (!edited) setDraft(composed);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [composed]);

      let researchLine;
      if (handoff.research && handoff.research.loading) researchLine = h('span', { className: 'af-hint' }, h(Spinner), '查找最近的 research.md…');
      else if (research && research.found) {
        // The host counts from the stage folder it was asked about; say it from the run's.
        const up = Math.max(0, research.levelsUp - (handoff.researchDepth || 0));
        researchLine = h(
          'div',
          { className: 'af-research' },
          h(Icon16, { name: 'book', size: 14 }),
          h('div', { style: { minWidth: 0 } },
            h('div', null, `AITP 课题（推断）：${up === 0 ? '运行目录里就有' : `从运行目录向上 ${up} 层找到`} research.md${research.title ? `「${research.title}」` : ''}`),
            h('div', { className: 'af-src' }, research.path)),
        );
      } else if (research && research.unavailable) researchLine = null;
      else researchLine = h('span', { className: 'af-hint' }, '向上没有找到 research.md，消息里不提 AITP 课题。');

      return h(
        'div',
        { className: 'af-handoff' },
        h('div', { className: 'af-agent-head' },
          h('span', { className: 'af-agent-label' }, '交给 Agent'),
          h('span', { className: 'af-agent-ctx' }, '把这个运行的事实整理成一条消息；Agent 读文件、调用 abacus_* / research_* 工具去做。')),
        h('div', { className: 'af-handoff-intents', role: 'group', 'aria-label': '想解决的问题' },
          intents.map((i) =>
            h('button', {
              key: i.id,
              type: 'button',
              className: 'af-toggle',
              'aria-pressed': i.id === intentId ? 'true' : 'false',
              onClick: () => {
                setIntentId(i.id);
                setEdited(false);
              },
            }, i.label))),
        researchLine,
        h('input', {
          className: 'af-input af-input-text',
          placeholder: '补充一句你想确认的事（可选）',
          value: note,
          onChange: (event) => {
            setNote(event.target.value);
            setEdited(false);
          },
        }),
        h('textarea', {
          className: 'af-textarea',
          value: draft,
          'aria-label': '将要发送的消息',
          onChange: (event) => {
            setDraft(event.target.value);
            setEdited(true);
          },
        }),
        h('div', { className: 'af-ask-row' },
          h('span', { className: 'af-hint', style: { flex: 1, minWidth: 0 } }, '发送前可以直接修改。消息只是请求：Agent 在提交作业或改输入前会先问你。'),
          edited ? h(Btn, { size: 'sm', kind: 'ghost', onClick: () => { setDraft(composed); setEdited(false); } }, '恢复生成稿') : null,
          h(Btn, { kind: 'primary', icon: 'send', onClick: () => onSend(draft), disabled: !draft.trim() }, '发送到对话')),
      );
    }

    /**
     * Pinned under the scroller. Two depths of the same action: a quick question that carries
     * the focused stage's path and state, and the run-level handoff sheet.
     */
    function AgentDock(props) {
      const { session, context, handoff } = props;
      const [text, setText] = useState('');
      const [status, setStatus] = useState(null);
      const [open, setOpen] = useState(false);
      const timer = useRef(null);
      useEffect(() => () => clearTimeout(timer.current), []);
      if (!context) return null;

      const post = (message) => {
        // `askAgent` now reports how it ended: submitted through the session, preloaded into
        // the composer, or failed outright. Saying "已发送" for a submission the Host later
        // rejects is worse than saying nothing, so the outcome callback updates the label.
        const result = askAgent(session, message, (outcome, detail) => {
          if (outcome === 'failed') {
            setStatus(detail || 'Host 拒绝了这条消息');
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setStatus(null), 8000);
          }
        });
        if (result === 'submitted') setStatus('已发送到对话');
        else if (result === 'prefilled') setStatus('已填进对话输入框，确认后发送');
        else setStatus('没能送入对话：请复制后粘贴');
        if (result !== 'failed') {
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setStatus(null), 4000);
        }
        return result === 'submitted';
      };
      const ask = (value) => {
        const question = String(value ?? text).trim();
        if (!question) return;
        if (post(`${context.prefix}${question}`)) setText('');
      };

      return h(
        'div',
        { className: 'af-agent' },
        open && handoff
          ? h(HandoffSheet, {
              handoff,
              onSend: (message) => {
                if (post(message)) setOpen(false);
              },
            })
          : null,
        h('div', { className: 'af-agent-head' },
          h('span', { className: 'af-agent-label' }, h(Icon16, { name: 'agent', size: 14 }), '问 Agent'),
          h('span', { className: 'af-agent-ctx', title: context.title }, `附带 ${context.title}`),
          handoff
            ? h(Btn, { size: 'sm', icon: open ? 'close' : 'send', onClick: () => setOpen(!open), 'aria-expanded': open ? 'true' : 'false' }, open ? '收起' : '交给 Agent…')
            : null),
        h('div', { className: 'af-ask-row' },
          h('input', {
            className: 'af-input af-input-text',
            placeholder: '提问会附带路径与状态，发到当前对话…',
            value: text,
            onChange: (event) => setText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') ask();
            },
          }),
          h(Btn, { kind: 'primary', icon: 'send', onClick: () => ask(), disabled: !text.trim() }, '发送')),
        h('div', { className: 'af-ask-quick' },
          (context.quick || []).map((q) => h(Btn, { key: q, size: 'sm', onClick: () => ask(q) }, q)),
          props.narrow ? null : h('span', { className: 'af-agent-status' }, status || '面板只读 · 计算由对话里的 Agent 执行')),
        // Narrow: the prompts scroll sideways, so the read-only statement gets its own line.
        props.narrow ? h('div', { className: 'af-agent-foot' }, status || '面板只读 · 计算由对话里的 Agent 执行') : null,
      );
    }

    // =====================================================================
    // the run page
    // =====================================================================

    const STAGE_TAB_LABEL = { overview: '概览', inputs: '输入', scf: '收敛', qsgw: 'QSGW', structure: '结构', files: '文件' };

    function quickPrompts(states) {
      const codes = new Set(Object.values(states).map((s) => s.code));
      const out = ['这个结果收敛了吗？依据是什么？'];
      if (codes.has('unconv')) out.push('为什么没有收敛？下一步怎么调？');
      if (codes.has('partial') || codes.has('none')) out.push('缺的输出在哪里？是没跑还是没拉回来？');
      out.push('检查这个阶段的输入文件有没有问题');
      return out.slice(0, 3);
    }

    /**
     * One open run: every stage's bundle, the derived states and lineage, the page, and the
     * agent dock pinned under the scroller (inside `.af-content-scroll` it would only appear
     * after scrolling past everything, because that element is the scroller).
     */
    function RunScope(props) {
      const { run, ui, setUi, session, narrow, series, onOpenSeries, onOpenLibrary } = props;
      // Poll only while some stage of this run is reported as running.
      const [polling, setPolling] = useState(false);
      const tick = useVisibleTick(10000, polling);
      const loaded = useStageBundles(run.stages, tick);
      const bundles = loaded.byId;
      useEffect(() => {
        setPolling(Object.values(bundles).some((b) => b && b.status && b.status.code === 'RUNNING'));
      }, [bundles]);
      const states = useMemo(
        () => Object.fromEntries(run.stages.map((s) => [s.id, stageState(s.task, bundles[s.id])])),
        [run, bundles],
      );
      const lineage = useMemo(
        () => Object.fromEntries(run.stages.map((s) => [s.id, lineageOf(s, bundles[s.id], run)])),
        [run, bundles],
      );
      // The rail and the picker show these same refined states, so a stage never reads one
      // way in the list and another in the pipeline.
      const stateKey = run.stages.map((s) => `${s.id}:${states[s.id].code}`).join('|');
      useEffect(() => {
        if (props.onStates) props.onStates(run.key, states);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [stateKey]);
      const [proofs, setProofs] = useState({});
      const [plotted, setPlotted] = useState([]);
      const [bandIterations, setBandIterations] = useState([]);
      const [iteration, setIteration] = useState(null);
      const matchStage = run.stages.find((s) => s.task.hasStru) || null;
      const match = useApi(matchStage ? `match:${matchStage.id}:${cacheGeneration}` : null, () => fetchMatch(matchStage.id));
      const research = useResearchContext(run.stages[0] ? run.stages[0].id : null);

      const view = ui.view === 'stage' ? 'stage' : 'results';
      const stage = run.stages.find((s) => s.id === ui.stageId) || null;
      const plottedSet = useMemo(() => new Set(plotted), [plotted]);
      const ranked = rankBandSources(run, bundles, states, lineage);
      const focusL = run.stages.find((s) => plottedSet.has(s.id) && s.role !== 'producer') || ranked.librpa[0] || null;

      const selectStage = (id, tab) => setUi({ stageId: id, view: 'stage', stageTab: tab || ui.stageTab || 'overview' });
      const onProof = useCallback((id, proof) => setProofs((prev) => ({ ...prev, [id]: proof })), []);

      const matches = match.data && match.data.ok ? match.data.matches || [] : [];
      const ledger = gapLedger(run, bundles, iteration, matches);

      // ---- what the dock attaches
      const focus = view === 'stage' && stage ? stage : focusL || run.stages[0];
      const focusBundle = focus ? bundles[focus.id] : null;
      const extra = view === 'stage' && stage
        ? `运行：${run.absPath}\n当前查看：阶段 ${stage.rel || stage.name} · ${STAGE_TAB_LABEL[ui.stageTab] || '概览'}`
        : `运行：${run.absPath}\n当前查看：运行结果（能带对比 / 关键数值 / 收敛）${iteration !== null ? `，QSGW 第 ${iteration} 次迭代` : ''}`;
      const context = focus
        ? {
            title: `${run.name} / ${focus.rel || focus.name} · ${(states[focus.id] || {}).label || ''}`,
            prefix: focusBundle ? buildAskContext(focusBundle, extra) : `【来自 ABACUS 面板】\n任务：${focus.task.absPath}\n${extra}\n\n`,
            quick: quickPrompts(states),
          }
        : null;
      const handoff = {
        run,
        items: run.stages.map((s) => ({
          producer: s.role === 'consumer' ? 'librpa' : 'abacus',
          rel: s.rel,
          name: s.name,
          state: states[s.id],
          facts: bundles[s.id] ? stageFacts(s, bundles[s.id]) : '',
          lineage: lineage[s.id] && s.role === 'consumer' ? lineage[s.id].text : '',
        })),
        ledger,
        research,
        researchDepth: run.stages[0] ? splitRel(run.stages[0].rel).length : 0,
        summary: {
          unconverged: Object.values(states).filter((s) => s.code === 'unconv').length,
          missing: Object.values(states).filter((s) => s.code === 'none' || s.code === 'partial').length,
          hasQsgw: run.stages.some((s) => qsgwRows(bundles[s.id]).length > 0 || /qsgw/i.test(String((bundles[s.id] && bundles[s.id].librpa && bundles[s.id].librpa.task) || ''))),
          inSeries: Boolean(series),
          hasLibrary: matches.length > 0,
          research: Boolean(research.data && research.data.found),
        },
      };

      const page = h(
        'div',
        { className: 'af-page' },
        h(RunHeader, { run, bundles, series, onOpenSeries }),
        h(Pipeline, {
          run,
          states,
          bundles,
          lineage,
          proofs,
          activeStageId: view === 'stage' && stage ? stage.id : null,
          plotted: plottedSet,
          onSelect: (id) => selectStage(id),
          narrow,
        }),
        h(
          'div',
          { className: 'af-viewbar' },
          h(
            'div',
            { className: 'af-tabs', role: 'tablist', 'aria-label': '运行视图' },
            h('button', { type: 'button', role: 'tab', className: 'af-tab', 'data-active': view === 'results' ? 'true' : undefined, 'aria-selected': view === 'results' ? 'true' : 'false', onClick: () => setUi({ view: 'results' }) },
              h(Icon16, { name: 'plot', size: 14 }), '结果'),
            h('button', {
              type: 'button',
              role: 'tab',
              className: 'af-tab',
              'data-active': view === 'stage' ? 'true' : undefined,
              'aria-selected': view === 'stage' ? 'true' : 'false',
              disabled: !stage && run.stages.length === 0,
              onClick: () => selectStage(stage ? stage.id : run.stages[0].id),
            }, h(Icon16, { name: 'layers', size: 14 }), stage ? `阶段 · ${stage.name}` : '阶段'),
          ),
          narrow ? null : h('span', { className: 'af-hint' }, view === 'results' ? '点流水线里的阶段看它自己的输入、收敛、结构和文件' : '结果视图汇总整个运行'),
        ),
        h(
          'div',
          { hidden: view !== 'results' },
          // The plot is what the reader came for: always open.
          h(Section, { title: '能带对比', meta: 'ABACUS KS 与 LibRPA QSGW 默认叠加' },
            h(BandOverlay, {
              run,
              bundles,
              states,
              lineage,
              iteration,
              onIteration: setIteration,
              narrow,
              onProof,
              onPlotted: setPlotted,
              onIterations: setBandIterations,
            })),
          // Everything below is supporting detail. It is collapsible and starts closed, so the
          // page's first screen is the run + its plot rather than a wall of tables.
          h(Section, {
            title: '关键数值',
            meta: '每个数都注明来源文件；下方是数据库对照',
            collapsible: true,
            defaultOpen: false,
            persistKey: 'results-keynumbers',
          },
            h(KeyNumbers, { run, bundles, iteration, onOpenLibrary, onSelectStage: (id) => selectStage(id) })),
          h(Section, {
            title: '收敛',
            meta: 'ABACUS SCF 与 LibRPA QSGW 分开看',
            collapsible: true,
            defaultOpen: false,
            persistKey: 'results-convergence',
          },
            h(ConvergenceStrip, {
              run,
              bundles,
              states,
              lineage,
              focusL,
              iteration,
              bandIterations,
              onIteration: setIteration,
              onOpenStage: (id, tab) => selectStage(id, tab),
            })),
        ),
        view === 'stage' && stage
          ? h(StageView, {
              stage,
              bundle: bundles[stage.id],
              state: states[stage.id],
              link: lineage[stage.id],
              tab: ui.stageTab,
              onTab: (tab) => setUi({ stageTab: tab }),
              error: loaded.errors[stage.id],
              iteration,
            })
          : null,
      );

      return h(
        React.Fragment,
        null,
        h('div', { className: 'af-content-scroll' }, page),
        h(AgentDock, { session, context, handoff, narrow }),
      );
    }

    // =====================================================================
    // the panel
    // =====================================================================

    const PLACES = [
      { id: 'runs', label: '运行', short: '运行', icon: 'layers' },
      { id: 'studies', label: 'k 收敛研究', short: '研究', icon: 'plot' },
      { id: 'basket', label: '对比篮', short: '对比', icon: 'basket' },
      { id: 'library', label: '数据库', short: '数据库', icon: 'book' },
    ];

    /** With nothing remembered, open the first run that left any output. */
    function defaultRun(runs) {
      return runs.find((run) => run.stages.some((s) => stageState(s.task, null).code !== 'none')) || runs[0] || null;
    }

    /** Above this many stages, runs are refined only as they are opened (see usePrefetchedStates). */
    const PREFETCH_MAX_STAGES = 80;

    /**
     * Refine every run's stage states in the background — read-only, two requests at a time,
     * the open run last because RunScope loads it first — so the list's fingerprints already
     * say what the pipeline will say. A run whose states RunScope reported is not overwritten.
     */
    function usePrefetchedStates(scan, runs, activeKey, setRefinedStates) {
      useEffect(() => {
        if (!scan || runs.length === 0) return undefined;
        if (runs.reduce((n, r) => n + r.stages.length, 0) > PREFETCH_MAX_STAGES) return undefined;
        let live = true;
        const queue = runs.filter((r) => r.key !== activeKey).concat(runs.filter((r) => r.key === activeKey));
        const worker = async () => {
          while (live && queue.length > 0) {
            const run = queue.shift();
            const states = {};
            for (const stage of run.stages) {
              if (!live) return;
              try {
                states[stage.id] = stageState(stage.task, await fetchBundle(stage.task, false));
              } catch {
                states[stage.id] = stageState(stage.task, null);
              }
            }
            if (live) setRefinedStates((prev) => (prev[run.key] ? prev : { ...prev, [run.key]: states }));
          }
        };
        // Let the open run's own requests go first.
        const timer = setTimeout(() => {
          worker();
          worker();
        }, 1200);
        return () => {
          live = false;
          clearTimeout(timer);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [scan]);
    }

    function Panel(props) {
      const session = props.session || null;
      const [rootRef, width] = useWidth(props.compact ? 400 : 1100);
      const narrow = width > 0 ? width < 760 : Boolean(props.compact);
      const [root, setRoot] = useState(readStoredRoot());
      /**
       * The path this browser has pinned as its default. Tracked separately from `root`
       * (which is the editable input) so the 「设为默认」 button can show whether the
       * current text already is the default.
       */
      const [pinnedRoot, setPinnedRoot] = useState(readStoredRoot());
      const [serverDefault, setServerDefault] = useState('');
      const [scan, setScan] = useState(null);
      const [scanning, setScanning] = useState(false);
      const [scanError, setScanError] = useState(null);
      const [ui, setUiState] = useState(() => readUiState());
      const [refinedStates, setRefinedStates] = useState({});
      const basket = useCompareBasket();
      const onStates = useCallback((runKey, states) => setRefinedStates((prev) => ({ ...prev, [runKey]: states })), []);

      const setUi = useCallback((patch) => {
        setUiState((prev) => {
          const next = { ...prev, ...patch };
          writeUiState(next);
          return next;
        });
      }, []);

      const runScan = useCallback(
        (value, force) => {
          const target = (value === undefined ? root : value).trim();
          if (!target) {
            setScanError('请先填写要扫描的目录');
            return;
          }
          setScanning(true);
          setScanError(null);
          api(`/scan?rootPath=${encodeURIComponent(target)}${force ? '&force=1' : ''}`)
            .then((result) => {
              setScanning(false);
              if (result.error) {
                setScanError(result.error);
                setScan(null);
                return;
              }
              clearClientCaches();
              setRefinedStates({});
              setScan(result);
              storeRoot(target);
            })
            .catch((caught) => {
              setScanning(false);
              setScanError(String(caught.message || caught));
            });
        },
        [root],
      );

      // First mount: prefer what this browser pinned, else the plugin's configured default.
      useEffect(() => {
        api('/ping')
          .then((info) => {
            const configured = (info && info.defaultScanRoot) || '';
            setServerDefault(configured);
            const pinned = readStoredRoot();
            const initial = pinned || configured;
            if (initial) {
              setRoot(initial);
              runScan(initial, false);
            }
          })
          .catch(() => {
            const pinned = readStoredRoot();
            if (pinned) runScan(pinned, false);
          });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const scanRoot = scan ? scan.rootPath || root : root;
      const runs = useMemo(() => groupRuns(scan ? scan.tasks || [] : [], scanRoot), [scan, scanRoot]);
      const series = useMemo(() => detectSeries(runs), [runs]);
      const remembered = (ui.runByRoot || {})[scanRoot];
      const activeRun = runs.find((r) => r.key === remembered) || defaultRun(runs);
      const place = PLACES.some((p) => p.id === ui.place) ? ui.place : 'runs';
      const seriesOfRun = activeRun ? series.find((s) => s.members.some((m) => m.runKey === activeRun.key)) || null : null;
      usePrefetchedStates(scan, runs, activeRun ? activeRun.key : null, setRefinedStates);

      // A UNC path means something only at its tail; show the tail while the field is idle.
      const pathRef = useRef(null);
      useEffect(() => {
        const input = pathRef.current;
        if (input && document.activeElement !== input) input.scrollLeft = input.scrollWidth;
      }, [root, scan, narrow]);

      const openRun = (key) => setUi({ place: 'runs', runByRoot: { ...(ui.runByRoot || {}), [scanRoot]: key }, view: 'results', stageId: null });
      const openStage = (id) => setUi({ place: 'runs', view: 'stage', stageId: id });
      const openSeries = (key) => setUi({ place: 'studies', seriesKey: key });
      const openLibrary = (query) => setUi({ place: 'library', libraryQuery: query || '' });

      const toolbar = h(
        'div',
        { className: 'af-toolbar' },
        h(
          'div',
          { className: 'af-toolbar-row' },
          !narrow ? h('span', { className: 'af-toolbar-title' }, h(Icon, { size: 16 }), 'ABACUS · LibRPA') : null,
          h(
            'div',
            { className: 'af-tabs', role: 'tablist', 'aria-label': '面板位置' },
            PLACES.map((p) =>
              h(
                'button',
                {
                  key: p.id,
                  type: 'button',
                  role: 'tab',
                  className: 'af-tab',
                  'data-active': place === p.id ? 'true' : undefined,
                  'aria-selected': place === p.id ? 'true' : 'false',
                  onClick: () => setUi({ place: p.id }),
                },
                narrow ? null : h(Icon16, { name: p.icon, size: 14 }),
                narrow ? p.short : p.label,
                p.id === 'basket' && basket.length > 0 ? h('span', { className: 'af-tab-count' }, String(basket.length)) : null,
              ),
            ),
          ),
          scanning ? h('span', { className: 'af-hint', style: { marginLeft: 'auto', whiteSpace: 'nowrap' } }, h(Spinner), '扫描中') : null,
        ),
        // The path field gets the full width (a UNC path is long); the actions sit beside it.
        h(
          'div',
          { className: 'af-toolbar-row' },
          h('input', {
            ref: pathRef,
            className: 'af-input',
            placeholder: '扫描目录，例如 \\\\wsl$\\Ubuntu2204\\home\\user\\runs 或 D:\\runs',
            value: root,
            title: root,
            'aria-label': '扫描目录',
            onChange: (event) => setRoot(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') runScan(undefined, true);
            },
          }),
          h(Btn, { kind: 'primary', size: 'sm', onClick: () => runScan(undefined, true), disabled: scanning }, '扫描'),
          h(Btn, { size: 'sm', icon: 'refresh', title: '重新读取（用缓存）', 'aria-label': '刷新', onClick: () => runScan(undefined, false), disabled: scanning || !root }),
          // Pinning is per-browser (localStorage) and overrides the plugin's defaultScanRoot,
          // so a user who mostly opens one folder does not retype it every session.
          narrow
            ? null
            : h(Btn, {
                size: 'sm',
                kind: 'ghost',
                title: '把这个路径记为「默认」，下次打开面板自动填好',
                disabled: !root || pinnedRoot === (root || '').trim(),
                onClick: () => {
                  const value = (root || '').trim();
                  if (!value) {
                    setScanError('请先填写一个路径，再设为默认');
                    return;
                  }
                  storeRoot(value);
                  setPinnedRoot(value);
                  setScanError(null);
                },
              }, pinnedRoot && pinnedRoot === (root || '').trim() ? '已是默认' : '设为默认'),
          pinnedRoot && !narrow
            ? h(Btn, {
                size: 'sm',
                kind: 'ghost',
                title: '取消本浏览器记住的路径，改用插件配置的默认值',
                onClick: () => {
                  clearStoredRoot();
                  setPinnedRoot('');
                },
              }, '用配置默认')
            : null,
        ),
      );

      // Which default is in force, and where it comes from — otherwise a pre-filled path
      // looks arbitrary. Kept to a single ellipsised row.
      const rootHint =
        pinnedRoot || serverDefault
          ? h(
              'div',
              { className: 'af-defroot' },
              h('span', { className: 'af-defroot-tag' }, pinnedRoot ? '浏览器默认' : '配置默认'),
              h('span', { className: 'af-defroot-path', title: pinnedRoot || serverDefault }, tailPath(pinnedRoot || serverDefault, 46)),
            )
          : null;

      const summary =
        scan && !scan.error
          ? h(
              'div',
              { className: 'af-summary' },
              h('b', null, String(runs.length)),
              ' 个运行 · ',
              h('b', null, String(scan.counts ? scan.counts.total : (scan.tasks || []).length)),
              ` 个阶段 · ${scan.elapsedMs || 0} ms`,
              scan.truncated ? h('span', { style: { color: 'var(--af-warn-text)' } }, ' · 已达上限截断') : null,
            )
          : null;

      const listProps = {
        runs,
        series,
        activeRunKey: place === 'runs' && activeRun ? activeRun.key : null,
        activeSeriesKey: place === 'studies' ? ui.seriesKey : null,
        runStates: activeRun ? refinedStates[activeRun.key] || null : null,
        statesByRun: refinedStates,
        activeStageId: ui.view === 'stage' ? ui.stageId : null,
        onRun: openRun,
        onStage: openStage,
        onSeries: openSeries,
      };

      let body;
      if (scanError) body = h('div', { className: 'af-content-scroll' }, h('div', { className: 'af-page' }, h(Note, { tone: 'err' }, scanError)));
      else if (!scan) {
        body = h('div', { className: 'af-content-scroll' },
          scanning ? h(Loading, null, '扫描中…') : h(Empty, { title: '填写要扫描的目录' }, '面板会把下面的 ABACUS 与 LibRPA 计算按「运行 → 阶段」整理出来。'));
      } else if (place === 'studies') {
        body = h('div', { className: 'af-content-scroll' },
          h(StudiesPlace, {
            runs,
            series,
            activeSeriesKey: ui.seriesKey,
            onSeries: (key) => setUi({ seriesKey: key }),
            kstudyPath: ui.kstudyPath || '',
            onKstudyPath: (path) => setUi({ kstudyPath: path }),
            kstudyMaterial: ui.kstudyMaterial || null,
            onKstudyMaterial: (material) => setUi({ kstudyMaterial: material }),
            narrow,
          }));
      } else if (place === 'basket') {
        body = h('div', { className: 'af-content-scroll' }, h(BasketPlace, { narrow }));
      } else if (place === 'library') {
        body = h('div', { className: 'af-content-scroll' },
          h(LibraryPlace, {
            initialQuery: ui.libraryQuery || '',
            matchStage: activeRun ? activeRun.stages.find((s) => s.task.hasStru) || null : null,
            runName: activeRun ? activeRun.name : '',
          }));
      } else if (!activeRun) {
        body = h('div', { className: 'af-content-scroll' },
          h(Empty, { title: '没有识别到任务' }, '这个目录下没有含 INPUT 或 librpa.in 的子目录（扫描深度见插件配置 maxDepth）。'));
      } else {
        body = h(RunScope, {
          key: `${scanRoot}::${activeRun.key}`,
          run: activeRun,
          ui,
          setUi,
          session,
          narrow,
          series: seriesOfRun,
          onOpenSeries: openSeries,
          onOpenLibrary: openLibrary,
          onStates,
        });
      }

      return h(
        'div',
        { className: 'af-root', ref: rootRef, 'data-narrow': narrow ? 'true' : undefined },
        toolbar,
        narrow
          ? h(
              'div',
              { className: 'af-content' },
              rootHint,
              scan && (place === 'runs' || place === 'studies') ? h(RunPicker, listProps) : null,
              body,
            )
          : h(
              'div',
              { className: 'af-body' },
              h('div', { className: 'af-rail' }, rootHint, summary, h('div', { className: 'af-rail-scroll' }, scan ? h(RunList, listProps) : null)),
              h('div', { className: 'af-content' }, body),
            ),
      );
    }

    function PanelRoot(props) {
      // The panel needs the live session to post questions into it.
      //
      // The correct accessor is `sessions.binding(id).session`, which is the `ISession` face
      // (`beginSubmission`, `prompt`, `cancel`, …). An earlier version used
      // `sessions.scope(id).get('session')`: `scope()` returns an *AgentContext*, which has
      // no `session` service, so the lookup always failed and the send button did nothing.
      const sessionId = props && props.sessionId;
      const [session, setSession] = React.useState(null);

      React.useEffect(() => {
        setSession(null);
        if (!sessionId) return undefined;
        const sessions = pluginContext && pluginContext.get ? pluginContext.get('sessions') : undefined;
        if (!sessions || typeof sessions.binding !== 'function') {
          console.warn('[abacusflow] sessions service unavailable; the ask box will fall back to composer prefill');
          return undefined;
        }
        let cancelled = false;
        const read = () => {
          try {
            const binding = sessions.binding(sessionId);
            if (!cancelled && binding && binding.session) {
              setSession(binding.session);
              return true;
            }
          } catch (error) {
            console.error('[abacusflow] session binding lookup failed:', error);
          }
          return false;
        };
        // The binding exists only while the session is retained (an open tab); retry briefly
        // on first mount, then give up and let the ask box fall back to prefill.
        if (read()) return undefined;
        let attempts = 0;
        const timer = setInterval(() => {
          attempts += 1;
          if (read() || attempts > 20) clearInterval(timer);
        }, 500);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [sessionId]);

      return h(Boundary, null, h(Panel, { ...(props || {}), session }));
    }

    // =====================================================================
    // error boundary
    // =====================================================================

    class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        console.error('[abacusflow] panel crashed:', error, info);
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'af-root' },
            h('div', { className: 'af-error' }, `面板出错：${String(this.state.error && this.state.error.message) || '未知错误'}`),
            h('div', { className: 'af-page' }, h('button', { type: 'button', className: 'af-btn', onClick: () => this.setState({ error: null }) }, '重试')),
          );
        }
        return this.props.children;
      }
    }

    // =====================================================================
    // sidebar icon
    // =====================================================================

    function Icon(props) {
      const size = (props && props.size) || 18;
      return h(
        'svg',
        {
          viewBox: '0 0 32 32',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M6 11.5 L16 6.5 L26 11.5 L26 20.5 L16 25.5 L6 20.5 Z' }),
        h('path', { d: 'M6 11.5 L16 16.5 L26 11.5' }),
        h('path', { d: 'M16 16.5 L16 25.5' }),
      );
    }

    // =====================================================================
    // apply
    // =====================================================================

    return {
      inject: ['slots'],
      apply(ctx) {
        injectCss();
        // PanelRoot needs the context later (session lookup for the ask box); keep a
        // module-level reference rather than threading ctx through every pane.
        pluginContext = ctx;

        // ---- main page --------------------------------------------------
        try {
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_KEY }, function AbacusFlowPage(props) {
              return h(PanelRoot, { sessionId: props && props.sessionId });
            }),
          );
        } catch (error) {
          console.error('[abacusflow] main slot registration failed:', error);
        }

        // ---- sidebar entry + right dock ---------------------------------
        let dockRegistered = false;
        let dockAttempts = 0;

        const registerDock = () => {
          if (dockRegistered) return;
          dockAttempts += 1;
          try {
            const tabs = ctx.get ? ctx.get('sidebarRightTabs') : undefined;
            if (!tabs || typeof tabs.register !== 'function') {
              if (dockAttempts <= 40) setTimeout(registerDock, 400);
              else console.error('[abacusflow] sidebarRightTabs service unavailable; right dock skipped');
              return;
            }
            ctx.effect(() =>
              tabs.register({
                id: PANEL_KEY,
                kind: PANEL_KEY,
                priority: 'extension',
                title: () => 'ABACUS',
                guide: [
                  {
                    id: PANEL_KEY,
                    order: 62,
                    title: () => 'ABACUS',
                    description: () => 'ABACUS → LibRPA 流水线：能带对比、收敛、k 收敛研究与数据库对照',
                  },
                ],
              }),
            );
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                { name: 'sidebar.right.pane.tab', key: PANEL_KEY },
                function AbacusFlowDock(props) {
                  return h(PanelRoot, { compact: true, sessionId: props && props.sessionId });
                },
              ),
            );
            dockRegistered = true;
          } catch (error) {
            if (dockAttempts <= 10) setTimeout(registerDock, 600);
            else console.error('[abacusflow] right dock registration error:', error);
          }
        };

        try {
          ctx.slots.inject('sidebar.panellist', () => {
            registerDock();
            return ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_KEY, order: 62, label: () => 'ABACUS' },
              Icon,
            );
          });
        } catch (error) {
          console.error('[abacusflow] sidebar entry registration failed:', error);
        }
      },
    };
  },
});
