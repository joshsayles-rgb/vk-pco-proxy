const https = require('https');
const http  = require('http');

const PCO_APP_ID = process.env.PCO_APP_ID || '';
const PCO_SECRET = process.env.PCO_SECRET || '';
const PORT       = process.env.PORT || 3000;

const auth = 'Basic ' + Buffer.from(PCO_APP_ID + ':' + PCO_SECRET).toString('base64');

console.log('PCO_APP_ID length:', PCO_APP_ID.length);
console.log('PCO_SECRET length:', PCO_SECRET.length);

// Location ID -> room name
const LOC = {
  '852593':  'Nursery',
  '933868':  'Toddler/Wobbler',
  '683779':  'Preschool',
  '1991723': 'Kindergarten - 1st Grade',
  '683780':  '2nd-3rd Grade',
  '909667':  '4th-6th Grade',
};
const CLASS_ORDER = ['Nursery','Toddler/Wobbler','Preschool','Kindergarten - 1st Grade','2nd-3rd Grade','4th-6th Grade'];

function pcoFetch(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.planningcenteronline.com',
      path,
      method: 'GET',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getCheckInCounts(eventId) {
  // Get recent event periods
  const periodsRes = await pcoFetch('/check-ins/v2/events/' + eventId + '/event_periods?order=-starts_at&per_page=5');
  if (periodsRes.status !== 200) throw new Error('Periods error: ' + periodsRes.status);

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const allPeriods = periodsRes.data.data || [];
  const todayPeriod = allPeriods.find(p => p.attributes.starts_at.split('T')[0] === todayStr);
  const pastPeriod  = allPeriods.find(p => new Date(p.attributes.starts_at) < now);
  const period = todayPeriod || pastPeriod;
  if (!period) return null;

  // Paginate through all check_ins for this period
  let allCheckIns = [];
  let path = '/check-ins/v2/check_ins?where[event_period_id]=' + period.id + '&per_page=100';

  while (path) {
    const res = await pcoFetch(path);
    if (res.status !== 200) break;
    allCheckIns = allCheckIns.concat(res.data.data || []);
    const nextUrl = res.data.links?.next || null;
    path = nextUrl ? new URL(nextUrl).pathname + new URL(nextUrl).search : null;
  }

  // Count by location
  const counts = {};
  for (const ci of allCheckIns) {
    const locId = ci.relationships?.locations?.data?.[0]?.id;
    const room = LOC[locId];
    if (!room) continue;
    if (!counts[room]) counts[room] = 0;
    counts[room]++;
  }

  return {
    total: allCheckIns.length,
    rooms: CLASS_ORDER.map(name => ({ name, count: counts[name] || 0 })),
    periodDate: period.attributes.starts_at.split('T')[0],
    isToday: !!todayPeriod,
  };
}

const server = http.createServer(async (req, res) => {
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

  // Special route: /checkins/:eventId
  const checkinMatch = req.url.match(/^\/checkins\/(\d+)$/);
  if (checkinMatch) {
    try {
      const counts = await getCheckInCounts(checkinMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(counts));
    } catch(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Default: forward to PCO
  const options = {
    hostname: 'api.planningcenteronline.com',
    path: req.url,
    method: 'GET',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' }
  };

  const proxyReq = https.request(options, (proxyRes) => {
    let body = '';
    proxyRes.on('data', chunk => body += chunk);
    proxyRes.on('end', () => {
      res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  });

  proxyReq.end();
});

server.listen(PORT, () => console.log('PCO proxy on port ' + PORT));
