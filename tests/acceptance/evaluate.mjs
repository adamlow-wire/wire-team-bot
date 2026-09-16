import { score } from "./scoring.mjs";
// Synthetic-only stored-record evaluation. No Wire connection or schema reset.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { loadConfig } = require('../../dist/app/config');
const fixture = JSON.parse(readFileSync(process.env.EVALUATION_FIXTURE ?? new URL('./capture-fixture.json', import.meta.url)));
const root = process.env.EVALUATION_ROOT ?? process.cwd();
const channel = `evaluation-${randomUUID()}`;
const prisma = new PrismaClient();
const child = spawn('node', [resolve(root, 'dist/app/cli.js')], {
  cwd: root, env: { ...process.env, E2E_CHANNEL_ID: channel, E2E_JSON: '1', LOG_LEVEL: 'warn' }, stdio: ['pipe','pipe','pipe'],
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
lines.on('line', line => {
  try { const result = JSON.parse(line); pending.get(result.eventId)?.resolve(result); pending.delete(result.eventId); }
  catch { /* Non-protocol output is captured as a failure by the event timeout. */ }
});
child.on('error', err => { for (const p of pending.values()) p.reject(err); });
const closed = new Promise(resolve => child.on('close', code => {
  for (const p of pending.values()) p.reject(new Error(`CLI exited ${code}`));
  resolve(code);
}));
async function send(event) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Event ${event.eventId} timed out`)); }, 240_000);
    pending.set(event.eventId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: err => { clearTimeout(timer); reject(err); } });
    child.stdin.write(JSON.stringify(event) + '\n');
  });
}

try {
  const exchanges = [];
  for (const event of [...fixture.events, ...fixture.questions]) {
    exchanges.push({ ...event, ...await send(event) });
    process.stderr.write(`Completed ${event.eventId}\n`);
  }
  child.stdin.end();
  if (await closed !== 0) throw new Error('CLI did not complete');
  // All jobs have drained; fetch every stored capture, including silent writes.
  const scope = { conversationId: channel, conversationDom: 'cli.local' };
  const decisions = await prisma.decision.findMany({ where: scope });
  const actions = await prisma.action.findMany({ where: scope });
  const channelId = `${channel}@cli.local`;
  const retained = await Promise.all([
    prisma.auditLog.findMany({where:scope}), prisma.reminder.findMany({where:scope}),
    prisma.conversationSignal.findMany({where:{channelId}}), prisma.entity.findMany({where:{channelId}}),
    prisma.channelConfig.findMany({where:{channelId}}), prisma.conversationSummary.findMany({where:{scopeId:channelId}}),
    prisma.entityRelationship.findMany({where:{source:{channelId}}}),
  ]);
  const marker = 'PRIVATE_CONTEXT_MARKER';
  const privacyMarkers = { storedOccurrences: JSON.stringify([decisions,actions,...retained]).split(marker).length-1,
    diagnosticOccurrences: diagnostics.split(marker).length-1 };
  const records = [...decisions.map(d => ({ type: 'decision', source: d.rawMessageId, content: d.summary, context: d.context, author: d.authorName, rationale: d.rationale, status: d.status })),
    ...actions.map(a => ({ type: 'action', source: a.rawMessageId, content: a.description, owner: a.assigneeId, ownerName: a.assigneeName, status: a.status, deadline: a.deadline }))];
  const expected = fixture.events.filter(e => e.expected);
  const config = loadConfig().llm.jeeves;
  const report = { runAt: new Date().toISOString(), commit: process.env.EVALUATION_COMMIT ?? 'working-tree (set EVALUATION_COMMIT for release evidence)',
    channel, privacyMarkers, configuration: { slots: config.slots, embeddings: config.embed }, reviewStatus: fixture.reviewStatus,
    reminders: retained[1].map(r => ({ type: "reminder", source: r.rawMessageId, content: r.description, owner: r.targetId, status: r.status, triggerAt: r.triggerAt })),
    overall: score(records, expected), decisions: score(records.filter(r=>r.type==='decision'),expected.filter(e=>e.expected.type==='decision')),
    actions: score(records.filter(r=>r.type==='action'),expected.filter(e=>e.expected.type==='action')), exchanges,
    failures: diagnostics.split('\n').filter(l => /"level":"(?:warn|error)"/.test(l)).map(l => {try {const x=JSON.parse(l); return {level:x.level,msg:x.msg};} catch {return {msg:'unparsed diagnostic'};}}),
    replyTimesMs: exchanges.filter(e=>e.replies.length).map(e=>e.elapsedMs),
    unsolicitedMessages: exchanges.filter(e=>!e.text.includes('@')&&!e.text.includes('action:')&&!e.text.includes('decision:')).reduce((n,e)=>n+e.replies.length,0),
  };
  // Never export endpoints, credentials or provider configuration objects wholesale.
  report.configuration.embeddings = { enabled: config.embed.enabled, dimensions: config.embedDims };
  const output = process.env.EVALUATION_REPORT ?? 'tests/acceptance/latest-report.json';
  writeFileSync(output, JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ output, correct:report.overall.correct, captured:records.length, expected:expected.length, duplicates:report.overall.duplicates }));
} finally { child.kill(); await prisma.$disconnect(); }
