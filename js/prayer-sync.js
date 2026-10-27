'use strict';
// Prayer schedule sync for Auto Bell: settings persistence, offline
// astronomical calculation (PrayTimes), and optional AI cross-check
// (Gemini / OpenAI-compatible) with validation and fallback.
// UMD: browser -> window.AutoBellSync, Node -> module.exports (unit tested).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AutoBellSync = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const SETTINGS_KEY = 'autobell.settings';
    const SYNC_KEY = 'autobell.prayerSync';
    const FIRED_KEY = 'autobell.fired';
    const AI_TIMEOUT_MS = 15000;
    const AI_TOLERANCE_MINUTES = 10;
    const TIMEZONE = 8; // WITA (UTC+8), lokasi sekolah
    const DEFAULT_MODEL_GEMINI = 'gemini-2.0-flash';
    const DEFAULT_MODEL_OPENAI = 'gpt-4o-mini';
    const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

    const DEFAULT_SETTINGS = {
        location: { lat: -5.1477, lng: 119.4328, label: 'Makassar' },
        ai: { enabled: true, provider: 'gemini', apiKey: '', baseUrl: DEFAULT_BASE_URL, model: '' },
        prayers: { dhuhr: true, ashr: true, manualOverride: false, manualDhuhr: '11:52', manualAshar: '15:11', manualScope: 'always', manualSetDate: '' },
        alarm: { offsetMinutes: 10, sound: 'prayerReminder' }
    };

    // --- small helpers ------------------------------------------------------

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    // Recursive merge; nested plain objects are merged key-by-key, never mutated.
    function deepMerge(base, override) {
        const out = {};
        Object.keys(base || {}).forEach((key) => {
            out[key] = isPlainObject(base[key]) ? deepMerge(base[key], {}) : base[key];
        });
        Object.keys(override || {}).forEach((key) => {
            if (isPlainObject(override[key]) && isPlainObject(out[key])) {
                out[key] = deepMerge(out[key], override[key]);
            } else {
                out[key] = override[key];
            }
        });
        return out;
    }

    function readJson(key) {
        try {
            const raw = globalThis.localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (err) {
            return null;
        }
    }

    function writeJson(key, value) {
        try {
            globalThis.localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (err) {
            console.warn(`Failed to persist ${key}:`, err);
            return false;
        }
    }

    function todayStr(date) {
        const d = date instanceof Date ? date : new Date(date);
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function prayerUtils() {
        const pu = globalThis.PrayerUtils;
        if (!pu) throw new Error('PrayerUtils not loaded');
        return pu;
    }

    // "9:05" | "11:46:30" -> canonical "HH:MM", or null when unparseable
    function normalizeHm(value) {
        const seconds = prayerUtils().parseTimeToSeconds(value);
        if (seconds === null) return null;
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${pad2(hours)}:${pad2(minutes)}`;
    }

    // --- settings ------------------------------------------------------------

    function loadSettings() {
        const stored = readJson(SETTINGS_KEY);
        const merged = deepMerge(DEFAULT_SETTINGS, isPlainObject(stored) ? stored : {});
        if (!stored) writeJson(SETTINGS_KEY, merged);
        return merged;
    }

    // Merge partial into current settings and persist. Stamp manualSetDate
    // when saving an active "today only" manual override.
    function saveSettings(partial) {
        const merged = deepMerge(loadSettings(), isPlainObject(partial) ? partial : {});
        const prayers = merged.prayers || {};
        if (prayers.manualOverride && prayers.manualScope === 'today') {
            merged.prayers.manualSetDate = todayStr(new Date());
        }
        writeJson(SETTINGS_KEY, merged);
        return merged;
    }

    // --- calculation (offline, source of truth) ------------------------------

    function getCalcTimes(date) {
        const settings = loadSettings();
        const PrayTimesCtor = globalThis.PrayTimes;
        if (typeof PrayTimesCtor !== 'function') throw new Error('PrayTimes not loaded');
        const when = date instanceof Date ? date : new Date(date);
        const calc = new PrayTimesCtor('MWL');
        calc.adjust({ fajr: 20, isha: 18, asr: 'Standard' }); // metode Kemenag
        const times = calc.getTimes(when, [settings.location.lat, settings.location.lng], TIMEZONE, 0, '24h');
        const dhuhr = normalizeHm(times.dhuhr);
        const ashr = normalizeHm(times.asr);
        if (!dhuhr || !ashr) throw new Error('PrayTimes returned invalid times');
        return { dhuhr, ashr };
    }

    function readSync() {
        return readJson(SYNC_KEY);
    }

    // Resolve today's prayer times: manual override > stored sync > live calc.
    function getActiveTimes(now) {
        const settings = loadSettings();
        const dateStr = todayStr(now);
        const prayers = settings.prayers;

        const manualValid = prayers.manualOverride
            && (prayers.manualScope !== 'today' || prayers.manualSetDate === dateStr);
        if (manualValid) {
            const dhuhr = normalizeHm(prayers.manualDhuhr);
            const ashr = normalizeHm(prayers.manualAshar);
            if (dhuhr && ashr) return { dhuhr, ashr, source: 'manual' };
        }

        const sync = readSync();
        if (sync && sync.date === dateStr) {
            if (sync.source === 'ai' && isPlainObject(sync.ai)) {
                const dhuhr = normalizeHm(sync.ai.dhuhr);
                const ashr = normalizeHm(sync.ai.ashr);
                if (dhuhr && ashr) return { dhuhr, ashr, source: 'ai' };
            }
            if (isPlainObject(sync.calc)) {
                const dhuhr = normalizeHm(sync.calc.dhuhr);
                const ashr = normalizeHm(sync.calc.ashr);
                if (dhuhr && ashr) return { dhuhr, ashr, source: 'calc' };
            }
        }

        try {
            const calc = getCalcTimes(now);
            return { dhuhr: calc.dhuhr, ashr: calc.ashr, source: 'calc' };
        } catch (err) {
            console.warn('Prayer time calculation failed:', err);
            return null;
        }
    }

    // --- AI cross-check --------------------------------------------------------

    function buildAiPrompt(date) {
        const settings = loadSettings();
        const loc = settings.location;
        return [
            'Calculate the Dzuhur (dhuhr) and Ashr (asr) prayer times.',
            `Date (YYYY-MM-DD): ${todayStr(date)}`,
            `Latitude: ${loc.lat}, Longitude: ${loc.lng}, Timezone: UTC+${TIMEZONE} (WITA).`,
            'Method: Indonesian Kemenag conventions - Fajr angle 20 degrees, Isha angle 18 degrees, Asr Standard (Shafii shadow factor 1).',
            'Reply with ONLY a JSON object, no markdown, no explanation: {"dhuhr":"HH:MM","ashr":"HH:MM"}'
        ].join('\n');
    }

    // Pull the first JSON object out of a model reply (handles code fences).
    function extractJsonObject(text) {
        if (typeof text !== 'string') return null;
        const cleaned = text.replace(/```(?:json)?/gi, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start === -1 || end <= start) return null;
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            return isPlainObject(parsed) ? parsed : null;
        } catch (err) {
            return null;
        }
    }

    async function callAi(prompt) {
        const ai = loadSettings().ai;
        if (!ai.apiKey) throw new Error('API key kosong');
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => controller.abort(), AI_TIMEOUT_MS) : null;
        try {
            if (ai.provider === 'gemini') {
                const model = ai.model || DEFAULT_MODEL_GEMINI;
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(ai.apiKey)}`;
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller ? controller.signal : undefined,
                    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                });
                if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
                const data = await res.json();
                const text = data && data.candidates && data.candidates[0]
                    && data.candidates[0].content && data.candidates[0].content.parts
                    && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
                if (!text) throw new Error('Gemini membalas kosong');
                return text;
            }
            const base = (ai.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
            const res = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.apiKey}` },
                signal: controller ? controller.signal : undefined,
                body: JSON.stringify({
                    model: ai.model || DEFAULT_MODEL_OPENAI,
                    temperature: 0,
                    messages: [{ role: 'user', content: prompt }]
                })
            });
            if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
            const data = await res.json();
            const text = data && data.choices && data.choices[0]
                && data.choices[0].message && data.choices[0].message.content;
            if (!text) throw new Error('OpenAI membalas kosong');
            return text;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    // Always persists a status for today; AI never blocks the calc fallback.
    async function syncNow() {
        const now = new Date();
        let calc;
        try {
            calc = getCalcTimes(now);
        } catch (err) {
            return { ok: false, message: `Kalkulasi gagal: ${err.message}` };
        }

        const aiSettings = loadSettings().ai;
        let aiResult = null;
        let source = 'calc';
        if (aiSettings.enabled && aiSettings.apiKey) {
            try {
                const raw = await callAi(buildAiPrompt(now));
                const parsed = extractJsonObject(raw);
                // Models sometimes answer "ashar" instead of the requested "ashr"
                const aiTimes = parsed
                    ? { dhuhr: parsed.dhuhr, ashr: parsed.ashr !== undefined ? parsed.ashr : parsed.ashar }
                    : null;
                if (aiTimes && prayerUtils().isValidAiTimes(aiTimes, calc, AI_TOLERANCE_MINUTES)) {
                    aiResult = { dhuhr: normalizeHm(aiTimes.dhuhr), ashr: normalizeHm(aiTimes.ashr) };
                    source = 'ai';
                } else {
                    console.warn('AI result rejected (bad JSON or failed validation); using calculation');
                }
            } catch (err) {
                console.warn('AI sync failed; using calculation:', err.message);
            }
        }

        const status = {
            date: todayStr(now),
            source,
            calc,
            ai: aiResult,
            lastSyncAt: new Date().toISOString()
        };
        writeJson(SYNC_KEY, status);
        return { ok: true, status };
    }

    async function syncIfNewDay() {
        const sync = readSync();
        if (sync && sync.date === todayStr(new Date())) {
            return { ok: true, status: sync, skipped: true };
        }
        return syncNow();
    }

    async function testConnection() {
        const ai = loadSettings().ai;
        if (!ai.apiKey) return { ok: false, message: 'API key belum diisi' };
        try {
            const reply = (await callAi('Reply with exactly the word: OK')).trim();
            return { ok: true, message: `Terhubung: ${reply.slice(0, 60)}` };
        } catch (err) {
            return { ok: false, message: `Gagal: ${err.message}` };
        }
    }

    // --- fired set (anti-dobel, di-reset otomatis saat ganti hari) ------------

    function readFired(dateStr) {
        const data = readJson(FIRED_KEY);
        if (!data || data.date !== dateStr || !Array.isArray(data.keys)) {
            return { date: dateStr, keys: [] };
        }
        return { date: data.date, keys: data.keys };
    }

    function firedHas(key, now) {
        const data = readFired(todayStr(now || new Date()));
        return data.keys.indexOf(key) !== -1;
    }

    function firedAdd(key, now) {
        const data = readFired(todayStr(now || new Date()));
        if (data.keys.indexOf(key) === -1) {
            data.keys.push(key);
            writeJson(FIRED_KEY, data);
        }
    }

    return {
        SETTINGS_KEY,
        SYNC_KEY,
        FIRED_KEY,
        DEFAULT_SETTINGS,
        loadSettings,
        saveSettings,
        normalizeHm,
        buildAiPrompt,
        getCalcTimes,
        getActiveTimes,
        readSync,
        extractJsonObject,
        syncNow,
        syncIfNewDay,
        testConnection,
        firedHas,
        firedAdd,
        todayStr
    };
});
