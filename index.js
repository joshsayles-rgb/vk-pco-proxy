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
// Split cutoff: 10:35 AM Pacific = 17:35 UTC
const SERVICE_CUTOFF_HOUR = 17;
const SERVICE_CUTOFF_MIN  = 35;
 
function isFirstService(createdAt) {
  const d = new Date(createdAt);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return h < SERVICE_CUTOFF_HOUR || (h === SERVICE_CUTOFF_HOUR && m < SERVICE_CUTOFF_MIN);
}
 
async function fetchAllForPeriod(periodId, periodDate) {
  // Get the period date bounds in UTC
  const dayStart = new Date(periodDate + 'T00:00:00Z');
  const dayEnd   = new Date(periodDate + 'T23:59:59Z');
 
  let all = [];
  let path = '/check-ins/v2/check_ins?where[event_period_id]=' + periodId + '&include=locations&per_page=100';
  let pages = 0;
  let hadMismatch = false;
 
  while (path && pages < 30) {
    pages++;
    const res = await pcoFetch(path);
    if (res.status !== 200) break;
    const pageData = res.data.data || [];
 
    // Filter to only check-ins created on the period's date
    const filtered = pageData.filter(ci => {
      const created = new Date(ci.attributes.created_at);
      return created >= dayStart && created <= dayEnd;
    });
 
    all = all.concat(filtered);
 
    // If we're getting check-ins from wrong dates, stop paginating
    const wrongDate = pageData.filter(ci => {
      const created = new Date(ci.attributes.created_at);
      return created < dayStart;
    });
    if (wrongDate.length > pageData.length / 2) {
      console.log('Stopping pagination - hitting old check-ins');
      break;
    }
 
    const nextUrl = res.data.links?.next || null;
    path = nextUrl ? new URL(nextUrl).pathname + new URL(nextUrl).search : null;
  }
  console.log('Period', periodId, 'date', periodDate, 'filtered total:', all.length, 'pages:', pages);
  return all;
}
 
function toCounts(checkIns) {
  const counts = {};
  for (const ci of checkIns) {
    const locId = ci.relationships?.locations?.data?.[0]?.id;
    const room = LOC[locId];
    if (!room) continue;
    counts[room] = (counts[room] || 0) + 1;
  }
  return {
    total: checkIns.length,
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
 
    // Split by time cutoff
    const period = recentPeriods[0];
    const allCI = await fetchAllForPeriod(period.id, mostRecentDate);
    const first  = allCI.filter(ci => isFirstService(ci.attributes.created_at));
    const second = allCI.filter(ci => !isFirstService(ci.attributes.created_at));
    console.log('Fallback: 1st service:', first.length, '2nd service:', second.length);
    return {
      isToday: false,
      date: mostRecentDate,
      service1: toCounts(first),
      service2: second.length > 0 ? toCounts(second) : null,
    };
  }
 
  // Today's periods - split by time
  const period = todayPeriods[0];
  const allCI = await fetchAllForPeriod(period.id, todayStr);
  const first  = allCI.filter(ci => isFirstService(ci.attributes.created_at));
  const second = allCI.filter(ci => !isFirstService(ci.attributes.created_at));
  console.log('Today: 1st service:', first.length, '2nd service:', second.length);
  return {
    isToday: true,
    date: todayStr,
    service1: toCounts(first),
    service2: second.length > 0 ? toCounts(second) : null,
    periods: todayPeriods.map(p => ({ id: p.id, starts_at: p.attributes.starts_at })),
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
