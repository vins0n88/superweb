#!/usr/bin/env node
// Test double for obscura-worker: newline-delimited JSON commands on stdin.
import readline from 'node:readline';
const log = [];
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line);
  log.push(cmd.cmd);
  const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  if (cmd.cmd === 'navigate') {
    if (cmd.url.includes('crash')) process.exit(3);
    if (cmd.url.includes('dns')) return reply({ ok: false, error: 'dns error: failed to lookup address' });
    return reply({ ok: true, result: { title: 'T', url: cmd.url, status: cmd.url.includes('404') ? 404 : 200 } });
  }
  if (cmd.cmd === 'evaluate') {
    if (cmd.expression.includes('PRELUDE')) return reply({ ok: true, result: true });
    return reply({ ok: true, result: { title: 'T', text: 'body', commands: log.slice(), env: { proxy: process.env.OBSCURA_PROXY, stealth: process.env.OBSCURA_STEALTH } } });
  }
  if (cmd.cmd === 'shutdown') { reply({ ok: true, result: 'bye' }); process.exit(0); }
});
