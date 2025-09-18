#!/usr/bin/env node
/**
 * Fresh project initialization script.
 * Responsibilities:
 *  - Ensure .env exists (copy from .env.example if missing)
 *  - Remove prior runtime data/log files for a clean start
 *  - Create a sentinel file .initialized to skip future auto-init
 *  - Optional reset mode via --reset or AI_AGENT_RESET=true
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SENTINEL = path.join(ROOT, '.initialized');
const DATA_FILES = [
  'ai-agent-data.json',
  'ai-agent-test-data.json',
  'ai-agent.log',
  'ai-agent-test.log',
  'user-config.json'
];

function log(msg){ console.log(`[init] ${msg}`); }

function fileExists(p){ try { return fs.existsSync(p); } catch { return false; } }

function copyEnvTemplate(){
  const template = path.join(ROOT, '.env.example');
  const target = path.join(ROOT, '.env');
  if (!fileExists(template)) { log('No .env.example found (skipping).'); return; }
  if (!fileExists(target)) {
    fs.copyFileSync(template, target);
    log('Created .env from .env.example. Please edit your credentials.');
  } else {
    log('.env already exists (kept).');
  }
}

function cleanRuntime(){
  DATA_FILES.forEach(f => {
    const p = path.join(ROOT, f);
    if (fileExists(p)) {
      try { fs.unlinkSync(p); log(`Removed ${f}`); } catch(e){ log(`Failed to remove ${f}: ${e.message}`); }
    }
  });
}

function createSentinel(){
  fs.writeFileSync(SENTINEL, new Date().toISOString());
  log('Wrote sentinel .initialized');
}

function run(){
  const args = process.argv.slice(2);
  const force = args.includes('--reset') || process.env.AI_AGENT_RESET === 'true';
  if (fileExists(SENTINEL) && !force) {
    log('Already initialized (use --reset or AI_AGENT_RESET=true to force).');
    return;
  }
  if (force) log('Reset mode enabled. Performing clean re-init.');
  copyEnvTemplate();
  cleanRuntime();
  createSentinel();
  log('Initialization complete.');
}

run();
