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
  // Use headcounts endpoint via location_event_times for accurate per-period counts
  const letRes = await pcoFetch('/check-ins/v2/event_periods/' + periodId + '/location_event_times?per_page=100&include=location,headcounts');
  console.log('location_event_times status:', letRes.status, 'for period:', periodId);
 
  if (letRes.status === 200 && letRes.data.data && letRes.data.data.length > 0) {
    // Build location map from included
    const locMap = {};
    for (const inc of (letRes.data.included || [])) {
      if (inc.type === 'Location') locMap[inc.id] = inc.attributes.name;
      if (inc.type === 'Headcount') {
        const locId = inc.relationships?.location?.data?.id;
        const room = LOC[locId];
        if (room) {
          locMap['count_' + room] = (locMap['count_' + room] || 0) + (inc.attributes.total || 0);
        }
      }
    }
    const total = Object.keys(locMap)
      .filter(k => k.startsWith('count_'))
      .reduce((s, k) => s + locMap[k], 0);
    return {
      total,
      rooms: CLASS_ORDER.map(name => ({ name, count: locMap['count_' + name] || 0 })),
    };
  }
 
  // Fallback: paginate check_ins filtered by event_period
  let all = [];
  let path = '/check-ins/v2/check_ins?filter[event_period_id]=' + periodId + '&include=locations&per_page=100';
  let pages = 0;
 
  while (path && pages < 30) {
    pages++;
    const res = await pcoFetch(path);
    if (res.status !== 200) break;
    const pageData = res.data.data || [];
    // Verify these belong to our period
    const filtered = pageData.filter(ci =>
      ci.relationships?.event_period?.data?.id === periodId
    );
    all = all.concat(filtered);
    // If PCO isn't filtering, stop after first page mismatch
    if (pageData.length > 0 && filtered.length === 0) break;
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
 
  console.log('Fallback period', periodId, 'total:', all.length);
  return {
    total: all.length,
    rooms: CLASS_ORDER.map(name => ({ name, count: counts[name] || 0 })),
  };
}
 
// Get today's check-in counts split by 1st and 2nd service
async function getCheckInCounts(eventId) {
  const periodsRes = await pcoFetch(
    '/check-ins/v2/events/' + eventId + '/event_periods?order=-starts_at&per_page=25'
  );
  if (periodsRes.status !== 200) throw new Error('Periods error: ' + periodsRes.status);
 
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const allPeriods = periodsRes.data.data || [];
 
  console.log('Today str:', todayStr, 'Now UTC:', now.toISOString());
  console.log('All periods count:', allPeriods.length);
  console.log('All periods:', JSON.stringify(allPeriods.map(p => ({ id: p.id, starts_at: p.attributes.starts_at }))));
 
  // Get today's periods sorted by start time
  const todayPeriods = allPeriods
    .filter(p => p.attributes.starts_at.split('T')[0] === todayStr)
    .sort((a, b) => new Date(a.attributes.starts_at) - new Date(b.attributes.starts_at));
 
  console.log('Today periods:', todayPeriods.map(p => ({ id: p.id, starts_at: p.attributes.starts_at })));
 
  if (todayPeriods.length === 0) {
    // Fall back to most recent past periods (last Sunday)
    // Get the most recent Sunday's periods
    const pastPeriods = allPeriods
      .filter(p => new Date(p.attributes.starts_at) < now)
      .sort((a, b) => new Date(b.attributes.starts_at) - new Date(a.attributes.starts_at));
 
    // Find the most recent date and get all periods from that date
    const mostRecentDate = pastPeriods[0]?.attributes.starts_at.split('T')[0];
    console.log('Most recent period date:', mostRecentDate);
    const recentPeriods = pastPeriods
      .filter(p => p.attributes.starts_at.split('T')[0] === mostRecentDate)
      .sort((a, b) => new Date(a.attributes.starts_at) - new Date(b.attributes.starts_at));
 
    if (recentPeriods.length === 0) return null;
    console.log('Using periods from:', mostRecentDate, 'count:', recentPeriods.length);
 
    const results = await Promise.all(recentPeriods.slice(0, 2).map(p => countsByPeriod(p.id)));
    return {
      isToday: false,
      date: mostRecentDate,
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
 
  // Debug event times - try multiple endpoints
  const timesMatch = req.url.match(/^[/]times[/](\d+)$/);
  if (timesMatch) {
    try {
      const eventId = timesMatch[1];
      const periodId = '45297297'; // May 3 period
      const endpoints = {
        event_times: await pcoFetch('/check-ins/v2/events/' + eventId + '/event_times?per_page=5'),
        period_times: await pcoFetch('/check-ins/v2/event_periods/' + periodId + '/event_times?per_page=5'),
        period_location_times: await pcoFetch('/check-ins/v2/event_periods/' + periodId + '/location_event_times?per_page=5'),
        event: await pcoFetch('/check-ins/v2/events/' + eventId),
      };
      const result = {};
      for (const [k, v] of Object.entries(endpoints)) {
        result[k] = { status: v.status, count: v.data?.data?.length, keys: Object.keys(v.data || {}) };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch(err) {
      res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
    }
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
