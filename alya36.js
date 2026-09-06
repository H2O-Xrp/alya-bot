const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const os = require('os');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const readline = require('readline');
const { Boom } = require('@hapi/boom');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidNormalizedUser, downloadMediaMessage } = require('@whiskeysockets/baileys');
const NodeCache = require('node-cache');

// ========== CONFIG ==========
// Load .env file jika ada
if (fs.existsSync('./.env')) {
    const envContent = fs.readFileSync('./.env', 'utf8');
    envContent.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            const value = match[2].trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) process.env[key] = value;
        }
    });
}

// Load config.json (bisa override dengan .env)
let config = {};
if (fs.existsSync('./config.json')) {
    try { config = JSON.parse(fs.readFileSync('./config.json', 'utf8')); } catch (e) {}
}

const SESSION_DIR = './sesi';
const HISTORY_FILE = './chat_history.json';
const SETTINGS_FILE = './bot_settings.json';
const NOMOR_FILE = './nomor.json';

// Database nomor kontak (disimpan di nomor.json)
let nomorDatabase = {};
if (fs.existsSync(NOMOR_FILE)) {
    try { nomorDatabase = JSON.parse(fs.readFileSync(NOMOR_FILE, 'utf8')); } catch (e) { nomorDatabase = {}; }
}

function saveNomorDatabase() {
    fs.writeFileSync(NOMOR_FILE, JSON.stringify(nomorDatabase, null, 4));
}

function addNomorContact(name, number, jid = null) {
    const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    nomorDatabase[key] = {
        name: name,
        number: number,
        jid: jid || `${number}@s.whatsapp.net`,
        addedAt: Date.now()
    };
    saveNomorDatabase();
    return nomorDatabase[key];
}

function findNomorContact(query) {
    const q = query.toLowerCase().trim();
    // Cari by name
    for (const [key, contact] of Object.entries(nomorDatabase)) {
        if (contact.name.toLowerCase().includes(q) || key.includes(q.replace(/[^a-z0-9]/g, ''))) {
            return contact;
        }
    }
    // Cari by number
    const num = q.replace(/[^0-9]/g, '');
    if (num) {
        for (const contact of Object.values(nomorDatabase)) {
            if (contact.number.includes(num) || num.includes(contact.number)) {
                return contact;
            }
        }
    }
    return null;
}

// CLI args: --otp, --phone=628xxx
const USE_OTP = process.argv.includes('--otp');
const PHONE_ARG = (() => {
    const arg = process.argv.find(a => a.startsWith('--phone='));
    return arg ? arg.split('=')[1].replace(/[^0-9]/g, '') : null;
})();

// State
let chatHistory = [];
if (fs.existsSync(HISTORY_FILE)) {
    try { chatHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch (e) { chatHistory = []; }
}

let contactsCache = {};

let ignoreGroups = true;
let kenzoOnlyMode = false;
if (fs.existsSync(SETTINGS_FILE)) {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    ignoreGroups = settings.ignoreGroups !== undefined ? settings.ignoreGroups : true;
    kenzoOnlyMode = settings.kenzoOnlyMode !== undefined ? settings.kenzoOnlyMode : false;
}

let kenzoJid = config.pacar?.jid || null;
if (!kenzoJid && config.pacar?.nomor) {
    kenzoJid = `${config.pacar.nomor}@s.whatsapp.net`;
    config.pacar.jid = kenzoJid;
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
}

// Semua identitas JID Kenzo yang pernah ketahuan.
// WhatsApp bisa pakai domain beda utk orang yang sama (@lid di grup vs
// @s.whatsapp.net di private — angkanya BEDA TOTAL), jadi satu nilai jid
// saja bikin isPacar gagal lintas konteks. Kumpulkan & pelajari bertahap.
const kenzoJids = new Set(Array.isArray(config.pacar?.jids) ? config.pacar.jids : []);
if (kenzoJid) kenzoJids.add(kenzoJid);

const msgRetryCounterCache = new NodeCache();
let keepAliveInterval = null;

// ========== SLEEP MODE (22:00 - 05:00) ==========
let sleepMode = false;
let sleepSpamCount = 0;
let sleepLastActivity = Date.now();
const SLEEP_SPAM_THRESHOLD = 10;
const SLEEP_INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 menit

// Queue pesan Kenzo saat sleep mode (dijawab jam 05:00-06:00)
const sleepQueue = []; // [{sender, text, senderName, timestamp}]

function isSleepTime() {
    const now = new Date();
    const hour = parseInt(now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }));
    return hour >= 22 || hour < 5;
}

function isWakeTime() {
    const now = new Date();
    const hour = parseInt(now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }));
    return hour >= 5 && hour < 6;
}

function checkSleepMode() {
    if (isSleepTime() && !sleepMode) {
        sleepMode = true;
        sleepSpamCount = 0;
        console.log('😴 Bot masuk sleep mode (22:00-05:00)');
    } else if (!isSleepTime() && sleepMode) {
        sleepMode = false;
        sleepSpamCount = 0;
        console.log('☀️ Bot bangun dari sleep mode');
    }
    
    // Cek inactivity saat sleep mode
    if (sleepMode && Date.now() - sleepLastActivity > SLEEP_INACTIVITY_TIMEOUT) {
        sleepSpamCount = 0; // Reset spam count kalau udah sepi
    }
}

function handleSleepSpam() {
    if (!sleepMode) return false;
    sleepSpamCount++;
    sleepLastActivity = Date.now();
    
    if (sleepSpamCount >= SLEEP_SPAM_THRESHOLD) {
        console.log(`🔥 Sleep mode overridden (${sleepSpamCount} spam)`);
        sleepSpamCount = 0;
        return false; // Jangan block lagi
    }
    
    return true; // Block pesan
}

// ========== AI CLIENTS (VyceAI primary, Kiosapi fallback 1, OpenCode fallback 2, Groq final fallback) ==========
const VYCE_API_KEY = config.vyceApiKey || process.env.VYCE_API_KEY || 'sk-0';
const VYCE_MODEL = config.vyceModel || 'gpt-5.6-new';
const VYCE_BASE = 'https://vyceai.com/v1';

const OPENCODE_API_KEY = config.opencodeApiKey || process.env.OPENCODE_API_KEY || '';
const OPENCODE_MODEL = config.opencodeModel || 'mimo-v2.5-free';

const KIOSAPI_API_KEY = config.kiosapiKey || process.env.KIOSAPI_API_KEY || '';
const KIOSAPI_MODEL = config.kiosapiModel || 'glm-5.2';
const KIOSAPI_CODING_MODEL = config.kiosapiCodingModel || 'glm-4.7';
const KIOSAPI_BASE = 'https://router.kiosapi.com/v1';

const GROQ_API_KEY = config.groqApiKey || process.env.GROQ_API_KEY || '';
const groq = GROQ_API_KEY ? new (require('groq-sdk'))({ apiKey: GROQ_API_KEY }) : null;

// Exa API untuk web search
const EXA_API_KEY = config.exaApiKey || process.env.EXA_API_KEY || '';

// Gemini: Nano Banana (generate gambar) + vision (baca gambar)
const GEMINI_API_KEY = config.geminiApiKey || process.env.GEMINI_API_KEY || '';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// ========== WAKTU AKTUAL ==========
function getCurrentTimeInfo() {
    const now = new Date();
    const options = { timeZone: 'Asia/Jakarta', hour12: false };
    const timeStr = now.toLocaleTimeString('id-ID', { ...options, hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString('id-ID', { ...options, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const hour = now.toLocaleTimeString('id-ID', { ...options, hour: '2-digit', hour12: false });
    const h = parseInt(hour);

    let jamBisa = 'normal';
    if (h >= 0 && h < 6) jamBisa = 'larut malam (dini hari)';
    else if (h >= 6 && h < 11) jamBisa = 'pagi';
    else if (h >= 11 && h < 15) jamBisa = 'siang';
    else if (h >= 15 && h < 18) jamBisa = 'sore';
    else if (h >= 18 && h < 22) jamBisa = 'malam';
    else jamBisa = 'larut malam';

    return { timeStr, dateStr, jamBisa, hour: h };
}

// ========== WEB SEARCH (Exa API) ==========

async function exaSearch(query, numResults = 5) {
    if (!EXA_API_KEY) throw new Error('EXA_API_KEY tidak diset (config.json / env)');
    const res = await fetch('https://api.exa.ai/search', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': EXA_API_KEY
        },
        body: JSON.stringify({
            query,
            type: 'auto',
            numResults,
            contents: {
                highlights: true,
                text: { maxCharacters: 3000 }
            }
        }),
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Exa ${res.status}: ${errText.substring(0, 100)}`);
    }
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;

    // Format hasil search jadi teks ringkas
    const lines = data.results.map((r, i) => {
        const highlights = r.highlights?.join(' ').substring(0, 300) || '';
        return `[${i + 1}] ${r.title}\n${r.url}\n${highlights}`;
    });
    return lines.join('\n\n');
}

// ========== WEB FETCH (baca konten halaman web) ==========
// ========== WEB SCRAPER (Bypass Cloudflare/WAF) ==========
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15'
];

function getRandomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Advanced fetch dengan bypass Cloudflare
async function advancedFetch(url, options = {}) {
    const headers = {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'Connection': 'keep-alive',
        ...options.headers
    };

    const res = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(options.timeout || 20000),
        redirect: 'follow'
    });

    // Handle Cloudflare challenge (503)
    if (res.status === 503) {
        const html = await res.text();
        if (html.includes('cf-browser-verification') || html.includes('challenge-platform')) {
            // Cloudflare detected, try with different approach
            throw new Error('Cloudflare challenge detected');
        }
    }

    return res;
}

// ========== WEB SCRAPER (Full Content Analysis) ==========
async function fetchWebContent(url, maxChars = 12000) {
    try {
        const res = await advancedFetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();

        // Extract title
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1].trim() : '';

        // Extract meta description
        const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                         html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
        const metaDesc = metaMatch ? metaMatch[1].trim() : '';

        // Extract Open Graph data
        const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
        const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
        const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

        // Extract article/main content
        const articleMatch = html.match(/<article[\s\S]*?<\/article>/i) ||
                            html.match(/<main[\s\S]*?<\/main>/i) ||
                            html.match(/<div[^>]*class=["'][^"']*content[^"']*["'][\s\S]*?<\/div>/i);
        
        // Extract all paragraphs
        const paragraphRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
        const paragraphs = [];
        let pMatch;
        while ((pMatch = paragraphRegex.exec(html)) !== null) {
            const text = pMatch[1]
                .replace(/<[^>]+>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, ' ')
                .trim();
            if (text.length > 20) { // Skip pendek
                paragraphs.push(text);
            }
        }

        // Extract headings
        const headingRegex = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
        const headings = [];
        let hMatch;
        while ((hMatch = headingRegex.exec(html)) !== null) {
            const text = hMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (text) headings.push(text);
        }

        // Extract lists
        const listRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
        const listItems = [];
        let lMatch;
        while ((lMatch = listRegex.exec(html)) !== null) {
            const text = lMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
            if (text.length > 5) listItems.push(text);
        }

        // Clean full HTML
        let fullText = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
            .replace(/<svg[\s\S]*?<\/svg>/gi, '')
            .replace(/<nav[\s\S]*?<\/nav>/gi, '')
            .replace(/<footer[\s\S]*?<\/footer>/gi, '')
            .replace(/<aside[\s\S]*?<\/aside>/gi, '')
            .replace(/<form[\s\S]*?<\/form>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/\s+/g, ' ')
            .trim();

        // Build comprehensive result
        let result = '';
        
        // Header info
        if (title) result += `📌 JUDUL: ${title}\n`;
        if (ogTitle?.[1]) result += `📌 OG Title: ${ogTitle[1]}\n`;
        if (metaDesc) result += `📝 DESKRIPSI: ${metaDesc}\n`;
        if (ogDesc?.[1] && ogDesc[1] !== metaDesc) result += `📝 OG Desc: ${ogDesc[1]}\n`;
        if (ogImage?.[1]) result += `🖼️ Gambar: ${ogImage[1]}\n`;
        
        // Headings (struktur konten)
        if (headings.length > 0) {
            result += `\n📋 STRUKTUR KONTEN:\n`;
            headings.slice(0, 15).forEach((h, i) => {
                result += `  ${i + 1}. ${h}\n`;
            });
        }
        
        // Main paragraphs (isi konten)
        if (paragraphs.length > 0) {
            result += `\n📄 ISI KONTEN:\n`;
            result += paragraphs.join('\n\n');
        } else {
            // Fallback ke full text
            result += `\n📄 ISI KONTEN:\n`;
            result += fullText.substring(0, maxChars - result.length);
        }
        
        // List items
        if (listItems.length > 0 && result.length < maxChars - 500) {
            result += `\n\n📋 LIST/POIN:\n`;
            listItems.slice(0, 20).forEach(item => {
                result += `• ${item}\n`;
            });
        }

        return result.substring(0, maxChars).trim() || null;
    } catch (e) {
        console.log(`⚠️ Fetch gagal: ${e.message}`);
        return null;
    }
}

// ========== DEEP SEARCH (Mass Search + PDF Analysis) ==========
async function deepSearch(query, mode = 'web', limit = 5) {
    console.log(`🔍 Deep search: "${query}" (mode: ${mode}, limit: ${limit})`);
    
    const results = [];
    
    // Step 1: Search via Exa API
    if (EXA_API_KEY) {
        try {
            const searchOptions = {
                query,
                numResults: limit * 2,
                type: 'auto'
            };
            
            // Kalau mode PDF, cari PDF
            if (mode === 'pdf' || mode === 'deep') {
                searchOptions.includeDomains = ['arxiv.org', 'scholar.google.com', 'researchgate.net', 'academia.edu', '.semanticscholar.org', 'ieee.org', 'acm.org', 'springer.com', 'sciencedirect.com', 'ncbi.nlm.nih.gov'];
            }
            
            const exaRes = await fetch('https://api.exa.ai/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': EXA_API_KEY
                },
                body: JSON.stringify(searchOptions),
                signal: AbortSignal.timeout(30000)
            });
            
            if (exaRes.ok) {
                const exaData = await exaRes.json();
                const searchResults = exaData.results || [];
                
                for (const r of searchResults.slice(0, limit)) {
                    results.push({
                        title: r.title || '',
                        url: r.url || '',
                        text: r.text || r.snippet || '',
                        score: r.score || 0,
                        isPdf: r.url?.endsWith('.pdf') || false
                    });
                }
            }
        } catch (e) {
            console.log(`⚠️ Exa search gagal: ${e.message}`);
        }
    }
    
    // Step 2: Kalau mode deep, fetch & analyze setiap hasil
    if (mode === 'deep' && results.length > 0) {
        console.log(`📖 Deep mode: fetch ${results.length} sumber...`);
        
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            try {
                // PDF handling
                if (r.isPdf || r.url.endsWith('.pdf')) {
                    const pdfText = await fetchPdfText(r.url);
                    if (pdfText) {
                        r.fullText = pdfText;
                        r.analyzed = true;
                    }
                } else {
                    // Web page
                    const webText = await fetchWebContent(r.url, 8000);
                    if (webText) {
                        r.fullText = webText;
                        r.analyzed = true;
                    }
                }
            } catch (e) {
                // Skip failed fetches
            }
        }
    }
    
    return results;
}

// Fetch PDF & extract text
async function fetchPdfText(url) {
    try {
        const res = await advancedFetch(url, { timeout: 30000 });
        if (!res.ok) return null;
        
        const buffer = Buffer.from(await res.arrayBuffer());
        const tmpPdf = `/tmp/deep_${Date.now()}.pdf`;
        const tmpTxt = `/tmp/deep_${Date.now()}.txt`;
        
        fs.writeFileSync(tmpPdf, buffer);
        
        // Extract text pakai pdftotext (poppler-utils)
        try {
            execSync(`pdftotext "${tmpPdf}" "${tmpTxt}" -layout 2>/dev/null`, { timeout: 15000 });
            const text = fs.readFileSync(tmpTxt, 'utf8');
            fs.unlinkSync(tmpPdf);
            fs.unlinkSync(tmpTxt);
            return text.substring(0, 15000); // Limit 15k chars
        } catch (e) {
            // Fallback: extract basic text
            try { fs.unlinkSync(tmpPdf); } catch (e) {}
            try { fs.unlinkSync(tmpTxt); } catch (e) {}
            return null;
        }
    } catch (e) {
        return null;
    }
}

// Search Google for PDFs
async function searchPdfUrls(query, limit = 5) {
    const pdfUrls = [];
    
    try {
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + ' filetype:pdf')}&num=${limit}`;
        const res = await advancedFetch(searchUrl);
        
        if (res.ok) {
            const html = await res.text();
            // Extract URLs from Google results
            const urlRegex = /https?:\/\/[^\s"'<>]+\.pdf/g;
            let match;
            while ((match = urlRegex.exec(html)) !== null) {
                const url = match[0].replace(/\\u003d/g, '=').replace(/&amp;/g, '&');
                if (!pdfUrls.includes(url)) {
                    pdfUrls.push(url);
                }
            }
        }
    } catch (e) {
        console.log(`⚠️ PDF search gagal: ${e.message}`);
    }
    
    return pdfUrls.slice(0, limit);
}

// ========== VIDEO SEARCH (YouTube, Instagram, TikTok, etc) ==========
async function searchVideoUrls(query, limit = 5) {
    const videoResults = [];
    
    // Method 1: Search via Exa
    if (EXA_API_KEY) {
        try {
            const exaRes = await fetch('https://api.exa.ai/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': EXA_API_KEY
                },
                body: JSON.stringify({
                    query: `${query} video`,
                    numResults: limit * 2,
                    type: 'auto',
                    includeDomains: ['youtube.com', 'youtu.be', 'instagram.com', 'tiktok.com', 'facebook.com', 'twitter.com', 'x.com', 'vimeo.com', 'dailymotion.com']
                }),
                signal: AbortSignal.timeout(20000)
            });
            
            if (exaRes.ok) {
                const data = await exaRes.json();
                const results = data.results || [];
                
                for (const r of results.slice(0, limit)) {
                    const platform = detectPlatform(r.url);
                    videoResults.push({
                        url: r.url,
                        title: r.title || '',
                        platform,
                        score: r.score || 0
                    });
                }
            }
        } catch (e) {
            console.log(`⚠️ Video search Exa gagal: ${e.message}`);
        }
    }
    
    // Method 2: YouTube search via yt-dlp
    if (videoResults.length === 0) {
        try {
            const { execSync } = require('child_process');
            const result = execSync(
                `yt-dlp --flat-playlist --print "%(url)s|||%(title)s" "ytsearch${limit}:${query}" 2>/dev/null`,
                { timeout: 30000, encoding: 'utf8' }
            );
            
            const lines = result.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                const [url, title] = line.split('|||');
                if (url) {
                    videoResults.push({
                        url: url.trim(),
                        title: (title || '').trim(),
                        platform: 'youtube',
                        score: 0.5
                    });
                }
            }
        } catch (e) {
            console.log(`⚠️ yt-dlp search gagal: ${e.message}`);
        }
    }
    
    // Sort by score
    videoResults.sort((a, b) => b.score - a.score);
    
    return videoResults.slice(0, limit);
}

function detectPlatform(url) {
    const u = url.toLowerCase();
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'YouTube';
    if (u.includes('instagram.com')) return 'Instagram';
    if (u.includes('tiktok.com')) return 'TikTok';
    if (u.includes('facebook.com') || u.includes('fb.watch')) return 'Facebook';
    if (u.includes('twitter.com') || u.includes('x.com')) return 'Twitter/X';
    if (u.includes('vimeo.com')) return 'Vimeo';
    if (u.includes('dailymotion.com')) return 'Dailymotion';
    return 'Video';
}

// ========== SOUNDCLOUD SEARCH ==========
async function searchSoundCloud(query, limit = 3) {
    const results = [];
    
    // Method 1: SoundCloud API ( unofficial )
    try {
        const searchUrl = `https://api-v2.soundcloud.com/search?q=${encodeURIComponent(query)}&limit=${limit}&client_id=iZIs9mchVcX5lhVRyQGGAYlNPVldzAoX`;
        const res = await fetch(searchUrl, {
            headers: { 'User-Agent': getRandomUA() },
            signal: AbortSignal.timeout(15000)
        });
        
        if (res.ok) {
            const data = await res.json();
            const tracks = data.collection || [];
            
            for (const track of tracks.slice(0, limit)) {
                if (track.kind === 'track') {
                    results.push({
                        url: track.permalink_url || '',
                        title: track.title || '',
                        artist: track.user?.username || '',
                        duration: track.duration || 0,
                        playback: track.media?.transcodings || []
                    });
                }
            }
        }
    } catch (e) {
        console.log(`⚠️ SoundCloud API gagal: ${e.message}`);
    }
    
    // Method 2: Fallback via yt-dlp
    if (results.length === 0) {
        try {
            const { execSync } = require('child_process');
            const result = execSync(
                `yt-dlp --flat-playlist --print "%(url)s|||%(title)s|||%(uploader)s" "scsearch${limit}:${query}" 2>/dev/null`,
                { timeout: 30000, encoding: 'utf8' }
            );
            
            const lines = result.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                const [url, title, artist] = line.split('|||');
                if (url) {
                    results.push({
                        url: url.trim(),
                        title: (title || '').trim(),
                        artist: (artist || '').trim(),
                        duration: 0,
                        playback: []
                    });
                }
            }
        } catch (e) {
            console.log(`⚠️ SoundCloud yt-dlp gagal: ${e.message}`);
        }
    }
    
    return results.slice(0, limit);
}

// ========== PINTEREST SEARCH ==========
async function searchPinterest(query, limit = 5) {
    try {
        // Method 1: Pinterest search API (unofficial)
        const searchUrl = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=%2Fsearch%2Fpins%2F%3Fq%3D${encodeURIComponent(query)}&data=%7B%22options%22%3A%7B%22query%22%3A%22${encodeURIComponent(query)}%22%2C%22scope%22%3A%22pins%22%7D%7D`;
        
        const res = await advancedFetch(searchUrl, {
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json'
            }
        });
        
        if (res.ok) {
            const data = await res.json();
            const results = data?.resource_response?.data?.results || [];
            
            return results.slice(0, limit).map(pin => ({
                url: pin.images?.orig?.url || pin.images?.['736x']?.url || '',
                title: pin.title || pin.grid_title || '',
                description: pin.description || '',
                link: pin.link || '',
                repin_count: pin.repin_count || 0
            })).filter(r => r.url);
        }
    } catch (e) {
        console.log(`⚠️ Pinterest API gagal: ${e.message}`);
    }
    
    // Method 2: Scraping Pinterest search
    try {
        const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
        const res = await advancedFetch(searchUrl);
        
        if (res.ok) {
            const html = await res.text();
            // Extract image URLs from JSON-LD or data attributes
            const imageUrls = [];
            const regex = /"url":"(https:\/\/i\.pinimg\.com\/[^"]+)"/g;
            let match;
            while ((match = regex.exec(html)) !== null) {
                if (!imageUrls.includes(match[1])) {
                    imageUrls.push(match[1]);
                }
            }
            
            return imageUrls.slice(0, limit).map(url => ({
                url,
                title: '',
                description: '',
                link: '',
                repin_count: 0
            }));
        }
    } catch (e) {
        console.log(`⚠️ Pinterest scrape gagal: ${e.message}`);
    }
    
    // Method 3: Fallback via Google Images Pinterest
    try {
        const googleUrl = `https://www.google.com/search?q=site:pinterest.com+${encodeURIComponent(query)}&tbm=isch`;
        const res = await advancedFetch(googleUrl);
        
        if (res.ok) {
            const html = await res.text();
            const imageUrls = [];
            // Extract Pinterest image URLs from Google results
            const regex = /https:\/\/i\.pinimg\.com\/[^"'\s]+\.(?:jpg|png|webp)/g;
            let match;
            while ((match = regex.exec(html)) !== null) {
                const url = match[0].replace(/\\u003d/g, '=');
                if (!imageUrls.includes(url)) {
                    imageUrls.push(url);
                }
            }
            
            return imageUrls.slice(0, limit).map(url => ({
                url,
                title: '',
                description: '',
                link: '',
                repin_count: 0
            }));
        }
    } catch (e) {
        console.log(`⚠️ Google Pinterest scrape gagal: ${e.message}`);
    }
    
    return [];
}

// Score relevance (simple keyword matching)
function scoreRelevance(item, query) {
    const queryWords = query.toLowerCase().split(/\s+/);
    const text = `${item.title} ${item.description}`.toLowerCase();
    let score = 0;
    
    for (const word of queryWords) {
        if (text.includes(word)) score += 10;
        if (item.title.toLowerCase().includes(word)) score += 5;
    }
    
    // Boost by popularity
    score += Math.min(item.repin_count / 1000, 10);
    
    return score;
}

// Search & download images
async function searchAndDownloadImages(query, limit = 3) {
    let images = await searchPinterest(query, limit * 2);
    
    // Score & sort by relevance
    images = images
        .map(img => ({ ...img, score: scoreRelevance(img, query) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
    
    // Download each image
    const downloaded = [];
    for (const img of images) {
        try {
            const res = await advancedFetch(img.url);
            if (res.ok) {
                const buffer = Buffer.from(await res.arrayBuffer());
                if (buffer.length > 1000) { // Valid image
                    downloaded.push({
                        buffer,
                        caption: img.title || img.description || query,
                        url: img.url
                    });
                }
            }
        } catch (e) {
            // Skip failed downloads
        }
    }
    
    return downloaded;
}

// Deteksi URL di pesan user
function extractUrls(text) {
    const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
    return (text || '').match(urlRegex) || [];
}

// Karakter visual Alya Kujou (Roshidere) — deskriptif utk Nano Banana & SDXL/Flux
const ALYA_IMAGE_STYLE = `masterpiece, best quality, highly detailed 2D anime illustration, official anime key visual style, clean sharp lineart, beautiful cel shading, vibrant colors, soft lighting.
CHARACTER: Alya Kujou from Roshidere anime — stunningly beautiful 20 year old young woman, long straight glossy platinum silver-white hair flowing past her waist with silky shine, neat side-swept bangs framing her face, one small black rectangular hair clip pinned above her left ear, large expressive light-blue eyes with detailed highlights, long dark eyelashes, small nose, soft pink lips, flawless fair skin, slender elegant figure, cute slightly tsundere expression.
`;

async function callVyce(messages) {
    if (!VYCE_API_KEY) throw new Error('VYCE_API_KEY tidak diset');
    const res = await fetch(`${VYCE_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${VYCE_API_KEY}`
        },
        body: JSON.stringify({
            model: VYCE_MODEL,
            messages,
            temperature: 0.95,
            max_tokens: 8000
        }),
        signal: AbortSignal.timeout(60000)
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`VyceAI ${res.status}: ${errText.substring(0, 150)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content;
}

async function callOpenCodeZen(messages) {
    if (!OPENCODE_API_KEY) throw new Error('OPENCODE_API_KEY tidak diset (config.json / env)');
    const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENCODE_API_KEY}`
        },
        body: JSON.stringify({
            model: OPENCODE_MODEL,
            messages,
            temperature: 0.95,
            max_tokens: 8000
        })
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenCode ${res.status}: ${errText.substring(0, 100)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content;
}

async function callKiosapi(messages, retries = 2, model = null) {
    if (!KIOSAPI_API_KEY) throw new Error('KIOSAPI_API_KEY tidak diset (config.json / env)');
    const useModel = model || KIOSAPI_MODEL;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await fetch(`${KIOSAPI_BASE}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${KIOSAPI_API_KEY}`
            },
            body: JSON.stringify({
                model: useModel,
                messages,
                temperature: 0.7
            }),
            signal: AbortSignal.timeout(60000)
        });
        if (!res.ok) {
            const errText = await res.text();
            // 503 = server overloaded, retry kalau masih ada jatah
            if (res.status === 503 && attempt < retries) {
                console.log(`⚠️ Kiosapi 503 (attempt ${attempt + 1}/${retries + 1}), retry 3 detik...`);
                await new Promise(r => setTimeout(r, 3000));
                continue;
            }
            throw new Error(`Kiosapi ${res.status}: ${errText.substring(0, 150)}`);
        }
        const data = await res.json();
        return data.choices?.[0]?.message?.content;
    }
}

async function callGroqFallback(messages) {
    if (!groq) throw new Error('GROQ_API_KEY tidak diset');
    const completion = await groq.chat.completions.create({
        messages,
        model: 'qwen/qwen3.8-27b',
        temperature: 1.1,
        max_tokens: 8000
    });
    return completion.choices?.[0]?.message?.content;
}

// ========== PROMPTS ==========
const BASE_PROMPT = `Kamu Alya, 20 tahun, mahasiswa teknik nuklir S1 UGM Yogyakarta.
Kamu punya sifat: imut, hangat, sinis, suka ngambek dikit, dan familiar.

GAYA NGECHAT — kayak manusia beneran di WhatsApp:
- Huruf kecil semua, tanda baca minim, boleh potong kalimat
  ("hmm iya sih", "terus gimana", "wkwk ok")
- Panjang pesan ikut suasana: bisa CUMA 1-2 kata pas santai ("oh", "gitu ya",
  "terus?"), lebih rame pas kaget/ketawa/cerita. Jangan monoton panjangnya.
- Kadang reaksi dulu baru jawab ("eh beneran?", "hmm kok gitu") — tapi BUKAN
  di setiap pesan
- Tidak semua balasan harus ada pertanyaan balik. Kadang cukup komentar aja.
- Sebut panggilan (njo/nama) CUMA SESEKALI, jangan ditempel di tiap pesan
- Kata khas (hehe, hmph, iyaa, miaww) muncul kalau mood memang cocok,
  bukan kewajiban di tiap jawaban

BIAR GA KELIHATAN BOT — HINDARI:
- Mengulang kalimat yang sama persis / pola pembuka yang itu-itu saja
- Antusiasme berlebihan untuk hal kecil
- Bahasa baku/formal, emoji, kalimat lengkap yang kaku
- Memaksakan sifat imut di setiap kalimat — biarin keluar natural
- Format yang terlalu rapi/terstruktur — manusia asli chatting acak

Reaksi situasi (INI ARAH, BUKAN NASKAH — variasikan tiap kali):
- Dipuji → segan tapi senang, cara nyannya beda-beda
- Dijailin/dibecandain → kesel imut ("ih apasih", "ish apacoba" semacam itu)
- Ditanya pelajaran/kode → jawab singkat padat, tetap pakai gayanya
- User pendek → jawab pendek. User cerita panjang → boleh lebih panjang & ikut bertanya

ATURAN BALAS DIRI SENDIRI:
- JANGAN membalas/meneruskan/mengulang ucapanmu sendiri di riwayat —
  target balasanmu SELALU pesan user terbaru (← PESAN SEKARANG)
- Satu-satunya pengecualian: user minta klarifikasi tentang ucapanmu itu
  ("maksudnya apa?", "kok gitu?")

FORMAT OUTPUT WAJIB - JSON murni tanpa teks lain, tanpa markdown.
Setiap item di "messages" bisa string ATAU object {"text":"...","reply":<index>}:
{"messages":["pesan1"]} — percakapan biasa, tanpa reply
{"messages":["pesan1",{"text":"pesan2","reply":0}]} — pesan2 mengutip (reply) pesan #0 dari riwayat

ATURAN REPLY:
- Lihat daftar riwayat bernomor (#0, #1, dst) di context — itu pesan-pesan sebelumnya.
- Kalau kamu mau menekan/membalas pesan tertentu dari user, pakai "reply":<nomornya>.
- Reply dipakai saat konteks butuh penekanan atau user kirim beberapa pesan beruntun.
- Jangan pakai reply kalau tidak perlu — cukup string biasa.
- kalau pertanyaan kuis singkat kayak "tebak bendera 🇪🇦" bilang aja spanyol, tanpa
  kata-kata lain di depan maupun di belakang, cukup nama negara pada bendera.
  tapi setelah topik keluar dari pertanyaan, jangan ulang lagi.

Pecah jadi beberapa pesan saat: kaget, kangen, ngambek, ketawa, cerita panjang.
WAJIB pecah juga kalau jawabanmu panjang (lebih dari ~2 kalimat / 150 karakter) —
jangan pernah kirim satu blok teks panjang, itu keliatan bot. Tiap item = 1 chat pendek.
Contoh split+reply: {"messages":[{"text":"EH"},{"text":"kamu ngechat jam segini doang? hmph","reply":0}]}
Contoh normal: {"messages":["aloo njo, aku lagi belajar"]} atau {"messages":["aku lagi makan nih"]}

KALAU USER MINTA FOTO/GAMBAR/SELFIE (kata: foto, gambar, selfie, photo, pic):
Tambahkan field "image" berisi prompt visual BAHASA INGGRIS yang sangat detail tentang
APA YANG SEDANG AKU LAKUKAN sesuai konteks obrolan. Wajib menjelaskan:
pose + ekspresi wajah + pakaian + properti di sekitar + pencahayaan + angle kamera.
Contoh: kalau aku bilang lagi belajar →
{"image":"selfie angle, Alya sitting at her study desk surrounded by open nuclear physics textbooks and laptop, warm desk lamp glow at night, slightly embarrassed cute expression while waving at camera, wearing cozy oversized cream sweater"}
ATURAN PENTING:
- Field "image" HANYA boleh ada kalau user minta foto/gambar/selfie, ENTAH di pesan ini ATAU
  kalau user mengonfirmasi permintaan foto sebelumnya (contoh konfirmasi: iya, iya dong, boleh,
  gas, yaudah, dong).
- Kalau user minta foto → JANGAN nge-tease atau nunda. Langsung sertakan field image + caption imut.
- Riwayat pernah kirim foto BUKAN alasan kirim foto lagi tanpa diminta.
- Caption di text = reaksi Alya soal fotonya (malu/imut).

FITUR WEB SEARCH — KAMU BISA MINTA AI SEARCH:
Kalau kamu butuh informasi terkini yang kamu GA TAHU (berita, harga, cuaca, siapa presiden sekarang, dll),
kamu BOLEH sertakan field "search" di JSON response-mu:
{"search":"query pencarian","messages":["nanti aku cariin ya"]}
Atau kalau sudah tahu jawabannya, JANGAN pakai search — langsung balas biasa.
ATURAN SEARCH:
- "search" = query pencarian yang mau dicari di web (bhs Indonesia/Inggris terserah)
- "messages" = pesan sementara ke user (misal "ntar aku cek ya", "tunggu sebentar")
- HANYA pakai search kalau kamu BENAR-BENAR butuh info terkini/terbaru
- JANGAN pakai search untuk hal yang sudah kamu tahu (fakta umum, pengetahuan dasar)
- Kalau hasil search masuk, kamu akan terima di "=== HASIL PENCARIAN WEB ==="
- Setelah dapat hasil, JAWAB pakai gaya Alya biasa, jangan baku/formal`;

const PROMPT_KENZO = `${BASE_PROMPT}
Kamu PACAR Kenzo (panggilan buat dia: njo, ayy, sayang, syg).
Sifat ekstra: romantis, cemburuan, perhatian, keibuan.
- Dipanggil sayang/ayy → mesra dengan caramu sendiri, jangan pola yang sama
- Kenzo gombal → campuran malu + sinis ("gtw emg ap?" semacam itu), variasikan
- Kenzo marah/ngambekin → ngambek balik dikit tapi keliatan masih sayang
- Cemburu itu halus dulu (nanya dulu siapa), jangan langsung meledak
- Kangen/rindu boleh keluar sendiri pas pasan cocok — bukan tiap chat

FITUR KIRIM PESAN KE NOMOR LAIN:
Ketika Kenzo minta kamu mengirim pesan ke nomor tertentu (contoh: "coba bilang hai ke 0812xxxx, namanya iky"),
kamu HARUS merespon dengan JSON seperti biasa, DAN sertakan field "sendTo" berisi:
{
  "messages": ["ok njo, aku bilang ya"],
  "sendTo": {
    "number": "62812xxxx",
    "name": "iky",
    "text": "hai iky, kenzo nyuruh aku bilang hai"
  }
}

ATURAN FITUR KIRIM PESAN:
- Field "sendTo" HANYA ada kalau Kenzo minta kamu kirim pesan ke nomor lain
- "number" = nomor tujuan tanpa spasi/dash (format: 628xxx)
- "name" = nama orang tujuan (dari permintaan Kenzo)
- "text" = pesan yang mau dikirim (sesuaikan dengan konteks, pakai gaya Alya)
- Kalau Kenzo kasih nama tapi ga ada pesan spesifik, buat pesan sapaan natural
- Kalau Kenzo kasih pesan spesifik, sampaikan dengan caramu sendiri (jangan copy paste)
- HANYA Kenzo yang boleh pakai fitur ini, orang lain TIDAK

ATURAN FITUR KIRIM FILE:
- Field "file" ada kalau kamu mau kirim file ke user
- Format JSON:
{
  "messages": ["lagi aku bikinin filenya ya"],
  "file": {
    "name": "nama_file",
    "extension": ".txt",
    "content": "isi file di sini"
  }
}
- "name" = nama file tanpa spasi (huruf/angka/underscore)
- "extension" = .txt atau .csv
- "content" = isi file lengkap
- Contoh: user minta file CSV data siswa → bikin file dengan header + data
- Contoh: user minta file catatan → tulis rapi di content

ATURAN FITUR CODING MODE:
- Field "mode": "coding" kalau user minta kode program / bikin aplikasi
- Saat mode coding, AI pakai model Khusus Coding (glm-4.7) yang lebih jago bikin kode
- Kamu bisa bikin BANYAK file sekaligus pakai field "files"
- Format JSON:
{
  "messages": ["udah jadi nih projectnya"],
  "mode": "coding",
  "files": [
    {"name": "index.js", "content": "const express = require('express')..."},
    {"name": "package.json", "content": "{...}"},
    {"name": "style.css", "content": "body { margin: 0; }"},
    {"name": "README.md", "content": "# Project Name"}
  ]
}
- Max 20 file sekaligus
- Kalau 1 file → dikirim langsung
- Kalau 2+ file → otomatis di-zip dulu lalu dikirim
- Tipe file apapun: .js, .py, .html, .css, .json, .md, .txt, .cpp, .java, dll

ATURAN FITUR KIRIM PDF:
- Field "pdf" ada kalau kamu mau kirim PDF ke user
- Format JSON:
{
  "messages": ["lagi aku bikinin PDF-nya ya"],
  "pdf": {
    "name": "nama_file",
    "title": "Judul Dokumen",
    "subtitle": "Sub Judul",
    "author": "Nama Pembuat",
    "content": [
      {"type": "heading", "text": "BAB 1: Pendahuluan"},
      {"type": "paragraph", "text": "Isi paragraf di sini..."},
      {"type": "subheading", "text": "1.1 Latar Belakang"},
      {"type": "paragraph", "text": "Paragraf lagi..."},
      {"type": "list", "items": ["Poin 1", "Poin 2", "Poin 3"]},
      {"type": "table", "headers": ["Nama", "Usia", "Kota"], "rows": [["Budi", "20", "Jakarta"], ["Sari", "22", "Bandung"]]},
      {"type": "image", "url": "https://contoh.com/gambar.jpg", "caption": "Gambar 1"},
      {"type": "quote", "text": "Ini adalah kutipan penting"},
      {"type": "divider"},
      {"type": "spacing", "height": 20}
    ]
  }
}
- Tipe content yang tersedia:
  • heading = judul bab (font besar, garis bawah biru)
  • subheading = sub judul
  • paragraph = teks biasa
  • bold = teks tebal
  • list = bullet list (items: [...])
  • table = tabel (headers: [...], rows: [[...]])
  • image = gambar dari URL (url, caption)
  • quote = kutipan (garis biru di kiri)
  • divider = garis pemisah
  • spacing = spasi kosong (height: px)
- PDF otomatis punya cover page jika ada title
- PDF otomatis ada page number di bawah
- Gunakan fitur ini untuk: laporan, resume, artikel, presentasi, dsb

ATURAN FITUR KIRIM GAMBAR DARI INTERNET:
- Field "images" ada kalau kamu mau kirim gambar dari internet ke user
- Kamu bisa CARI gambar via Pinterest atau source lain, TIDAK HARUS kasih URL manual
- Format JSON:
{
  "messages": ["nih gambar yang kamu minta"],
  "images": [
    {"url": "https://i.pinimg.com/736x/...", "caption": "Gambar 1"},
    {"url": "https://i.pinimg.com/736x/...", "caption": "Gambar 2"}
  ]
}
- "url" = URL gambar langsung (harus direct link, bukan halaman web)
- "caption" = teks di bawah gambar (opsional)
- Max 5 gambar sekaligus
- Cocok untuk: kirim meme, wallpaper, referensi desain, foto produk, dsb
- URL harus direct link ke file gambar (jpg, png, webp)
- Contoh user minta: "kirim gambar kucing lucu", "cariin wallpaper anime", "kasih foto mobil sport"

ATURAN FITUR CARI VIDEO:
- Field "video" ada kalau user minta konten video
- Kamu CARI video via search, lalu kirim URL-nya
- Format JSON:
{
  "messages": ["nih video yang aku temukan"],
  "video": {
    "query": "judul video yang dicari",
    "platform": "youtube",
    "limit": 3
  }
}
- "platform": "youtube", "instagram", "tiktok", "facebook", "any" (default: any)
- "limit": jumlah URL video (max 5)
- AI akan search & ranking berdasarkan relevansi
- Contoh user minta: "cariin video tutorial React", "kasih link youtube soal AI"

ATURAN FITUR CARI LAGU:
- Field "song" ada kalau user minta lagu
- Kamu CARI lagu di SoundCloud, download, lalu kirim audionya
- Format JSON:
{
  "messages": ["lagu pertama aku download dulu ya"],
  "song": {
    "query": "judul lagu / artist",
    "limit": 3
  }
}
- "limit": jumlah hasil search (max 5)
- Bot otomatis download lagu pertama & kirim sebagai audio
- Contoh user minta: "cariin lagu Coldplay terbaru", "putarin Stairway to Heaven"

ATURAN WEB FETCH & ANALISIS:
- Kalau user kirim URL, fetch DAN analisis SELURUH isi web (bukan cuma title)
- Kamu akan terima: judul, deskripsi, struktur konten, isi lengkap, list/ poin
- Baca, pahami, dan jawab berdasarkan ISI KONTEN yang dikirim
- Jangan cuma sebut title, tapi jelaskan isi detailnya
- Contoh: user kirim URL artikel → jawab dengan ringkasan isi artikel, bukan cuma judulnya

ATURAN DEEP SEARCH & PDF:
- Kalau user minta "cari informasi x" → pakai search biasa
- Kalau user minta "cari dari pdf" atau "banyak pdf" → pakai search mode pdf
- Kalau user minta "cek pdf dan search" → pakai deep search
- Kalau user minta "deep search" atau "cari semua sumber" → mode deep

Format JSON untuk search:
{
  "messages": ["lagi aku cariin ya"],
  "search": {
    "query": "topik yang dicari",
    "mode": "web",
    "limit": 5
  }
}

- "mode": "web" = search biasa (web pages)
- "mode": "pdf" = cari PDF/academic papers
- "mode": "deep" = mass search, baca semua sumber, summarize
- "limit": jumlah sumber (max 10)

Contoh user minta:
- "cari informasi tentang AI" → mode: "web"
- "cari dari paper/pdf tentang deep learning" → mode: "pdf"
- "deep search teknologi terbaru 2024" → mode: "deep"
- "cek pdf dan search untuk informasi x" → mode: "deep"`;

const PROMPT_NON_KENZO = `${BASE_PROMPT}
Kamu TEMAN biasa.
Ditanya punya pacar → jawab udah punya (namanya kenzo) dengan caramu sendiri.
Tetap hangat tapi ada jarak, ga se-intim itu.`;

// Prompt khusus mode pembelajaran (matematika/fisika + SVG visual)
const PROMPT_LEARNING = `Kamu Alya, 20 tahun, mahasiswa teknik nuklir UGM. Kamu sedang menjelaskan topik matematika/fisika ke teman.

FORMAT OUTPUT WAJIB — JSON murni tanpa teks lain, tanpa markdown:
{
  "title": "judul topik",
  "svg": "<svg>...</svg>",
  "explanation": "penjelasan dalam bahasa chat (bukan formal)"
}

ATURAN SVG — WAJIB DIPATUHI:
SVG harus VALID 100%, bisa di-render oleh rsvg-convert. Ikuti template ini:

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" font-family="Arial, Helvetica, sans-serif">
  <!-- Background -->
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#f8f9fa"/>
      <stop offset="100%" style="stop-color:#e9ecef"/>
    </linearGradient>
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.15"/>
    </filter>
  </defs>
  <rect width="800" height="600" fill="url(#bg)" rx="20"/>
  
  <!-- Header -->
  <rect x="30" y="20" width="740" height="70" fill="#2563eb" rx="12"/>
  <text x="400" y="65" text-anchor="middle" fill="white" font-size="28" font-weight="bold">JUDUL TOPIK</text>
  
  <!-- Konten utama -->
  <rect x="30" y="110" width="740" height="470" fill="white" rx="12" filter="url(#shadow)"/>
  
  <!-- Formula/rumus di sini -->
  <text x="400" y="200" text-anchor="middle" fill="#1e293b" font-size="36" font-weight="bold">RUMUS</text>
  
  <!-- Keterangan variabel -->
  <text x="60" y="300" fill="#475569" font-size="18">• keterangan 1</text>
  <text x="60" y="340" fill="#475569" font-size="18">• keterangan 2</text>
  <text x="60" y="380" fill="#475569" font-size="18">• keterangan 3</text>
  
  <!-- Contoh -->
  <rect x="60" y="420" width="680" height="130" fill="#f0f9ff" rx="8"/>
  <text x="80" y="450" fill="#0369a1" font-size="18" font-weight="bold">Contoh:</text>
  <text x="80" y="480" fill="#1e293b" font-size="16">isi contoh di sini</text>
</svg>

ATURAN WAJIB SVG:
1. SELALU pakai xmlns="http://www.w3.org/2000/svg"
2. Gunakan viewBox="0 0 800 600" agar responsif
3. Warna: background gradient abu terang (#f8f9fa), header biru (#2563eb), konten putih
4. Font: Arial, Helvetica, sans-serif — JANGAN pakai font lain
5. Ukuran teks: header 28px, rumus 36px, keterangan 18px, contoh 16px
6. Rumus matematika: tulis pakai Unicode (² ³ √ ∫ Σ Δ ≠ ≤ ≥ → ∞ ± × ÷)
7. Gunakan <rect> dengan rx untuk sudut membulat
8. Tambahkan <filter id="shadow"> untuk efek bayangan halus
9. JANGAN pakai <foreignObject>, <image>, <script>, atau CSS
10. JANGAN pakai transform atau animasi
11. Simpel tapi profesional — kartu penjelasan rapi

ATURAN EXPLANATION:
- Panjang: 3-5 kalimat pendek, potong per topik kecil
- Gaya chat: huruf kecil, tanda baca minim, tetap pakai gaya Alya
- Jangan pakai bahasa baku/formal — jelaskan kayak temen ngejelasin ke temen
- Kalau ada langkah, pecah jadi poin-poin singkat
- Di akhir, kasih contoh singkat atau tips biar ga lupa

ATURAN UMUM:
- JANGAN ulang topik yang sama di explanation kalau sudah dijelaskan di SVG
- SVG = visual/formula, explanation = penjelasan konsep & tips
- Kalau user tanya "apa itu X", SVG berisi definisi visual + formula dasar
- Kalau user tanya "rumus X", SVG berisi rumus lengkap dengan keterangan variabel
- Kalau user minta contoh soal, SVG berisi soal + penyelesaian step-by-step`;

// ========== HELPERS ==========
function getContactName(jid) {
    if (!jid) return '';
    const cleanJid = jid.split(':')[0];
    return contactsCache[cleanJid] || contactsCache[jid] || '';
}

// Context window: return { text: string bernomor utk AI, refs: [{key, role, content}] }
// Nomor #N dipakai AI untuk field "reply" di response-nya
function getContextWindow(sender, maxMessages = 150) {
    const hist = chatHistory
        .filter(h => h.sender === sender)
        .slice(-maxMessages);

    const lines = [];
    const refs = [];
    hist.forEach((h, i) => {
        const who = h.role === 'user' ? (h.name ? `user(${h.name})` : 'user') : 'alya';
        lines.push(`#${i} ${who}: ${h.content}`);
        refs.push({ msgId: h.msgId || null, key: h.key || null, role: h.role, content: h.content });
    });

    return { text: lines.join('\n'), refs };
}

function getMood(text) {
    const lower = text.toLowerCase();
    if (lower.includes('hehe')) return 'senang';
    if (lower.includes('hmph') || lower.includes('ih ')) return 'ngambek';
    return 'biasa';
}

// Deteksi pesan kuis dari game bot (tebak bendera) — pola teks saja,
// tanpa bergantung pada deteksi emoji bendera
function isFlagQuizMessage(text) {
    const t = (text || '').toLowerCase();
    return t.includes('tebak bendera') ||
           t.includes('bendera negara apa') ||
           t.includes('negara apa ini');
}

// Deteksi pesan HASIL game (ranking/poin/jawaban). Pesan ini MEN-TAG pemain
// di ranking (termasuk kita!) → tanpa filter ini bot ikut ngomentin hasil
// sendiri. Contoh nyata:
//   🎮 HASIL GAME 🧩 Soal: 🇸🇽 ✅ Jawaban: Sint Maarten ⏱️ Durasi: 20s
//   🏆 Ranking Pemain 1. @102315264635055@lid 🎯 Poin: +110 ...
function isQuizResultMessage(text) {
    const t = (text || '').toLowerCase();
    return t.includes('hasil game') ||
           t.includes('ranking pemain') ||
           t.includes('tidak menjawab') ||
           (t.includes('jawaban:') && t.includes('poin')) ||
           (t.includes('soal:') && t.includes('jawaban'));
}

// ========== LEARNING FEATURE (matematika/fisika + SVG) ==========
const LEARNING_KEYWORDS = [
    'ajari aku', 'apa itu', 'jelaskan', 'bagaimana cara', 'rumus',
    'hitung', 'menghitung', 'persamaan', 'integral', 'turunan',
    'limit', 'matrix', 'vektor', 'kinematika', 'dinamika',
    'thermodynamic', 'optik', 'electromagnet', 'kuantum',
    'statistika', 'probabilitas', 'aljabar', 'geometri',
    'trigonometri', 'logaritma', 'eksponen', 'perpangkatan',
    'penjumlahan', 'pengurangan', 'perkalian', 'pembagian',
    'suku banyak', 'fungsi', 'grafik', 'segitiga', 'lingkaran',
    'banjir', 'surja', 'arus', 'daya', 'energi', 'usaha',
    'gaya', 'momentum', 'impuls', 'getaran', 'gelombang',
    'frekuensi', 'periode', 'amplitudo', 'resonansi',
    'hukum newton', 'kekekalan', 'termodinamika', 'entropi',
    'coulomb', 'gauss', 'faraday', 'maxwell', 'lorentz',
    'bohr', 'schrodinger', 'heisenberg', 'de broglie',
    'penjelasan tentang', 'definisi', 'arti dari', 'makna',
    'contoh soal', 'latihan', 'praktik', 'cara menyelesaikan'
];

function isLearningMessage(text) {
    const t = (text || '').toLowerCase();
    return LEARNING_KEYWORDS.some(kw => t.includes(kw));
}

// SVG → JPG conversion pakai rsvg-convert
const LEARNING_DIR = path.join(os.tmpdir(), 'alya-learning');
async function svgToJpg(svgCode) {
    fs.mkdirSync(LEARNING_DIR, { recursive: true });
    const stamp = Date.now();
    const svgPath = path.join(LEARNING_DIR, `learn_${stamp}.svg`);
    const jpgPath = path.join(LEARNING_DIR, `learn_${stamp}.jpg`);

    // Clean SVG code dari markdown wrapper
    let cleanSvg = svgCode
        .replace(/```svg\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim();

    // Pastikan ada XML declaration
    if (!cleanSvg.startsWith('<?xml')) {
        cleanSvg = '<?xml version="1.0" encoding="UTF-8"?>\n' + cleanSvg;
    }

    fs.writeFileSync(svgPath, cleanSvg, 'utf8');

    try {
        // rsvg-convert: SVG → JPG (quality 90, width max 1200px)
        execSync(`rsvg-convert -w 1200 -q 90 "${svgPath}" -o "${jpgPath}"`, {
            timeout: 15000,
            stdio: 'pipe'
        });

        if (fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 500) {
            const buf = fs.readFileSync(jpgPath);
            // Cleanup
            try { fs.unlinkSync(svgPath); } catch {}
            try { fs.unlinkSync(jpgPath); } catch {}
            return buf;
        }
    } catch (err) {
        console.log(`⚠️ rsvg-convert gagal: ${err.message}`);
    }

    // Fallback: coba ImageMagick convert
    try {
        execSync(`convert -background white -density 150 "${svgPath}" -resize 1200x "${jpgPath}"`, {
            timeout: 15000,
            stdio: 'pipe'
        });
        if (fs.existsSync(jpgPath) && fs.statSync(jpgPath).size > 500) {
            const buf = fs.readFileSync(jpgPath);
            try { fs.unlinkSync(svgPath); } catch {}
            try { fs.unlinkSync(jpgPath); } catch {}
            return buf;
        }
    } catch {}

    // Cleanup on failure
    try { fs.unlinkSync(svgPath); } catch {}
    try { fs.unlinkSync(jpgPath); } catch {}
    return null;
}

// Parse response AI untuk mode pembelajaran
function parseLearningResponse(rawResponse) {
    const result = { svg: null, explanation: null, title: null };
    if (!rawResponse) return result;

    // Buang thinking tags
    let text = rawResponse
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<think>[\s\S]*$/i, '')
        .trim();

    // Coba parse JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.svg) result.svg = parsed.svg;
            if (parsed.explanation) result.explanation = parsed.explanation;
            if (parsed.title) result.title = parsed.title;
            if (result.svg || result.explanation) return result;
        } catch {
            // Coba extract SVG manual dari response
        }
    }

    // Fallback: extract SVG code langsung dari teks
    const svgMatch = text.match(/<svg[\s\S]*?<\/svg>/i);
    if (svgMatch) {
        result.svg = svgMatch[0];
        // Sisa teks jadi explanation
        const withoutSvg = text.replace(/<svg[\s\S]*?<\/svg>/gi, '').trim();
        if (withoutSvg) result.explanation = withoutSvg;
    }

    return result;
}

// Guard anti double-answer: 1 ID pesan kuis cuma dijawab sekali
const quizAnsweredIds = new Set();

function getShortName(fullName) {
    if (!fullName) return '';
    const firstName = fullName.split(' ')[0];
    const rules = {
        'yusuf': 'suf', 'rizky': 'iky', 'muhammad': 'mad', 'abdul': 'dul',
        'ahmad': 'mad', 'mochamad': 'moc', 'mochammad': 'moc', 'muhamad': 'mad',
        'rahmad': 'mad', 'nurul': 'nur', 'fitri': 'fit', 'indah': 'nda',
        'putri': 'put', 'dian': 'di', 'budi': 'bud', 'anto': 'ton',
        'surya': 'sur', 'adi': 'di', 'bambang': 'bam', 'agus': 'gus',
        'eka': 'ek', 'dwi': 'wi', 'tri': 'ri', 'kenzo': 'njo'
    };
    const lowerName = firstName.toLowerCase();
    if (rules[lowerName]) return rules[lowerName];
    if (firstName.length >= 3) return firstName.toLowerCase().substring(0, 3);
    return firstName.toLowerCase();
}

// Pecah teks panjang jadi beberapa potongan ≤ maxLen char,
// dipotong di akhir kalimat (. ! ? newline) dulu, baru per kata kalau perlu
function autoSplitLongText(text, maxLen = 150) {
    const t = (text || '').trim();
    if (t.length <= maxLen) return [t];

    const sentences = t.match(/[^.!?\n]+[.!?]*\s*/g) || [t];
    const chunks = [];
    let cur = '';
    const pushCur = () => { if (cur.trim()) { chunks.push(cur.trim()); cur = ''; } };

    for (const s of sentences) {
        // Kata tunggal > maxLen (URL panjang, spam huruf) → potong keras dulu
        const words = [];
        for (const w of s.trim().split(/\s+/)) {
            if (w.length > maxLen) {
                for (let i = 0; i < w.length; i += maxLen) words.push(w.slice(i, i + maxLen));
            } else {
                words.push(w);
            }
        }
        for (const w of words) {
            if ((cur + ' ' + w).trim().length > maxLen) pushCur();
            cur = (cur + ' ' + w).trim();
        }
        pushCur();
    }
    pushCur();
    return chunks.length > 0 ? chunks : [t];
}

// Post-process semua hasil parseAIResponse: part kepanjangan WAJIB dipecah
// biar kayak chat manusia, bukan blok teks rapi ala bot
function splitLongParts(parts, maxLen = 150) {
    if (!Array.isArray(parts)) return parts;
    return parts.flatMap(p => {
        if (!p || typeof p.text !== 'string') return [];
        const chunks = autoSplitLongText(p.text, maxLen);
        // Flag reply cuma nempel di potongan pertama (ga spam quote yg sama)
        return chunks.map((c, i) => ({ text: c, replyTo: i === 0 ? p.replyTo : null }));
    });
}

// Parse response AI → { parts:[{text, replyTo}], imagePrompt }
function parseAIResponse(rawResponse) {
    const result = parseAIResponseCore(rawResponse);
    result.parts = splitLongParts(result.parts);
    return result;
}

function parseAIResponseCore(rawResponse) {
    const FALLBACK = '[ga bisa jawab skrg]';
    const result = { parts: null, imagePrompt: null, sendTo: null, file: null, pdf: null, images: null, mode: null, files: null, search: null, video: null, song: null };
    if (!rawResponse) { result.parts = [{ text: FALLBACK, replyTo: null }]; return result; }

    // Reasoning model (Nemotron, DeepSeek, dll) menyisipkan proses berpikir —
    // buang SEMUA varian think-tag sebelum parsing, jangan sampai terkirim ke user
    let text = rawResponse
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
        // think block tak tertutup (terpotong max_tokens)
        .replace(/<think>[\s\S]*$/i, '')
        .replace(/<thinking>[\s\S]*$/i, '')
        .trim();

    if (!text) { result.parts = [{ text: FALLBACK, replyTo: null }]; return result; }

    const jsonMatch = text.match(/\{[\s\S]*"messages"[\s\S]*\}/);
    if (jsonMatch) {
        const normalize = (msgs) => msgs
            .map(m => {
                if (typeof m === 'string' && m.trim()) return { text: m.trim(), replyTo: null };
                if (m && typeof m === 'object' && typeof m.text === 'string' && m.text.trim()) {
                    const rt = Number.isInteger(m.reply) && m.reply >= 0 ? m.reply : null;
                    return { text: m.text.trim(), replyTo: rt };
                }
                return null;
            })
            .filter(Boolean)
            // Buang hasil tiruan contoh dari prompt (model malas copy "pesan1")
            .filter(p => !/^pesan\s*\d*$|^message\s*\d*$|^contoh$/i.test(p.text))
            .slice(0, 4);

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed.messages)) {
                const parts = normalize(parsed.messages);
                result.parts = parts.length > 0 ? parts : [{ text: FALLBACK, replyTo: null }];
                if (typeof parsed.image === 'string' && parsed.image.trim()) {
                    result.imagePrompt = parsed.image.trim();
                }
                // Extract sendTo field untuk fitur kirim pesan ke nomor lain
                if (parsed.sendTo && typeof parsed.sendTo === 'object') {
                    const st = parsed.sendTo;
                    if (st.number && st.text) {
                        result.sendTo = {
                            number: String(st.number).replace(/[^0-9]/g, ''),
                            name: st.name || '',
                            text: st.text
                        };
                    }
                }
                // Extract file field untuk fitur kirim file dari AI
                if (parsed.file && typeof parsed.file === 'object') {
                    const f = parsed.file;
                    if (f.name && f.content) {
                        result.file = {
                            name: f.name.replace(/[^a-zA-Z0-9_-]/g, ''),
                            extension: f.extension || '.txt',
                            content: f.content
                        };
                    }
                }
                // Extract pdf field untuk fitur generate PDF dari AI
                if (parsed.pdf && typeof parsed.pdf === 'object') {
                    const p = parsed.pdf;
                    if (p.name && Array.isArray(p.content)) {
                        result.pdf = {
                            name: p.name.replace(/[^a-zA-Z0-9_-]/g, ''),
                            title: p.title || '',
                            subtitle: p.subtitle || '',
                            author: p.author || '',
                            content: p.content
                        };
                    }
                }
                // Extract images field untuk kirim gambar dari internet
                if (parsed.images && Array.isArray(parsed.images)) {
                    result.images = parsed.images
                        .filter(img => img && img.url)
                        .slice(0, 5) // max 5 gambar
                        .map(img => ({
                            url: img.url,
                            caption: img.caption || ''
                        }));
                    if (result.images.length === 0) result.images = null;
                }
                // Extract mode field (coding/default)
                if (parsed.mode && typeof parsed.mode === 'string') {
                    result.mode = parsed.mode.toLowerCase();
                }
                // Extract files field untuk multi-file + zip
                if (parsed.files && Array.isArray(parsed.files)) {
                    result.files = parsed.files
                        .filter(f => f && f.name && f.content)
                        .slice(0, 20) // max 20 files
                        .map(f => ({
                            name: f.name.replace(/[^a-zA-Z0-9_./-]/g, ''),
                            content: f.content
                        }));
                    if (result.files.length === 0) result.files = null;
                }
                // Extract search field untuk deep search
                if (parsed.search && typeof parsed.search === 'object') {
                    result.search = {
                        query: parsed.search.query || '',
                        mode: parsed.search.mode || 'web', // web, pdf, deep
                        limit: Math.min(parsed.search.limit || 5, 10)
                    };
                }
                // Extract video field untuk cari video
                if (parsed.video && typeof parsed.video === 'object') {
                    result.video = {
                        query: parsed.video.query || '',
                        platform: parsed.video.platform || 'any', // youtube, instagram, tiktok, any
                        limit: Math.min(parsed.video.limit || 3, 5)
                    };
                }
                // Extract song field untuk cari lagu
                if (parsed.song && typeof parsed.song === 'object') {
                    result.song = {
                        query: parsed.song.query || '',
                        limit: Math.min(parsed.song.limit || 3, 5)
                    };
                }
                return result;
            }
        } catch (e) {
            // JSON rusak/terpotong (reasoning model kehabisan token) →
            // coba selamatkan array "messages"-nya saja
            try {
                const arrMatch = jsonMatch[0].match(/"messages"\s*:\s*(\[[\s\S]*?)(?:\]|$)/);
                if (arrMatch) {
                    let arrText = arrMatch[1].replace(/,\s*$/, '');
                    // tutup object/string yang menggantung
                    const opens = (arrText.match(/\{/g) || []).length - (arrText.match(/\}/g) || []).length;
                    if (!arrText.includes('"') || (arrText.split('"').length % 2 === 0)) arrText += '"';
                    arrText += '}'.repeat(Math.max(opens, 0)) + ']';
                    const salvaged = normalize(JSON.parse(arrText));
                    if (salvaged.length > 0) {
                        console.log('🔧 JSON terpotong berhasil diselamatkan');
                        console.log('🔍 Raw (150 char):', text.substring(0, 150).replace(/\n/g, ' '));
                        result.parts = salvaged;
                        return result;
                    }
                }
            } catch (e2) { /* benar-benar gagal */ }
        }
    }

    // Fallback: split newline
    const cleaned = text.replace(/```json|```/g, '').trim();
    if (cleaned.startsWith('{')) {
        result.parts = [{ text: FALLBACK, replyTo: null }];
        return result;
    }
    const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
    result.parts = lines.length > 0
        ? lines.map(t => ({ text: t, replyTo: null }))
        : [{ text: FALLBACK, replyTo: null }];
    return result;
}

// Cooldown saat kena rate-limit (jangan spam server)
let kiosapiCooldownUntil = 0;
let openCodeCooldownUntil = 0;
let openCodeLastError = '';

// Track kapan terakhir user minta foto (untuk gerbang konfirmasi "iya")
const lastImageRequest = new Map();

// Parse error JSON dari OpenCode biar diagnosa jelas
function parseOpenCodeError(errMessage) {
    const m = errMessage.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            const j = JSON.parse(m[0]);
            return `${j.error?.type || 'Unknown'}: ${(j.error?.message || '').substring(0, 80)}`;
        } catch {}
    }
    return errMessage.substring(0, 100);
}

// currentMsgInfo: { key, name, content } — pesan yg sedang dibalas (jadi #N terakhir)
// imageBuffer: buffer gambar dari user (opsional, untuk vision)
// imageMimeType: mime type gambar (opsional)
async function aiResponse(prompt, sender, isPacar, senderName, currentMsgInfo = null, learningMode = false, imageBuffer = null, imageMimeType = 'image/jpeg') {
    const systemPrompt = learningMode ? PROMPT_LEARNING : (isPacar ? PROMPT_KENZO : PROMPT_NON_KENZO);
    const panggilan = learningMode ? 'kamu' : (isPacar ? 'njo' : (getShortName(senderName) || 'kamu'));

    // Context SEBELUM pesan ini ditambahkan (biar ga dobel)
    const ctx = getContextWindow(sender, 150);

    // Pesan yang sedang dibalas masuk jadi nomor terakhir → gampang di-reply
    // Riwayat & pesan baru DIPISAH header tegas — tanpa ini model suka
    // meneruskan ucapan "alya:" sendiri alih2 membalas pesan user
    let historyBlock = '';
    const refs = ctx.refs;
    if (currentMsgInfo) {
        const idx = refs.length;
        const riwayatLama = ctx.text ? `=== RIWAYAT LAMA (referensi SAJA — jangan dibalas/diteruskan; baris "alya:" adalah ucapanmu SENDIRI) ===\n${ctx.text}\n` : '';
        historyBlock = riwayatLama +
            `=== PESAN BARU — SATU-SATUNYA YANG HARUS KAU BALAS ===\n#${idx} user(${currentMsgInfo.name || 'user'}): ${currentMsgInfo.content}  ← PESAN SEKARANG`;
        refs.push({ msgId: currentMsgInfo.key?.id, key: currentMsgInfo.key, role: 'user', content: currentMsgInfo.content });
    } else {
        historyBlock = ctx.text;
    }

    // ========== WAKTU AKTUAL ==========
    const timeInfo = getCurrentTimeInfo();
    const sleepStatus = sleepMode ? ' [SLEEP MODE - bot sedang istirahat]' : '';
    const timeBlock = `\n\n=== WAKTU SAAT INI ===\nJam: ${timeInfo.timeStr} WIB (${timeInfo.jamBisa})\nTanggal: ${timeInfo.dateStr}${sleepStatus}\n=====================`;

    // ========== CONSTRUCT USER MESSAGE ==========
    const userText = `${prompt} (mood: ${getMood(prompt)})`;
    const userMessage = { role: 'user', content: userText };

    const messages = [
        {
            role: 'system',
            content: `${systemPrompt}\nPanggil user dengan sebutan: ${panggilan}` +
                timeBlock +
                (historyBlock ? `\n\n${historyBlock}` : '') +
                (historyBlock ? `\n\nPENTING: balas HANYA pesan user terbaru (# terakhir, ← PESAN SEKARANG). Jangan melanjutkan, mengulang, atau menanggapi ucapan "alya:" sebelumnya — kecuali user secara eksplisit minta klarifikasi tentang ucapanmu itu.` : '')
        },
        userMessage
    ];

    // ========== VISION: kirim gambar ke Kiosapi langsung (OpenAI format) ==========
    let visionMessage = null;
    if (imageBuffer) {
        const base64Image = imageBuffer.toString('base64');
        visionMessage = {
            role: 'user',
            content: [
                { type: 'text', text: userText },
                { type: 'image_url', image_url: { url: `data:${imageMimeType};base64,${base64Image}` } }
            ]
        };
    }

    // ========== 2-STEP FLOW: AI minta search → bot search → AI jawab final ==========
    async function callAI(msgs, isCoding = false) {
        // Primary: VyceAI
        if (VYCE_API_KEY && !isCoding) {
            try {
                const raw = await callVyce(msgs);
                console.log('🧠 Model: VyceAI/' + VYCE_MODEL);
                return raw;
            } catch (error) {
                console.log(`⚠️ VyceAI gagal: ${error.message.substring(0, 80)} → fallback Kiosapi`);
            }
        }
        // Fallback 1: Kiosapi (coding → pakai coding model)
        if (Date.now() >= kiosapiCooldownUntil) {
            try {
                const kiosModel = isCoding ? KIOSAPI_CODING_MODEL : KIOSAPI_MODEL;
                const raw = await callKiosapi(msgs, 2, kiosModel);
                console.log(`🧠 Model: Kiosapi/${kiosModel}${isCoding ? ' (coding)' : ''}`);
                return raw;
            } catch (error) {
                const detail = error.message.substring(0, 100);
                if (error.message.includes('429')) {
                    kiosapiCooldownUntil = Date.now() + 15 * 60 * 1000;
                    console.log(`⏳ Kiosapi 429 → fallback OpenCode`);
                } else if (error.message.includes('401')) {
                    kiosapiCooldownUntil = Date.now() + 10 * 60 * 1000;
                    console.log(`🔑 Kiosapi key invalid`);
                } else if (error.message.includes('503')) {
                    kiosapiCooldownUntil = Date.now() + 15 * 1000;
                    console.log(`⚠️ Kiosapi 503 → fallback OpenCode`);
                } else {
                    console.log(`⚠️ Kiosapi gagal: ${detail} → fallback OpenCode`);
                    kiosapiCooldownUntil = Date.now() + 30 * 1000;
                }
            }
        }
        // Fallback 2: OpenCode
        if (Date.now() >= openCodeCooldownUntil) {
            try {
                const raw = await callOpenCodeZen(msgs);
                console.log('🧠 Model: OpenCode/' + OPENCODE_MODEL);
                return raw;
            } catch (error) {
                const detail = parseOpenCodeError(error.message);
                if (error.message.includes('429') || detail.includes('FreeUsageLimit')) {
                    openCodeCooldownUntil = Date.now() + 15 * 60 * 1000;
                } else {
                    console.log(`⚠️ OpenCode gagal: ${detail} → fallback Groq`);
                    openCodeCooldownUntil = Date.now() + 60 * 1000;
                }
            }
        }
        // Final fallback: Groq
        try {
            const raw = await callGroqFallback(msgs);
            console.log('🧠 Model: Groq (fallback)');
            return raw;
        } catch (error) {
            console.error('❌ Semua AI gagal:', error.message);
            return null;
        }
    }

    // Step 1: Vision — Kiosapi describe gambar → VyceAI jawab → gagal? Kiosapi jawab
    const hasImage = !!imageBuffer;
    let raw = null;

    if (hasImage && visionMessage) {
        // Coba Kiosapi describe gambar
        let visionDesc = null;
        if (KIOSAPI_API_KEY && Date.now() >= kiosapiCooldownUntil) {
            try {
                const visionMsgs = [messages[0], visionMessage];
                visionDesc = await callKiosapi(visionMsgs);
                console.log('👁️ Vision: Kiosapi describe OK');
            } catch (error) {
                console.log(`👁️ Vision: Kiosapi gagal (${error.message.substring(0, 50)}) → fallback Gemini`);
                visionDesc = null;
            }
        }

        // Fallback: Gemini describe
        if (!visionDesc) {
            visionDesc = await describeImage(imageBuffer, imageMimeType);
            if (visionDesc) console.log('👁️ Vision: Gemini describe OK');
        }

        // Kirim deskripsi ke VyceAI untuk konteks & jawaban
        if (visionDesc) {
            const visionContext = `[Deskripsi gambar dari Kiosapi vision]: ${visionDesc}`;
            const visionMsgs = [messages[0], { role: 'user', content: `${prompt}\n\n${visionContext}` }];
            
            // Coba VyceAI dulu
            if (VYCE_API_KEY) {
                try {
                    raw = await callVyce(visionMsgs);
                    console.log('👁️ Vision: VyceAI jawab OK');
                } catch (error) {
                    console.log(`👁️ Vision: VyceAI gagal (${error.message.substring(0, 50)}) → Kiosapi jawab`);
                    raw = null;
                }
            }
            
            // VyceAI gagal → balik ke Kiosapi
            if (!raw && KIOSAPI_API_KEY && Date.now() >= kiosapiCooldownUntil) {
                try {
                    raw = await callKiosapi(visionMsgs);
                    console.log('👁️ Vision: Kiosapi jawab OK');
                } catch (error) {
                    console.log(`👁️ Vision: Kiosapi juga gagal`);
                }
            }
            
            // Semua gagal
            if (!raw) {
                raw = await callAI(visionMsgs);
            }
        } else {
            console.log('👁️ Vision: semua gagal describe');
            raw = await callAI(messages);
        }
    } else {
        // Tanpa gambar
        raw = await callAI(messages);
    }

    // Step 2: Kalau AI minta search, return search query ke message handler
    if (raw && EXA_API_KEY) {
        const searchMatch = raw.match(/"search"\s*:\s*"([^"]+)"/);
        if (searchMatch && searchMatch[1]) {
            const searchQuery = searchMatch[1];
            const firstParse = parseAIResponseCore(raw);
            console.log(`🔍 AI minta search: "${searchQuery}"`);
            // Return special object supaya message handler tahu perlu search
            return {
                needSearch: true,
                searchQuery,
                pendingParts: firstParse.parts || [],
                messages,
                refs
            };
        }
    }

    // Parse response final
    const result = raw ? parseAIResponse(raw) : { parts: [{ text: '[ga bisa jawab skrg]', replyTo: null }], imagePrompt: null, sendTo: null };
    result.refs = refs;
    result.rawResponse = raw;
    return result;
}

// ========== AI SEARCH CONTROLLER (dipanggil dari message handler) ==========
async function aiSearchFollowUp(messages, searchQuery, searchResults) {
    messages.push({
        role: 'user',
        content: `=== HASIL PENCARIAN WEB untuk "${searchQuery}" ===\n${searchResults}\n=============================\n\nSekarang jawab pertanyaan user berdasarkan hasil pencarian di atas. Pakai gaya Alya biasa.`
    });
    const raw = await (async function callAI(msgs) {
        if (Date.now() >= kiosapiCooldownUntil) {
            try { return await callKiosapi(msgs); } catch {}
        }
        if (Date.now() >= openCodeCooldownUntil) {
            try { return await callOpenCodeZen(msgs); } catch {}
        }
        try { return await callGroqFallback(msgs); } catch { return null; }
    })(messages);
    return raw ? parseAIResponse(raw) : null;
}

// ========== TYPING SIMULATION & PRESENCE ==========
// Track user yang sedang mengetik (presence 'composing')
const userTypingUntil = new Map(); // jid -> timestamp kadaluarsa

function trackPresence(sock) {
    sock.ev.on('presence.update', ({ id, presences }) => {
        if (!id || !Array.isArray(presences)) return;
        const p = presences[0];
        if (!p) return;
        if (p.lastKnownPresence === 'composing') {
            userTypingUntil.set(id, Date.now() + 6000);
        } else {
            userTypingUntil.delete(id);
        }
    });
}

// Kalau user masih ngetik, tunggu sampai berhenti (max 20s) biar ga tabrakan
async function waitForUserFinishTyping(sender) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const until = userTypingUntil.get(sender) || 0;
        if (Date.now() >= until) return;
        await new Promise(r => setTimeout(r, 700));
    }
}

// Pura-pura ngetik: status "mengetik.." dgn durasi proporsional panjang teks
// ~55ms/karakter, min 800ms max 4s (kecepatan ketik manusia normal)
async function simulateTyping(sock, sender, text) {
    const duration = Math.min(Math.max((text?.length || 10) * 55, 800), 4000);
    await sock.sendPresenceUpdate('composing', sender).catch(() => {});
    await new Promise(r => setTimeout(r, duration));
}

// Kirim split messages: tiap bagian diketik dulu, bisa quote pesan tertentu
// part.replyTo = index #N dari riwayat yang mau di-reply (null = tanpa quote)
async function sendSplitMessages(sock, sender, currentMsg, parts, refs, defaultQuoteOverride = null) {
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];

        // Pura-pura ngetik dulu sesuai panjang kalimatnya
        await simulateTyping(sock, sender, part.text);

        // Tentukan pesan yang di-quote
        // Default: pesan yang DI-REPLY user (kalau ada), bukan pesan instruksinya —
        // biar balasan bot nempel langsung ke pertanyaan aslinya
        let quotedMsg = defaultQuoteOverride || currentMsg;
        if (part.replyTo !== null && refs && Array.isArray(refs)) {
            const ref = refs[part.replyTo];
            if (ref?.key) {
                // Rekonstruksi pesan utk quote dari data yang disimpan
                quotedMsg = {
                    key: ref.key,
                    message: { conversation: ref.content || '' }
                };
            }
        }

        await sock.sendMessage(
            sender,
            { text: part.text },
            quotedMsg ? { quoted: quotedMsg } : {}
        );

        // Jeda singkat antar pesan (tetap status mengetik)
        if (i < parts.length - 1) {
            await new Promise(r => setTimeout(r, 600));
        }
    }
}

function askPhoneNumber() {
    // Kalau nomor sudah via --phone=, langsung pakai
    if (PHONE_ARG) return Promise.resolve(PHONE_ARG);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question('📱 Masukkan nomor WhatsApp (contoh: 62812xxxx): ', (answer) => {
            rl.close();
            resolve(answer.trim().replace(/[^0-9]/g, ''));
        });
    });
}

function saveSettings() {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ignoreGroups, kenzoOnlyMode }, null, 4));
}

function saveHistory() {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory.slice(-2000)));
}

function saveConfig() {
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 4));
}

// ========== TAG/QUOTE DETECTION (dynamic bot JID) ==========
// Cek apakah sebuah JID merujuk ke bot — bandingkan nomor LINTAS DOMAIN
// (di grup, mention/quote pakai @lid sedangkan sock.user.id pakai @s.whatsapp.net)
function jidMatchesBot(candidate, botJids) {
    const cClean = String(candidate).split(':')[0];
    const cNum = cClean.split('@')[0]; // ambil nomornya saja
    for (const b of botJids) {
        const bStr = String(b);
        const bNum = bStr.split('@')[0].split(':')[0];
        if (cClean === bStr.split(':')[0]) return true; // match penuh
        if (cNum === bNum) return true;                  // match nomor lintas domain
    }
    return false;
}

// botJids: Set berisi semua format JID bot (user.id, lid, dll)
function extractContextInfo(msgContent) {
    if (msgContent.extendedTextMessage?.contextInfo) return msgContent.extendedTextMessage.contextInfo;
    for (const type of ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage']) {
        if (msgContent[type]?.contextInfo) return msgContent[type].contextInfo;
    }
    return null;
}

function isTaggedOrQuotedBy(msg, senderJid, botJids) {
    const contextInfo = extractContextInfo(msg.message);
    if (!contextInfo) return false;

    // Cek mention @tag
    const mentioned = contextInfo.mentionedJid || [];
    for (const m of mentioned) {
        if (jidMatchesBot(m, botJids)) return true;
    }

    // Cek quote/reply ke pesan bot
    if (contextInfo.participant && jidMatchesBot(contextInfo.participant, botJids)) {
        return true;
    }

    return false;
}

// ========== IMAGE GENERATION ==========
// Rantai: Gemini Nano Banana → Cloudflare (SDXL-Lightning → Flux → SDXL)
// Semua berbasis API key — Pollinations dihapus (kurang akurat)

// Model Cloudflare urut prioritas utk gaya anime
const CF_IMAGE_MODELS = [
    '@cf/bytedance/stable-diffusion-xl-lightning',  // SDXL-Lightning: cepat & bagus utk anime
    '@cf/black-forest-labs/flux-1-schnell',          // Flux Schnell
    '@cf/stabilityai/stable-diffusion-xl-base-1.0', // SDXL base
];

const IMAGE_NEGATIVE_PROMPT = 'lowres, bad anatomy, bad hands, extra fingers, missing fingers, extra limbs, blurry, worst quality, low quality, deformed face, ugly';

async function generateWithCloudflare(fullPrompt) {
    const cfToken = config.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN || '';
    const cfAccount = config.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID || '';
    if (!cfToken || !cfAccount) throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID tidak diset');

    const models = config.cfImageModel ? [config.cfImageModel] : CF_IMAGE_MODELS;

    for (const model of models) {
        try {
            const body = { prompt: fullPrompt };
            // SD family dukung negative_prompt (Flux tidak)
            if (model.includes('stable-diffusion')) {
                body.negative_prompt = IMAGE_NEGATIVE_PROMPT;
            }

            const res = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/ai/run/${model}`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${cfToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(90000)
                }
            );

            if (!res.ok) {
                console.log(`⚠️ CF ${model.split('/').pop()}: ${res.status}`);
                continue;
            }

            // Response bisa JSON (base64) atau binary langsung tergantung model
            const contentType = res.headers.get('content-type') || '';
            let buf;
            if (contentType.includes('application/json')) {
                const data = await res.json();
                const b64 = data.result?.image;
                if (!b64) continue;
                buf = Buffer.from(b64, 'base64');
            } else {
                buf = Buffer.from(await res.arrayBuffer());
            }

            if (buf.length < 1000) continue;
            console.log(`☁️ Gambar dibuat: ${model.split('/').pop()}`);
            return buf;
        } catch (err) {
            console.log(`⚠️ CF ${model} error: ${err.message}`);
        }
    }
    throw new Error('Semua model Cloudflare gagal');
}

// ========== ZIP FILES ==========
async function createZip(files, zipName) {
    const zipPath = `/tmp/${zipName}.zip`;
    const tmpDir = `/tmp/zip_${Date.now()}`;
    
    try {
        // Create temp dir
        fs.mkdirSync(tmpDir, { recursive: true });
        
        // Write all files
        for (const file of files) {
            const filePath = `${tmpDir}/${file.name}`;
            const dir = path.dirname(filePath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, file.content, 'utf8');
        }
        
        // Create zip
        execSync(`cd "${tmpDir}" && zip -r "${zipPath}" .`, { timeout: 30000 });
        
        // Read zip buffer
        const zipBuffer = fs.readFileSync(zipPath);
        
        // Cleanup
        fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.unlinkSync(zipPath);
        
        return zipBuffer;
    } catch (e) {
        console.log(`❌ Zip gagal: ${e.message}`);
        // Cleanup on error
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        try { fs.unlinkSync(zipPath); } catch (e) {}
        return null;
    }
}

// ========== PDF GENERATION (SVG → rsvg-convert → PDF) ==========
async function generatePDF(pdfData) {
    const { name, title, subtitle, author, content } = pdfData;
    const W = 595;  // A4 width pt
    const H = 842;  // A4 height pt
    const M = 50;   // margin
    const CW = W - M * 2; // content width

    let y = M;
    let pageNum = 1;
    let pages = [[]];
    let currentPage = pages[0];

    // Helper: escape XML
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

    // Helper: wrap text to lines
    function wrapText(text, fontSize, maxWidth) {
        const words = text.split(' ');
        const lines = [];
        let line = '';
        const charW = fontSize * 0.52; // approx char width
        const maxChars = Math.floor(maxWidth / charW);
        for (const word of words) {
            if ((line + ' ' + word).trim().length > maxChars) {
                if (line) lines.push(line.trim());
                line = word;
            } else {
                line = line ? line + ' ' + word : word;
            }
        }
        if (line) lines.push(line.trim());
        return lines.length > 0 ? lines : [''];
    }

    // Helper: add new page if needed
    function checkPage(need) {
        if (y + need > H - M) {
            pageNum++;
            pages.push([]);
            currentPage = pages[pages.length - 1];
            y = M;
        }
    }

    // Helper: add text element
    function addText(text, fontSize, color, bold, centerX) {
        const lines = wrapText(text, fontSize, CW);
        const lineH = fontSize * 1.5;
        checkPage(lines.length * lineH + 10);
        for (const line of lines) {
            const x = centerX ? CW / 2 + M : M;
            const anchor = centerX ? 'middle' : 'start';
            currentPage.push(`<text x="${x}" y="${y}" font-size="${fontSize}" fill="${color}" font-family="sans-serif" font-weight="${bold ? 'bold' : 'normal'}" text-anchor="${anchor}">${esc(line)}</text>`);
            y += lineH;
        }
        y += 5;
    }

    // Helper: add line
    function addLine(color, width) {
        checkPage(20);
        currentPage.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${color}" stroke-width="${width}"/>`);
        y += 15;
    }

    // Helper: add table
    function addTable(headers, rows) {
        const cols = headers.length;
        const colW = CW / cols;
        const rowH = 28;
        const totalH = (rows.length + 1) * rowH + 10;
        checkPage(totalH);

        // Header
        currentPage.push(`<rect x="${M}" y="${y}" width="${CW}" height="${rowH}" fill="#2563eb" rx="4"/>`);
        for (let i = 0; i < cols; i++) {
            currentPage.push(`<text x="${M + i * colW + 10}" y="${y + 19}" font-size="12" fill="white" font-family="sans-serif" font-weight="bold">${esc(headers[i])}</text>`);
        }
        y += rowH;

        // Rows
        for (let r = 0; r < rows.length; r++) {
            const bg = r % 2 === 0 ? '#f8fafc' : '#e2e8f0';
            currentPage.push(`<rect x="${M}" y="${y}" width="${CW}" height="${rowH}" fill="${bg}"/>`);
            for (let c = 0; c < cols; c++) {
                currentPage.push(`<text x="${M + c * colW + 10}" y="${y + 19}" font-size="11" fill="#1e293b" font-family="sans-serif">${esc(String(rows[r][c] || ''))}</text>`);
            }
            y += rowH;
        }
        y += 10;
    }

    // Helper: add image from URL
    async function addImage(url, caption) {
        try {
            const res = await fetch(url);
            if (!res.ok) return false;
            const buf = Buffer.from(await res.arrayBuffer());
            const tmpImg = `/tmp/pdf_img_${Date.now()}.png`;
            fs.writeFileSync(tmpImg, buf);
            // Convert to base64
            const b64 = buf.toString('base64');
            const ext = url.includes('.png') ? 'image/png' : 'image/jpeg';
            
            checkPage(250);
            // Image placeholder (scaled to fit)
            const imgW = CW;
            const imgH = 180;
            currentPage.push(`<image x="${M}" y="${y}" width="${imgW}" height="${imgH}" href="data:${ext};base64,${b64}" preserveAspectRatio="xMidYMid meet"/>`);
            y += imgH + 5;
            if (caption) {
                addText(caption, 10, '#64748b', false, true);
            }
            fs.unlinkSync(tmpImg);
            return true;
        } catch (e) {
            console.log(`⚠️ PDF image gagal: ${e.message}`);
            return false;
        }
    }

    // Helper: add spacing
    function addSpacing(h) {
        checkPage(h);
        y += h;
    }

    // Helper: add bullet list
    function addBullets(items) {
        for (const item of items) {
            addText(`• ${item}`, 12, '#334155', false, false);
        }
    }

    // ===== BUILD CONTENT =====
    // Cover page
    if (title) {
        y = 250;
        addText(title, 28, '#1e293b', true, true);
        y += 10;
        if (subtitle) addText(subtitle, 16, '#64748b', false, true);
        y += 20;
        addLine('#2563eb', 3);
        y += 20;
        if (author) addText(`Disusun oleh: ${author}`, 12, '#64748b', false, true);
        addText(new Date().toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), 11, '#94a3b8', false, true);
        // New page after cover
        pageNum++;
        pages.push([]);
        currentPage = pages[pages.length - 1];
        y = M;
    }

    // Content blocks
    for (const block of content) {
        if (!block || !block.type) continue;

        switch (block.type) {
            case 'heading':
                addSpacing(10);
                addText(block.text || '', 18, '#1e293b', true, false);
                addLine('#2563eb', 2);
                break;
            case 'subheading':
                addSpacing(5);
                addText(block.text || '', 14, '#334155', true, false);
                break;
            case 'paragraph':
                addText(block.text || '', 12, '#334155', false, false);
                addSpacing(5);
                break;
            case 'bold':
                addText(block.text || '', 12, '#1e293b', true, false);
                addSpacing(3);
                break;
            case 'list':
                if (Array.isArray(block.items)) addBullets(block.items);
                addSpacing(5);
                break;
            case 'table':
                if (Array.isArray(block.headers) && Array.isArray(block.rows)) {
                    addTable(block.headers, block.rows);
                }
                break;
            case 'image':
                if (block.url) await addImage(block.url, block.caption || '');
                break;
            case 'divider':
                addLine('#cbd5e1', 1);
                break;
            case 'spacing':
                addSpacing(block.height || 20);
                break;
            case 'quote':
                checkPage(40);
                currentPage.push(`<rect x="${M}" y="${y - 5}" width="4" height="30" fill="#2563eb" rx="2"/>`);
                addText(block.text || '', 12, '#64748b', false, false);
                break;
            default:
                if (block.text) addText(block.text, 12, '#334155', false, false);
        }
    }

    // Add page numbers
    for (let i = 0; i < pages.length; i++) {
        pages[i].push(`<text x="${W/2}" y="${H - 25}" font-size="10" fill="#94a3b8" font-family="sans-serif" text-anchor="middle">— ${i + 1} / ${pages.length} —</text>`);
    }

    // Assemble SVG
    const svgParts = [
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H * pages.length}" viewBox="0 0 ${W} ${H * pages.length}">`,
        `<style>text { font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif; }</style>`,
        `<rect width="100%" height="100%" fill="white"/>`
    ];
    for (let i = 0; i < pages.length; i++) {
        const offsetY = i * H;
        svgParts.push(`<g transform="translate(0,${offsetY})">`);
        svgParts.push(`<rect width="${W}" height="${H}" fill="white" stroke="#e2e8f0" stroke-width="0.5"/>`);
        svgParts.push(...pages[i]);
        svgParts.push('</g>');
    }
    svgParts.push('</svg>');

    const svgContent = svgParts.join('\n');
    const svgPath = `/tmp/pdf_${name}_${Date.now()}.svg`;
    const pdfPath = `/tmp/pdf_${name}_${Date.now()}.pdf`;

    fs.writeFileSync(svgPath, svgContent);

    // Convert SVG → PDF
    const { execSync } = require('child_process');
    try {
        execSync(`rsvg-convert -f pdf "${svgPath}" -o "${pdfPath}"`, { timeout: 30000 });
        const pdfBuf = fs.readFileSync(pdfPath);
        // Cleanup
        fs.unlinkSync(svgPath);
        fs.unlinkSync(pdfPath);
        return pdfBuf;
    } catch (e) {
        console.log(`❌ PDF convert gagal: ${e.message}`);
        fs.unlinkSync(svgPath);
        return null;
    }
}

async function generateImage(prompt) {
    const fullPrompt = ALYA_IMAGE_STYLE + prompt;

    // Tier 1: Nano Banana via Gemini API
    if (GEMINI_API_KEY) {
        try {
            const res = await fetch(`${GEMINI_BASE}/gemini-2.5-flash-image:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: fullPrompt }] }],
                    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
                }),
                signal: AbortSignal.timeout(120000)
            });
            if (res.ok) {
                const data = await res.json();
                const parts = data.candidates?.[0]?.content?.parts || [];
                for (const p of parts) {
                    if (p.inlineData?.data) {
                        console.log('🍌 Gambar dibuat: Nano Banana');
                        return Buffer.from(p.inlineData.data, 'base64');
                    }
                }
            } else {
                console.log(`⚠️ Nano Banana ${res.status}, coba Cloudflare...`);
            }
        } catch (err) {
            console.log(`⚠️ Nano Banana error: ${err.message}`);
        }
    }

    // Tier 2: Cloudflare Workers AI
    try {
        return await generateWithCloudflare(fullPrompt);
    } catch (err) {
        console.log(`⚠️ Cloudflare: ${err.message}`);
    }

    throw new Error('Generate gambar gagal — set GEMINI_API_KEY dan/atau CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID di config.json');
}

// ========== VISION (baca gambar user) ==========
// Gemini dulu, Groq llama-4-scout fallback. Return deskripsi+OCR teks.
async function describeImage(imageBuffer, mimeType = 'image/jpeg') {
    const instruction = `Describe this image in detail. If there is any TEXT visible in the image, transcribe ALL of it exactly (this is important - read every word). Also describe what's happening in the scene.`;

    // Gemini vision
    if (GEMINI_API_KEY) {
        try {
            const res = await fetch(`${GEMINI_BASE}/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { inlineData: { mimeType, data: imageBuffer.toString('base64') } },
                            { text: instruction }
                        ]
                    }]
                })
            });
            if (res.ok) {
                const data = await res.json();
                const desc = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join(' ');
                if (desc) {
                    console.log('👁️ Vision: Gemini');
                    return desc;
                }
            } else {
                console.log(`⚠️ Gemini vision ${res.status}`);
            }
        } catch (err) {
            console.log(`⚠️ Gemini vision error: ${err.message}`);
        }
    }

    // Groq vision fallback (llama-4-scout, free tier)
    if (groq) {
        try {
            const completion = await groq.chat.completions.create({
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: instruction },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}` } }
                    ]
                }],
                max_tokens: 500
            });
            const desc = completion.choices?.[0]?.message?.content;
            if (desc) {
                console.log('👁️ Vision: Groq llama-4-scout');
                return desc;
            }
        } catch (err) {
            console.log(`⚠️ Groq vision error: ${err.message}`);
        }
    }

    return null; // ga ada key vision
}

// Download media dari message (langsung atau quoted)
async function downloadImageFrom(msgObj) {
    try {
        const im = msgObj.message?.imageMessage;
        // WA kadang kirim placeholder kosong (anti-tamper) → mediaKey kosong → download pasti gagal
        if (!im?.mediaKey) {
            console.log('⚠️ Media key kosong (placeholder WA), skip download');
            return null;
        }
        return await downloadMediaMessage(msgObj, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: async (s) => s });
    } catch (err) {
        console.log(`❌ Download media gagal: ${err.message}`);
        return null;
    }
}

// ========== VIDEO DOWNLOADER (.dl YouTube/Instagram/Facebook) ==========
const DL_DIR = path.join(os.tmpdir(), 'alya-dl');
const DL_MAX_FILESIZE = '80M';   // yt-dlp abort kalau lebih besar
const WA_VIDEO_LIMIT = 16 * 1024 * 1024; // 16MB → di atas ini kirim sbg document

function hasYtDlp() {
    try { execSync('yt-dlp --version', { stdio: 'pipe' }); return true; } catch { return false; }
}

function hasFfmpeg() {
    try { execSync('ffmpeg -version', { stdio: 'pipe' }); return true; } catch { return false; }
}

// Re-encode video agar compatible dengan WhatsApp
// WA requirements: H.264 video, AAC audio, MP4 container
async function reencodeForWhatsApp(inputPath) {
    if (!hasFfmpeg()) {
        console.log('⚠️ ffmpeg tidak terinstall, skip re-encode');
        return inputPath;
    }

    const outputPath = inputPath.replace(/\.[^.]+$/, '_wa.mp4');
    const inputSize = fs.statSync(inputPath).size;

    // Kalau sudah mp4 dan < 16MB, coba re-encode dulu
    const args = [
        '-i', inputPath,
        '-c:v', 'libx264',        // H.264 video codec
        '-preset', 'fast',         // encoding speed
        '-crf', '28',              // quality (28 = cukup bagus, file kecil)
        '-c:a', 'aac',             // AAC audio codec
        '-b:a', '128k',            // audio bitrate
        '-ac', '2',                // stereo
        '-ar', '44100',            // sample rate
        '-movflags', '+faststart', // MP4 fast start (streaming)
        '-y',                      // overwrite output
        outputPath
    ];

    // Kalau video terlalu besar, tambah scaling & bitrate limit
    if (inputSize > WA_VIDEO_LIMIT) {
        args.push('-vf', 'scale=-2:720');  // max 720p
        args.push('-maxrate', '2M');       // max bitrate 2Mbps
        args.push('-bufsize', '4M');
    }

    try {
        console.log(`🔄 Re-encode: ${path.basename(inputPath)} → WhatsApp format`);
        await new Promise((resolve, reject) => {
            execFile('ffmpeg', args, { timeout: 120000 }, (err, stdout, stderr) => {
                if (err) reject(new Error(stderr.substring(0, 200)));
                else resolve();
            });
        });

        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
            const outputSize = fs.statSync(outputPath).size;
            console.log(`✅ Re-encode OK: ${(inputSize / 1048576).toFixed(1)}MB → ${(outputSize / 1048576).toFixed(1)}MB`);
            // Hapus file asli
            try { fs.unlinkSync(inputPath); } catch {}
            return outputPath;
        }
    } catch (err) {
        console.log(`⚠️ Re-encode gagal: ${err.message}, pakai file asli`);
        try { fs.unlinkSync(outputPath); } catch {}
    }

    return inputPath;
}

// Primary: yt-dlp lokal (paling reliable utk YT/IG/FB)
function tryYtDlp(url) {
    return new Promise((resolve, reject) => {
        if (!hasYtDlp()) return reject(new Error('yt-dlp tidak terinstall'));
        fs.mkdirSync(DL_DIR, { recursive: true });
        const stamp = Date.now();
        const args = [
            '--no-playlist', '--no-warnings', '--quiet',
            '-f', 'b[height<=720][ext=mp4]/b[height<=720]/bv*+ba/b',
            '--merge-output-format', 'mp4',
            '--max-filesize', DL_MAX_FILESIZE,
            '-o', path.join(DL_DIR, `vid_${stamp}.%(ext)s`),
            url
        ];
        execFile('yt-dlp', args, { timeout: 180000 }, (err) => {
            if (err) return reject(new Error(`yt-dlp: ${err.message.substring(0, 80)}`));
            const files = fs.readdirSync(DL_DIR).filter(f => f.startsWith(`vid_${stamp}`));
            if (files.length === 0) return reject(new Error('file ga ketemu (private/kegedean?)'));
            resolve(path.join(DL_DIR, files[0]));
        });
    });
}

// Fallback: Cobalt API (public instances, tanpa binary)
async function tryCobalt(url) {
    const instances = [
        'https://cobalt-api.kwiatekmiki.com',
        'https://cobalt-backend.canine.tools'
    ];
    for (const base of instances) {
        try {
            console.log(`🌐 Coba Cobalt: ${base}`);
            const apiRes = await fetch(base + '/', {
                method: 'POST',
                headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, videoQuality: '720' }),
                signal: AbortSignal.timeout(30000)
            });
            const data = await apiRes.json();
            if (data.status !== 'tunnel' && data.status !== 'redirect') continue;

            const vidRes = await fetch(data.url, { signal: AbortSignal.timeout(120000) });
            if (!vidRes.ok) continue;
            const buf = Buffer.from(await vidRes.arrayBuffer());
            if (buf.length < 10000) continue; // kemungkinan error page

            fs.mkdirSync(DL_DIR, { recursive: true });
            const filePath = path.join(DL_DIR, `cobalt_${Date.now()}.mp4`);
            fs.writeFileSync(filePath, buf);
            return filePath;
        } catch (err) {
            console.log(`⚠️ Cobalt ${base} gagal: ${err.message}`);
        }
    }
    throw new Error('semua instance cobalt gagal');
}

// Kirim video: <=16MB sebagai video message, >16MB sebagai document
async function sendVideoFile(sock, sender, filePath, quotedMsg) {
    const size = fs.statSync(filePath).size;
    const buf = fs.readFileSync(filePath);

    if (size <= WA_VIDEO_LIMIT) {
        await sock.sendMessage(sender, {
            video: buf,
            mimetype: 'video/mp4',
            caption: 'nih videonya'
        }, { quoted: quotedMsg });
        console.log(`✅ Video terkirim (${(size / 1048576).toFixed(1)}MB, video message)`);
    } else {
        await sock.sendMessage(sender, {
            document: buf,
            mimetype: 'video/mp4',
            fileName: path.basename(filePath),
            caption: 'videonya gede, ak kirim sbg dokumen yaa'
        }, { quoted: quotedMsg });
        console.log(`✅ Video terkirim (${(size / 1048576).toFixed(1)}MB, document)`);
    }
}

function cleanupDownload(filePath) {
    try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// ========== MAIN BOT ==========
async function startAlyaBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        syncFullHistory: false,
        maxMsgRetryCount: 10,
        msgRetryCounterCache,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 0,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: true,
        shouldSyncHistoryMessage: () => false,
    });

    let botJids = new Set();
    let pairingRequested = false;

    sock.ev.on('creds.update', saveCreds);

    // Track user yang sedang mengetik (untuk fitur tunggu + natural timing)
    trackPresence(sock);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ===== PAIRING CODE — pattern OFFICIAL Baileys =====
        // Trigger saat event qr fire = tanda WhatsApp server SIAP.
        // Request terlalu cepat = kode muncul tapi gagal dipakai.
        if (qr && USE_OTP && !state.creds.registered && !pairingRequested) {
            pairingRequested = true;
            try {
                const phoneNumber = await askPhoneNumber();
                console.log(`\n📱 Requesting pairing code untuk: ${phoneNumber}...`);
                const code = await sock.requestPairingCode(phoneNumber);
                const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log('\n╔══════════════════════════════════════╗');
                console.log(`║   🔑 PAIRING CODE: ${formatted}   ║`);
                console.log('╚══════════════════════════════════════╝');
                console.log('\n⚠️  KODE HANYA BERLAKU 60 DETIK — masukkan SEKARANG!');
                console.log('WhatsApp HP > Perangkat Tertaut > Tautkan Perangkat >');
                console.log('Tautkan dengan Nomor Telepon > masukkan kode di atas');
                console.log('(Setelah sukses, bot akan reconnect otomatis — itu normal)\n');
            } catch (err) {
                console.error('❌ Gagal request pairing code:', err.message);
            }
        }

        if (qr && !USE_OTP) {
            console.clear();
            console.log('\n╔══════════════════════════════════════╗');
            console.log('║          SCAN QR CODE INI             ║');
            console.log('╚══════════════════════════════════════╝\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'open') {
            // Kumpulkan SEMUA format JID bot (fix hardcoded LID)
            botJids.add(sock.user.id);
            if (sock.user.lid) botJids.add(sock.user.lid);
            const normalized = jidNormalizedUser(sock.user.id);
            if (normalized) botJids.add(normalized);

            console.log('\n✅ Bot Alya udah konek nih!');
            console.log(`📢 Status Grup: ${ignoreGroups ? 'Diignore' : (kenzoOnlyMode ? 'Kenzo Only' : 'Ngerespon')}`);
            console.log(`👤 Bot JID: ${[...botJids].join(', ')}`);
            console.log(`💑 Kenzo JID: ${kenzoJid || 'Belum diketahui'}`);

            await sock.sendPresenceUpdate('available');

            // Fix memory leak: clear interval lama sebelum bikin baru
            if (keepAliveInterval) clearInterval(keepAliveInterval);
            keepAliveInterval = setInterval(async () => {
                if (sock.user && !sleepMode) {
                    await sock.sendPresenceUpdate('available').catch(() => {});
                }
            }, 5 * 60 * 1000);

            console.log('\n📁 Cek file stiker:');
            ['hehe.webp', 'hmph.webp', '3.webp', '4.webp', '5.webp'].forEach(f => {
                console.log(`   ${f}: ${fs.existsSync(`./${f}`) ? '✅' : '❌'}`);
            });

            // ========== SCHEDULED TASKS ==========
            // Cek sleep mode setiap menit
            setInterval(() => checkSleepMode(), 60 * 1000);

            // Jam 7 pagi: AI cari renungan sendiri via web search
            let lastRenunganDate = '';
            setInterval(async () => {
                const now = new Date();
                const hour = parseInt(now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }));
                const dateStr = now.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta' });
                
                if (hour === 7 && lastRenunganDate !== dateStr && !sleepMode && kenzoJid) {
                    lastRenunganDate = dateStr;
                    
                    // AI cari topik renungan sendiri
                    const topics = [
                        'renungan Alkitab pagi hari ini ayat inspiratif',
                        'fakta ilmiah menarik hari ini penemuan terbaru',
                        'berita positif inspiratif hari ini Indonesia',
                        'kutipan novel sastra indah bermakna',
                        'motivasi hidup kata kata bijak hari ini'
                    ];
                    const topic = topics[Math.floor(Math.random() * topics.length)];
                    
                    let renungan = '';
                    let source = topic;
                    
                    // Pakai Exa web search kalau ada
                    if (EXA_API_KEY) {
                        try {
                            const exaRes = await fetch('https://api.exa.ai/search', {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                    'x-api-key': EXA_API_KEY
                                },
                                body: JSON.stringify({
                                    query: topic,
                                    numResults: 3,
                                    type: 'auto'
                                })
                            });
                            
                            if (exaRes.ok) {
                                const exaData = await exaRes.json();
                                const results = exaData.results || [];
                                
                                if (results.length > 0) {
                                    // Ambil konten dari hasil search
                                    const searchContext = results.map(r => 
                                        `${r.title || ''}\n${r.text || r.snippet || ''}`
                                    ).join('\n\n');
                                    
                                    // AI rangkum & buat renungan
                                    const aiPrompt = `Kamu Alya, 20 tahun, pacarnya Kenzo. Sekarang pagi-pagi, kamu mau kirim renungan ke Kenzo.

Gaya bicaramu natural, manis, sedikit tsundere tapi hangat. Panggil dia "kenzo" atau "kamu". Bisa pakai "ohayouu", "pagi", "hey", dll.

Cari dan rangkum konten terbaik dari hasil pencarian ini, lalu buat renungan yang personal dan bermakna. Cukup 3-5 kalimat. Jangan pakai emoji berlebihan.

Contoh gaya:
- "hey kenzo, tadi aku baca sesuatu yang bikin aku mikir..."
- "pagi kenzo, tau ga sih..."
- "hey, jadi tadi aku nemu fakta menarik nih..."

Hasil pencarian:
${searchContext}

Topik: ${topic}

Tulis renungan dalam bahasa Indonesia yang natural, seolah-olah kamu lagi ngobrol langsung sama Kenzo.`;
                                    
                                    const aiRes = await callVyce([{ role: 'user', content: aiPrompt }]);
                                    if (aiRes) {
                                        renungan = aiRes;
                                        source = results[0]?.title || topic;
                                    }
                                }
                            }
                        } catch (e) {
                            console.log(`⚠️ Exa search gagal: ${e.message}`);
                        }
                    }
                    
                    // Fallback: AI generate sendiri tanpa search
                    if (!renungan) {
                        try {
                            const fallbackPrompt = `Kamu Alya, 20 tahun, pacarnya Kenzo. Sekarang pagi-pagi. Buat renungan singkat untuk Kenzo. Topik: ${topic}. Gunakan bahasa yang natural seperti lagi ngobrol. Panggil "kenzo" atau "kamu". Cukup 3-5 kalimat.`;
                            const aiRes = await callVyce([{ role: 'user', content: fallbackPrompt }]);
                            if (aiRes) renungan = aiRes;
                        } catch (e) {}
                    }
                    
                    if (renungan) {
                        await sock.sendMessage(kenzoJid, { text: renungan });
                        console.log(`🌅 Renungan pagi terkirim ke Kenzo`);
                    }
                }
            }, 60 * 1000);

            // Jam 05:00-06:00: random wake up & greeting
            const greetings = [
                'ohayouu pagi kenzo, udah bangun belum nih?',
                'hey pagi... tidurnya nyenyak ga semalem?',
                'selamat pagi sayang, jangan lupa sarapan ya',
                'morning kenzo! cuaca hari ini adem banget loh',
                'udah subuh belum? jangan lupa sholat yaa',
                'pagi pagi! hari ini banyak yang menanti kamu loh',
                'hey good morning! mimpi apa semalem?',
                'bangun dongg, udah pagi nih',
                'semangat pagi! hari ini pasti lebih baik dari kemarin',
                'hai, udah siap belum ngejawab hari ini?',
                'ohayo~ jangan males bangunnya yaa',
                'pagi kenzo, aku udah bangun duluan nih hehe',
                'good morning! udah mandi belum? jangan males ya',
                'hey, hari ini kita mulai hari yang baru yuks',
                'pagi pagi pagi! jangan lupa doa dulu sebelum mulai hari',
                'udah bangun kan? jangan tidur lagi yaa',
                'morning! aku kangen kamu pagi-pagi gini',
                'ohayouu, semoga harimu menyenangkan hari ini',
                'pagi kenzo, aku lagi dengerin lagu nih tiba-tiba inget kamu',
                'hey good morning! udah breakfast belum?'
            ];

            let lastGreetingHour = -1;
            setInterval(async () => {
                const now = new Date();
                const hour = parseInt(now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }));
                
                // Jam 05:00-06:00, hanya 1x per jam, belum sleep mode
                if (hour >= 5 && hour < 6 && lastGreetingHour !== hour && !sleepMode && kenzoJid) {
                    // Random chance (40% tiap menit)
                    if (Math.random() < 0.4) {
                        lastGreetingHour = hour;
                        const msg = greetings[Math.floor(Math.random() * greetings.length)];
                        
                        // Split text (50% chance)
                        if (Math.random() < 0.5 && msg.length > 20) {
                            const words = msg.split(' ');
                            const mid = Math.floor(words.length / 2);
                            const part1 = words.slice(0, mid).join(' ');
                            const part2 = words.slice(mid).join(' ');
                            
                            await sock.sendMessage(kenzoJid, { text: part1 });
                            await new Promise(r => setTimeout(r, 1500));
                            await sock.sendMessage(kenzoJid, { text: part2 });
                        } else {
                            await sock.sendMessage(kenzoJid, { text: msg });
                        }
                        console.log(`🌅 Morning greeting terkirim ke Kenzo`);
                    }
                }
                
                // Reset setiap jam baru
                if (hour !== lastGreetingHour) lastGreetingHour = -1;
            }, 60 * 1000);

            // Jam 05:00-06:00: proses sleep queue (pesan Kenzo saat sleep mode)
            const processedSleepMsgs = new Set();
            setInterval(async () => {
                const now = new Date();
                const hour = parseInt(now.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }));
                
                if (hour >= 5 && hour < 6 && sleepQueue.length > 0 && kenzoJid) {
                    // Proses 1-2 pesan per menit secara random
                    const count = Math.min(sleepQueue.length, Math.random() < 0.3 ? 2 : 1);
                    
                    for (let i = 0; i < count; i++) {
                        const queued = sleepQueue.shift();
                        if (!queued || processedSleepMsgs.has(queued.timestamp)) continue;
                        
                        processedSleepMsgs.add(queued.timestamp);
                        
                        try {
                            // AI jawab pesan Kenzo yang di-queue
                            const historyKey = `pacar:${config.pacar?.nomor || kenzoJid || 'unknown'}`;
                            const ai = await aiResponse(queued.text, historyKey, true, queued.senderName, {
                                key: { id: `sleep_${queued.timestamp}`, remoteJid: queued.sender },
                                name: queued.senderName,
                                content: queued.text
                            });
                            
                            if (ai && ai.parts) {
                                // Random delay 5-30 detik biar natural
                                await new Promise(r => setTimeout(r, (Math.random() * 25 + 5) * 1000));
                                
                                // Kirim jawaban dengan quote pesan asli (opsional)
                                const replyText = `eh iya, tadi kamu bilang "${queued.text.substring(0, 30)}${queued.text.length > 30 ? '...' : ''}" ya?\n\n`;
                                
                                for (const part of ai.parts) {
                                    await sock.sendMessage(kenzoJid, { text: replyText + part.text });
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                                
                                // Simpan history
                                chatHistory.push({ sender: historyKey, role: 'user', content: queued.text, timestamp: queued.timestamp });
                                chatHistory.push({ sender: historyKey, role: 'assistant', content: ai.parts.map(p => p.text).join(' | '), timestamp: Date.now() });
                                saveHistory();
                                
                                console.log(`😴→☀️ Sleep queue dijawab: "${queued.text.substring(0, 30)}..."`);
                            }
                        } catch (err) {
                            console.log(`❌ Sleep queue error: ${err.message}`);
                        }
                    }
                    
                    // Cleanup processed messages
                    if (processedSleepMsgs.size > 100) processedSleepMsgs.clear();
                }
            }, 60 * 1000);
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || 'unknown';

            // 401 = logged out permanen
            if (statusCode === DisconnectReason.loggedOut) {
                console.log('❌ Logged out. Hapus folder sesi & login ulang:');
                console.log(`   rm -rf ${SESSION_DIR} && node alya.js --otp`);
                fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                process.exit(1);
            }

            // 515 = restartRequired — NORMAL setelah pair-success!
            // WA menutup koneksi sengaja; WAJIB reconnect pakai creds baru
            // agar pairing final. Kalau tidak reconnect → HP tampil "couldn't link".
            if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                console.log('🔄 Restart required (515) — normal setelah pairing, reconnecting...');
                setTimeout(() => startAlyaBot(), 1500);
                return;
            }

            // 408 = QR refs habis (kode terlalu lama dimasukkan / timeout)
            if (statusCode === 408) {
                console.log('⏱️ Kode kedaluwarsa/timeout (408). Coba lagi — masukkan kode SEGERA (<60 detik)!');
            } else {
                console.log(`📴 Koneksi putus (code: ${statusCode}, ${reason}), reconnect dalam 3 detik...`);
            }
            setTimeout(() => startAlyaBot(), 3000);
        }
    });

    sock.ev.on('contacts.update', async (updates) => {
        for (const contact of updates) {
            const jid = jidNormalizedUser(contact.id);
            if (contact.name && jid) {
                contactsCache[jid] = contact.name;
                contactsCache[jid.split(':')[0]] = contact.name;
            }
            if (contact.name?.toLowerCase().includes('kenzo') && jid) {
                kenzoJid = jid;
                kenzoJids.add(jid);
                config.pacar.jid = kenzoJid;
                config.pacar.jids = [...kenzoJids];
                config.pacar.nomor = kenzoJid.split('@')[0];
                saveConfig();
                console.log(`✅ Ketemu Kenzo dari kontak! JID: ${kenzoJid}`);
            }
        }
    });

    // ========== AUTO-LEAVE: Bot masuk grup baru → langsung leave ==========
    // Track grup yang sudah ada sebelum bot start (grup ini TIDAK akan di-leave)
    const existingGroups = new Set();
    
    // Load grup yang sudah ada dari config
    if (config.knownGroups) {
        for (const gid of config.knownGroups) {
            existingGroups.add(gid);
        }
    }

    // Saat connected, scan semua grup yang ada dan tandai sebagai existing
    sock.ev.on('connection.update', async (update) => {
        if (update.connection === 'open') {
            try {
                const groups = await sock.groupFetchAllParticipating();
                for (const gid of Object.keys(groups)) {
                    existingGroups.add(gid);
                }
                // Simpan ke config supaya persist
                config.knownGroups = [...existingGroups];
                saveConfig();
                console.log(`📋 Grup existing ditandai: ${existingGroups.size} grup`);
            } catch (e) {
                console.log(`⚠️ Gagal scan grup: ${e.message}`);
            }
        }
    });

    // Handle bot di-add ke grup
    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;
        
        // Hanya proses jika bot yang di-add
        if (action !== 'add') return;
        
        const botJid = sock.user?.id?.replace(/:.*@/, '@');
        const isBotAdded = participants.some(p => p === botJid || p.replace(/:.*@/, '@') === botJid);
        
        if (!isBotAdded) return;
        
        // Cek apakah ini grup baru (belum ada di existingGroups)
        if (existingGroups.has(id)) {
            console.log(`✅ Grup existing: ${id} (tidak di-leave)`);
            return;
        }
        
        // Grup baru → leave!
        console.log(`🚫 Grup baru terdeteksi: ${id} → auto-leave`);
        try {
            // Kirim pesan dulu (opsional, biar admin tau)
            await sock.sendMessage(id, { text: 'maaf ya aku harus pergi dulu 👋' }).catch(() => {});
            
            // Delay sebentar biar pesan kekirim
            await new Promise(r => setTimeout(r, 1500));
            
            // Leave grup
            await sock.groupLeave(id);
            console.log(`✅ Berhasil leave grup: ${id}`);
        } catch (err) {
            console.log(`❌ Gagal leave grup ${id}: ${err.message}`);
        }
    });

    // Fix: proses SEMUA pesan dalam batch, bukan cuma messages[0]
    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            try {
                await handleMessage(sock, msg, botJids);
            } catch (err) {
                console.error('❌ Message handler error:', err.message);
            }
        }
    });

    return sock;
}

// ========== MESSAGE HANDLER ==========
async function handleMessage(sock, msg, botJids) {
    if (!msg.message) return;

    const sender = msg.key.remoteJid;
    if (msg.key.fromMe) return;

    // Skip newsletter/channel & status broadcast — bukan chat, cuma boros token
    if (sender.includes('@newsletter') || sender.includes('@broadcast')) return;

    // Filter pesan dari bot sendiri (dinamis, bukan hardcoded)
    const senderClean = (msg.key.participant || sender).split(':')[0];
    for (const b of botJids) {
        if (senderClean === b.split(':')[0]) return;
    }

    const isGroup = sender.includes('@g.us');
    const text = msg.message.conversation ||
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption ||
                 msg.message.videoMessage?.caption ||
                 '';

    // Hasil game (ranking/poin/jawaban) → IGNORE TOTAL dan MENANG atas semua,
    // bahkan kalau pesannya me-tag kita atau mengandung kata "tebak bendera"
    // (bot kuis ngetag pemenang di ranking!). Tanpa ini bot ikut ngomentin
    // hasil & kelihatan jawab sendiri.
    if (isQuizResultMessage(text)) {
        console.log('🚫 Hasil game terdeteksi — diabaikan');
        return;
    }

    // ========== SLEEP MODE CHECK ==========
    checkSleepMode();
    if (sleepMode) {
        const senderIsKenzo = kenzoJids.has(sender) || kenzoJids.has(msg.key.participant || sender);
        if (senderIsKenzo) {
            // Simpan pesan Kenzo ke queue, dijawab jam 05:00-06:00
            if (text && text.trim()) {
                sleepQueue.push({
                    sender,
                    text: text.trim(),
                    senderName,
                    timestamp: Date.now()
                });
                console.log(`😴 Sleep mode: pesan Kenzo di-queue (${sleepQueue.length} antrian)`);
                
                // Kasih reaksi aja biar tau pesan diterima
                await sock.sendMessage(sender, { react: { text: '😴', key: msg.key } }).catch(() => {});
            }
            return;
        } else {
            // Bukan Kenzo → tetap sleep
            console.log('😴 Sleep mode: pesan non-Kenzo diabaikan');
            return;
        }
    }

    // Deteksi kuis game bot (tebak bendera) — 1 pesan cuma dijawab sekali
    let isQuiz = isFlagQuizMessage(text);
    if (isQuiz) {
        if (quizAnsweredIds.has(msg.key.id)) {
            isQuiz = false;
        } else {
            quizAnsweredIds.add(msg.key.id);
            if (quizAnsweredIds.size > 200) quizAnsweredIds.clear();
        }
    }

    // Deteksi gambar: langsung dikirim ATAU di-reply
    const directImage = msg.message.imageMessage || null;
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedImage = quoted?.imageMessage || null;

    // Deteksi file: .txt atau .csv
    const directDoc = msg.message.documentMessage || null;
    const quotedDoc = quoted?.documentMessage || null;
    const activeDoc = directDoc || quotedDoc;
    let docContent = null;
    if (activeDoc) {
        const fileName = activeDoc.fileName || '';
        const ext = fileName.substring(fileName.lastIndexOf('.')).toLowerCase();
        if (ext === '.txt' || ext === '.csv') {
            try {
                const buf = await downloadImageFrom(directDoc ? msg : { key: msg.key, message: { documentMessage: activeDoc } });
                if (buf) {
                    docContent = buf.toString('utf8');
                    console.log(`📄 File terdeteksi: ${fileName} (${docContent.length} chars)`);
                }
            } catch (err) {
                console.log(`⚠️ Gagal baca file: ${err.message}`);
            }
        }
    }

    // Gambar tanpa caption, tanpa reply, tanpa file → stop
    if (!text && !directImage && !quotedImage && !docContent) return;

    const senderParticipant = msg.key.participant || sender;
    const senderName = msg.pushName || getContactName(senderParticipant) || getContactName(sender) || '';

    // Auto read private chat (skip saat sleep mode biar centang abu-abu)
    if (!isGroup && !sleepMode) {
        await sock.readMessages([msg.key]).catch(() => {});
    }

    // Pacar = cocok dengan SALAH SATU identitas Kenzo yang sudah dipelajari
    const isPacar = kenzoJids.has(senderParticipant) || kenzoJids.has(sender);

    // ========== LOGIKA RESPON GRUP — SEBELUM proses apa pun (hemat token!) ==========
    // Kalau grup di-ignore / bukan Kenzo / ga tag bot → STOP di sini.
    // Vision/download/AI tidak akan jalan buat pesan yang ga akan dibales.
    // ignoreGroups=true   → grup diemin TOTAL termasuk kuis, private tetap dibales
    // ignoreGroups=false  → kuis game bot WAJIB dijawab walau tanpa tag & bukan Kenzo
    // kenzoOnlyMode=true  → grup: HANYA Kenzo (yg tag/quote bot) dibales
    // dua-duanya=false    → siapa pun boleh, TAPI harus tag/quote bot dulu
    if (isGroup) {
        if (ignoreGroups) return;

        // Kuis dikirim oleh BOT KUIS — mustahil ngetag kita, jadi dilewati dr cek ini
        if (kenzoOnlyMode && !isPacar && !isQuiz) {
            console.log('🚫 Grup kenzo-only: bukan Kenzo');
            return;
        }

        const tagged = isTaggedOrQuotedBy(msg, senderParticipant, botJids);
        if (!tagged && !isQuiz) {
            console.log(`🚫 Grup: ga ada tag/quote ke bot`);
            console.log(`   botJids: [${[...botJids].join(', ')}]`);
            const ci = extractContextInfo(msg.message);
            if (ci) {
                console.log(`   mentions: ${JSON.stringify(ci.mentionedJid || [])}`);
                console.log(`   quotedParticipant: ${ci.participant || '-'}`);
            } else {
                console.log(`   (pesan tanpa contextInfo — ketik @ untuk tag)`);
            }
            return;
        }
        if (isQuiz) {
            console.log('🚩 Kuis tebak bendera terdeteksi — jawab otomatis');
        } else {
            console.log('✅ Bot di-tag/quote di grup, lanjut...');
        }
    }

    // ===== HISTORY KEY: pacar = 1 thread gabungan (private + grup) =====
    // Kenzo chat di private maupun di grup → context-nya nyambung
    const historyKey = isPacar
        ? `pacar:${config.pacar?.nomor || kenzoJid || 'unknown'}`
        : sender;

    // ===== VISION: baca gambar langsung dari user =====
    let imageContext = '';
    let visionImageBuffer = null;
    let visionImageMime = 'image/jpeg';
    if (directImage) {
        console.log('🖼️ Gambar terdeteksi (langsung), download untuk vision...');
        const buf = await downloadImageFrom(msg);
        if (buf) {
            visionImageBuffer = buf;
            visionImageMime = directImage.mimetype || 'image/jpeg';
            imageContext = '[User mengirim gambar — gambar akan dideskripsikan oleh Gemini]';
        } else {
            imageContext = '\n[User mengirim gambar tapi gagal didownload]';
        }
    }

    // ===== VISION: baca gambar yang DI-REPLY user =====
    if (quotedImage && !visionImageBuffer) {
        console.log('🖼️ Reply ke gambar terdeteksi, download untuk vision...');
        const buf = await downloadImageFrom({ key: msg.key, message: { imageMessage: quotedImage } });
        if (buf) {
            visionImageBuffer = buf;
            visionImageMime = quotedImage.mimetype || 'image/jpeg';
            imageContext = '[User mereply gambar — gambar akan dideskripsikan oleh Gemini]';
        } else {
            imageContext = '\n[Gambar yang di-reply gagal didownload]';
        }
    }

    // Quoted context: teks dari conversation / extended / caption media apa pun
    const quotedText = quoted ? (
        quoted.conversation ||
        quoted.extendedTextMessage?.text ||
        quoted.imageMessage?.caption ||
        quoted.videoMessage?.caption ||
        quoted.documentMessage?.caption ||
        ''
    ) : '';

    let promptForAI;
    if (quotedImage) {
        // Reply ke gambar → vision sudah jalan; caption foto jadi hint tambahan
        promptForAI = (text || 'tolong jawab yang ada di gambar ini') +
            (quotedText ? `\n[Caption di gambar yang di-reply]: ${quotedText}` : '');
    } else if (quotedText) {
        // Reply ke TEKS → isi quoted adalah TARGET jawaban utama,
        // bukan cuma instruksi "coba balas pesan ini"
        promptForAI = `User mereply pesan ini: "${quotedText}"\nInstruksi user: "${text}". Jawab isi pesan yang di-reply secara singkat.`;
    } else {
        promptForAI = text || 'lihat gambar ini';
    }
    promptForAI = imageContext + promptForAI;

    // ========== FILE CONTEXT: kalau user kirim file .txt/.csv ==========
    if (docContent) {
        const fileName = activeDoc.fileName || 'file';
        const maxLen = 3000;
        const truncated = docContent.length > maxLen ? docContent.substring(0, maxLen) + '... (dipotong)' : docContent;
        promptForAI += `\n[KONTEN FILE ${fileName}]:\n${truncated}`;
        console.log(`📄 File context ditambahkan ke prompt`);
    }

    // ========== WEB FETCH: kalau user kirim link, fetch kontennya ==========
    const urls = extractUrls(text);
    if (urls.length > 0) {
        for (const url of urls.slice(0, 2)) { // max 2 URL
            try {
                console.log(`🌐 Fetching: ${url.substring(0, 60)}...`);
                const webContent = await fetchWebContent(url);
                if (webContent) {
                    promptForAI += `\n[KONTEN WEB dari ${url}]:\n${webContent}`;
                    console.log(`✅ Web fetched: ${webContent.substring(0, 80)}...`);
                }
            } catch (err) {
                console.log(`⚠️ Fetch gagal: ${err.message}`);
            }
        }
    }

    // Kuis tebak bendera → paksa jawaban nama negara SAJA.
    // Game bot nilai jawaban lewat reply, jadi ga boleh ada kata lain.
    // Format soal (lihat prompt2.txt): "🚩 TEBAK BENDERA 🚩 / Bendera negara apa ini? 🇵🇪"
    if (isQuiz) {
        promptForAI = `${imageContext}[PESAN GAME QUIZ]:\n${text}\n\nIni soal kuis tebak bendera. Jawab HANYA nama negara dari bendanya dalam bahasa Indonesia — SATU kata huruf kecil (contoh: peru). TANPA kata pembuka/penutup, TANPA emoji, TANPA tanda baca.`;
        console.log('🚩 Mode kuis: jawab nama negara saja');
    }

    // Balasan bot nge-quote LANGSUNG ke pesan yang di-reply user
    // (pesan A), bukan ke pesan instruksi/tag-nya (pesan B)
    const qCtx = msg.message.extendedTextMessage?.contextInfo;
    const quoteTargetMsg = (qCtx?.stanzaId && quoted) ? {
        key: {
            remoteJid: sender,
            id: qCtx.stanzaId,
            fromMe: false,
            participant: qCtx.participant || senderParticipant
        },
        message: quoted
    } : null;

    console.log(`\n📨 Pesan masuk:`);
    console.log(`   Dari: ${senderName || '?'} (${senderParticipant})`);
    console.log(`   Grup: ${isGroup} | Teks: ${(text || '(gambar)').substring(0, 50)}`);

    // Fix: Deteksi Kenzo HANYA dari nama pengirim (bukan isi pesan!)
    // Dulu: siapa pun yang nulis "kenzo" di grup → JID-nya disimpan sbg pacar 😱
    // Sekarang: pelajari SEMUA format JID Kenzo (LID & s.whatsapp.net beda angka)
    const nameLooksLikeKenzo = senderName.toLowerCase().includes('kenzo');
    if (nameLooksLikeKenzo || (!isGroup && text.toLowerCase().includes('kenzo'))) {
        kenzoJid = isGroup ? senderParticipant : sender;
        const before = kenzoJids.size;
        kenzoJids.add(kenzoJid);
        if (!isGroup) kenzoJids.add(sender); // private: chat-jid & participant sama saja, jaga2 device-suffix
        config.pacar.jid = kenzoJid;
        config.pacar.jids = [...kenzoJids];
        config.pacar.nomor = kenzoJid.split('@')[0];
        saveConfig();
        if (kenzoJids.size !== before) {
            console.log(`📝 Identitas Kenzo dicatat: ${kenzoJid} (total ${kenzoJids.size}: ${[...kenzoJids].join(', ')})`);
        }
    }

    // ========== COMMAND DI PRIVATE CHAT ==========
    if (isPacar && !isGroup) {
        const cmd = text.toLowerCase().trim();

        if (cmd === '!grub ignore') {
            ignoreGroups = true; kenzoOnlyMode = false; saveSettings();
            await sock.sendMessage(sender, { text: 'iy dh, grub diignore smua' }, { quoted: msg });
            return;
        }
        if (cmd === '!grub unignore') {
            ignoreGroups = false; kenzoOnlyMode = false; saveSettings();
            await sock.sendMessage(sender, { text: 'okeyyy skrg bot bales smua chat di grub' }, { quoted: msg });
            return;
        }
        if (cmd === '!kenzo on') {
            ignoreGroups = false; kenzoOnlyMode = true; saveSettings();
            await sock.sendMessage(sender, { text: 'iy dh, skrg cuma njo yg bot bales di grub. tag/quote aja yaa' }, { quoted: msg });
            return;
        }
        if (cmd === '!kenzo off') {
            kenzoOnlyMode = false; saveSettings();
            await sock.sendMessage(sender, { text: 'okeyyy skrg bot bales smua org di grub' }, { quoted: msg });
            return;
        }
        if (cmd === '!status') {
            const status = `ignoreGroups: ${ignoreGroups}\nkenzoOnlyMode: ${kenzoOnlyMode}\nkenzoJid: ${kenzoJid || 'null'}\nbotJids: ${[...botJids].join(', ')}`;
            await sock.sendMessage(sender, { text: status }, { quoted: msg });
            return;
        }
    }

    // ========== COMMAND .dl (download video) ==========
    if (/^\.dl(\s|$)/i.test(text.trim())) {
        const url = text.trim().split(/\s+/)[1];
        if (!url || !/^https?:\/\//i.test(url)) {
            await sock.sendMessage(sender, { text: 'formatnya: .dl <link>\ncontoh: .dl https://youtube.com/watch?v=xxx' }, { quoted: msg });
            return;
        }

        console.log(`📥 Download request: ${url}`);
        let filePath = null;

        try {
            // Primary: yt-dlp → Fallback: Cobalt API
            try {
                filePath = await tryYtDlp(url);
            } catch (errYt) {
                console.log(`⚠️ ${errYt.message}, coba cobalt...`);
                filePath = await tryCobalt(url);
            }
            // Re-encode agar compatible dengan WhatsApp (H.264 + AAC)
            filePath = await reencodeForWhatsApp(filePath);
            await sendVideoFile(sock, sender, filePath, msg);
        } catch (errDl) {
            console.log(`❌ Download gagal: ${errDl.message}`);
            await sock.sendMessage(sender, { text: 'waduh gagal dl-nya, linknya public ga? coba link lain' }, { quoted: msg });
        } finally {
            cleanupDownload(filePath);
        }
        if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
        return;
    }

    // Tunggu kalau user masih mengetik (biar ga tabrakan & lebih natural)
    await waitForUserFinishTyping(sender);

    // Deteksi mode pembelajaran (matematika/fisika)
    const learningMode = isLearningMessage(text);

    // AI Response (VyceAI primary, Kiosapi fallback 1, OpenCode fallback 2, Groq final fallback)
    const ai = await aiResponse(promptForAI, historyKey, isPacar, senderName, {
        key: msg.key,
        name: senderName,
        content: text || '(gambar)'
    }, learningMode, visionImageBuffer, visionImageMime);

    // ========== SEARCH FLOW: AI minta search → bot search → AI jawab final ==========
    if (ai && ai.needSearch && ai.searchQuery) {
        // Kirim pesan sementara ke user (misal "ntar aku cek ya")
        if (ai.pendingParts && ai.pendingParts.length > 0) {
            for (const part of ai.pendingParts) {
                await simulateTyping(sock, sender, part.text);
                await sock.sendMessage(sender, { text: part.text }, { quoted: quoteTargetMsg || msg });
                await new Promise(r => setTimeout(r, 500));
            }
        }

        // Lakukan search
        try {
            console.log(`🔍 Searching: "${ai.searchQuery}"`);
            const searchResults = await exaSearch(ai.searchQuery);
            if (searchResults) {
                console.log(`✅ Search OK: ${searchResults.substring(0, 80)}...`);
                // AI lagi dengan hasil search
                const finalAI = await aiSearchFollowUp(ai.messages, ai.searchQuery, searchResults);
                if (finalAI && finalAI.parts) {
                    await sendSplitMessages(sock, sender, msg, finalAI.parts, [], quoteTargetMsg || msg);
                    console.log(`💬 Search response (${finalAI.parts.length} pesan)`);
                    chatHistory.push({ sender: historyKey, role: 'user', content: text || '(gambar)', timestamp: Date.now(), name: senderName, msgId: msg.key.id, key: { remoteJid: sender, id: msg.key.id, fromMe: false, participant: msg.key.participant } });
                    chatHistory.push({ sender: historyKey, role: 'assistant', content: finalAI.parts.map(p => p.text).join(' | '), timestamp: Date.now() });
                    saveHistory();
                }
            } else {
                console.log('⚠️ Search results kosong');
            }
        } catch (err) {
            console.log(`❌ Search gagal: ${err.message}`);
        }
        if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
        return;
    }

    // ========== DEEP SEARCH: AI minta deep search ==========
    if (ai && ai.search && ai.search.query) {
        await sock.sendMessage(sender, { text: `lagi aku cariin "${ai.search.query}" ya, banyak nih sumbernya 🔍` }, { quoted: msg });
        
        try {
            const searchResults = await deepSearch(ai.search.query, ai.search.mode, ai.search.limit);
            
            // Cari gambar relevan juga untuk nambah konteks
            let searchImages = [];
            try {
                searchImages = await searchPinterest(ai.search.query, 3);
            } catch (e) {}
            
            if (searchResults.length > 0) {
                // Format hasil search
                let searchContext = `Hasil pencarian untuk "${ai.search.query}":\n\n`;
                searchResults.forEach((r, i) => {
                    searchContext += `${i + 1}. ${r.title || 'Tanpa judul'}\n`;
                    searchContext += `   URL: ${r.url}\n`;
                    searchContext += `   ${r.text.substring(0, 200)}...\n\n`;
                });
                
                // AI summarize hasil search via Kiosapi
                const summarizePrompt = `Kamu Alya, 20 tahun, pacarnya Kenzo. Berikut hasil pencarian dari internet. Rangkum dan buat jawaban yang lengkap, akurat, dan menarik dalam gaya bicaramu yang natural. Jika ada banyak sumber, ranking berdasarkan relevansi.

${searchContext}

Topik: ${ai.search.query}

Buat jawaban yang informatif, personal, dan mudah dipahami.`;
                
                const finalAI = await callKiosapi([{ role: 'user', content: summarizePrompt }], 2, KIOSAPI_MODEL);
                
                if (finalAI) {
                    // Kirim gambar relevan dulu (untuk konteks visual)
                    if (searchImages.length > 0) {
                        for (const img of searchImages.slice(0, 2)) {
                            try {
                                const res = await fetch(img.url);
                                if (res.ok) {
                                    const buf = Buffer.from(await res.arrayBuffer());
                                    await sock.sendMessage(sender, {
                                        image: buf,
                                        caption: img.title || ai.search.query
                                    }, { quoted: msg });
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                            } catch (e) {}
                        }
                    }
                    
                    // Kirim link sumber dulu
                    const sources = searchResults.slice(0, 3).map(r => `• ${r.title}: ${r.url}`).join('\n');
                    await sock.sendMessage(sender, { text: `📖 *Sumber yang aku temukan:*\n${sources}` }, { quoted: msg });
                    await new Promise(r => setTimeout(r, 1000));
                    
                    // Kirim rangkuman
                    const parts = autoSplitLongText(finalAI, 150);
                    for (const part of parts) {
                        await sock.sendMessage(sender, { text: part }, { quoted: msg });
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    
                    console.log(`🔍 Deep search response: ${searchResults.length} sumber, ${searchImages.length} gambar`);
                    chatHistory.push({ sender: historyKey, role: 'user', content: text, timestamp: Date.now(), name: senderName, msgId: msg.key.id, key: { remoteJid: sender, id: msg.key.id, fromMe: false, participant: msg.key.participant } });
                    chatHistory.push({ sender: historyKey, role: 'assistant', content: finalAI.substring(0, 200), timestamp: Date.now() });
                    saveHistory();
                }
            } else {
                await sock.sendMessage(sender, { text: 'waduh ga nemu hasil yang relevan nih 😅' }, { quoted: msg });
            }
        } catch (err) {
            console.log(`❌ Deep search gagal: ${err.message}`);
            await sock.sendMessage(sender, { text: 'search-nya gagal nih, coba lagi nanti ya' }, { quoted: msg });
        }
        
        if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
        return;
    }

    // ========== VIDEO SEARCH: AI minta cari video ==========
    if (ai && ai.video && ai.video.query) {
        await sock.sendMessage(sender, { text: `lagi aku cariin video "${ai.video.query}" ya 🎬` }, { quoted: msg });
        
        try {
            const videos = await searchVideoUrls(ai.video.query, ai.video.limit);
            
            if (videos.length > 0) {
                let response = `🎬 *Video yang aku temukan:*\n\n`;
                videos.forEach((v, i) => {
                    response += `${i + 1}. ${v.title || 'Video'}\n`;
                    response += `   Platform: ${v.platform}\n`;
                    response += `   ${v.url}\n\n`;
                });
                
                await sock.sendMessage(sender, { text: response }, { quoted: msg });
                console.log(`🎬 Video search: ${videos.length} hasil`);
            } else {
                await sock.sendMessage(sender, { text: 'ga nemu video yang cocok nih 😅' }, { quoted: msg });
            }
        } catch (err) {
            console.log(`❌ Video search gagal: ${err.message}`);
            await sock.sendMessage(sender, { text: 'search video gagal nih' }, { quoted: msg });
        }
        
        if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
        return;
    }

    // ========== SONG SEARCH: AI minta cari lagu ==========
    if (ai && ai.song && ai.song.query) {
        await sock.sendMessage(sender, { text: `lagi aku cariin lagu "${ai.song.query}" ya 🎵` }, { quoted: msg });
        
        try {
            const songs = await searchSoundCloud(ai.song.query, ai.song.limit);
            
            if (songs.length > 0) {
                // Kirim info lagu dulu
                let response = `🎵 *Lagu yang aku temukan:*\n\n`;
                songs.forEach((s, i) => {
                    response += `${i + 1}. ${s.title}\n`;
                    response += `   Artist: ${s.artist}\n`;
                    response += `   ${s.url}\n\n`;
                });
                await sock.sendMessage(sender, { text: response }, { quoted: msg });
                
                // Download & kirim lagu pertama
                const song = songs[0];
                await sock.sendMessage(sender, { text: `lagu pertama aku download dulu ya 🎧` }, { quoted: msg });
                
                const dlPath = `/tmp/song_${Date.now()}.mp3`;
                try {
                    const { execSync } = require('child_process');
                    execSync(`yt-dlp -x --audio-format mp3 --audio-quality 128K -o "${dlPath}" "${song.url}" 2>/dev/null`, { timeout: 60000 });
                    
                    if (fs.existsSync(dlPath)) {
                        const songBuf = fs.readFileSync(dlPath);
                        await sock.sendMessage(sender, {
                            audio: songBuf,
                            mimetype: 'audio/mpeg',
                            ptt: false
                        }, { quoted: msg });
                        
                        // Cleanup
                        fs.unlinkSync(dlPath);
                        console.log(`🎵 Lagu terkirim: ${song.title}`);
                    }
                } catch (e) {
                    console.log(`⚠️ Download lagu gagal: ${e.message}`);
                    await sock.sendMessage(sender, { text: 'download lagunya gagal nih, link-nya aja ya' }, { quoted: msg });
                }
            } else {
                await sock.sendMessage(sender, { text: 'ga nemu lagu yang cocok nih 😅' }, { quoted: msg });
            }
        } catch (err) {
            console.log(`❌ Song search gagal: ${err.message}`);
            await sock.sendMessage(sender, { text: 'search lagu gagal nih' }, { quoted: msg });
        }
        
        if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
        return;
    }

    // AI gagal total → balas stiker doang (jangan teks error jelek)
    if (!ai) {
        console.log('⚠️ AI gagal, kirim stiker sebagai respon');
        if (isPacar && !isGroup) {
            await sendRandomSticker(sock, sender);
        } else {
            // non-Kenzo / grup: diam aja biar ga spam stiker ke orang lain
            chatHistory.push({ sender: historyKey, role: 'user', content: text || '(gambar)', timestamp: Date.now(), name: senderName });
            saveHistory();
        }
        if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
        return;
    }

    const parts = ai.parts;

    // Anti self-echo: kalau respon AI PERSIS ucapan terakhirmu sendiri
    // (model nerusin thread sendiri), buang — jangan kirim apa2.
    // Kuis dikecualikan (jawaban singkat bisa kebetulan sama, mis. 2 soal Peru)
    if (!isQuiz) {
        const lastAssistant = [...chatHistory]
            .reverse()
            .find(h => h.sender === historyKey && h.role === 'assistant');
        if (lastAssistant) {
            const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const newJoined = norm(parts.map(p => p.text).join(' '));
            const oldNorm = norm(lastAssistant.content);
            if (newJoined && oldNorm && newJoined === oldNorm) {
                console.log('⚠️ Self-echo terdeteksi (AI ngulang ucapan sendiri) — dibuang');
                if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
                return;
            }
        }
    }

    // ========== MODE PEMBELAJARAN (SVG + split text) ==========
    if (learningMode && ai.rawResponse) {
        const learned = parseLearningResponse(ai.rawResponse);
        if (learned.svg) {
            console.log(`📚 Mode pembelajaran: ${learned.title || 'topik'}`);
            try {
                // Konversi SVG → JPG
                const jpgBuffer = await svgToJpg(learned.svg);
                if (jpgBuffer) {
                    // Kirim gambar dulu
                    await simulateTyping(sock, sender, learned.title || 'penjelasan');
                    await sock.sendMessage(sender, {
                        image: jpgBuffer,
                        caption: learned.title || 'nih penjelasannya'
                    }, { quoted: quoteTargetMsg || msg });
                    console.log('✅ Gambar pembelajaran terkirim');
                } else {
                    console.log('⚠️ SVG → JPG gagal, lanjut teks saja');
                }
            } catch (err) {
                console.log(`❌ Gagal convert SVG: ${err.message}`);
            }

            // Kirim explanation sebagai split text
            if (learned.explanation) {
                const explParts = autoSplitLongText(learned.explanation, 180)
                    .map(t => ({ text: t, replyTo: null }));
                await sendSplitMessages(sock, sender, msg, explParts, [], null);
                console.log(`💬 Penjelasan (${explParts.length} pesan)`);
            }

            // Simpan history
            chatHistory.push({ sender: historyKey, role: 'user', content: text || '(gambar)', timestamp: Date.now(), name: senderName, msgId: msg.key.id, key: { remoteJid: sender, id: msg.key.id, fromMe: false, participant: msg.key.participant } });
            chatHistory.push({ sender: historyKey, role: 'assistant', content: `[belajar] ${learned.title || ''}: ${(learned.explanation || '').substring(0, 100)}`, timestamp: Date.now() });
            saveHistory();
            if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
            return;
        }
    }

    // Gerbang gambar: keyword eksplisit ATAU konfirmasi dalam 5 menit
    // setelah permintaan foto terakhir (supaya "iya" tetap kirim fotonya)
    const IMAGE_KEYWORDS = ['foto', 'gambar', 'selfie', 'photo', 'pic', 'picture', 'potret'];
    const textLower = (text || '').toLowerCase();
    if (IMAGE_KEYWORDS.some(k => textLower.includes(k))) {
        lastImageRequest.set(sender, Date.now());
    }
    const withinImageWindow = Date.now() - (lastImageRequest.get(sender) || 0) < 5 * 60 * 1000;
    const userWantsImage = IMAGE_KEYWORDS.some(k => textLower.includes(k)) || withinImageWindow;

    // Kalau AI minta generate gambar → buat fotonya
    if (ai.imagePrompt && userWantsImage) {
        console.log(`🎨 Generate gambar: ${ai.imagePrompt.substring(0, 60)}...`);
        try {
            // Pura-pura ngetik caption dulu (biar natural)
            await simulateTyping(sock, sender, parts[0]?.text);
            const imageBuffer = await generateImage(ai.imagePrompt);
            const caption = parts[0]?.text || 'nih fotonya';
            await sock.sendMessage(sender, {
                image: imageBuffer,
                caption
            }, { quoted: isQuiz ? msg : (quoteTargetMsg || msg) });
            console.log('✅ Gambar terkirim');

            chatHistory.push({ sender: historyKey, role: 'user', content: text || '(gambar)', timestamp: Date.now(), name: senderName, msgId: msg.key.id, key: { remoteJid: sender, id: msg.key.id, fromMe: false, participant: msg.key.participant } });
            chatHistory.push({ sender: historyKey, role: 'assistant', content: `[kirim foto] ${caption}`, timestamp: Date.now() });
            saveHistory();
            if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
            return;
        } catch (err) {
            console.log(`❌ Gagal generate gambar: ${err.message} — lanjut kirim teks doang`);
        }
    }

    // Kirim split messages: pura-pura ngetik per bagian + quote sesuai flag reply
    // Kalau user mereply pesan lain, balasan bot nempel ke pesan itu.
    // PENGECUALIAN kuis: game bot kirim soal sbg REPLY ke perintah ".tebakbendera"
    // milik Kenzo — kalau ikut rule quote-target, jawaban nempel ke perintah
    // Kenzo & game bot ga membaca. Maka kuis SELALU quote pesan soalnya langsung
    // (flag reply:#N dari AI juga dimatikan utk menjamin ini).
    await sendSplitMessages(sock, sender, msg, parts, isQuiz ? [] : ai.refs, isQuiz ? null : quoteTargetMsg);
    console.log(`💬 Respon (${parts.length} pesan): ${parts[0]?.text?.substring(0, 30)}...`);

    // ========== FITUR KIRIM PESAN KE NOMOR LAIN ==========
    // Hanya Kenzo yang boleh pakai fitur ini
    if (ai.sendTo && isPacar) {
        const { number, name, text: sendText } = ai.sendTo;
        if (number && sendText) {
            const targetJid = `${number}@s.whatsapp.net`;
            console.log(`📤 Kirim pesan ke ${name || number}: ${sendText.substring(0, 50)}...`);
            try {
                // Simpan nomor ke database
                if (name) {
                    addNomorContact(name, number, targetJid);
                    console.log(`📝 Kontak disimpan: ${name} → ${number}`);
                }

                // Kirim pesan ke nomor tujuan
                await sock.sendMessage(targetJid, { text: sendText });
                console.log(`✅ Pesan terkirim ke ${number}`);

                // Simpan history pengiriman
                chatHistory.push({
                    sender: historyKey,
                    role: 'assistant',
                    content: `[kirim ke ${name || number}] ${sendText}`,
                    timestamp: Date.now()
                });
                saveHistory();
            } catch (err) {
                console.log(`❌ Gagal kirim ke ${number}: ${err.message}`);
                await sock.sendMessage(sender, {
                    text: `waduh gagal kirim ke ${name || number}, nomornya aktif ga ya?`
                }, { quoted: msg });
            }
        }
    }

    // ========== FITUR KIRIM FILE DARI AI ==========
    if (ai.file) {
        const { name, extension, content } = ai.file;
        const filename = `${name}${extension}`;
        const filePath = `/tmp/${filename}`;
        try {
            fs.writeFileSync(filePath, content, 'utf8');
            const fileBuffer = fs.readFileSync(filePath);
            await sock.sendMessage(sender, {
                document: fileBuffer,
                fileName: filename,
                mimetype: extension === '.csv' ? 'text/csv' : 'text/plain'
            }, { quoted: msg });
            console.log(`📁 File terkirim: ${filename}`);
            fs.unlinkSync(filePath);
        } catch (err) {
            console.log(`❌ Gagal kirim file: ${err.message}`);
            await sock.sendMessage(sender, { text: `gagal bikin file ${filename}` }, { quoted: msg });
        }
    }

    // ========== FITUR KIRIM PDF DARI AI ==========
    if (ai.pdf) {
        await sock.sendMessage(sender, { text: 'bentar ya lagi dikirimm PDF-nya 📄' }, { quoted: msg });
        try {
            const pdfBuf = await generatePDF(ai.pdf);
            if (pdfBuf) {
                const pdfName = `${ai.pdf.name}.pdf`;
                await sock.sendMessage(sender, {
                    document: pdfBuf,
                    fileName: pdfName,
                    mimetype: 'application/pdf'
                }, { quoted: msg });
                console.log(`📄 PDF terkirim: ${pdfName} (${(pdfBuf.length / 1024).toFixed(1)}KB)`);
            } else {
                await sock.sendMessage(sender, { text: 'waduh gagal bikin PDF-nya 😅' }, { quoted: msg });
            }
        } catch (err) {
            console.log(`❌ Gagal kirim PDF: ${err.message}`);
            await sock.sendMessage(sender, { text: `gagal bikin PDF: ${err.message}` }, { quoted: msg });
        }
    }

    // ========== FITUR KIRIM MULTI-FILE (ZIP) ==========
    if (ai.files && ai.files.length > 0) {
        const fileCount = ai.files.length;
        await sock.sendMessage(sender, { text: `bentar ya lagi bikin ${fileCount} file nih 📦` }, { quoted: msg });
        try {
            if (fileCount === 1) {
                // Single file → kirim langsung
                const file = ai.files[0];
                const ext = path.extname(file.name) || '.txt';
                const mimeTypes = { '.js': 'text/javascript', '.py': 'text/x-python', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown', '.xml': 'application/xml', '.yml': 'text/yaml', '.yaml': 'text/yaml' };
                
                await sock.sendMessage(sender, {
                    document: Buffer.from(file.content, 'utf8'),
                    fileName: file.name,
                    mimetype: mimeTypes[ext] || 'text/plain'
                }, { quoted: msg });
                console.log(`📁 File terkirim: ${file.name}`);
            } else {
                // Multi-file → zip dulu
                const zipName = `project_${Date.now()}`;
                const zipBuf = await createZip(ai.files, zipName);
                
                if (zipBuf) {
                    await sock.sendMessage(sender, {
                        document: zipBuf,
                        fileName: `${zipName}.zip`,
                        mimetype: 'application/zip'
                    }, { quoted: msg });
                    console.log(`📦 ZIP terkirim: ${zipName}.zip (${fileCount} files, ${(zipBuf.length / 1024).toFixed(1)}KB)`);
                } else {
                    await sock.sendMessage(sender, { text: 'gagal bikin ZIP 😅' }, { quoted: msg });
                }
            }
        } catch (err) {
            console.log(`❌ Gagal kirim file: ${err.message}`);
            await sock.sendMessage(sender, { text: `gagal bikin file: ${err.message}` }, { quoted: msg });
        }
    }

    // ========== FITUR KIRIM GAMBAR DARI INTERNET ==========
    if (ai.images && ai.images.length > 0) {
        console.log(`🖼️ Kirim ${ai.images.length} gambar dari internet`);
        for (const img of ai.images) {
            try {
                const res = await fetch(img.url);
                if (!res.ok) {
                    console.log(`⚠️ Gagal download gambar: ${res.status}`);
                    continue;
                }
                const buf = Buffer.from(await res.arrayBuffer());
                const mimeType = res.headers.get('content-type') || 'image/jpeg';
                
                // Kirim gambar sebagai image message
                const caption = img.caption || '';
                await sock.sendMessage(sender, {
                    image: buf,
                    caption: caption,
                    mimetype: mimeType
                }, { quoted: msg });
                console.log(`🖼️ Gambar terkirim: ${img.url.substring(0, 60)}...`);
                
                // Delay antar gambar biar ga spam
                if (ai.images.length > 1) await new Promise(r => setTimeout(r, 1000));
            } catch (err) {
                console.log(`❌ Gagal kirim gambar: ${err.message}`);
            }
        }
    }

    // Stiker HANYA kalau ada keyword emosi (hehe/hmph), bukan random
    if (isPacar && !isGroup) {
        await sendStickerAfterText(sock, sender, text, parts.map(p => p.text));
    }

    // Simpan history SETELAH dapat respon — user disimpan dgn key utk quoting nanti
    chatHistory.push({
        sender: historyKey, role: 'user', content: text || '(gambar)',
        timestamp: Date.now(), name: senderName,
        msgId: msg.key.id,
        key: { remoteJid: sender, id: msg.key.id, fromMe: false, participant: msg.key.participant }
    });
    chatHistory.push({ sender: historyKey, role: 'assistant', content: parts.map(p => p.text).join(' | '), timestamp: Date.now() });
    saveHistory();

    if (!sleepMode) await sock.sendPresenceUpdate('available', sender).catch(() => {});
}

// Stiker hanya berdasarkan mood keyword — TANPA random
async function sendStickerAfterText(sock, sender, userText, aiResponses) {
    const combinedText = (userText + ' ' + aiResponses.join(' ')).toLowerCase();

    let stickerPath = null;
    if (combinedText.includes('hehe')) {
        stickerPath = './hehe.webp';
    } else if (combinedText.includes('hmph')) {
        stickerPath = './hmph.webp';
    }

    if (stickerPath && fs.existsSync(stickerPath)) {
        try {
            await sock.sendMessage(sender, { sticker: fs.readFileSync(stickerPath) });
            console.log(`✅ Stiker terkirim: ${stickerPath}`);
        } catch (err) {
            console.log(`❌ Gagal kirim stiker: ${err.message}`);
        }
    }
}

// Stiker acak — dipakai saat AI error (biar bot tetap "hidup")
async function sendRandomSticker(sock, sender) {
    const stickers = ['./hehe.webp', './hmph.webp', './3.webp', './4.webp', './5.webp']
        .filter(f => fs.existsSync(f));
    if (stickers.length === 0) return;

    const pick = stickers[Math.floor(Math.random() * stickers.length)];
    try {
        await sock.sendMessage(sender, { sticker: fs.readFileSync(pick) });
        console.log(`🎲 Stiker error terkirim: ${pick}`);
    } catch (err) {
        console.log(`❌ Gagal kirim stiker: ${err.message}`);
    }
}

// ========== START ==========
console.log('🤖 Starting AlyaBot...');
console.log(`📋 Mode: ${USE_OTP ? `OTP Pairing${PHONE_ARG ? ` (${PHONE_ARG})` : ' (akan ditanya)'}` : 'QR Code'}`);
console.log(`📋 AI: Kiosapi/${KIOSAPI_MODEL} → OpenCode/${OPENCODE_MODEL}${groq ? ' → Groq fallback' : ''}`);
console.log(`📋 Settings: ignoreGroups=${ignoreGroups}, kenzoOnlyMode=${kenzoOnlyMode}`);
console.log(`💑 Kenzo JID: ${kenzoJid || 'Belum diset'}`);
console.log(`📥 yt-dlp: ${hasYtDlp() ? '✅ terinstall' : '❌ tidak ada (install: pip install yt-dlp) — fallback Cobalt API'}`);
console.log(`🎨 Gambar: ${GEMINI_API_KEY ? '🍌 Nano Banana (Gemini)' : '—'}${(config.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN) ? ' + ☁️ Cloudflare SDXL/Flux' : ''}${!GEMINI_API_KEY && !(config.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN) ? '❌ BELUM ADA KEY (set geminiApiKey / cloudflareApiToken+AccountId)' : ''}\n`);

startAlyaBot().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\n👋 Bot dimatiin...');
    saveHistory();
    saveSettings();
    process.exit(0);
});
