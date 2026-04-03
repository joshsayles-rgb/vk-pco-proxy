const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

const PCO_APP_ID = process.env.PCO_APP_ID || '';
const PCO_SECRET = process.env.PCO_SECRET || '';
const PORT       = process.env.PORT || 3000;

const auth = 'Basic ' + Buffer.from(PCO_APP_ID + ':' + PCO_SECRET).toString('base64');

console.log('PCO_APP_ID length:', PCO_APP_ID.length);
console.log('PCO_SECRET length:', PCO_SECRET.length);

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
    headers:  {
      'Authorization': auth,
      'Content-Type':  'application/json',
      'Accept-Encoding': 'identity', // request uncompressed response
    }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let body = '';
    const encoding = proxyRes.headers['content-encoding'];

    let stream = proxyRes;
    if (encoding === 'gzip') {
      stream = proxyRes.pipe(zlib.createGunzip());
    } else if (encoding === 'br') {
      stream = proxyRes.pipe(zlib.createBrotliDecompress());
    } else if (encoding === 'deflate') {
      stream = proxyRes.pipe(zlib.createInflate());
    }

    stream.on('data', chunk => body += chunk);
    stream.on('end', () => {
      console.log('PCO status:', proxyRes.statusCode, 'body length:', body.length);
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    stream.on('error', (err) => {
      console.log('Stream error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Stream error: ' + err.message }));
    });
  });

  proxyReq.on('error', (err) => {
    console.log('Proxy error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });

  proxyReq.end();
});

server.listen(PORT, () => console.log('PCO proxy on port ' + PORT));
