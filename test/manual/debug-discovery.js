// Trace discovery.js execution step by step
import https from 'node:https';
import http from 'node:http';

const serverUrl = 'https://ai.todoist.net/mcp';
const insecure = true;
const agent = new https.Agent({ rejectUnauthorized: false });

async function fetchJSON(url, useInsecure) {
  const ag = useInsecure && url.startsWith('https:') ? agent : undefined;
  const mod = url.startsWith('https:') ? https : http;

  return new Promise((resolve) => {
    const req = mod.get(url, { timeout: 10000, agent: ag }, (res) => {
      console.log(`  GET ${url} -> ${res.statusCode}`);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        req.destroy();
        return resolve(null);
      }
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', (e) => { console.log(`  GET ${url} -> Error: ${e.message}`); resolve(null); });
    req.on('timeout', () => { console.log(`  GET ${url} -> Timeout`); req.destroy(); resolve(null); });
  });
}

async function postJson(urlStr, body, useInsecure) {
  const ag = urlStr.startsWith('https:') && useInsecure ? agent : undefined;
  const mod = urlStr.startsWith('https:') ? https : http;

  return new Promise((resolve) => {
    const req = mod.request(urlStr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 10000,
      agent: ag,
    }, (res) => {
      console.log(`  POST ${urlStr} -> ${res.statusCode}`);
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: d }));
    });
    req.on('error', (e) => { console.log(`  POST ${urlStr} -> Error: ${e.message}`); resolve(null); });
    req.on('timeout', () => { console.log(`  POST ${urlStr} -> Timeout`); req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

console.log('=== Strategy 1: path-level well-known ===');
const base = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
const r1 = await fetchJSON(base + '.well-known/oauth-authorization-server', insecure);
console.log(`  Result: ${r1 ? 'found' : 'null'}`);

console.log('\n=== Strategy 2: root well-known ===');
const origin = 'https://ai.todoist.net';
const r2 = await fetchJSON(`${origin}/.well-known/oauth-protected-resource`, insecure);
console.log(`  Result: ${r2 ? JSON.stringify(r2) : 'null'}`);

console.log('\n=== Strategy 3: WWW-Authenticate ===');
const r3 = await postJson(serverUrl, JSON.stringify({
  jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mcphub', version: '0.1.0' } },
}), insecure);
if (!r3) { console.log('  postJson returned null'); process.exit(1); }
console.log(`  Status: ${r3.statusCode}`);
console.log(`  WWW-Authenticate: ${r3.headers['www-authenticate']}`);

if (r3.statusCode !== 401) { console.log('  Expected 401'); process.exit(1); }

const wwwAuth = r3.headers['www-authenticate'];
const match = wwwAuth.match(/resource_metadata\s*=\s*"([^"]+)"/i);
if (!match) { console.log('  No resource_metadata param'); process.exit(1); }
const resourceMetaUrl = match[1];
console.log(`  resource_metadata URL: ${resourceMetaUrl}`);

console.log('\n=== Fetch resource_metadata ===');
const r4 = await fetchJSON(resourceMetaUrl, insecure);
console.log(`  Result: ${r4 ? JSON.stringify(r4) : 'null'}`);
if (!r4) process.exit(1);

const authServer = r4.authorization_servers?.[0];
console.log(`  auth_server: ${authServer}`);

const authOrigin = new URL(authServer).origin || authServer;
console.log(`  Fetch: ${authOrigin}/.well-known/oauth-authorization-server`);
const r5 = await fetchJSON(`${authOrigin}/.well-known/oauth-authorization-server`, false); // todoist.com has valid cert
console.log(`  Result: ${r5 ? 'found' : 'null'}`);
if (r5) {
  console.log(`  authorization_endpoint: ${r5.authorization_endpoint}`);
  console.log(`  token_endpoint: ${r5.token_endpoint}`);
  console.log(`  registration_endpoint: ${r5.registration_endpoint}`);
  console.log(`  resource_parameter_supported: ${r5.resource_parameter_supported}`);
}
