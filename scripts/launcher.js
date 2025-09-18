#!/usr/bin/env node
/**
 * Cross-platform launcher (Node) that mimics start-ai-agent.sh menu.
 * Works on Windows, macOS, Linux without bash.
 */
const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SENTINEL = path.join(ROOT, '.initialized');

function ensureInit(cb){
  if (fs.existsSync(SENTINEL)) return cb();
  console.log('\n[first-run] Performing initial project setup...');
  const child = spawn(process.execPath, [path.join(__dirname,'init.js')], { stdio: 'inherit' });
  child.on('exit', code => {
    if (code !== 0) { console.error('Initialization failed.'); process.exit(code); }
    cb();
  });
}

const menu = `\nJIRA Tempo AI Time Tracking Agent\n=================================\n1) Start Web Server + AI Agent (Recommended)\n2) Start AI Agent Only (Background)\n3) Start AI Agent in Test Mode (Fast + Dry Run prompt)\n4) Test AI Agent Connection (basic)\n5) Check AI Agent Status\n6) Start Web Server Only\n7) Exit\n`; // keep minimal

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, ans => { rl.close(); res(ans); }));
}

async function main() {
  await new Promise(res => ensureInit(res));
  console.log(menu);
  const choice = (await ask('Enter choice (1-7): ')).trim();
  switch (choice) {
    case '1':
      runNode(['server.js']);
      break;
    case '2':
      runNode(['ai-agent-daemon.js','start']);
      break;
    case '3':
      const dry = (await ask('Enable DRY RUN? (y/N): ')).trim().toLowerCase().startsWith('y');
      runNode(['ai-agent-daemon.js','start'], { AI_AGENT_TEST_MODE:'true', AI_AGENT_DRY_RUN: dry?'true':'false' });
      break;
    case '4':
      console.log('Basic connection test starting...');
      runNode(['ai-agent-daemon.js','status']);
      break;
    case '5':
      runNode(['ai-agent-daemon.js','status']);
      break;
    case '6':
      runNode(['server.js']);
      break;
    default:
      console.log('Bye');
      process.exit(0);
  }
}

function runNode(args, extraEnv={}) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  child.on('exit', code => process.exit(code));
}

main();
