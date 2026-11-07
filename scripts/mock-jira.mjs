// A tiny stand-in for the Jira Cloud REST API, for testing `traceqa bugs file` without a real Jira.
// Usage: node scripts/mock-jira.mjs [port]   (default 4455). GET /_state shows what was received.
import http from 'node:http';

const port = Number(process.argv[2] ?? 4455);
const issues = [];
const log = [];

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  log.push({ method: req.method, path: url.pathname, auth: (req.headers.authorization ?? '').split(' ')[0], atlassianToken: req.headers['x-atlassian-token'] ?? null, bytes: raw.length });

  if (url.pathname === '/_state') return json(res, 200, { issues, log });
  if (!req.headers.authorization) return json(res, 401, { errorMessages: ['Unauthorized'] });

  if (req.method === 'GET' && url.pathname === '/rest/api/3/search/jql') {
    const jql = url.searchParams.get('jql') ?? '';
    const label = jql.match(/labels = "([^"]+)"/)?.[1];
    const found = issues.filter((i) => i.fields.labels.includes(label));
    return json(res, 200, { issues: found.map((i) => ({ key: i.key, fields: { summary: i.fields.summary } })) });
  }
  if (req.method === 'POST' && url.pathname === '/rest/api/3/issue') {
    const body = JSON.parse(raw.toString('utf8'));
    if (!body.fields?.project?.key || !body.fields?.summary || body.fields?.description?.type !== 'doc') return json(res, 400, { errors: { fields: 'invalid' } });
    const key = `${body.fields.project.key}-${issues.length + 1}`;
    issues.push({ key, fields: body.fields, attachments: [], comments: [] });
    return json(res, 201, { id: String(issues.length), key, self: `http://localhost:${port}/rest/api/3/issue/${key}` });
  }
  const m = url.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)\/(attachments|comment)$/);
  if (req.method === 'POST' && m) {
    const issue = issues.find((i) => i.key === decodeURIComponent(m[1]));
    if (!issue) return json(res, 404, { errorMessages: ['Issue does not exist'] });
    if (m[2] === 'attachments') {
      if (req.headers['x-atlassian-token'] !== 'no-check') return json(res, 403, { errorMessages: ['XSRF check failed'] });
      const name = raw.toString('latin1').match(/filename="([^"]+)"/)?.[1] ?? 'file';
      issue.attachments.push({ name, bytes: raw.length });
      return json(res, 200, [{ filename: name }]);
    }
    issue.comments.push(JSON.parse(raw.toString('utf8')));
    return json(res, 201, { id: String(issue.comments.length) });
  }
  json(res, 404, { errorMessages: ['Not found'] });
});

server.listen(port, '127.0.0.1', () => console.log(`Mock Jira on http://127.0.0.1:${port}`));
