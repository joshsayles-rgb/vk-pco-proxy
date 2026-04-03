const https = require('https');
const http  = require('http');

const PCO_APP_ID = process.env.PCO_APP_ID || '';
const PCO_SECRET = process.env.PCO_SECRET || '';
const PORT       = process.env.PORT || 3000;

console.log('PCO_APP_ID length:', PCO_APP_ID.length);
console.log('PCO_SECRET length:', PCO_SECRET.length);
console.log('PCO_APP_ID start:', PCO_APP_ID.substring(0, 8));

const auth = 'Basic ' + Buffer.from(PCO_APP_ID + ':' + PCO_SECRET).toString('base64');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'GET')     { res.writeHead(405); res.end(JSON.stringify({ error: 'Method not allowed' })); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, appIdLength: PCO_APP_ID.length, secretLength: PCO_SECRET.length }));
    return;
  }

  const options = {
    hostname: 'api.planningcenteronline.com',
    path:     req.url,
    method:   'GET',
    headers:  { 'Authorization': auth, 'Content-Type': 'application/json' }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });

  proxyReq.end();
});

server.listen(PORT, () => console.log('PCO proxy on port ' + PORT));
