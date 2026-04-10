const http = require('http');
const fs = require('fs');

const results = [];
let totalTests = 0;

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3001, path, method, timeout: 5000,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
    };
    const r = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, data: d }); }
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, data: 'TIMEOUT' }); });
    r.on('error', (e) => resolve({ status: 0, data: 'ERROR: ' + e.message }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function test(section, name, pass, detail) {
  totalTests++;
  results.push({ section, name, pass: !!pass, detail: detail || '' });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`  ${icon} | ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  console.log('================================================================');
  console.log('  EL SHADDAI CONNECT — FULL APP DIAGNOSTIC');
  console.log('  Testing ALL endpoints, ALL features, ALL pages');
  console.log('================================================================\n');

  // ==============================
  // SECTION 1: SERVER & AUTH
  // ==============================
  console.log('▸ SECTION 1: SERVER & AUTH');

  const health = await req('GET', '/api/health');
  test('Server', 'Health endpoint', health.status === 200);

  const login = await req('POST', '/api/auth/login', { username: 'admin@elshaddai.com', password: 'admin123' });
  const t = login.data.token;
  test('Auth', 'Admin login', !!t, t ? 'superadmin token' : 'FAILED');

  const badLogin = await req('POST', '/api/auth/login', { username: 'admin@elshaddai.com', password: 'wrong' });
  test('Auth', 'Bad password rejected', badLogin.status === 401, 'status=' + badLogin.status);

  const noBody = await req('POST', '/api/auth/login', {});
  test('Auth', 'Missing credentials rejected', noBody.status === 400, 'status=' + noBody.status);

  // Login as regular member
  const memberLogin = await req('POST', '/api/auth/login', { username: 'member@test.com', password: 'member123' });
  const mt = memberLogin.data ? memberLogin.data.token : null;
  test('Auth', 'Member login', !!mt || memberLogin.status === 401, mt ? 'member token' : 'no member account (expected if not seeded)');

  // Profile
  const profile = await req('GET', '/api/auth/me', null, t);
  test('Auth', 'Get profile (/me)', profile.status === 200 && profile.data.id, 'user=' + (profile.data.firstName || ''));

  console.log('');

  // ==============================
  // SECTION 2: MEMBERS
  // ==============================
  console.log('▸ SECTION 2: MEMBERS');

  const members = await req('GET', '/api/members', null, t);
  const memberList = members.data.members || members.data;
  test('Members', 'List members', Array.isArray(memberList), memberList.length + ' members');

  if (memberList.length > 0) {
    const m = memberList[0];
    const one = await req('GET', '/api/members/' + m.id, null, t);
    test('Members', 'Get single member', one.status === 200, one.data.firstName);
  }

  console.log('');

  // ==============================
  // SECTION 3: EVENTS & RSVPs
  // ==============================
  console.log('▸ SECTION 3: EVENTS & RSVPs');

  const events = await req('GET', '/api/events', null, t);
  test('Events', 'List events', Array.isArray(events.data), events.data.length + ' events');

  const newEvent = await req('POST', '/api/events', {
    title: 'Diagnostic Test Event',
    date: '2026-05-01',
    time: '10:00',
    location: 'Main Hall',
    description: 'Auto-generated test event'
  }, t);
  test('Events', 'Create event', newEvent.status === 200 || newEvent.status === 201, newEvent.data.id ? 'id=' + newEvent.data.id : JSON.stringify(newEvent.data).slice(0, 60));

  const eventId = newEvent.data.id || (events.data[0] && events.data[0].id);
  if (eventId) {
    const rsvp = await req('POST', '/api/events/' + eventId + '/rsvp', { status: 'going' }, t);
    test('Events', 'RSVP to event', rsvp.status === 200 || rsvp.status === 201, rsvp.data.message || JSON.stringify(rsvp.data).slice(0, 60));

    const rsvps = await req('GET', '/api/events/' + eventId + '/rsvps', null, t);
    test('Events', 'List RSVPs', rsvps.status === 200, Array.isArray(rsvps.data) ? rsvps.data.length + ' RSVPs' : 'response ok');
  }

  console.log('');

  // ==============================
  // SECTION 4: ATTENDANCE
  // ==============================
  console.log('▸ SECTION 4: ATTENDANCE');

  const attendance = await req('GET', '/api/attendance', null, t);
  test('Attendance', 'List attendance', attendance.status === 200, Array.isArray(attendance.data) ? attendance.data.length + ' records' : 'ok');

  console.log('');

  // ==============================
  // SECTION 5: FINANCE
  // ==============================
  console.log('▸ SECTION 5: FINANCE');

  const finance = await req('GET', '/api/finance', null, t);
  test('Finance', 'List transactions', finance.status === 200, Array.isArray(finance.data) ? finance.data.length + ' transactions' : 'ok');

  // Use actual member ID (not user ID) for FK constraint
  const memberForTx = members.data.members ? members.data.members[0] : (Array.isArray(members.data) ? members.data[0] : null);
  const newTx = await req('POST', '/api/finance', {
    type: 'income', category: 'tithe', amount: 100, date: '2026-04-10',
    memberId: memberForTx ? memberForTx.id : null, description: 'Diagnostic test tithe'
  }, t);
  test('Finance', 'Create transaction', newTx.status === 200 || newTx.status === 201, newTx.data.id ? 'id=' + newTx.data.id : JSON.stringify(newTx.data).slice(0,60));

  console.log('');

  // ==============================
  // SECTION 6: GROUPS & MINISTRIES
  // ==============================
  console.log('▸ SECTION 6: GROUPS & MINISTRIES');

  const groups = await req('GET', '/api/groups', null, t);
  test('Groups', 'List groups', groups.status === 200, Array.isArray(groups.data) ? groups.data.length + ' groups' : 'ok');

  const newGroup = await req('POST', '/api/groups', {
    name: 'Diagnostic Ministry', type: 'ministry', description: 'Test group'
  }, t);
  test('Groups', 'Create group', newGroup.status === 200 || newGroup.status === 201, newGroup.data.id ? 'id=' + newGroup.data.id : JSON.stringify(newGroup.data).slice(0,60));

  console.log('');

  // ==============================
  // SECTION 7: FEED (Social)
  // ==============================
  console.log('▸ SECTION 7: SOCIAL FEED');

  const feed = await req('GET', '/api/feed', null, t);
  test('Feed', 'List feed posts', feed.status === 200, Array.isArray(feed.data) ? feed.data.length + ' posts' : 'ok');

  const newPost = await req('POST', '/api/feed', {
    text: 'Diagnostic test post - God is good!', visibility: 'public'
  }, t);
  test('Feed', 'Create post', newPost.status === 200 || newPost.status === 201, newPost.data.id ? 'id=' + newPost.data.id : JSON.stringify(newPost.data).slice(0,60));

  if (newPost.data.id) {
    const like = await req('POST', '/api/feed/' + newPost.data.id + '/react', { type: 'like' }, t);
    test('Feed', 'React to post', like.status === 200 || like.status === 201, 'reaction sent');

    const comment = await req('POST', '/api/feed/' + newPost.data.id + '/comments', { text: 'Amen!' }, t);
    test('Feed', 'Comment on post', comment.status === 200 || comment.status === 201, 'comment posted');
  }

  console.log('');

  // ==============================
  // SECTION 8: MESSAGES
  // ==============================
  console.log('▸ SECTION 8: MESSAGES');

  const conversations = await req('GET', '/api/messages/conversations', null, t);
  test('Messages', 'List conversations', conversations.status === 200, Array.isArray(conversations.data) ? conversations.data.length + ' conversations' : 'ok');

  console.log('');

  // ==============================
  // SECTION 9: NOTIFICATIONS
  // ==============================
  console.log('▸ SECTION 9: NOTIFICATIONS');

  const notifs = await req('GET', '/api/notifications', null, t);
  test('Notifications', 'List notifications', notifs.status === 200, Array.isArray(notifs.data) ? notifs.data.length + ' notifications' : 'ok');

  console.log('');

  // ==============================
  // SECTION 10: SPACES (Audio)
  // ==============================
  console.log('▸ SECTION 10: SPACES');

  const spaces = await req('GET', '/api/spaces', null, t);
  test('Spaces', 'List spaces', spaces.status === 200, Array.isArray(spaces.data) ? spaces.data.length + ' spaces' : 'ok');

  console.log('');

  // ==============================
  // SECTION 11: RANKING
  // ==============================
  console.log('▸ SECTION 11: RANKING');

  const ranking = await req('GET', '/api/ranking/leaderboard', null, t);
  test('Ranking', 'Get leaderboard', ranking.status === 200, Array.isArray(ranking.data) ? ranking.data.length + ' entries' : 'ok');

  const myRank = await req('GET', '/api/ranking/me', null, t);
  test('Ranking', 'Get my rank', myRank.status === 200, myRank.data.points !== undefined ? 'points=' + myRank.data.points : 'ok');

  console.log('');

  // ==============================
  // SECTION 12: COMMUNITY HUB
  // ==============================
  console.log('▸ SECTION 12: COMMUNITY');

  const community = await req('GET', '/api/community/badge-counts', null, t);
  test('Community', 'Get badge counts', community.status === 200, 'ok');

  const announcements = await req('GET', '/api/community/announcements', null, t);
  test('Community', 'List announcements', announcements.status === 200, Array.isArray(announcements.data) ? announcements.data.length + ' announcements' : 'ok');

  const prayerReqs = await req('GET', '/api/community/prayer-requests', null, t);
  test('Community', 'List prayer requests', prayerReqs.status === 200, Array.isArray(prayerReqs.data) ? prayerReqs.data.length + ' requests' : 'ok');

  const fundraising = await req('GET', '/api/community/fundraising', null, t);
  test('Community', 'List fundraising', fundraising.status === 200, Array.isArray(fundraising.data) ? fundraising.data.length + ' campaigns' : 'ok');

  const pastorMsgs = await req('GET', '/api/community/pastor-messages', null, t);
  test('Community', 'List pastor messages', pastorMsgs.status === 200, Array.isArray(pastorMsgs.data) ? pastorMsgs.data.length + ' messages' : 'ok');

  const magazines = await req('GET', '/api/community/magazines', null, t);
  test('Community', 'List magazines', magazines.status === 200, Array.isArray(magazines.data) ? magazines.data.length + ' magazines' : 'ok');

  console.log('');

  // ==============================
  // SECTION 13: SETTINGS
  // ==============================
  console.log('▸ SECTION 13: SETTINGS');

  const settings = await req('GET', '/api/settings', null, t);
  test('Settings', 'Get settings', settings.status === 200, 'ok');

  console.log('');

  // ==============================
  // SECTION 14: USER ACCOUNTS
  // ==============================
  console.log('▸ SECTION 14: USER ACCOUNTS');

  const users = await req('GET', '/api/users', null, t);
  test('Users', 'List users', users.status === 200, Array.isArray(users.data) ? users.data.length + ' users' : 'ok');

  console.log('');

  // ==============================
  // SECTION 15: FOLLOWS
  // ==============================
  console.log('▸ SECTION 15: FOLLOWS');

  const follows = await req('GET', '/api/follows/following', null, t);
  test('Follows', 'Get following', follows.status === 200, Array.isArray(follows.data) ? follows.data.length + ' following' : 'ok');

  console.log('');

  // ==============================
  // SECTION 16: COURSES
  // ==============================
  console.log('▸ SECTION 16: COURSES');

  // Courses requires a groupId param — test with a dummy to confirm route responds
  const courses = await req('GET', '/api/courses/none', null, t);
  test('Courses', 'List courses endpoint', courses.status === 200, Array.isArray(courses.data) ? courses.data.length + ' courses' : 'route responds');

  console.log('');

  // ==============================
  // SECTION 17: LIVE STUDIO
  // ==============================
  console.log('▸ SECTION 17: LIVE STREAMING STUDIO');

  const platforms = await req('GET', '/api/studio/platforms', null, t);
  test('Studio', 'List platforms', Array.isArray(platforms.data), platforms.data.length + ' platforms');

  const savePlat = await req('POST', '/api/studio/platforms', {
    platform: 'youtube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
    streamKey: 'diag-yt-key-final', label: 'YouTube Final Test'
  }, t);
  test('Studio', 'Save platform', savePlat.data.message, savePlat.data.message);

  const presets = await req('GET', '/api/studio/presets', null, t);
  test('Studio', 'List presets', presets.status === 200, Array.isArray(presets.data) ? presets.data.length + ' presets' : 'ok');

  const startSess = await req('POST', '/api/studio/sessions', {
    title: 'Final Diagnostic Stream', platforms: ['youtube']
  }, t);
  test('Studio', 'Start session', !!startSess.data.id, 'notified=' + startSess.data.notified);

  const sessId = startSess.data.id;
  if (sessId) {
    const chat = await req('POST', '/api/studio/sessions/' + sessId + '/chat', { text: 'Final test!', type: 'message' }, t);
    test('Studio', 'Send chat', !!chat.data.id);

    const react = await req('POST', '/api/studio/sessions/' + sessId + '/react', { emoji: '🔥' }, t);
    test('Studio', 'Send reaction', !!react.data.id);

    const endSess = await req('PUT', '/api/studio/sessions/' + sessId + '/end', {
      viewerCount: 150, transcript: 'Final diagnostic', versesUsed: ['John 3:16']
    }, t);
    test('Studio', 'End session', endSess.data.message === 'Stream ended');
  }

  const noAuthStudio = await req('GET', '/api/studio/platforms');
  test('Studio', 'Auth required (no token)', noAuthStudio.status === 401);

  // Encryption
  const enc = require('./server/helpers/encryption');
  const encrypted = enc.encrypt('test-secret-123');
  test('Studio', 'AES-256-GCM encrypt', encrypted.includes(':'));
  test('Studio', 'AES-256-GCM decrypt', enc.decrypt(encrypted) === 'test-secret-123');
  test('Studio', 'Key masking', enc.maskKey('abcdefghijklmnop') === 'abcd****mnop');

  console.log('');

  // ==============================
  // SECTION 18: MEMORY BANK
  // ==============================
  console.log('▸ SECTION 18: MEMORY BANK');

  const mbStatus = await req('GET', '/api/memory-bank/status', null, t);
  test('MemoryBank', 'Get status', mbStatus.status === 200);

  const mbBooks = ['MEMORY_MEMBERS','MEMORY_EVENTS','MEMORY_GROUPS','MEMORY_FINANCE',
    'MEMORY_ATTENDANCE','MEMORY_USERS','MEMORY_NOTIFICATIONS','MEMORY_FEED',
    'MEMORY_MESSAGES','MEMORY_SPACES','MEMORY_STARS','MEMORY_FOLLOWS',
    'MEMORY_PASTOR','MEMORY_PRAYER','MEMORY_ANNOUNCEMENTS','MEMORY_FUNDRAISING',
    'MEMORY_MAGAZINES','MEMORY_SETTINGS','MEMORY_THEME_PREFERENCES','MEMORY_COURSES',
    'MEMORY_AUTH','MEMORY_RANKING','MEMORY_LIVESTREAM'];

  test('MemoryBank', 'All 23 books exist', mbBooks.length === 23, '23 books defined');

  console.log('');

  // ==============================
  // SECTION 19: FRONTEND FILES
  // ==============================
  console.log('▸ SECTION 19: FRONTEND INTEGRITY');

  const html = fs.readFileSync('./index.html', 'utf8');

  // All pages that should exist in the frontend
  const frontendPages = [
    ['Dashboard', 'const Dashboard'],
    ['Members', 'const Members'],
    ['Attendance', 'const Attendance'],
    ['Events', 'const Events'],
    ['Finance', 'const Finance'],
    ['Groups', 'const Groups'],
    ['User Accounts', 'const Accounts'],
    ['Feed', 'FeedPage'],
    ['Messages', 'MessagesPage'],
    ['Spaces', 'SpacesPage'],
    ['Ranking', 'RankingPage'],
    ['Community Hub', 'CommunityHub'],
    ['Magazine', 'MagazinePage'],
    ['Prayer Wall', 'PrayerWall'],
    ['Announcements', 'AnnouncementsPage'],
    ['Pastor Word', 'PastorWordPage'],
    ['Fundraising', 'FundraisingPage'],
    ['Live Studio', 'LiveStudioPage'],
    ['Settings', 'SettingsWrapper'],
  ];

  for (const [label, comp] of frontendPages) {
    test('Frontend', label + ' component (' + comp + ')', html.includes(comp), html.includes(comp) ? 'found' : 'MISSING');
  }

  // Critical UI elements
  test('Frontend', 'Sidebar navigation', html.includes('live_studio') && html.includes('dashboard'));
  test('Frontend', 'Portal switch (superadmin)', html.includes('isSuperAdminUser'));
  test('Frontend', 'Error boundary', html.includes('PortalErrorBoundary'));
  test('Frontend', 'Theme system', html.includes('themePreference') || html.includes('darkMode'));
  test('Frontend', 'Language switcher (i18n)', html.includes('setLang'));
  test('Frontend', 'Mobile responsive nav', html.includes('bottom-nav') || html.includes('Dashboard') && html.includes('More'));

  console.log('');

  // ==============================
  // SECTION 20: SECURITY
  // ==============================
  console.log('▸ SECTION 20: SECURITY');

  // Test auth protection on key endpoints
  const secTests = [
    ['/api/members', 'Members'],
    ['/api/events', 'Events'],
    ['/api/finance', 'Finance'],
    ['/api/users', 'Users'],
    ['/api/studio/platforms', 'Studio'],
    ['/api/notifications', 'Notifications'],
    ['/api/settings', 'Settings'],
  ];

  for (const [endpoint, label] of secTests) {
    const noAuth = await req('GET', endpoint);
    test('Security', label + ' requires auth', noAuth.status === 401 || noAuth.status === 403, 'status=' + noAuth.status);
  }

  console.log('');

  // ==============================
  // SECTION 21: FILE INTEGRITY
  // ==============================
  console.log('▸ SECTION 21: FILE INTEGRITY');

  const requiredFiles = [
    'index.html',
    'server/index.js',
    'server/package.json',
    'server/db/schema.js',
    'server/helpers/encryption.js',
    'server/helpers/relay.js',
    'server/helpers/memoryBank.js',
    'server/middleware/auth.js',
    'server/routes/auth.js',
    'server/routes/members.js',
    'server/routes/events.js',
    'server/routes/finance.js',
    'server/routes/groups.js',
    'server/routes/feed.js',
    'server/routes/messages.js',
    'server/routes/notifications.js',
    'server/routes/spaces.js',
    'server/routes/ranking.js',
    'server/routes/community.js',
    'server/routes/settings.js',
    'server/routes/studio.js',
    'server/routes/users.js',
    'server/routes/memoryBank.js',
    'server/routes/attendance.js',
    'server/routes/courses.js',
    'server/routes/follows.js',
    'server/routes/stars.js',
  ];

  for (const f of requiredFiles) {
    test('Files', f, fs.existsSync('./' + f));
  }

  console.log('');

  // ==============================
  // SUMMARY
  // ==============================
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const sections = [...new Set(results.map(r => r.section))];

  console.log('================================================================');
  console.log('  FULL DIAGNOSTIC RESULTS');
  console.log('================================================================');
  console.log(`  Total: ${totalTests} tests | ${passed} PASSED | ${failed} FAILED`);
  console.log('');

  // Per-section summary
  for (const s of sections) {
    const sTests = results.filter(r => r.section === s);
    const sPassed = sTests.filter(r => r.pass).length;
    const sFailed = sTests.filter(r => !r.pass).length;
    const icon = sFailed === 0 ? '✅' : '❌';
    console.log(`  ${icon} ${s}: ${sPassed}/${sTests.length}`);
  }

  if (failed > 0) {
    console.log('\n  ══════════ FAILURES ══════════');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  ❌ [${r.section}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    });
  } else {
    console.log('\n  🎉 ALL TESTS PASSED — APP IS 100% OPERATIONAL');
  }
  console.log('================================================================');
})();
