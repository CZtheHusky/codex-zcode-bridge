// Minimal HTTP/WS peer for the documented Kimi 2.3.3 boundary. No model calls.
const http = require('node:http');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const scenario = JSON.parse(fs.readFileSync('scenario.json', 'utf8'));
const session = { id: 'session_fixture', metadata: { cwd: process.cwd() }, agent_config: { model: 'fixture/default' }, busy: false, usage: { input_tokens: 7, output_tokens: 3 } };
let socket, prompt, seq = 0, turnId = 4, loaded = false;
const requests = fs.existsSync('requests.json') ? JSON.parse(fs.readFileSync('requests.json', 'utf8')) : [];
const record = (route, body) => { requests.push({ route, body }); fs.writeFileSync('requests.json', JSON.stringify(requests)); };
function send(value) {
  const data = Buffer.from(JSON.stringify(value));
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  socket.write(Buffer.concat([head, data]));
}
function event(type, payload, extra = {}) { send({ type, session_id: session.id, seq: ++seq, payload: { type, agentId: 'main', turnId, ...payload }, ...extra }); }
const report = JSON.stringify({ summary: 'fixture success', files_changed: [], tests: [], issues: [], needs_master_decision: false, acceptance_met: true });
function complete() {
  event('assistant.delta', { delta: scenario.kind === 'invalid' ? '{}' : report }, { offset: scenario.kind === 'gap' ? 99 : 0 });
  event('turn.ended', { reason: scenario.kind === 'failure' ? 'failed' : 'completed', ...(scenario.kind === 'failure' ? { error: { code: 'provider.rate_limit', message: scenario.message ?? 'Usage quota exhausted', details: { api_key: 'SECRET_MUST_NOT_LEAK' } } } : {}) });
}
const server = http.createServer(async (req, res) => {
  let text = ''; for await (const part of req) text += part;
  const body = text ? JSON.parse(text) : undefined;
  record(req.url, body);
  if (req.headers.authorization !== 'Bearer private-fixture-token') { res.writeHead(401); return res.end(JSON.stringify({ code: 40101, data: null })); }
  let data = {};
  if (req.url.endsWith('/snapshot')) { loaded = true; data = { session, as_of_seq: 0, epoch: 'fixture-epoch' }; }
  else if (req.url === '/api/v1/config') data = { default_model: 'fixture/default' };
  else if (req.url === '/api/v1/sessions' || req.url === '/api/v1/sessions/session_fixture') data = { ...session, metadata: { cwd: scenario.kind === 'wrong_workspace' && req.method === 'GET' ? '/wrong' : process.cwd() } };
  else if (req.url.endsWith('/prompts')) {
    if (scenario.kind === 'envelope_error') { res.end(JSON.stringify({ code: 40110, msg: 'SECRET_MUST_NOT_LEAK', data: {} })); return; }
    prompt = body;
    if (body.thinking !== undefined) session.agent_config.thinking = scenario.kind === 'thinking_fallback' ? 'high' : body.thinking;
    setTimeout(() => {
      event('turn.ended', { turnId: 0, reason: 'completed' });
      event('turn.started', { promptId: 'foreign-prompt', turnId: 0 });
      event('turn.started', { promptId: body.prompt_id });
      event('assistant.delta', { agentId: 'subagent', delta: 'HIDDEN_SUBAGENT' });
      event('thinking.delta', { delta: 'HIDDEN_REASONING' });
      if (scenario.kind === 'disconnect') return socket.destroy();
      if (scenario.kind === 'hang') return;
      if (scenario.kind === 'permission') event('event.approval.requested', {});
      else if (scenario.kind === 'question') event('event.question.requested', {});
      else complete();
    }, 10);
  } else if (req.url.endsWith('/approvals?status=pending')) data = { items: [{ approval_id: 'approval_1', turn_id: turnId, tool_name: 'Write', action: 'write fixture', tool_input_display: { path: 'proof.txt', content: 'test' } }] };
  else if (req.url.endsWith('/questions?status=pending')) data = { items: [{ question_id: 'question_1', turn_id: turnId, questions: [{ id: 'q1', question: 'Which color?', options: [{ id: 'blue', label: 'Blue' }, { id: 'red', label: 'Red' }], allow_other: true }] }] };
  else if (/\/(approvals|questions)\//.test(req.url)) setTimeout(complete, 10);
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: 0, data }));
});
server.on('upgrade', (req, peer) => {
  socket = peer;
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  peer.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: kimi-code.bearer.private-fixture-token\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  peer.on('data', bytes => {
    buffer = Buffer.concat([buffer, bytes]);
    while (buffer.length >= 2) {
      let length = buffer[1] & 127, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      if (buffer.length < offset + 4 + length) return;
      const opcode = buffer[0] & 15;
      const mask = buffer.subarray(offset, offset + 4); offset += 4;
      const content = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);
      if (opcode === 8) { peer.end(); return; }
      for (let i = 0; i < content.length; i++) content[i] ^= mask[i % 4];
      const message = JSON.parse(content.toString());
      if (message.type === 'subscribe') send({ type: 'ack', id: message.id, code: 0, payload: { accepted: loaded ? [session.id] : [], not_found: loaded ? [] : [session.id], resync_required: [] } });
    }
  });
  peer.on('error', () => {});
});
server.listen(0, '127.0.0.1', () => console.log(`Kimi server: http://127.0.0.1:${server.address().port}/#token=private-fixture-token`));
