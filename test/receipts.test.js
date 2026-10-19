import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Stand-in for the Claude API: records the request and replies like the Messages API would
let fake, lastRequest, reply;
before(async () => {
  fake = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; });
    req.on('end', () => {
      lastRequest = { path: req.url, headers: req.headers, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: reply.stop || 'end_turn', content: reply.stop === 'refusal' ? [] : [{ type: 'text', text: JSON.stringify(reply.json) }], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  }).listen(0);
  await new Promise(r => fake.once('listening', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
});
after(() => fake.close());

test('reads a receipt with the expected request and cleans the result', async () => {
  const { readReceipt } = await import('../src/receipts.js');
  reply = { json: { is_receipt: true, kind: 'expense', vendor: 'Staples', date: '2026-10-14', total: 42.17, category: 'Supplies' } };
  const r = await readReceipt({ mediaType: 'image/jpeg', data: 'AAAA' });
  assert.deepEqual(r, { type: 'out', description: 'Staples', date: '2026-10-14', amount: 42.17, category: 'Supplies' });
  const b = lastRequest.body;
  assert.equal(b.model, 'claude-opus-5-5');
  assert.equal(b.fallbacks, 'default');
  assert.match(lastRequest.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(b.output_config.format.type, 'json_schema');
  assert.equal(b.messages[0].content[0].source.media_type, 'image/jpeg');
});

test('sale receipts become money in; odd values are corrected', async () => {
  const { readReceipt } = await import('../src/receipts.js');
  reply = { json: { is_receipt: true, kind: 'sale', vendor: 'Customer Co', date: '14/10/2026', total: -99.5, category: 'Rent' } };
  const r = await readReceipt({ mediaType: 'image/png', data: 'AAAA' });
  assert.deepEqual(r, { type: 'in', description: 'Customer Co', date: null, amount: 99.5, category: 'Sales' });
});

test('non-receipts and refusals give a clear message', async () => {
  const { readReceipt } = await import('../src/receipts.js');
  reply = { json: { is_receipt: false, kind: 'expense', vendor: '', date: null, total: 0, category: 'Other expense' } };
  await assert.rejects(readReceipt({ mediaType: 'image/png', data: 'AAAA' }), /does not look like a receipt/);
  reply = { stop: 'refusal' };
  await assert.rejects(readReceipt({ mediaType: 'image/png', data: 'AAAA' }), /could not be read/);
});
