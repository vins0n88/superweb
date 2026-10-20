// Fixture web server for e2e tests: routes by Host header, records form posts.
import http from 'node:http';
import { PORT, route } from './fixtures.mjs';

export function startFixtureServer(port = PORT) {
  const submissions = [];
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && host.startsWith('forms.') && pathname === '/submit') {
        submissions.push(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString())));
      }
      const html = route(host, pathname, searchParams);
      res.writeHead(html ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html ?? '<h1>Not found</h1>');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    submissions,
    stop: () => new Promise((r) => server.close(r)),
  })));
}
