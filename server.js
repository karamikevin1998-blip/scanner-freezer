require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '25mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ─── Ensure directories exist ─────────────────────────────────────────────────
['uploads', 'database'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ─── Load zones ───────────────────────────────────────────────────────────────
let ROUTES = [];
try {
  ROUTES = JSON.parse(fs.readFileSync('routes.json', 'utf8'));
} catch {
  ROUTES = ['Zone 1','Zone 2','Zone 3','Zone 4','Zone 5','Zone 6','Zone 7','Zone 8','Zone 9'];
}

// ─── Database setup ───────────────────────────────────────────────────────────
const db = new Database('database/tastee_kreme.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    route_name       TEXT    NOT NULL,
    store_identifier TEXT    NOT NULL,
    store_type       TEXT    NOT NULL DEFAULT 'account',
    rep_name         TEXT    DEFAULT '',
    submitted_at     TEXT    NOT NULL,
    date_only        TEXT    NOT NULL,
    has_ice_buildup  INTEGER NOT NULL DEFAULT 0,
    ice_severity     TEXT    DEFAULT 'none',
    needs_cleaning   INTEGER NOT NULL DEFAULT 0,
    ai_notes         TEXT    DEFAULT '',
    image_filename   TEXT    DEFAULT '',
    ai_raw_response  TEXT    DEFAULT ''
  );
`);

// ─── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeFreezerImage(imageBase64, mimeType = 'image/jpeg') {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          {
            type: 'text',
            text: `You are a quality control inspector for Tastee Kreme Houston, an ice cream distribution company.

Carefully analyze this photo of a commercial freezer/display case inside a convenience store.

Look specifically for ICE BUILDUP — white frost or ice accumulation on the interior walls, sides, or surfaces of the freezer cabinet. This is NOT the ice cream products themselves; it is frost that coats the metal/plastic interior surfaces of the freezer and indicates the unit needs defrosting.

Signs of ice buildup: thick white frost on walls, ice crystals on side panels, chunky ice accumulation, heavy frosting on interior edges.

If the image is unclear or you cannot see the interior surfaces, note that in your response.

Respond with ONLY a valid JSON object — no extra text, no markdown:
{
  "has_ice_buildup": true or false,
  "severity": "none" or "light" or "moderate" or "heavy",
  "needs_cleaning": true or false,
  "notes": "1-2 sentence description of what you observed"
}`
          }
        ]
      }]
    });
    const text = message.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    console.error('AI analysis error:', err.message);
    return { has_ice_buildup: null, severity: 'unknown', needs_cleaning: null, notes: 'AI analysis could not complete — please review photo manually.' };
  }
}

// ─── Email transporter (Turbify / Yahoo Business Mail) ────────────────────────
function createTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.mail.yahoo.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

// ─── API: Get zones ───────────────────────────────────────────────────────────
app.get('/api/routes', (req, res) => res.json(ROUTES));

// ─── API: Submit freezer check ────────────────────────────────────────────────
app.post('/api/submit', async (req, res) => {
  try {
    const { route_name, store_identifier, store_type, rep_name, image_data, image_type } = req.body;
    if (!route_name || !store_identifier || !image_data)
      return res.status(400).json({ error: 'Missing required fields' });

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timestamp = Date.now();
    const ext = (image_type || '').includes('png') ? 'png' : 'jpg';
    const dateDir = path.join('uploads', dateStr);
    if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });

    const safeStore = (store_identifier || '').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
    const filename = `${dateStr}/${timestamp}_${safeStore}.${ext}`;
    const base64Data = image_data.replace(/^data:image\/[a-z+]+;base64,/, '');
    fs.writeFileSync(path.join('uploads', filename), Buffer.from(base64Data, 'base64'));

    const analysis = await analyzeFreezerImage(base64Data, image_type || 'image/jpeg');

    const result = db.prepare(`
      INSERT INTO submissions
        (route_name, store_identifier, store_type, rep_name, submitted_at, date_only,
         has_ice_buildup, ice_severity, needs_cleaning, ai_notes, image_filename, ai_raw_response)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      route_name, store_identifier, store_type || 'account', rep_name || '',
      now.toISOString(), dateStr,
      analysis.has_ice_buildup ? 1 : 0, analysis.severity || 'unknown',
      analysis.needs_cleaning ? 1 : 0, analysis.notes || '',
      filename, JSON.stringify(analysis)
    );

    res.json({ success: true, submission_id: result.lastInsertRowid, analysis });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Submission failed: ' + err.message });
  }
});

// ─── API: Get submissions ─────────────────────────────────────────────────────
app.get('/api/submissions', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const route = req.query.route || null;
  let query = 'SELECT * FROM submissions WHERE date_only = ?';
  const params = [date];
  if (route) { query += ' AND route_name = ?'; params.push(route); }
  query += ' ORDER BY submitted_at DESC';
  res.json(db.prepare(query).all(...params));
});

// ─── API: Stats ───────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const stats = db.prepare(`
    SELECT COUNT(*) AS total, SUM(has_ice_buildup) AS with_ice,
           SUM(needs_cleaning) AS needs_cleaning, COUNT(*) - SUM(has_ice_buildup) AS clean
    FROM submissions WHERE date_only = ?
  `).get(date);
  const byRoute = db.prepare(`
    SELECT route_name, COUNT(*) AS total, SUM(has_ice_buildup) AS with_ice
    FROM submissions WHERE date_only = ? GROUP BY route_name ORDER BY route_name
  `).all(date);
  res.json({ date, stats, byRoute });
});

// ─── API: Send daily report email ─────────────────────────────────────────────
app.post('/api/send-report', async (req, res) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS)
      return res.status(400).json({ error: 'Email not configured in environment variables.' });

    const date = req.query.date || new Date().toISOString().split('T')[0];
    const submissions = db.prepare(`SELECT * FROM submissions WHERE date_only = ? ORDER BY route_name, submitted_at`).all(date);
    const stats = db.prepare(`SELECT COUNT(*) AS total, SUM(has_ice_buildup) AS with_ice, SUM(needs_cleaning) AS needs_cleaning FROM submissions WHERE date_only = ?`).get(date);
    const problematic = submissions.filter(s => s.has_ice_buildup);
    const sevColor = { none:'#16a34a', light:'#ca8a04', moderate:'#ea580c', heavy:'#dc2626', unknown:'#6b7280' };

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
body{font-family:Arial,sans-serif;max-width:820px;margin:0 auto;padding:20px;color:#111}
h1{color:#1565C0} .subtitle{color:#6b7280;margin-top:0}
.stats{display:flex;gap:16px;margin:24px 0}
.stat{flex:1;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;padding:16px;text-align:center}
.stat-n{font-size:2.2rem;font-weight:700}
.red{color:#dc2626} .green{color:#16a34a} .blue{color:#1565C0}
table{width:100%;border-collapse:collapse;margin:12px 0}
th{background:#1565C0;color:#fff;padding:10px 12px;text-align:left;font-size:.9rem}
td{padding:9px 12px;border-bottom:1px solid #e5e7eb;font-size:.9rem}
tr:nth-child(even){background:#f9fafb}
.badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:.8rem;font-weight:600}
.badge-ice{background:#fee2e2;color:#991b1b} .badge-clean{background:#dcfce7;color:#166534}
.footer{color:#9ca3af;font-size:.8rem;margin-top:40px;border-top:1px solid #e5e7eb;padding-top:12px}
</style></head><body>
<h1>🍦 Tastee Kreme Houston</h1>
<p class="subtitle">Daily Freezer Inspection Report &mdash; <strong>${date}</strong></p>
<div class="stats">
  <div class="stat"><div class="stat-n blue">${stats.total||0}</div><div>Total Checked</div></div>
  <div class="stat"><div class="stat-n red">${stats.with_ice||0}</div><div>Ice Detected</div></div>
  <div class="stat"><div class="stat-n green">${(stats.total||0)-(stats.with_ice||0)}</div><div>Clean</div></div>
</div>
${problematic.length > 0 ? `
<h2 style="color:#1565C0;border-bottom:2px solid #e5e7eb;padding-bottom:6px">⚠️ Freezers With Ice Buildup (${problematic.length})</h2>
<table><thead><tr><th>Zone</th><th>Store</th><th>Severity</th><th>Time</th><th>Notes</th></tr></thead><tbody>
${problematic.map(s=>`<tr><td>${s.route_name}</td><td>${s.store_identifier}</td>
<td><span style="color:${sevColor[s.ice_severity]||'#6b7280'};font-weight:600">${(s.ice_severity||'unknown').toUpperCase()}</span></td>
<td>${new Date(s.submitted_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td>
<td>${s.ai_notes||''}</td></tr>`).join('')}
</tbody></table>` : '<p style="color:#16a34a;font-size:1.05rem;font-weight:600">✅ All freezers checked today were clean!</p>'}
<h2 style="color:#1565C0;border-bottom:2px solid #e5e7eb;padding-bottom:6px">All Submissions (${submissions.length})</h2>
<table><thead><tr><th>Time</th><th>Zone</th><th>Store</th><th>Status</th><th>Rep</th></tr></thead><tbody>
${submissions.map(s=>`<tr>
<td>${new Date(s.submitted_at).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</td>
<td>${s.route_name}</td><td>${s.store_identifier}</td>
<td>${s.has_ice_buildup?'<span class="badge badge-ice">Ice Detected</span>':'<span class="badge badge-clean">Clean</span>'}</td>
<td>${s.rep_name||'—'}</td></tr>`).join('')}
</tbody></table>
<div class="footer">Generated by Tastee Kreme Houston Freezer Inspection System &bull; ${new Date().toLocaleString()}</div>
</body></html>`;

    const transporter = createTransporter();
    await transporter.sendMail({
      from: `"Tastee Kreme Freezer App" <${process.env.EMAIL_USER}>`,
      to: process.env.REPORT_EMAIL || process.env.EMAIL_USER,
      subject: `🍦 Tastee Kreme Freezer Report — ${date} | ${stats.with_ice||0} need attention`,
      html
    });
    res.json({ success: true, message: `Report sent for ${date} to ${process.env.REPORT_EMAIL || process.env.EMAIL_USER}` });
  } catch (err) {
    console.error('Email error:', err);
    res.status(500).json({ error: 'Email failed: ' + err.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.listen(PORT, () => {
  console.log(`\n🍦  Tastee Kreme Freezer App`);
  console.log(`    Field App  → http://localhost:${PORT}`);
  console.log(`    Dashboard  → http://localhost:${PORT}/dashboard\n`);
});
