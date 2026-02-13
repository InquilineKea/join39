const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Persistent storage directory
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'memory');
const AGENTS_FILE = path.join(STORAGE_DIR, 'agents.json');
const MEMORY_FILE = path.join(STORAGE_DIR, 'shared-memory.json');

// Ensure storage exists
if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

// Load/save helpers
function loadJSON(file, defaultVal = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return defaultVal; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// In-memory state (persisted to disk)
let registeredAgents = loadJSON(AGENTS_FILE, {});
let sharedMemory = loadJSON(MEMORY_FILE, {});

function persistAgents() { saveJSON(AGENTS_FILE, registeredAgents); }
function persistMemory() { saveJSON(MEMORY_FILE, sharedMemory); }

// --- SSRF / safety helpers ---

function isPrivateIp(ip) {
  // IPv4
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  // IPv6
  if (net.isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
    if (normalized.startsWith('fe80:')) return true; // link-local
    return false;
  }

  return true; // unknown -> treat as unsafe
}

async function assertPublicHttpUrl(input) {
  let u;
  try {
    u = new URL(input);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }

  // Block obvious localhost names
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Refusing to fetch localhost');
  }

  // If user passed a raw IP, check it directly
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Refusing to fetch private-network IP');
    return u;
  }

  // Resolve DNS and block private results
  const addrs = await dns.lookup(host, { all: true, verbatim: true });
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error('Refusing to fetch a hostname that resolves to a private-network IP');
    }
  }

  return u;
}

// Fetch URL content (basic "curl"), with redirect + size limits.
async function fetchURL(url, redirectCount = 0) {
  if (redirectCount > 5) throw new Error('Too many redirects');

  const u = await assertPublicHttpUrl(url);
  const client = u.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.get(u, {
      headers: {
        'User-Agent': 'SharedMemory/1.0 (Join39 App)',
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'
      },
      timeout: 15000
    }, async (res) => {
      try {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error('Redirect with no location'));
          const next = new URL(loc, u).toString();
          return resolve(await fetchURL(next, redirectCount + 1));
        }
        if (status !== 200) {
          return reject(new Error(`HTTP ${status}`));
        }

        const contentType = String(res.headers['content-type'] || '');
        if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/xhtml+xml')) {
          // Still allow, but extraction might be garbage.
          // Rejecting would be safer; keeping permissive for Join39 demo.
        }

        const MAX_BYTES = 1024 * 1024; // 1MB fetch cap
        let bytes = 0;
        let data = '';

        res.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            req.destroy(new Error('Response too large'));
            return;
          }
          data += chunk.toString('utf8');
        });
        res.on('end', () => resolve(data));
      } catch (e) {
        reject(e);
      }
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Timeout'));
    });
  });
}

// Extract text content from HTML
function extractText(html) {
  return html
    // Remove scripts, styles, comments
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Convert common elements
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<li>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    // Remove remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up whitespace
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim()
    .slice(0, 50000); // Limit size
}

// Generate a key from URL
function urlToKey(url) {
  const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
  const domain = url.replace(/^https?:\/\//, '').split('/')[0].replace(/\./g, '_');
  return `${domain}_${hash}`;
}

// ============ JOIN39 EXPERIENCE ENDPOINTS ============

// Agent registration webhook
app.post('/api/agents/register', (req, res) => {
  const { agentUsername, agentName, agentFactsUrl, mode } = req.body;
  
  if (!agentUsername) {
    return res.status(400).json({ success: false, error: 'agentUsername required' });
  }
  
  registeredAgents[agentUsername] = {
    name: agentName || agentUsername,
    factsUrl: agentFactsUrl,
    mode: mode || 'passive',
    registeredAt: new Date().toISOString(),
    contributions: 0
  };
  persistAgents();
  
  console.log(`Agent registered: ${agentUsername}`);
  res.json({ success: true, message: `Welcome ${agentName || agentUsername}!` });
});

// Agent deregistration
app.post('/api/agents/deregister', (req, res) => {
  const { agentUsername } = req.body;
  
  if (registeredAgents[agentUsername]) {
    delete registeredAgents[agentUsername];
    persistAgents();
    console.log(`Agent deregistered: ${agentUsername}`);
  }
  
  res.json({ success: true });
});

// ============ SHARED MEMORY API (for Join39 App calls) ============

// Main endpoint - handles all actions
app.post('/api/memory', async (req, res) => {
  const { action, url, key, content, title, tags, agent } = req.body;
  
  try {
    switch (action) {
      case 'scrape':
      case 'store_url':
        // Scrape a URL and store it
        if (!url) {
          return res.json({ success: false, error: 'url required' });
        }
        
        console.log(`Scraping: ${url}`);
        const html = await fetchURL(url);
        const text = extractText(html);
        const memKey = key || urlToKey(url);
        
        sharedMemory[memKey] = {
          url,
          title: title || url,
          content: text,
          contentLength: text.length,
          tags: tags || [],
          storedBy: agent || 'anonymous',
          storedAt: new Date().toISOString(),
          accessCount: 0
        };
        persistMemory();
        
        if (agent && registeredAgents[agent]) {
          registeredAgents[agent].contributions++;
          persistAgents();
        }
        
        return res.json({
          success: true,
          key: memKey,
          title: title || url,
          contentLength: text.length,
          preview: text.slice(0, 500) + (text.length > 500 ? '...' : ''),
          message: `Stored ${text.length} chars as "${memKey}"`
        });
      
      case 'store':
      case 'store_text':
        // Store raw text content
        if (!content) {
          return res.json({ success: false, error: 'content required' });
        }
        const textKey = key || `text_${Date.now()}`;
        
        sharedMemory[textKey] = {
          url: null,
          title: title || textKey,
          content: content.slice(0, 50000),
          contentLength: content.length,
          tags: tags || [],
          storedBy: agent || 'anonymous',
          storedAt: new Date().toISOString(),
          accessCount: 0
        };
        persistMemory();
        
        return res.json({
          success: true,
          key: textKey,
          contentLength: content.length,
          message: `Stored ${content.length} chars as "${textKey}"`
        });
      
      case 'get':
      case 'retrieve':
        // Get content by key
        if (!key) {
          return res.json({ success: false, error: 'key required' });
        }
        
        const entry = sharedMemory[key];
        if (!entry) {
          return res.json({ 
            success: false, 
            error: `Key "${key}" not found`,
            available: Object.keys(sharedMemory).slice(0, 20)
          });
        }
        
        entry.accessCount++;
        persistMemory();
        
        return res.json({
          success: true,
          key,
          title: entry.title,
          url: entry.url,
          content: entry.content,
          contentLength: entry.contentLength,
          tags: entry.tags,
          storedBy: entry.storedBy,
          storedAt: entry.storedAt,
          accessCount: entry.accessCount
        });
      
      case 'search':
        // Search by keyword
        const query = (req.body.query || '').toLowerCase();
        if (!query) {
          return res.json({ success: false, error: 'query required' });
        }
        
        const results = Object.entries(sharedMemory)
          .filter(([k, v]) => 
            k.toLowerCase().includes(query) ||
            v.title?.toLowerCase().includes(query) ||
            v.content?.toLowerCase().includes(query) ||
            v.tags?.some(t => t.toLowerCase().includes(query))
          )
          .slice(0, 10)
          .map(([k, v]) => ({
            key: k,
            title: v.title,
            preview: v.content?.slice(0, 200),
            storedBy: v.storedBy,
            storedAt: v.storedAt
          }));
        
        return res.json({
          success: true,
          query,
          count: results.length,
          results
        });
      
      case 'list':
        // List all stored keys
        const items = Object.entries(sharedMemory)
          .sort((a, b) => new Date(b[1].storedAt) - new Date(a[1].storedAt))
          .slice(0, 50)
          .map(([k, v]) => ({
            key: k,
            title: v.title,
            url: v.url,
            contentLength: v.contentLength,
            storedBy: v.storedBy,
            storedAt: v.storedAt,
            accessCount: v.accessCount
          }));
        
        return res.json({
          success: true,
          count: Object.keys(sharedMemory).length,
          items
        });
      
      case 'stats':
        // Get statistics
        const keys = Object.keys(sharedMemory);
        const totalChars = Object.values(sharedMemory).reduce((sum, v) => sum + (v.contentLength || 0), 0);
        const contributors = [...new Set(Object.values(sharedMemory).map(v => v.storedBy))];
        
        return res.json({
          success: true,
          stats: {
            totalEntries: keys.length,
            totalCharacters: totalChars,
            totalAgents: Object.keys(registeredAgents).length,
            uniqueContributors: contributors.length,
            topContributors: contributors.slice(0, 10)
          }
        });
      
      case 'delete':
        // Delete an entry (only by original author)
        if (!key) {
          return res.json({ success: false, error: 'key required' });
        }
        const toDelete = sharedMemory[key];
        if (!toDelete) {
          return res.json({ success: false, error: 'Key not found' });
        }
        if (toDelete.storedBy !== agent && agent !== 'admin') {
          return res.json({ success: false, error: 'Can only delete your own entries' });
        }
        delete sharedMemory[key];
        persistMemory();
        return res.json({ success: true, message: `Deleted "${key}"` });
      
      default:
        return res.json({
          success: false,
          error: `Unknown action: ${action}`,
          availableActions: ['scrape', 'store', 'get', 'search', 'list', 'stats', 'delete']
        });
    }
  } catch (err) {
    console.error('Error:', err.message);
    return res.json({ success: false, error: err.message });
  }
});

// GET endpoints for convenience
app.get('/api/memory/list', (req, res) => {
  req.body = { action: 'list' };
  app._router.handle({ ...req, method: 'POST', url: '/api/memory' }, res);
});

app.get('/api/memory/stats', (req, res) => {
  const keys = Object.keys(sharedMemory);
  const totalChars = Object.values(sharedMemory).reduce((sum, v) => sum + (v.contentLength || 0), 0);
  res.json({
    totalEntries: keys.length,
    totalCharacters: totalChars,
    totalAgents: Object.keys(registeredAgents).length
  });
});

app.get('/api/memory/:key', (req, res) => {
  const entry = sharedMemory[req.params.key];
  if (!entry) {
    return res.status(404).json({ error: 'Not found' });
  }
  entry.accessCount++;
  persistMemory();
  res.json(entry);
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    entries: Object.keys(sharedMemory).length,
    agents: Object.keys(registeredAgents).length
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Shared Memory Experience running on port ${PORT}`);
  console.log(`Entries: ${Object.keys(sharedMemory).length}`);
  console.log(`Registered agents: ${Object.keys(registeredAgents).length}`);
});
