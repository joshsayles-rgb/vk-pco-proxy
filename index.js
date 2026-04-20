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

// Paginate all check-ins for a period and count by location
async function countsByPeriod(periodId) {
  let all = [];
  let path = '/check-ins/v2/check_ins?where[event_period_id]=' + periodId + '&include=locations&per_page=100';
  let pages = 0;

  while (path && pages < 20) {
    pages++;
    const res = await pcoFetch(path);
    if (res.status !== 200) break;
    all = all.concat(res.data.data || []);
    const nextUrl = res.data.links?.next || null;
    path = nextUrl ? new URL(nextUrl).pathname + new URL(nextUrl).search : null;
  }

  const counts = {};
  for (const ci of all) {
    const locId = ci.relationships?.locations?.data?.[0]?.id;
    const room = LOC[locId];
    if (!room) continue;
    counts[room] = (counts[room] || 0) + 1;
  }

  return {
    total: all.length,
    rooms: CLASS_ORDER.map(name => ({ name, count: counts[name] || 0 })),
  };
}

// Get today's check-in counts split by 1st and 2nd service
async function getCheckInCounts(eventId) {
  const periodsRes = await pcoFetch(
    '/check-ins/v2/events/' + eventId + '/event_periods?order=-starts_at&per_page=10'
  );
  if (periodsRes.status !== 200) throw new Error('Periods error: ' + periodsRes.status);

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const allPeriods = periodsRes.data.data || [];

  // Get today's periods sorted by start time
  const todayPeriods = allPeriods
    .filter(p => p.attributes.starts_at.split('T')[0] === todayStr)
    .sort((a, b) => new Date(a.attributes.starts_at) - new Date(b.attributes.starts_at));

  if (todayPeriods.length === 0) {
    // Fall back to most recent past periods (last Sunday)
    const pastPeriods = allPeriods
      .filter(p => new Date(p.attributes.starts_at) < now)
      .sort((a, b) => new Date(b.attributes.starts_at) - new Date(a.attributes.starts_at))
      .slice(0, 2)
      .sort((a, b) => new Date(a.attributes.starts_at) - new Date(b.attributes.starts_at));

    if (pastPeriods.length === 0) return null;

    const results = await Promise.all(pastPeriods.map(p => countsByPeriod(p.id)));
    return {
      isToday: false,
      date: pastPeriods[0].attributes.starts_at.split('T')[0],
      service1: results[0] || null,
      service2: results[1] || null,
    };
  }

  // Today's periods
  const results = await Promise.all(todayPeriods.slice(0, 2).map(p => countsByPeriod(p.id)));
  return {
    isToday: true,
    date: todayStr,
    service1: results[0] || null,
    service2: results[1] || null,
    periods: todayPeriods.map(p => ({
      id: p.id,
      starts_at: p.attributes.starts_at,
    })),
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
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // /checkins/:eventId — split by service
  const checkinMatch = req.url.match(/^\/checkins\/(\d+)$/);
  if (checkinMatch) {
    try {
      const counts = await getCheckInCounts(checkinMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(counts));
    } catch(err) {
      console.error('checkins error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Default: forward to PCO
  const result = await pcoFetch(req.url).catch(err => ({ status: 500, data: { error: err.message } }));
  res.writeHead(result.status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result.data));
});

server.listen(PORT, () => console.log('PCO proxy on port ' + PORT));
