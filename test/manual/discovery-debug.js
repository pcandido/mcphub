// Debug script: trace OAuth metadata discovery for Todoist MCP
import https from 'node:https';

async function fetchJSON(url) {
  return new Promise((resolve) => {
    https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.log(`  -> HTTP ${res.statusCode}`);
        return resolve(null);
      }
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    }).on('error', (e) => { console.log(`  -> Error: ${e.message}`); resolve(null); })
    .on('timeout', () => { console.log('  -> Timeout'); resolve(null); });
  });
}

async function postJson(urlStr, body) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const req = https.request(urlStr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 10000,
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: d,
        });
      });
    });
    req.on('error', (e) => { resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function main() {
  const serverUrl = 'https://ai.todoist.net/mcp';

  // Strategy 1
  console.log('1. Path-level .well-known/oauth-authorization-server');
  const base = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
  const r1 = await fetchJSON(base + '.well-known/oauth-authorization-server');
  console.log(`   Result: ${r1 ? 'found' : 'null'}`);

  // Strategy 2
  console.log('2. Root .well-known/oauth-protected-resource');
  const r2 = await fetchJSON('https://ai.todoist.net/.well-known/oauth-protected-resource');
  console.log(`   Result: ${r2 ? JSON.stringify(r2) : 'null'}`);

  // Strategy 3
  console.log('3. POST initialize → 401 WWW-Authenticate');
  const r3 = await postJson(serverUrl, JSON.stringify({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcphub', version: '0.1.0' },
    },
  }));
  if (!r3) { console.log('   postJson returned null'); return; }
  console.log(`   Status: ${r3.statusCode}`);
  console.log(`   WWW-Authenticate: ${r3.headers['www-authenticate']}`);

  if (r3.statusCode !== 401) {
    console.log('   (expected 401, stopping)');
    return;
  }

  const wwwAuth = r3.headers['www-authenticate'];
  if (!wwwAuth) {
    console.log('   No WWW-Authenticate header');
    return;
  }

  // Parse resource_metadata
  const match = wwwAuth.match(/resource_metadata\s*=\s*"([^"]+)"/i);
  if (!match) { console.log('   No resource_metadata in header'); return; }
  const metadataUrl = match[1];
  console.log(`   resource_metadata: ${metadataUrl}`);

  console.log('4. Fetch resource_metadata');
  const r4 = await fetchJSON(metadataUrl);
  console.log(`   Result: ${r4 ? JSON.stringify(r4) : 'null'}`);
  if (!r4) return;

  const authServer = r4.authorization_servers?.[0];
  if (!authServer) { console.log('   No authorization_servers'); return; }
  console.log(`   auth_server: ${authServer}`);

  console.log('5. Fetch auth server .well-known');
  const authOrigin = new URL(authServer).origin || authServer;
  console.log(`   URL: ${authOrigin}/.well-known/oauth-authorization-server`);
  const r5 = await fetchJSON(`${authOrigin}/.well-known/oauth-authorization-server`);
  console.log(`   Result: ${r5 ? JSON.stringify(r5, null, 2) : 'null'}`);
}

main().catch(console.error);
