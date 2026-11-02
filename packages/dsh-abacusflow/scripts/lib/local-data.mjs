/**
 * Where this machine keeps real sample data, for the real-data tests (which skip when a path
 * is unknown or unreachable) and for the preview and screenshot scripts.
 *
 * Environment variables win over the `dev` block of the git-ignored local-config.json, so
 * nothing machine-specific is committed:
 *
 *   ABACUSFLOW_PHYSICS_HOME   root of the research tree (tests build paths under it)
 *   ABACUSFLOW_SCAN_ROOT      the folder the preview panel scans
 *   ABACUSFLOW_KSTUDY         a k-mesh study snapshot.json
 *   ABACUSFLOW_LIBRARY        the LibRPA-database metadata index
 */
import { join } from 'node:path';
import { readLocalConfig } from '../../lib/host/local-config.js';

export function localData() {
  const dev = readLocalConfig().dev || {};
  const pick = (env, key) => String(process.env[env] || dev[key] || '').trim();
  return {
    physicsHome: pick('ABACUSFLOW_PHYSICS_HOME', 'physicsHome'),
    sampleRoot: pick('ABACUSFLOW_SCAN_ROOT', 'sampleRoot'),
    kstudySnapshot: pick('ABACUSFLOW_KSTUDY', 'kstudySnapshot'),
    libraryRoot: pick('ABACUSFLOW_LIBRARY', 'libraryRoot'),
  };
}

/** A path under the physics home, or '' when it is not configured (`existsSync('')` is false). */
export function physicsPath(...parts) {
  const home = localData().physicsHome;
  return home ? join(home, ...parts) : '';
}
