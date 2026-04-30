#!/usr/bin/env node
/**
 * install-rdc-studio — registers rdc-studio on every Claude surface.
 *
 * Usage:
 *   node scripts/install-rdc-studio.js                      ← standard
 *   node scripts/install-rdc-studio.js --skip-pull          ← skip git pull
 *   node scripts/install-rdc-studio.js --claude-home <path> ← custom CLI home
 *   node scripts/install-rdc-studio.js --codex-root <path>  ← also install to .agents/skills/user/
 *
 * What it does:
 *   1. git pull (latest skills + scripts)
 *   2. CLI plugin  — registers in ~/.claude/plugins/ + settings.json
 *   3. Cowork      — registers in Desktop cowork_plugins/ + cowork_settings.json
 *   4. Codex       — copies skills to <project>/.agents/skills/user/studio-<name>/
 *   5. Symlinks    — creates .claude/skills/<name>/ → source in regen-root
 *   6. Preflight   — Node version check
 */

'use strict';
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execSync } = require('child_process');

// ── Args ──────────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const skipPull   = args.includes('--skip-pull');
const homeIdx    = args.indexOf('--claude-home');
const claudeHome = homeIdx >= 0 ? args[homeIdx + 1] : path.join(os.homedir(), '.claude');

const repoRoot   = path.resolve(__dirname, '..');

const codexIdx   = args.indexOf('--codex-root');
const codexRoot  = codexIdx >= 0
  ? path.resolve(args[codexIdx + 1])
  : (() => {
      const sibling = path.resolve(repoRoot, '..', 'regen-root');
      return fs.existsSync(path.join(sibling, '.agents')) ? sibling : null;
    })();

const settingsPath = path.join(claudeHome, 'settings.json');
const PLUGIN_KEY   = 'rdc-studio@rdc-studio';
const MARKETPLACE  = 'rdc-studio';

// ── Logging ───────────────────────────────────────────────────────────────────
const ok   = msg => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const info = msg => console.log(`  \x1b[36m→\x1b[0m ${msg}`);
const warn = msg => console.log(`  \x1b[33m⚠\x1b[0m ${msg}`);
const fail = msg => console.log(`  \x1b[31m✗\x1b[0m ${msg}`);

// ── Filesystem helpers ────────────────────────────────────────────────────────
function copyDirRecursive(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readJson(p, fallback = {}) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data, indent = 2) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, indent));
}

function readFrontmatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const fm = {};
    for (const line of match[1].split('\n')) {
      const kv = line.match(/^(\w+):\s*(.*)?$/);
      if (kv) fm[kv[1]] = kv[2] || '';
    }
    return fm;
  } catch { return {}; }
}

function flushOldCaches(cacheBase, keepVersion) {
  if (!fs.existsSync(cacheBase)) return 0;
  let flushed = 0;
  for (const entry of fs.readdirSync(cacheBase)) {
    if (entry === keepVersion || entry === 'latest') continue;
    try { fs.rmSync(path.join(cacheBase, entry), { recursive: true, force: true }); flushed++; } catch {}
  }
  return flushed;
}

// ── Plugin cache builder ───────────────────────────────────────────────────────
function buildPluginCache(cacheDir) {
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const item of ['.claude-plugin', 'skills', 'package.json', 'README.md']) {
    const src = path.join(repoRoot, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(cacheDir, item);
    if (fs.statSync(src).isDirectory()) copyDirRecursive(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// ── Step 2: CLI plugin registration ──────────────────────────────────────────
function registerCLI(version, gitSha) {
  const pluginDir  = path.join(claudeHome, 'plugins');
  const mktDir     = path.join(pluginDir, 'marketplaces', MARKETPLACE);
  const mktPlugDir = path.join(mktDir, '.claude-plugin');
  const cacheBase  = path.join(pluginDir, 'cache', MARKETPLACE, 'rdc-studio');
  const cacheDir   = path.join(cacheBase, version);
  const latestDir  = path.join(cacheBase, 'latest');

  // Marketplace manifest
  fs.mkdirSync(mktPlugDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, '.claude-plugin', 'marketplace.json'), path.join(mktPlugDir, 'marketplace.json'));

  // known_marketplaces.json
  const kmpPath = path.join(pluginDir, 'known_marketplaces.json');
  const knownMp = readJson(kmpPath);
  knownMp[MARKETPLACE] = { source: { source: 'github', repo: 'LIFEAI/rdc-studio' }, installLocation: mktDir, lastUpdated: new Date().toISOString() };
  writeJson(kmpPath, knownMp, 4);

  // Flush stale caches, write versioned + stable latest
  const flushed = flushOldCaches(cacheBase, version);
  if (flushed > 0) info(`       flushed  : ${flushed} stale cache dir(s)`);
  buildPluginCache(cacheDir);
  if (fs.existsSync(latestDir)) fs.rmSync(latestDir, { recursive: true, force: true });
  buildPluginCache(latestDir);

  // installed_plugins.json
  const ipPath    = path.join(pluginDir, 'installed_plugins.json');
  const installed = readJson(ipPath, { version: 2, plugins: {} });
  for (const key of Object.keys(installed.plugins || {})) {
    if (key.startsWith('rdc-studio@')) delete installed.plugins[key];
  }
  installed.plugins[PLUGIN_KEY] = [{ scope: 'user', installPath: latestDir, version, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString(), gitCommitSha: gitSha }];
  writeJson(ipPath, installed, 4);

  // settings.json enabledPlugins
  const settings = readJson(settingsPath);
  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  for (const key of Object.keys(settings.enabledPlugins)) {
    if (key.startsWith('rdc-studio@')) delete settings.enabledPlugins[key];
  }
  settings.enabledPlugins[PLUGIN_KEY] = true;
  writeJson(settingsPath, settings);

  return latestDir;
}

// ── Step 3: Cowork registration ───────────────────────────────────────────────
function findCoworkBases() {
  const results = [];
  const localAppData = process.env.LOCALAPPDATA || '';
  const pkgsDir = path.join(localAppData, 'Packages');
  if (!fs.existsSync(pkgsDir)) return results;

  let claudePkg = null;
  for (const dir of fs.readdirSync(pkgsDir)) {
    if (/^Claude_/i.test(dir)) { claudePkg = path.join(pkgsDir, dir); break; }
  }
  if (!claudePkg) return results;

  const sessionsRoot = path.join(claudePkg, 'LocalCache', 'Roaming', 'Claude', 'local-agent-mode-sessions');
  if (!fs.existsSync(sessionsRoot)) return results;

  for (const ws of fs.readdirSync(sessionsRoot)) {
    const wsDir = path.join(sessionsRoot, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const dev of fs.readdirSync(wsDir)) {
      const devDir = path.join(wsDir, dev);
      if (!fs.statSync(devDir).isDirectory()) continue;
      const settingsFile = path.join(devDir, 'cowork_settings.json');
      if (fs.existsSync(settingsFile)) results.push({ dir: devDir, settingsFile });
    }
  }
  return results;
}

function registerCowork(version, gitSha) {
  const bases = findCoworkBases();
  if (bases.length === 0) {
    warn('Cowork     — Claude Desktop not found (MSIX package missing)');
    return 0;
  }

  for (const { dir, settingsFile } of bases) {
    const pluginsDir = path.join(dir, 'cowork_plugins');
    const cacheBase  = path.join(pluginsDir, 'cache', MARKETPLACE, 'rdc-studio');
    const cacheDir   = path.join(cacheBase, version);
    const latestDir  = path.join(cacheBase, 'latest');
    const mktDir     = path.join(pluginsDir, 'marketplaces', MARKETPLACE);
    const mktPlugDir = path.join(mktDir, '.claude-plugin');

    fs.mkdirSync(mktPlugDir, { recursive: true });
    fs.copyFileSync(path.join(repoRoot, '.claude-plugin', 'marketplace.json'), path.join(mktPlugDir, 'marketplace.json'));

    const kmpPath = path.join(pluginsDir, 'known_marketplaces.json');
    const knownMp = readJson(kmpPath);
    knownMp[MARKETPLACE] = { source: { source: 'github', repo: 'LIFEAI/rdc-studio' }, installLocation: mktDir, lastUpdated: new Date().toISOString() };
    writeJson(kmpPath, knownMp, 4);

    flushOldCaches(cacheBase, version);
    buildPluginCache(cacheDir);
    if (fs.existsSync(latestDir)) fs.rmSync(latestDir, { recursive: true, force: true });
    buildPluginCache(latestDir);

    const ipPath    = path.join(pluginsDir, 'installed_plugins.json');
    const installed = readJson(ipPath, { version: 2, plugins: {} });
    for (const key of Object.keys(installed.plugins || {})) {
      if (key.startsWith('rdc-studio@')) delete installed.plugins[key];
    }
    installed.plugins[PLUGIN_KEY] = [{ scope: 'user', installPath: latestDir, version, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString(), gitCommitSha: gitSha }];
    writeJson(ipPath, installed, 4);

    const settings = readJson(settingsFile);
    if (!settings.enabledPlugins) settings.enabledPlugins = {};
    for (const key of Object.keys(settings.enabledPlugins)) {
      if (key.startsWith('rdc-studio@')) delete settings.enabledPlugins[key];
    }
    settings.enabledPlugins[PLUGIN_KEY] = true;
    if (!settings.extraKnownMarketplaces) settings.extraKnownMarketplaces = {};
    settings.extraKnownMarketplaces[MARKETPLACE] = { source: { source: 'github', repo: 'LIFEAI/rdc-studio' } };
    writeJson(settingsFile, settings);
  }

  return bases.length;
}

// ── Step 4: Codex registration ────────────────────────────────────────────────
function registerCodex(codexProjectRoot) {
  const targetDir = path.join(codexProjectRoot, '.agents', 'skills', 'user');
  fs.mkdirSync(targetDir, { recursive: true });

  // Remove stale studio-* skill dirs
  let removed = 0;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(targetDir, entry.name);
    if (/^studio-/.test(entry.name)) {
      fs.rmSync(candidate, { recursive: true, force: true });
      removed++;
    } else {
      const fm = readFrontmatter(path.join(candidate, 'SKILL.md'));
      if (fm.name && fm.name === 'impeccable') {
        fs.rmSync(candidate, { recursive: true, force: true });
        removed++;
      }
    }
  }

  // Copy each skill dir
  const skillsSrc = path.join(repoRoot, 'skills');
  let copied = 0;
  for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsSrc, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const dst = path.join(targetDir, `studio-${entry.name}`);
    copyDirRecursive(path.join(skillsSrc, entry.name), dst);
    copied++;
  }

  return { removed, copied };
}

// ── Step 5: Symlink in regen-root/.claude/skills/ ────────────────────────────
function createSymlinks(codexProjectRoot) {
  if (!codexProjectRoot) return 0;
  const skillsDir    = path.join(codexProjectRoot, '.claude', 'skills');
  const skillsSrc    = path.join(repoRoot, 'skills');
  let created = 0;

  fs.mkdirSync(skillsDir, { recursive: true });

  for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsSrc, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const linkPath = path.join(skillsDir, entry.name);
    const target   = path.join(skillsSrc, entry.name);

    // Remove existing (symlink, junction, or directory)
    if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).nlink > 0) {
      try {
        const stat = fs.lstatSync(linkPath);
        if (stat.isSymbolicLink() || stat.isDirectory()) {
          fs.rmSync(linkPath, { recursive: true, force: true });
        }
      } catch {}
    }

    try {
      // On Windows, try junction first (works without admin), fall back to symlink
      if (process.platform === 'win32') {
        try {
          const { execSync: exec } = require('child_process');
          // Convert to Windows paths for mklink
          const winLink   = linkPath.replace(/\//g, '\\');
          const winTarget = target.replace(/\//g, '\\');
          exec(`cmd /c mklink /J "${winLink}" "${winTarget}"`, { stdio: 'pipe' });
        } catch {
          fs.symlinkSync(target, linkPath, 'junction');
        }
      } else {
        fs.symlinkSync(target, linkPath, 'dir');
      }
      created++;
      info(`       link     : ${linkPath} → ${target}`);
    } catch (e) {
      warn(`       symlink failed for ${entry.name}: ${e.message}`);
    }
  }

  return created;
}

// ── Preflight ─────────────────────────────────────────────────────────────────
function runPreflight() {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 18) { fail(`Node.js >= 18 required — found v${process.versions.node}`); process.exit(1); }
  ok(`Node.js v${process.versions.node}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const pkg     = readJson(path.join(repoRoot, 'package.json'));
  const version = pkg.version || '0.1.0';

  const bannerLine    = `║  install-rdc-studio v${version}`;
  const bannerPadded  = bannerLine.padEnd(41) + '║';
  console.log('');
  console.log('  \x1b[35m╔═══════════════════════════════════════╗\x1b[0m');
  console.log(`  \x1b[35m${bannerPadded}\x1b[0m`);
  console.log('  \x1b[35m╚═══════════════════════════════════════╝\x1b[0m');
  console.log('');
  console.log(`  CLAUDE_HOME : ${claudeHome}`);
  console.log(`  Plugin root : ${repoRoot}`);
  console.log('');

  if (!fs.existsSync(claudeHome)) {
    fail(`CLAUDE_HOME not found: ${claudeHome}`);
    process.exit(1);
  }

  let gitSha = '';
  try { gitSha = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch {}

  // 0. Pull latest
  if (!skipPull) {
    try {
      const before = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }).trim();
      execSync('git pull --ff-only', { cwd: repoRoot, stdio: 'pipe' });
      const after = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }).trim();
      ok(`[0/5] git pull   — ${before === after ? after.slice(0, 7) : `${before.slice(0,7)} → ${after.slice(0,7)}`}`);
      // Re-read git SHA after pull
      try { gitSha = execSync('git rev-parse HEAD', { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' }).trim(); } catch {}
    } catch {
      warn('[0/5] git pull failed — installing from local copy');
    }
  } else {
    info('[0/5] git pull   — skipped (--skip-pull)');
  }

  // 1. CLI registration
  const cliCacheDir = registerCLI(version, gitSha);
  ok(`[1/5] CLI plugin — ${PLUGIN_KEY} v${version}`);
  info(`       cache    : ${cliCacheDir}`);

  // 2. Cowork registration
  const coworkCount = registerCowork(version, gitSha);
  if (coworkCount > 0) {
    ok(`[2/5] Cowork     — registered in ${coworkCount} workspace(s)`);
  } else {
    warn('[2/5] Cowork     — no Desktop workspaces found (open Claude Desktop once to create them)');
  }

  // 3. Codex registration
  if (codexRoot) {
    const { removed, copied } = registerCodex(codexRoot);
    const codexTarget = path.join(codexRoot, '.agents', 'skills', 'user');
    ok(`[3/5] Codex      — ${copied} skill(s) installed, ${removed} stale removed`);
    info(`       target   : ${codexTarget}`);
  } else {
    info('[3/5] Codex      — skipped (no .agents/ found; use --codex-root <path>)');
  }

  // 4. Symlinks in regen-root/.claude/skills/
  if (codexRoot) {
    const linked = createSymlinks(codexRoot);
    if (linked > 0) {
      ok(`[4/5] Symlinks   — ${linked} link(s) created in ${path.join(codexRoot, '.claude', 'skills')}`);
    } else {
      warn('[4/5] Symlinks   — no links created (check permissions or paths)');
    }
  } else {
    info('[4/5] Symlinks   — skipped (no codex root found)');
  }

  // 5. Preflight
  console.log('');
  console.log('  \x1b[36mPreflight:\x1b[0m');
  runPreflight();

  console.log('');
  console.log('  \x1b[32mDone!\x1b[0m');
  console.log('');
  console.log('  \x1b[33mNext steps:\x1b[0m');
  console.log('  CLI    : restart Claude Code — try $impeccable to verify');
  console.log('  Cowork : restart Claude Desktop — $impeccable in a new Cowork session');
  console.log('  claude.ai : use FS MCP to read .claude/skills/impeccable/ on demand');
  console.log('');
}

main().catch(e => { fail(e.message); process.exit(1); });
