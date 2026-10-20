// P1 e2e scenarios: background jobs (F5.1), schedules with change detection (F5.2),
// skill replay (F3.2), cross-tab comparison (F1.3), and result verification (F2.4).
import { url } from './fixtures.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digits = (s) => String(s).replace(/[^\d]/g, '');

async function waitJob(app, jobId, timeoutMs = 300000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const j = await app.eval(`superweb.jobs.get(${JSON.stringify(jobId)})`);
    if (j && !['queued', 'running', 'waiting'].includes(j.status)) return j;
    await sleep(2000);
  }
  return null;
}

export const P1_SCENARIOS = [
  {
    id: 'background-job',
    async run(app) {
      await app.eval(`superweb.nav.go(${JSON.stringify(url('news', '/article'))})`);
      await sleep(2500);
      const before = await app.eval('superweb.tabs.state()');
      const res = await app.eval(`superweb.jobs.start({ prompt: 'How many solar panels does each ferry have? Answer with the number.' })`);
      const after = await app.eval('superweb.tabs.state()');
      const job = await waitJob(app, res.id);
      const missing = [];
      if (after.activeId !== before.activeId) missing.push('foreground tab stayed active');
      if (!after.tabs.some((t) => t.job === res.id)) missing.push('job has its own background tab');
      if (job?.status !== 'done') missing.push(`job done (got ${job?.status})`);
      if (!/96/.test(job?.text ?? '')) missing.push('answer 96');
      if (!job?.result?.verification) missing.push('verification report');
      return missing;
    },
  },
  {
    id: 'schedule-on-change',
    async run(app) {
      const res = await app.eval(`superweb.schedules.create({ kind: 'template', templateId: 'price-check', name: 'e2e price watch', notify: 'on_change',
        values: { url: ${JSON.stringify(url('shop-b', '/product/aurora-x1'))}, target: '8500' }, cadence: { freq: 'daily', time: '09:00' } })`);
      if (!res.ok) return [`create: ${res.error}`];
      const runOnce = async (n) => {
        await app.eval(`superweb.schedules.run(${JSON.stringify(res.schedule.id)})`);
        for (let i = 0; i < 150; i++) {
          await sleep(2000);
          const s = (await app.eval('superweb.schedules.list()')).find((x) => x.id === res.schedule.id);
          if (s.history.length >= n && !s.running) return s;
        }
        return null;
      };
      await runOnce(1);
      const s = await runOnce(2);
      if (process.env.E2E_DEBUG) {
        for (const h of s?.history ?? []) {
          const j = await app.eval(`superweb.jobs.get(${JSON.stringify(h.jobId)})`);
          console.log('--- run', h.changed, JSON.stringify(j?.text?.slice(-300)), JSON.stringify(j?.result?.tables?.map((t) => t.rows)));
        }
      }
      await app.eval(`superweb.schedules.remove(${JSON.stringify(res.schedule.id)})`);
      const missing = [];
      if (!s) return ['schedule runs finished'];
      if (s.history.some((h) => h.status !== 'done')) missing.push(`runs done (got ${s.history.map((h) => h.status)})`);
      if (s.history[0].changed) missing.push('second run reports no change');
      if (!/每天 09:00/.test(s.cadence)) missing.push('cadence label');
      return missing;
    },
  },
  {
    id: 'compare-tabs',
    async run(app) {
      await app.eval(`(async () => {
        const s = await superweb.tabs.state();
        for (const t of s.tabs.filter((t) => !t.job).slice(1)) await superweb.tabs.close(t.id);
        await superweb.nav.go(${JSON.stringify(url('shop-a', '/product/aurora-x1'))});
        await superweb.tabs.create(${JSON.stringify(url('shop-b', '/product/aurora-x1'))});
        await superweb.tabs.create(${JSON.stringify(url('shop-c', '/product/aurora-x1'))});
      })()`);
      await sleep(3500);
      await app.eval(`Object.assign(window.__e2e, { text: '', events: [], tables: [] })`);
      const ids = await app.eval(`superweb.tabs.state().then((s) => s.tabs.filter((t) => !t.job && t.url.includes('aurora')).map((t) => t.id))`);
      const res = await app.eval(`superweb.compare.run(${JSON.stringify(ids)}, '價格、庫存')`);
      if (!res.ok) return [`start: ${res.error}`];
      for (let i = 0; i < 150; i++) {
        await sleep(2000);
        if (await app.eval(`window.__e2e.events.some((e) => e.type === 'done' || e.type === 'error')`)) break;
      }
      const tables = await app.eval('window.__e2e.tables');
      const tools = await app.eval(`window.__e2e.events.filter((e) => e.type === 'tool' && e.status === 'done').map((e) => e.name)`);
      const d = digits(JSON.stringify(tables));
      const missing = ['8990', '8490', '9200'].filter((p) => !d.includes(p)).map((p) => `price ${p}`);
      if (tools.filter((n) => n === 'read_tab').length < 3) missing.push(`read_tab x3 (got ${tools.join(',')})`);
      if (tools.some((n) => ['click', 'navigate', 'switch_tab'].includes(n))) missing.push('no navigation while comparing');
      return missing;
    },
  },
  {
    id: 'skill-replay',
    async run(app) {
      const saved = await app.eval(`superweb.skills.save(${JSON.stringify({
        name: 'e2e 搜尋商品',
        goal: 'Report the product price',
        steps: [
          { type: 'navigate', url: url('shop-c', '/') },
          { type: 'type', target: { role: 'textbox', name: '搜尋商品', tag: 'input' }, value: 'Aurora' },
          { type: 'enter', target: { role: 'textbox', name: '搜尋商品', tag: 'input' } },
          { type: 'click', target: { role: 'link', name: 'Aurora X1 無線耳機', tag: 'a', href: url('shop-c', '/product/aurora-x1') } },
        ],
        params: [{ key: 'kw', step: 1, label: '關鍵字', default: 'Aurora' }],
      })})`);
      if (!saved.ok) return [`save: ${saved.error}`];
      const res = await app.eval(`superweb.skills.run(${JSON.stringify(saved.skill.id)}, { kw: 'Aurora' }, true)`);
      const job = await waitJob(app, res.jobId);
      await app.eval(`superweb.skills.remove(${JSON.stringify(saved.skill.id)})`);
      const missing = [];
      if (job?.status !== 'done') missing.push(`job done (got ${job?.status}${job?.error ? `: ${job.error}` : ''})`);
      if (!digits(job?.text ?? '').includes('9200')) missing.push('reports NT$9,200');
      return missing;
    },
  },
];
