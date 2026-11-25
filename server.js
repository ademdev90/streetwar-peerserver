const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});
const server = http.createServer(app);

server.on('connection', (tcpSocket) => {
    tcpSocket.setNoDelay(true);
});

const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    perMessageDeflate: false,
    httpCompression: false,
    pingInterval: 5000,
    pingTimeout: 10000
});

app.get('/ping', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(200).send('Server is active');
});

// ================= Real Email Verification Code Endpoints =================
const emailVerificationStore = new Map(); // email -> { code, expiresAt, verified, attempts, lastSentAt }

function cleanupExpiredVerificationCodes() {
    const now = Date.now();
    for (const [k, entry] of emailVerificationStore.entries()) {
        if (!entry || now > entry.expiresAt + 10 * 60 * 1000) {
            emailVerificationStore.delete(k);
        }
    }
}

let cachedMailTransporter = null;
let cachedMailSignature = '';

function getOrCreateMailTransporter() {
    const smtpUser = (process.env.SMTP_USER || process.env.GMAIL_USER || '').trim();
    const smtpPass = (process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '').trim();
    const smtpHost = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10) || 587;

    if (!smtpUser || !smtpPass) {
        return { error: 'SMTP_NOT_CONFIGURED' };
    }

    let nodemailer = null;
    try {
        nodemailer = require('nodemailer');
    } catch (e) {
        return { error: 'NODEMAILER_MISSING' };
    }

    const sig = `${smtpHost}:${smtpPort}:${smtpUser}:${smtpPass.slice(0, 4)}`;
    if (!cachedMailTransporter || cachedMailSignature !== sig) {
        cachedMailTransporter = nodemailer.createTransport({
            host: smtpHost,
            port: smtpPort,
            secure: smtpPort === 465,
            pool: true,
            maxConnections: 3,
            maxMessages: 50,
            family: 4,
            connectionTimeout: 10000,
            greetingTimeout: 10000,
            socketTimeout: 15000,
            tls: {
                rejectUnauthorized: false
            },
            auth: { user: smtpUser, pass: smtpPass }
        });
        cachedMailSignature = sig;
    }

    return { transporter: cachedMailTransporter, smtpUser };
}

async function dispatchVerificationEmail(toEmail, code) {
    const setup = getOrCreateMailTransporter();
    if (setup.error) {
        return { sent: false, reason: setup.error };
    }

    const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; background: #0b1220; color: #f8fafc; border: 2px solid #00d4ff; border-radius: 14px; padding: 24px; text-align: center;">
            <h2 style="color: #00d4ff; margin: 0 0 8px;">🏎️ STREET WAR BATTLE CARS</h2>
            <p style="color: #cbd5e1; font-size: 14px; margin: 0 0 18px;">
                Use the verification code below to confirm your email address and complete registration:
            </p>
            <div style="font-size: 32px; font-weight: 900; letter-spacing: 6px; color: #00ffaa; background: #0f1f36; border: 1.5px dashed #00ffaa; border-radius: 10px; padding: 14px 18px; margin-bottom: 16px;">
                ${code}
            </div>
            <p style="color: #94a3b8; font-size: 12px; margin: 0;">
                This code expires in <b>10 minutes</b>. If you did not request this code, you can ignore this email.
            </p>
        </div>
    `;

    const mailOptions = {
        from: `"Street War Battle Cars" <${setup.smtpUser}>`,
        to: toEmail,
        subject: `${code} is your Street War verification code`,
        text: `Your Street War Battle Cars verification code is: ${code} (valid for 10 minutes).`,
        html: htmlBody
    };

    try {
        await setup.transporter.sendMail(mailOptions);
        return { sent: true };
    } catch (firstErr) {
        // Reset pooled transporter and retry once immediately on transient SMTP socket close
        cachedMailTransporter = null;
        const retrySetup = getOrCreateMailTransporter();
        if (retrySetup.error) throw firstErr;
        await retrySetup.transporter.sendMail(mailOptions);
        return { sent: true };
    }
}

app.post('/api/send-verification-code', async (req, res) => {
    cleanupExpiredVerificationCodes();
    const rawEmail = (req.body && req.body.email) ? String(req.body.email) : '';
    const email = rawEmail.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ ok: false, error: 'INVALID_EMAIL', message: 'Please enter a valid email address.' });
    }

    const existing = emailVerificationStore.get(email);
    const now = Date.now();
    if (existing && existing.lastSentAt && (now - existing.lastSentAt) < 10000) {
        const waitSec = Math.ceil((10000 - (now - existing.lastSentAt)) / 1000);
        return res.status(429).json({ ok: false, error: 'RATE_LIMITED', message: `Please wait ${waitSec}s before requesting another code.` });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    emailVerificationStore.set(email, {
        code,
        expiresAt: now + 10 * 60 * 1000,
        verified: false,
        attempts: 0,
        lastSentAt: now
    });

    try {
        const mailRes = await dispatchVerificationEmail(email, code);
        if (!mailRes.sent) {
            emailVerificationStore.delete(email);
            return res.status(503).json({
                ok: false,
                error: mailRes.reason || 'EMAIL_SERVICE_UNAVAILABLE',
                message: 'Email server not configured yet on Render (add SMTP_USER & SMTP_PASS).'
            });
        }
        return res.json({ ok: true, message: 'Verification code sent to your email inbox!' });
    } catch (err) {
        emailVerificationStore.delete(email);
        const errDetail = (err && (err.responseCode || err.code || err.message)) ? String(err.responseCode || err.code || err.message) : 'SMTP_ERROR';
        console.error('Failed to send verification email:', errDetail);
        return res.status(500).json({
            ok: false,
            error: 'SMTP_SEND_FAILED',
            message: `Temporary email server delay (${errDetail}). Click Resend Code to retry.`
        });
    }
});

app.post('/api/verify-email-code', (req, res) => {
    cleanupExpiredVerificationCodes();
    const email = ((req.body && req.body.email) ? String(req.body.email) : '').trim().toLowerCase();
    const code = ((req.body && req.body.code) ? String(req.body.code) : '').trim();

    if (!email || !code) {
        return res.status(400).json({ ok: false, message: 'Email and verification code are required.' });
    }

    const record = emailVerificationStore.get(email);
    if (!record) {
        return res.status(400).json({ ok: false, message: 'No verification code found for this email. Click Verify Email first.' });
    }
    if (Date.now() > record.expiresAt) {
        emailVerificationStore.delete(email);
        return res.status(400).json({ ok: false, message: 'Verification code expired. Please request a new code.' });
    }

    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts > 6) {
        emailVerificationStore.delete(email);
        return res.status(429).json({ ok: false, message: 'Too many wrong attempts. Please request a new code.' });
    }

    if (record.code !== code) {
        return res.status(400).json({ ok: false, message: 'Incorrect verification code. Check your email inbox.' });
    }

    record.verified = true;
    return res.json({ ok: true, verified: true, message: 'Email verified successfully!' });
});

app.get('/', (req, res) => {
    res.send(`Street War Dedicated Server Running | Active Rooms: ${Object.keys(rooms).length}`);
});

const port = process.env.PORT || 9000;
const LOBBY_WAIT_TIME = 30;
const MAP_SIZE = 2500;
const BOT_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];

let rooms = {};
let roomSequence = 1;

// نظام البطولة السنوية (7 جانفي من كل عام - 60 لاعباً - 6 مجموعات BR -> CTF 3v3 -> Final DM بدون بوتات)
const TOURNAMENT_MAX_PLAYERS = 60;
let championshipData = {
    seasonYear: Math.max(2026, new Date().getFullYear()),
    championName: 'Awaiting Champion',
    registeredPlayers: [], // { uid, name, country, lastCheckInAt, confirmed }
    stage: 'registration' // 'registration' | 'br_groups' | 'ctf_semis' | 'dm_final' | 'completed'
};

let serverLeaderboardStore = new Map();

// ================= Friends & Unique Player ID Directory =================
const onlinePlayerDirectory = new Map(); // playerId -> { playerId, uid, accountKey, name, country, level, totalXp, hasPass, ownedCars, awakenedCars, careerStats, online, socketId, lastSeen }

// ================= Mutual Friend Requests & Official Friendships =================
const friendshipsStore = new Map();       // playerId -> Set<friendPlayerId>
const incomingRequestsStore = new Map();  // targetId -> Map<fromId, { fromId, createdAt, profileSnapshot }>
const outgoingRequestsStore = new Map();  // fromId   -> Map<targetId, { targetId, createdAt, profileSnapshot }>
const pendingRemovalStore = new Map();    // targetId -> Set<removedById> (for offline removal sync)

function getOrCreateFriendSet(map, key) {
    if (!map.has(key)) map.set(key, new Set());
    return map.get(key);
}

function getOrCreateFriendMap(map, key) {
    if (!map.has(key)) map.set(key, new Map());
    return map.get(key);
}

function buildSafeProfilePreview(playerId, fallback = null) {
    const cleanId = String(playerId || '').trim().toUpperCase();
    const live = onlinePlayerDirectory.get(cleanId);
    if (live) return toPublicProfileDTO(live);
    const fb = (fallback && typeof fallback === 'object') ? fallback : {};
    return {
        playerId: cleanId,
        uid: String(fb.uid || ''),
        name: String(fb.name || 'Driver').trim().slice(0, 18) || 'Driver',
        country: String(fb.country || 'INTL').trim().slice(0, 10) || 'INTL',
        level: Math.max(1, Math.floor(Number(fb.level) || 1)),
        totalXp: Math.max(0, Math.floor(Number(fb.totalXp) || 0)),
        hasPass: !!fb.hasPass,
        ownedCars: Array.isArray(fb.ownedCars) && fb.ownedCars.length ? fb.ownedCars : [0],
        awakenedCars: Array.isArray(fb.awakenedCars) ? fb.awakenedCars : [],
        careerStats: sanitizeCareerStatsPayload(fb.careerStats),
        online: false,
        lastSeen: Number(fb.lastSeen) || Date.now()
    };
}

function getFriendSystemSnapshot(playerId) {
    const cleanId = String(playerId || '').trim().toUpperCase();
    const friendsIds = Array.from(friendshipsStore.get(cleanId) || []);
    const incomingMap = incomingRequestsStore.get(cleanId) || new Map();
    const outgoingMap = outgoingRequestsStore.get(cleanId) || new Map();
    const removedIds = Array.from(pendingRemovalStore.get(cleanId) || []);

    return {
        friends: friendsIds.map(id => buildSafeProfilePreview(id)),
        incoming: Array.from(incomingMap.values()).map(r => ({
            playerId: r.fromId,
            createdAt: r.createdAt || Date.now(),
            profile: buildSafeProfilePreview(r.fromId, r.profileSnapshot)
        })),
        outgoing: Array.from(outgoingMap.values()).map(r => ({
            playerId: r.targetId,
            createdAt: r.createdAt || Date.now(),
            profile: buildSafeProfilePreview(r.targetId, r.profileSnapshot)
        })),
        removedFriendIds: removedIds
    };
}

function emitToPlayerIfOnline(playerId, eventName, payload) {
    const cleanId = String(playerId || '').trim().toUpperCase();
    const rec = onlinePlayerDirectory.get(cleanId);
    if (rec && rec.online && rec.socketId) {
        io.to(rec.socketId).emit(eventName, payload);
        return true;
    }
    return false;
}

function makeOfficialFriends(idA, idB) {
    const a = String(idA || '').trim().toUpperCase();
    const b = String(idB || '').trim().toUpperCase();
    if (!a || !b || a === b) return;

    getOrCreateFriendSet(friendshipsStore, a).add(b);
    getOrCreateFriendSet(friendshipsStore, b).add(a);

    // Clear any pending removal flags between them
    pendingRemovalStore.get(a)?.delete(b);
    pendingRemovalStore.get(b)?.delete(a);

    // Clear pending requests in BOTH directions (one acceptance suffices even if both sent requests)
    incomingRequestsStore.get(a)?.delete(b);
    outgoingRequestsStore.get(a)?.delete(b);
    incomingRequestsStore.get(b)?.delete(a);
    outgoingRequestsStore.get(b)?.delete(a);
}

function sanitizeCareerModeStats(m) {
    const src = (m && typeof m === 'object') ? m : {};
    return {
        wins: Math.max(0, Math.floor(Number(src.wins) || 0)),
        kills: Math.max(0, Math.floor(Number(src.kills) || 0)),
        damage: Math.max(0, Math.floor(Number(src.damage) || 0)),
        games: Math.max(0, Math.floor(Number(src.games) || 0))
    };
}

function sanitizeCareerStatsPayload(cs) {
    const src = (cs && typeof cs === 'object') ? cs : {};
    const sanitizeScope = (sc) => {
        const s = (sc && typeof sc === 'object') ? sc : {};
        return {
            br: sanitizeCareerModeStats(s.br),
            dm: sanitizeCareerModeStats(s.dm),
            ctf: sanitizeCareerModeStats(s.ctf)
        };
    };
    return {
        offline: sanitizeScope(src.offline),
        online: sanitizeScope(src.online)
    };
}

function syncOnlinePlayerProfile(payload = {}, socketId = '') {
    const cleanId = String(payload.playerId || '').trim().toUpperCase().slice(0, 24);
    if (!cleanId) return null;
    const prev = onlinePlayerDirectory.get(cleanId) || {};
    const record = {
        playerId: cleanId,
        uid: String(payload.uid || prev.uid || socketId || '').slice(0, 96),
        accountKey: String(payload.accountKey || prev.accountKey || '').slice(0, 128),
        name: String(payload.name || prev.name || 'Driver').trim().slice(0, 18) || 'Driver',
        country: String(payload.country || prev.country || 'INTL').trim().slice(0, 10) || 'INTL',
        level: Math.max(1, Math.floor(Number(payload.level) || prev.level || 1)),
        totalXp: Math.max(0, Math.floor(Number(payload.totalXp) || prev.totalXp || 0)),
        hasPass: payload.hasPass !== undefined ? !!payload.hasPass : !!prev.hasPass,
        ownedCars: Array.isArray(payload.ownedCars)
            ? payload.ownedCars.map(Number).filter(n => !isNaN(n)).slice(0, 50)
            : (Array.isArray(prev.ownedCars) ? prev.ownedCars : [0]),
        awakenedCars: Array.isArray(payload.awakenedCars)
            ? payload.awakenedCars.map(Number).filter(n => !isNaN(n)).slice(0, 50)
            : (Array.isArray(prev.awakenedCars) ? prev.awakenedCars : []),
        careerStats: payload.careerStats
            ? sanitizeCareerStatsPayload(payload.careerStats)
            : (prev.careerStats || sanitizeCareerStatsPayload({})),
        online: true,
        socketId: socketId || prev.socketId || '',
        lastSeen: Date.now()
    };
    onlinePlayerDirectory.set(cleanId, record);
    return record;
}

function toPublicProfileDTO(rec) {
    if (!rec) return null;
    return {
        playerId: rec.playerId,
        uid: rec.uid,
        name: rec.name,
        country: rec.country,
        level: rec.level,
        totalXp: rec.totalXp,
        hasPass: !!rec.hasPass,
        ownedCars: rec.ownedCars || [0],
        awakenedCars: rec.awakenedCars || [],
        careerStats: rec.careerStats || sanitizeCareerStatsPayload({}),
        online: !!rec.online,
        lastSeen: rec.lastSeen || Date.now()
    };
}

app.get('/api/player/:playerId', (req, res) => {
    const qId = String((req.params && req.params.playerId) || '').trim().toUpperCase();
    if (!qId) return res.status(400).json({ ok: false, message: 'Missing playerId.' });
    const found = onlinePlayerDirectory.get(qId);
    if (!found) return res.status(404).json({ ok: false, message: 'Player not found.' });
    return res.json({ ok: true, profile: toPublicProfileDTO(found) });
});


function recordServerLeaderboardEntry(entry) {
    if (!entry || !entry.uid) return;
    const prev = serverLeaderboardStore.get(entry.uid) || {
        uid: entry.uid,
        name: entry.name || 'Driver',
        country: entry.country || 'INTL',
        kills: 0,
        damage: 0,
        wins: 0
    };
    serverLeaderboardStore.set(entry.uid, {
        uid: entry.uid,
        name: entry.name || prev.name || 'Driver',
        country: entry.country || prev.country || 'INTL',
        kills: Math.max(prev.kills, 0) + Math.max(0, Math.floor(Number(entry.kills) || 0)),
        damage: Math.max(prev.damage, 0) + Math.max(0, Math.floor(Number(entry.damage) || 0)),
        wins: Math.max(prev.wins, 0) + Math.max(0, Math.floor(Number(entry.wins) || 0))
    });
}

function buildTournamentBracket(playersList) {
    const pool = playersList.slice(0, TOURNAMENT_MAX_PLAYERS);
    const groups = [];
    for (let i = 0; i < 6; i++) {
        groups.push({
            groupIndex: i + 1,
            mode: 'BR',
            players: pool.slice(i * 10, (i + 1) * 10)
        });
    }
    return {
        totalRegistered: pool.length,
        maxPlayers: TOURNAMENT_MAX_PLAYERS,
        groups: groups,
        ctfFinalistsCount: 6,
        finalDmPlayersCount: 3,
        finalDmBotsCount: 0
    };
}

// تحديد الحد الأقصى للاعبين حسب الطور (6 لاعبين أي 3 ضد 3 في طور سرقة العلم CTF، و10 في البقية)
function getMaxPlayersForMode(mode) {
    return (mode || 'br').toLowerCase() === 'ctf' ? 6 : 10;
}

function generatePrivateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    do {
        code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (Object.values(rooms).some(r => r && r.code === code));
    return code;
}

function broadcastOnlinePlayersCount() {
    const count = Math.max(1, io.engine ? io.engine.clientsCount : 1);
    io.emit('onlinePlayersCount', { count });
}

io.on('connection', (socket) => {
    broadcastOnlinePlayersCount();

    // Friends & Player ID Presence / Lookup (also prepares for Squad Lobby Invites)
    socket.on('registerPlayerProfile', (data = {}, cb) => {
        const rec = syncOnlinePlayerProfile(data, socket.id);
        let friendState = null;
        if (rec) {
            socket.playerId = rec.playerId;
            friendState = getFriendSystemSnapshot(rec.playerId);
            // Clear delivered offline removal notifications once fetched
            if (pendingRemovalStore.has(rec.playerId)) {
                pendingRemovalStore.delete(rec.playerId);
            }
        }
        if (typeof cb === 'function') {
            cb({ ok: !!rec, profile: toPublicProfileDTO(rec), friendState });
        }
    });

    socket.on('lookupPlayerById', (data = {}, cb) => {
        const queryId = String((data && data.playerId) || '').trim().toUpperCase();
        if (!queryId) {
            if (typeof cb === 'function') cb({ ok: false, message: 'Invalid Player ID.' });
            return;
        }
        const found = onlinePlayerDirectory.get(queryId) || null;
        if (typeof cb === 'function') {
            cb({ ok: !!found, profile: toPublicProfileDTO(found) });
        }
    });

    socket.on('getFriendsPresence', (data = {}, cb) => {
        const ids = Array.isArray(data && data.playerIds) ? data.playerIds.slice(0, 100) : [];
        const profiles = {};
        ids.forEach((rawId) => {
            const cleanId = String(rawId || '').trim().toUpperCase();
            if (!cleanId) return;
            const found = onlinePlayerDirectory.get(cleanId);
            if (found) profiles[cleanId] = toPublicProfileDTO(found);
        });
        if (typeof cb === 'function') cb({ ok: true, profiles });
    });

    // ================= Mutual Friend Requests & Acceptance Socket Handlers =================
    socket.on('getFriendSystemState', (data = {}, cb) => {
        const myId = String((data && data.playerId) || socket.playerId || '').trim().toUpperCase();
        if (!myId) {
            if (typeof cb === 'function') cb({ ok: false, message: 'Missing Player ID.' });
            return;
        }
        const state = getFriendSystemSnapshot(myId);
        if (pendingRemovalStore.has(myId)) {
            pendingRemovalStore.delete(myId);
        }
        if (typeof cb === 'function') cb({ ok: true, state });
    });

    socket.on('sendFriendRequest', (data = {}, cb) => {
        const fromId = String((data && data.fromId) || socket.playerId || '').trim().toUpperCase();
        const targetId = String((data && data.targetId) || '').trim().toUpperCase();

        if (!fromId || !targetId) {
            if (typeof cb === 'function') cb({ ok: false, message: 'Invalid Player ID.' });
            return;
        }
        if (fromId === targetId) {
            if (typeof cb === 'function') cb({ ok: false, message: 'You cannot send a friend request to yourself.' });
            return;
        }

        // Keep sender profile fresh in directory if provided
        if (data && data.fromProfile && typeof data.fromProfile === 'object') {
            syncOnlinePlayerProfile(Object.assign({}, data.fromProfile, { playerId: fromId }), socket.id);
            socket.playerId = fromId;
        }

        const myFriends = getOrCreateFriendSet(friendshipsStore, fromId);
        if (myFriends.has(targetId)) {
            if (typeof cb === 'function') {
                cb({
                    ok: true,
                    status: 'already_friends',
                    state: getFriendSystemSnapshot(fromId)
                });
            }
            return;
        }

        // Free Fire Rule: If target ALREADY sent a request to sender -> Instant official friendship!
        const myIncoming = getOrCreateFriendMap(incomingRequestsStore, fromId);
        if (myIncoming.has(targetId)) {
            makeOfficialFriends(fromId, targetId);
            const fromProf = buildSafeProfilePreview(fromId, data && data.fromProfile);
            const targetProf = buildSafeProfilePreview(targetId, data && data.targetProfile);
            emitToPlayerIfOnline(targetId, 'friendRequestAccepted', {
                friendId: fromId,
                profile: fromProf,
                state: getFriendSystemSnapshot(targetId)
            });
            if (typeof cb === 'function') {
                cb({
                    ok: true,
                    status: 'accepted_mutual',
                    profile: targetProf,
                    state: getFriendSystemSnapshot(fromId)
                });
            }
            return;
        }

        // Check if already sent
        const myOutgoing = getOrCreateFriendMap(outgoingRequestsStore, fromId);
        if (myOutgoing.has(targetId)) {
            if (typeof cb === 'function') {
                cb({
                    ok: true,
                    status: 'already_pending',
                    state: getFriendSystemSnapshot(fromId)
                });
            }
            return;
        }

        const now = Date.now();
        const fromProf = buildSafeProfilePreview(fromId, data && data.fromProfile);
        const targetProf = buildSafeProfilePreview(targetId, data && data.targetProfile);

        getOrCreateFriendMap(incomingRequestsStore, targetId).set(fromId, {
            fromId,
            createdAt: now,
            profileSnapshot: fromProf
        });
        myOutgoing.set(targetId, {
            targetId,
            createdAt: now,
            profileSnapshot: targetProf
        });

        emitToPlayerIfOnline(targetId, 'friendRequestReceived', {
            fromId,
            profile: fromProf,
            state: getFriendSystemSnapshot(targetId)
        });

        if (typeof cb === 'function') {
            cb({
                ok: true,
                status: 'pending',
                profile: targetProf,
                state: getFriendSystemSnapshot(fromId)
            });
        }
    });

    socket.on('respondFriendRequest', (data = {}, cb) => {
        const myId = String((data && data.playerId) || socket.playerId || '').trim().toUpperCase();
        const fromId = String((data && data.fromId) || '').trim().toUpperCase();
        const action = String((data && data.action) || '').trim().toLowerCase(); // 'accept' | 'reject'

        if (!myId || !fromId || (action !== 'accept' && action !== 'reject')) {
            if (typeof cb === 'function') cb({ ok: false, message: 'Invalid response parameters.' });
            return;
        }

        if (data && data.myProfile && typeof data.myProfile === 'object') {
            syncOnlinePlayerProfile(Object.assign({}, data.myProfile, { playerId: myId }), socket.id);
            socket.playerId = myId;
        }

        const myIncoming = incomingRequestsStore.get(myId);
        const existingReq = myIncoming ? myIncoming.get(fromId) : null;

        // If already friends (e.g. mutual race condition), simply succeed cleanly
        if (action === 'accept' && getOrCreateFriendSet(friendshipsStore, myId).has(fromId)) {
            incomingRequestsStore.get(myId)?.delete(fromId);
            outgoingRequestsStore.get(fromId)?.delete(myId);
            if (typeof cb === 'function') {
                cb({
                    ok: true,
                    action: 'accept',
                    profile: buildSafeProfilePreview(fromId, existingReq && existingReq.profileSnapshot),
                    state: getFriendSystemSnapshot(myId)
                });
            }
            return;
        }

        const myProf = buildSafeProfilePreview(myId, data && data.myProfile);
        const fromProf = buildSafeProfilePreview(fromId, existingReq && existingReq.profileSnapshot);

        if (action === 'accept') {
            makeOfficialFriends(myId, fromId);
            emitToPlayerIfOnline(fromId, 'friendRequestAccepted', {
                friendId: myId,
                profile: myProf,
                state: getFriendSystemSnapshot(fromId)
            });
        } else {
            incomingRequestsStore.get(myId)?.delete(fromId);
            outgoingRequestsStore.get(fromId)?.delete(myId);
            emitToPlayerIfOnline(fromId, 'friendRequestRejected', {
                byId: myId,
                profile: myProf,
                state: getFriendSystemSnapshot(fromId)
            });
        }

        if (typeof cb === 'function') {
            cb({
                ok: true,
                action,
                profile: fromProf,
                state: getFriendSystemSnapshot(myId)
            });
        }
    });

    socket.on('cancelFriendRequest', (data = {}, cb) => {
        const myId = String((data && data.playerId) || socket.playerId || '').trim().toUpperCase();
        const targetId = String((data && data.targetId) || '').trim().toUpperCase();
        if (!myId || !targetId) {
            if (typeof cb === 'function') cb({ ok: false });
            return;
        }
        outgoingRequestsStore.get(myId)?.delete(targetId);
        incomingRequestsStore.get(targetId)?.delete(myId);

        emitToPlayerIfOnline(targetId, 'friendSystemUpdated', {
            state: getFriendSystemSnapshot(targetId)
        });

        if (typeof cb === 'function') {
            cb({ ok: true, state: getFriendSystemSnapshot(myId) });
        }
    });

    socket.on('removeFriend', (data = {}, cb) => {
        const myId = String((data && data.playerId) || socket.playerId || '').trim().toUpperCase();
        const friendId = String((data && data.friendId) || '').trim().toUpperCase();
        if (!myId || !friendId) {
            if (typeof cb === 'function') cb({ ok: false });
            return;
        }
        friendshipsStore.get(myId)?.delete(friendId);
        friendshipsStore.get(friendId)?.delete(myId);

        const delivered = emitToPlayerIfOnline(friendId, 'friendRemovedByOther', {
            byId: myId,
            state: getFriendSystemSnapshot(friendId)
        });
        if (!delivered) {
            getOrCreateFriendSet(pendingRemovalStore, friendId).add(myId);
        }

        if (typeof cb === 'function') {
            cb({ ok: true, state: getFriendSystemSnapshot(myId) });
        }
    });

    socket.on('getOnlinePlayersCount', (cb) => {
        const count = Math.max(1, io.engine ? io.engine.clientsCount : 1);
        if (typeof cb === 'function') cb({ count });
    });
    if (socket.conn && socket.conn.transport && socket.conn.transport.socket) {
        try { socket.conn.transport.socket.setNoDelay(true); } catch (e) {}
    }

    socket.on('submitLeaderboardStats', (data = {}, cb) => {
        const uid = (data.uid || socket.id).toString().substring(0, 80);
        recordServerLeaderboardEntry({
            uid: uid,
            name: (data.name || 'Driver').toString().substring(0, 16),
            country: (data.country || 'INTL').toString().substring(0, 8),
            kills: Number(data.kills) || 0,
            damage: Number(data.damage) || 0,
            wins: Number(data.wins) || 0
        });
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('getLeaderboardData', (data = {}, cb) => {
        if (data && data.selfEntry && data.selfEntry.uid) {
            const existing = serverLeaderboardStore.get(data.selfEntry.uid);
            if (!existing) {
                recordServerLeaderboardEntry(data.selfEntry);
            } else {
                serverLeaderboardStore.set(data.selfEntry.uid, {
                    ...existing,
                    name: data.selfEntry.name || existing.name,
                    country: data.selfEntry.country || existing.country,
                    kills: Math.max(existing.kills, Math.floor(Number(data.selfEntry.kills) || 0)),
                    damage: Math.max(existing.damage, Math.floor(Number(data.selfEntry.damage) || 0)),
                    wins: Math.max(existing.wins, Math.floor(Number(data.selfEntry.wins) || 0))
                });
            }
        }
        const entries = Array.from(serverLeaderboardStore.values());
        if (typeof cb === 'function') cb({ entries });
    });

    socket.on('getChampionshipInfo', (cb) => {
        if (typeof cb === 'function') {
            cb({
                seasonYear: championshipData.seasonYear,
                championName: championshipData.championName,
                registeredCount: championshipData.registeredPlayers.length,
                maxPlayers: TOURNAMENT_MAX_PLAYERS,
                stage: championshipData.stage,
                bracket: buildTournamentBracket(championshipData.registeredPlayers)
            });
        }
    });

    socket.on('registerChampionship', (data = {}, cb) => {
        if (championshipData.registeredPlayers.length >= TOURNAMENT_MAX_PLAYERS) {
            if (typeof cb === 'function') cb({ ok: false, message: 'Championship bracket is full (60/60).' });
            return;
        }
        const cleanName = (data.name || 'Player').toString().substring(0, 14);
        const country = (data.country || 'INTL').toString().substring(0, 8);
        const existingIdx = championshipData.registeredPlayers.findIndex(p => p.uid === socket.id);
        const entry = {
            uid: socket.id,
            name: cleanName,
            country: country,
            lastCheckInAt: Date.now(),
            confirmed: true
        };
        if (existingIdx >= 0) championshipData.registeredPlayers[existingIdx] = entry;
        else championshipData.registeredPlayers.push(entry);

        if (typeof cb === 'function') {
            cb({
                ok: true,
                registeredCount: championshipData.registeredPlayers.length,
                maxPlayers: TOURNAMENT_MAX_PLAYERS,
                bracket: buildTournamentBracket(championshipData.registeredPlayers)
            });
        }
    });

    socket.on('confirmChampionshipCheckIn', (cb) => {
        const found = championshipData.registeredPlayers.find(p => p.uid === socket.id);
        if (found) {
            found.lastCheckInAt = Date.now();
            found.confirmed = true;
        }
        if (typeof cb === 'function') cb({ ok: !!found });
    });

    socket.on('pingCheck', (sentAt, callback) => {
        if (typeof callback === 'function') {
            callback(sentAt);
        } else {
            socket.volatile.emit('pongCheck', sentAt);
        }
    });

    // البحث العشوائي السريع (Quick Matchmaking)
    socket.on('findMatch', (data = {}) => {
        leaveRoom(socket);

        const mode = (data.mode || 'br').toLowerCase();
        const maxPlayers = getMaxPlayersForMode(mode);
        const playerName = (data.name || 'Player').toString().substring(0, 14);
        const playerCar = Number.isInteger(data.car) ? data.car : 0;
        const playerSecAbil = Number.isInteger(data.secAbil) ? data.secAbil : 1;
        const playerHasPass = !!data.hasPass;
        const playerHasAwakening = !!data.hasAwakening;

        let targetRoomId = Object.keys(rooms).find(id => {
            const r = rooms[id];
            return r && r.mode === mode && !r.started && !r.isPrivate && r.players.length < maxPlayers;
        });

        if (!targetRoomId) {
            targetRoomId = `room_${mode}_${roomSequence++}_${Date.now()}`;
            rooms[targetRoomId] = createNewRoomObject(targetRoomId, mode, false);
        }

        const room = rooms[targetRoomId];
        socket.join(targetRoomId);
        socket.currentRoomId = targetRoomId;

        room.players.push({
            id: socket.id,
            name: playerName,
            car: playerCar,
            secAbil: playerSecAbil,
            hasPass: playerHasPass,
            hasAwakening: playerHasAwakening,
            socket: socket
        });

        broadcastLobbyState(targetRoomId);

        if (room.players.length >= maxPlayers) {
            if (room.lobbyTimer) {
                clearInterval(room.lobbyTimer);
                room.lobbyTimer = null;
            }
            startGame(targetRoomId);
            return;
        }

        if (!room.lobbyTimer) {
            room.lobbyTimer = setInterval(() => {
                if (!rooms[targetRoomId] || rooms[targetRoomId].started) {
                    clearInterval(room.lobbyTimer);
                    return;
                }
                room.countdown--;
                if (room.countdown <= 0 || room.players.length >= getMaxPlayersForMode(room.mode)) {
                    clearInterval(room.lobbyTimer);
                    room.lobbyTimer = null;
                    startGame(targetRoomId);
                } else {
                    broadcastLobbyState(targetRoomId);
                }
            }, 1000);
        }
    });

    // إنشاء روم خاص (Custom Private Room)
    socket.on('createPrivateRoom', (data = {}) => {
        leaveRoom(socket);

        const mode = (data.mode || 'br').toLowerCase();
        const allowBots = data.allowBots !== false;
        const playerName = (data.name || 'Player').toString().substring(0, 14);
        const playerCar = Number.isInteger(data.car) ? data.car : 0;
        const playerSecAbil = Number.isInteger(data.secAbil) ? data.secAbil : 1;
        const playerHasPass = !!data.hasPass;
        const playerHasAwakening = !!data.hasAwakening;

        const code = generatePrivateCode();
        const roomId = `priv_${code}_${Date.now()}`;
        const room = createNewRoomObject(roomId, mode, true);
        room.code = code;
        room.hostId = socket.id;
        room.allowBots = allowBots;
        rooms[roomId] = room;

        socket.join(roomId);
        socket.currentRoomId = roomId;

        room.players.push({
            id: socket.id,
            name: playerName,
            car: playerCar,
            secAbil: playerSecAbil,
            hasPass: playerHasPass,
            hasAwakening: playerHasAwakening,
            socket: socket
        });

        socket.emit('privateRoomCreated', buildPrivateRoomPayload(room));
    });

    // الانضمام إلى روم خاص عبر الكود أو الرابط
    socket.on('joinPrivateRoom', (data = {}) => {
        const cleanCode = (data.code || '').toString().trim().toUpperCase();
        if (!cleanCode) {
            socket.emit('privateRoomError', { message: 'Invalid Room Code!' });
            return;
        }

        const targetRoomId = Object.keys(rooms).find(id => {
            const r = rooms[id];
            return r && r.isPrivate && r.code === cleanCode;
        });

        if (!targetRoomId || !rooms[targetRoomId]) {
            socket.emit('privateRoomError', { message: 'Room not found or expired!' });
            return;
        }

        const room = rooms[targetRoomId];
        if (room.started) {
            socket.emit('privateRoomError', { message: 'Match already started in this room!' });
            return;
        }

        const maxPlayers = getMaxPlayersForMode(room.mode);
        if (room.players.length >= maxPlayers) {
            socket.emit('privateRoomError', { message: `Room is full (${maxPlayers}/${maxPlayers})!` });
            return;
        }

        leaveRoom(socket);

        const playerName = (data.name || 'Player').toString().substring(0, 14);
        const playerCar = Number.isInteger(data.car) ? data.car : 0;
        const playerSecAbil = Number.isInteger(data.secAbil) ? data.secAbil : 1;
        const playerHasPass = !!data.hasPass;
        const playerHasAwakening = !!data.hasAwakening;

        socket.join(targetRoomId);
        socket.currentRoomId = targetRoomId;

        room.players.push({
            id: socket.id,
            name: playerName,
            car: playerCar,
            secAbil: playerSecAbil,
            hasPass: playerHasPass,
            hasAwakening: playerHasAwakening,
            socket: socket
        });

        broadcastPrivateRoomState(targetRoomId);
    });

    // تحديث إعدادات الروم الخاص (تغيير المود أو تفعيل/منع البوتات) من قِبل صاحب الروم
    socket.on('updatePrivateRoom', (data = {}) => {
        const roomId = socket.currentRoomId;
        const room = roomId ? rooms[roomId] : null;
        if (!room || !room.isPrivate || room.started || room.hostId !== socket.id) return;

        if (data.mode) {
            const nextMode = data.mode.toString().toLowerCase();
            if (['br', 'dm', 'ctf'].includes(nextMode)) {
                room.mode = nextMode;
            }
        }
        if (typeof data.allowBots === 'boolean') {
            room.allowBots = data.allowBots;
        }

        broadcastPrivateRoomState(roomId);
    });

    // بدء مباراة الروم الخاص من قِبل صاحب الروم
    socket.on('startPrivateRoom', () => {
        const roomId = socket.currentRoomId;
        const room = roomId ? rooms[roomId] : null;
        if (!room || !room.isPrivate || room.started || room.hostId !== socket.id) return;
        startGame(roomId);
    });

    socket.on('playerInput', (data) => {
        const roomId = socket.currentRoomId;
        if (!roomId || !rooms[roomId] || !rooms[roomId].started) return;
        const room = rooms[roomId];
        if (data && data.controls) {
            room.inputs.set(socket.id, data.controls);
        }
    });

    socket.on('sendPacket', (data) => {
        if (!data || !data.roomId) return;
        const room = rooms[data.roomId];
        if (room && room.started && data.packet && data.packet.type === 'input') {
            room.inputs.set(socket.id, data.packet.controls || {});
            return;
        }
        socket.to(data.roomId).emit('receivePacket', data.packet);
    });

    socket.on('cancelMatchmaking', () => {
        leaveRoom(socket);
    });

    socket.on('leaveMatch', () => {
        leaveRoom(socket);
    });

    socket.on('disconnect', () => {
        if (socket.playerId && onlinePlayerDirectory.has(socket.playerId)) {
            const rec = onlinePlayerDirectory.get(socket.playerId);
            if (rec && rec.socketId === socket.id) {
                rec.online = false;
                rec.lastSeen = Date.now();
            }
        } else {
            for (const rec of onlinePlayerDirectory.values()) {
                if (rec && rec.socketId === socket.id) {
                    rec.online = false;
                    rec.lastSeen = Date.now();
                }
            }
        }
        setTimeout(broadcastOnlinePlayersCount, 120);
        leaveRoom(socket);
    });
});

function createNewRoomObject(id, mode, isPrivate = false) {
    return {
        id: id,
        code: null,
        hostId: null,
        mode: mode,
        isPrivate: isPrivate,
        allowBots: true,
        players: [],
        inputs: new Map(),
        countdown: LOBBY_WAIT_TIME,
        lobbyTimer: null,
        simInterval: null,
        netInterval: null,
        started: false,
        finished: false,
        state: null
    };
}

function buildPrivateRoomPayload(room) {
    const maxPlayers = getMaxPlayersForMode(room.mode);
    return {
        roomId: room.id,
        code: room.code,
        hostId: room.hostId,
        mode: room.mode,
        allowBots: room.allowBots !== false,
        playersCount: room.players.length,
        maxPlayers: maxPlayers,
        players: room.players.map(p => ({
            id: p.id,
            name: p.name,
            car: p.car,
            secAbil: p.secAbil,
            hasPass: !!p.hasPass
        }))
    };
}

function broadcastPrivateRoomState(roomId) {
    const room = rooms[roomId];
    if (!room || !room.isPrivate || room.started) return;
    io.to(roomId).emit('privateRoomUpdate', buildPrivateRoomPayload(room));
}

function broadcastLobbyState(roomId) {
    const room = rooms[roomId];
    if (!room || room.started) return;
    const maxPlayers = getMaxPlayersForMode(room.mode);
    const playersList = room.players.map(p => ({ id: p.id, name: p.name, car: p.car, secAbil: p.secAbil, hasPass: !!p.hasPass }));
    io.to(roomId).emit('lobbyUpdate', {
        roomId: roomId,
        playersCount: room.players.length,
        maxPlayers: maxPlayers,
        players: playersList,
        countdown: room.countdown
    });
}

function startGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.started || room.players.length === 0) return;

    room.started = true;
    if (room.lobbyTimer) {
        clearInterval(room.lobbyTimer);
        room.lobbyTimer = null;
    }

    const maxPlayers = getMaxPlayersForMode(room.mode);
    const realPlayersData = room.players.map(p => ({
        id: p.id,
        name: p.name,
        car: p.car,
        secAbil: p.secAbil || 1,
        hasPass: !!p.hasPass,
        hasAwakening: !!p.hasAwakening
    }));

    // إذا كان الروم خاصاً وتم إيقاف البوتات من قِبل صاحب الروم، يكون عدد البوتات 0
    const botsCount = (room.isPrivate && !room.allowBots)
        ? 0
        : Math.max(0, maxPlayers - realPlayersData.length);

    initServerWorld(room, realPlayersData, botsCount);

    const initialSnapshot = buildRoomSnapshot(room, true);

    room.players.forEach((p) => {
        p.socket.emit('matchFound', {
            role: 'player',
            serverAuthoritative: true,
            isPrivate: !!room.isPrivate,
            roomId: roomId,
            mode: room.mode,
            players: realPlayersData,
            totalPlayers: realPlayersData.length,
            botsCount: botsCount,
            initialState: initialSnapshot
        });
    });

    room.simInterval = setInterval(() => {
        if (!rooms[roomId] || room.finished) return;
        simulateRoomStep(room);
    }, 1000 / 60);

    room.netInterval = setInterval(() => {
        if (!rooms[roomId] || room.finished) return;
        io.to(roomId).volatile.emit('serverState', buildRoomSnapshot(room, false));
    }, 40);
}

function initServerWorld(room, realPlayers, botsCount) {
    const mode = room.mode.toUpperCase();
    const mapIndex = Math.floor(Math.random() * 5);

    const obstacles = [];
    for (let i = 0; i < 40; i++) {
        obstacles.push({
            x: Math.round(100 + Math.random() * (MAP_SIZE - 200)),
            y: Math.round(100 + Math.random() * (MAP_SIZE - 200)),
            r: Math.round(30 + Math.random() * 50)
        });
    }

    // نقاط انطلاق محددة ومنظمة للباتل رويال حول الخريطة
    const BR_SPAWN_SLOTS = [
        { x: 340,  y: 340 },
        { x: 2160, y: 340 },
        { x: 340,  y: 2160 },
        { x: 2160, y: 2160 },
        { x: 1250, y: 290 },
        { x: 1250, y: 2210 },
        { x: 290,  y: 1250 },
        { x: 2210, y: 1250 },
        { x: 760,  y: 760 },
        { x: 1740, y: 1740 }
    ];
    for (let i = BR_SPAWN_SLOTS.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [BR_SPAWN_SLOTS[i], BR_SPAWN_SLOTS[j]] = [BR_SPAWN_SLOTS[j], BR_SPAWN_SLOTS[i]];
    }
    let brSlotCursor = 0;
    const getSpawnPosition = (team) => {
        if (mode === 'CTF') {
            return {
                x: team === 'red' ? 200 + Math.random() * 200 : MAP_SIZE - 400 + Math.random() * 200,
                y: MAP_SIZE / 2 - 200 + Math.random() * 400
            };
        }
        if (mode === 'BR') {
            const slot = BR_SPAWN_SLOTS[brSlotCursor % BR_SPAWN_SLOTS.length];
            brSlotCursor++;
            for (let oi = obstacles.length - 1; oi >= 0; oi--) {
                if (Math.hypot(obstacles[oi].x - slot.x, obstacles[oi].y - slot.y) < obstacles[oi].r + 75) {
                    obstacles.splice(oi, 1);
                }
            }
            return { x: slot.x, y: slot.y };
        }
        return {
            x: 300 + Math.random() * (MAP_SIZE - 600),
            y: 300 + Math.random() * (MAP_SIZE - 600)
        };
    };

    const cars = [];
    realPlayers.forEach((pData, idx) => {
        const team = mode === 'CTF' ? (idx % 2 === 0 ? 'red' : 'blue') : null;
        const pos = getSpawnPosition(team);
        const carObj = createServerCar(pData.id, pData.name, pos.x, pos.y, false, pData.car, pData.secAbil, team, !!pData.hasPass, !!pData.hasAwakening);
        carObj.angle = Math.atan2(MAP_SIZE / 2 - pos.y, MAP_SIZE / 2 - pos.x);
        cars.push(carObj);
    });

    for (let i = 0; i < botsCount; i++) {
        const bType = Math.floor(Math.random() * 18);
        const redCount = cars.filter(c => c.team === 'red').length;
        const blueCount = cars.filter(c => c.team === 'blue').length;
        const team = mode === 'CTF' ? (redCount <= blueCount ? 'red' : 'blue') : null;
        const pos = getSpawnPosition(team);
        const bName = BOT_NAMES[i] || `Bot_${i + 1}`;
        const botSec = Math.floor(Math.random() * 7) + 1;
        const botObj = createServerCar(`bot_${i}`, bName, pos.x, pos.y, true, bType, botSec, team, false);
        botObj.angle = Math.atan2(MAP_SIZE / 2 - pos.y, MAP_SIZE / 2 - pos.x);
        cars.push(botObj);
    }

    room.state = {
        map: mapIndex,
        mode: mode,
        initialCarsCount: cars.length,
        introTimer: 132,
        timer: 0,
        dmTimer: 180 * 60,
        redScore: 0,
        blueScore: 0,
        ctfFlags: {
            red: { x: 200, y: MAP_SIZE / 2, baseX: 200, baseY: MAP_SIZE / 2, carrierUid: null },
            blue: { x: MAP_SIZE - 200, y: MAP_SIZE / 2, baseX: MAP_SIZE - 200, baseY: MAP_SIZE / 2, carrierUid: null }
        },
        zone: { x: MAP_SIZE / 2, y: MAP_SIZE / 2, radius: MAP_SIZE * 0.7 },
        cars: cars,
        obstacles: obstacles,
        drops: [],
        mines: [],
        lavas: [],
        fogs: [],
        turrets: [],
        walls: [],
        debris: [],
        respawningObstacles: [],
        bullets: []
    };
}

function createServerCar(uid, name, x, y, isAI, carType, secType, team, hasPass = false, hasAwakening = false) {
    return {
        uid: uid,
        id: name,
        x: x,
        y: y,
        angle: Math.random() * Math.PI * 2,
        speed: 0,
        maxSpeed: 8,
        rotSpeed: 0.06,
        hp: 100,
        maxHp: 100,
        isAI: isAI,
        carType: carType || 0,
        secType: secType || 1,
        secCD: 0,
        radarTimer: 0,
        visionTimer: 0,
        trajectoryTimer: 0,
        dualSkillReady: false,
        bonusCarType: -1,
        cdBoostReady: false,
        hasPass: !!hasPass,
        hasAwakening: !!hasAwakening,
        w: 38,
        h: 65,
        alive: true,
        shootCD: 0,
        abilCD: 0,
        abilActive: 0,
        shield: 0,
        shieldTimer: 0,
        healOverTimeRemaining: 0,
        healOverTimeTick: 0,
        ammo: 12,
        maxAmmo: 12,
        reloadTimer: 0,
        stunTimer: 0,
        slowTimer: 0,
        silenceTimer: 0,
        curseTimer: 0,
        cursedByUid: null,
        blindTimer: 0,
        invisTimer: 0,
        hookTimer: 0,
        hookTargetUid: null,
        hookPullSelf: false,
        soulReapTimer: 0,
        drillTimer: 0,
        drillHitUids: [],
        mindControlTimer: 0,
        controlledTargetUid: null,
        controlledByUid: null,
        respawnTimer: 0,
        kills: 0,
        dmgDealt: 0,
        flagsScored: 0,
        isReviving: false,
        team: team,
        hasFlag: null,
        rank: 1
    };
}

function clearServerMindControlLinks(st, car) {
    if (!st || !car) return;
    if (car.controlledTargetUid) {
        const t = st.cars.find(c => c.uid === car.controlledTargetUid);
        if (t && t.controlledByUid === car.uid) {
            t.controlledByUid = null;
        }
    }
    if (car.controlledByUid) {
        const ctrlCar = st.cars.find(c => c.uid === car.controlledByUid);
        if (ctrlCar && ctrlCar.controlledTargetUid === car.uid) {
            ctrlCar.controlledTargetUid = null;
            ctrlCar.mindControlTimer = 0;
        }
    }
    car.controlledTargetUid = null;
    car.controlledByUid = null;
    car.mindControlTimer = 0;
}

function carHasTrait(car, typeId) {
    return car.carType === typeId || (car.abilActive > 0 && car.bonusCarType > 0 && car.bonusCarType === typeId);
}

function driveServerCar(car, control) {
    if (!car || !control) return;
    const stick = control.stick;
    if (stick && Number.isFinite(stick.x) && Number.isFinite(stick.y) && Math.hypot(stick.x, stick.y) > 0) {
        const strength = Math.min(1, Math.hypot(stick.x, stick.y));
        const desired = Math.atan2(stick.y, stick.x);
        const turn = Math.atan2(Math.sin(desired - car.angle), Math.cos(desired - car.angle));
        car.angle += Math.max(-car.rotSpeed, Math.min(car.rotSpeed, turn));
        const targetSpeed = car.maxSpeed * strength * Math.max(0.2, Math.cos(turn));
        car.speed += Math.max(-0.3, Math.min(0.3, targetSpeed - car.speed));
    } else {
        if (control.up) car.speed = Math.min(car.maxSpeed, car.speed + 0.3);
        else if (control.down) car.speed = Math.max(-3, car.speed - 0.3);
        else car.speed *= 0.92;
        if (control.left) car.angle -= car.rotSpeed;
        if (control.right) car.angle += car.rotSpeed;
    }
}

function simulateRoomStep(room) {
    const st = room.state;
    if (!st) return;

    if (st.introTimer > 0) {
        st.introTimer--;
        return;
    }

    st.timer++;
    if (st.mode === 'BR') {
        if (st.zone.radius > 150) st.zone.radius -= 0.2;
    } else {
        st.dmTimer--;
    }

    if (st.timer % 600 === 0 && st.drops.length < 5) {
        st.drops.push({
            x: Math.round(st.zone.x + (Math.random() - 0.5) * st.zone.radius * 1.5),
            y: Math.round(st.zone.y + (Math.random() - 0.5) * st.zone.radius * 1.5),
            r: 20,
            type: 'hp'
        });
    }

    for (let i = st.mines.length - 1; i >= 0; i--) {
        const m = st.mines[i];
        m.timer--;
        const ownerCar = st.cars.find(c => c.uid === m.ownerUid);
        st.cars.forEach(c => {
            if (c.alive && !c.isReviving && c.uid !== m.ownerUid && Math.hypot(c.x - m.x, c.y - m.y) < 250) {
                if (st.mode === 'CTF' && ownerCar && c.team === ownerCar.team) return;
                const ang = Math.atan2(m.y - c.y, m.x - c.x);
                c.x += Math.cos(ang) * 3;
                c.y += Math.sin(ang) * 3;
            }
        });
        if (m.timer <= 0) {
            st.cars.forEach(c => {
                if (c.alive && !c.isReviving && Math.hypot(c.x - m.x, c.y - m.y) < 150) {
                    if (st.mode === 'CTF' && ownerCar && c.team === ownerCar.team) return;
                    damageServerCar(room, c, 40, ownerCar);
                }
            });
            st.mines.splice(i, 1);
        }
    }

    for (let i = st.lavas.length - 1; i >= 0; i--) {
        const l = st.lavas[i];
        l.timer--;
        const ownerCar = st.cars.find(c => c.uid === l.ownerUid);
        st.cars.forEach(c => {
            if (c.alive && !c.isReviving && c.uid !== l.ownerUid && Math.hypot(c.x - l.x, c.y - l.y) < 120) {
                if (st.mode === 'CTF' && ownerCar && c.team === ownerCar.team) return;
                c.slowTimer = 12;
                c.speed *= 0.42;
                damageServerCar(room, c, 0.5, ownerCar);
            }
        });
        if (l.timer <= 0) st.lavas.splice(i, 1);
    }

    // تحديث مناطق الضباب المشوش للرؤية (Car 11: Mirage Hazmat)
    for (let i = st.fogs.length - 1; i >= 0; i--) {
        const fg = st.fogs[i];
        fg.timer--;
        const ownerCar = st.cars.find(c => c.uid === fg.ownerUid);
        st.cars.forEach(c => {
            if (c.alive && !c.isReviving && c.uid !== fg.ownerUid && Math.hypot(c.x - fg.x, c.y - fg.y) < 145) {
                if (st.mode === 'CTF' && ownerCar && c.team === ownerCar.team) return;
                c.blindTimer = 300;
            }
        });
        if (fg.timer <= 0) st.fogs.splice(i, 1);
    }

    // تحديث روبوتات السنايبر في السيرفر
    for (let i = st.turrets.length - 1; i >= 0; i--) {
        let t = st.turrets[i];
        t.timer--;
        if (t.shootCD > 0) t.shootCD--;
        const ownerCar = st.cars.find(c => c.uid === t.ownerUid);
        if (t.shootCD <= 0) {
            let target = null, minDist = 650;
            st.cars.forEach(c => {
                if (c.alive && !c.isReviving && c.uid !== t.ownerUid) {
                    if (st.mode === 'CTF' && ownerCar && c.team === ownerCar.team) return;
                    const d = Math.hypot(c.x - t.x, c.y - t.y);
                    if (d < minDist) { minDist = d; target = c; }
                }
            });
            if (target) {
                t.angle = Math.atan2(target.y - t.y, target.x - t.x);
                st.bullets.push({
                    x: t.x + Math.cos(t.angle) * 20,
                    y: t.y + Math.sin(t.angle) * 20,
                    vx: Math.cos(t.angle) * 22,
                    vy: Math.sin(t.angle) * 22,
                    angle: t.angle,
                    ownerUid: t.ownerUid,
                    sourceUid: t.ownerUid,
                    dmg: 55,
                    isHeart: false,
                    isSniper: true,
                    isEmpArc: false,
                    isHackArrow: false
                });
                t.shootCD = 85;
            }
        }
        if (t.timer <= 0) {
            st.turrets.splice(i, 1);
        }
    }

    // تحديث الجدران العاكسة المؤقتة في السيرفر
    for (let i = st.walls.length - 1; i >= 0; i--) {
        st.walls[i].timer--;
        if (st.walls[i].timer <= 0) st.walls.splice(i, 1);
    }

    // تحديث شظايا العوائق المحطمة (Drill Dozer)
    if (!st.debris) st.debris = [];
    for (let i = st.debris.length - 1; i >= 0; i--) {
        const db = st.debris[i];
        db.timer--;
        const ownerCar = st.cars.find(c => c.uid === db.ownerUid);
        st.cars.forEach(c => {
            if (c.alive && !c.isReviving && c.uid !== db.ownerUid && Math.hypot(c.x - db.x, c.y - db.y) < (db.r || 12) + 20) {
                if (st.mode === 'CTF' && ownerCar && c.team === ownerCar.team) return;
                if (!db.hitCooldowns) db.hitCooldowns = {};
                if ((db.hitCooldowns[c.uid] || 0) <= 0) {
                    db.hitCooldowns[c.uid] = 35;
                    damageServerCar(room, c, 12, ownerCar);
                }
            }
        });
        if (db.hitCooldowns) {
            for (const uidKey in db.hitCooldowns) {
                if (db.hitCooldowns[uidKey] > 0) db.hitCooldowns[uidKey]--;
            }
        }
        if (db.timer <= 0) st.debris.splice(i, 1);
    }

    // إعادة إنشاء العوائق المدمرة بعد فترة في أماكن عشوائية آمنة
    if (!st.respawningObstacles) st.respawningObstacles = [];
    for (let i = st.respawningObstacles.length - 1; i >= 0; i--) {
        st.respawningObstacles[i].timer--;
        if (st.respawningObstacles[i].timer <= 0) {
            const obsRadius = st.respawningObstacles[i].r || Math.round(30 + Math.random() * 50);
            let rx = 250 + Math.random() * (MAP_SIZE - 500);
            let ry = 250 + Math.random() * (MAP_SIZE - 500);
            for (let attempt = 0; attempt < 8; attempt++) {
                const tx = 250 + Math.random() * (MAP_SIZE - 500);
                const ty = 250 + Math.random() * (MAP_SIZE - 500);
                const nearCar = st.cars.some(c => c.alive && Math.hypot(c.x - tx, c.y - ty) < obsRadius + 130);
                if (!nearCar) { rx = tx; ry = ty; break; }
            }
            st.obstacles.push({ x: Math.round(rx), y: Math.round(ry), r: obsRadius });
            st.respawningObstacles.splice(i, 1);
        }
    }

    if (st.mode === 'CTF') {
        st.cars.forEach(c => {
            if (!c.alive || c.isReviving) return;
            if (c.team === 'red' && !st.ctfFlags.blue.carrierUid && Math.hypot(c.x - st.ctfFlags.blue.x, c.y - st.ctfFlags.blue.y) < 50) {
                st.ctfFlags.blue.carrierUid = c.uid;
                c.hasFlag = 'blue';
            } else if (c.team === 'blue' && !st.ctfFlags.red.carrierUid && Math.hypot(c.x - st.ctfFlags.red.x, c.y - st.ctfFlags.red.y) < 50) {
                st.ctfFlags.red.carrierUid = c.uid;
                c.hasFlag = 'red';
            }

            if (c.hasFlag === 'blue' && c.team === 'red' && Math.hypot(c.x - st.ctfFlags.red.baseX, c.y - st.ctfFlags.red.baseY) < 100) {
                st.redScore++;
                c.flagsScored = (c.flagsScored || 0) + 1;
                st.ctfFlags.blue.carrierUid = null;
                st.ctfFlags.blue.x = st.ctfFlags.blue.baseX;
                st.ctfFlags.blue.y = st.ctfFlags.blue.baseY;
                c.hasFlag = null;
            } else if (c.hasFlag === 'red' && c.team === 'blue' && Math.hypot(c.x - st.ctfFlags.blue.baseX, c.y - st.ctfFlags.blue.baseY) < 100) {
                st.blueScore++;
                c.flagsScored = (c.flagsScored || 0) + 1;
                st.ctfFlags.red.carrierUid = null;
                st.ctfFlags.red.x = st.ctfFlags.red.baseX;
                st.ctfFlags.red.y = st.ctfFlags.red.baseY;
                c.hasFlag = null;
            }
        });

        ['red', 'blue'].forEach(flagColor => {
            const flag = st.ctfFlags[flagColor];
            if (flag.carrierUid) {
                const carrier = st.cars.find(c => c.uid === flag.carrierUid);
                if (!carrier || !carrier.alive || carrier.isReviving) {
                    if (carrier) carrier.hasFlag = null;
                    flag.carrierUid = null;
                    flag.x = flag.baseX;
                    flag.y = flag.baseY;
                } else {
                    flag.x = carrier.x;
                    flag.y = carrier.y;
                }
            }
        });

        if (st.redScore >= 3 || st.blueScore >= 3) {
            finishServerMatch(room);
            return;
        }
    }

    st.cars.forEach(c => updateServerCar(room, c));

    function distanceToSegment(px, py, x1, y1, x2, y2) {
        const A = px - x1, B = py - y1, C = x2 - x1, D = y2 - y1;
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        if (lenSq !== 0) param = dot / lenSq;
        let xx, yy;
        if (param < 0) { xx = x1; yy = y1; }
        else if (param > 1) { xx = x2; yy = y2; }
        else { xx = x1 + param * C; yy = y1 + param * D; }
        return Math.hypot(px - xx, py - yy);
    }

    for (let i = st.bullets.length - 1; i >= 0; i--) {
        const b = st.bullets[i];
        const ownerCar = st.cars.find(c => c.uid === b.ownerUid);

        if (b.isHeart) {
            let closest = null, minDist = Infinity;
            st.cars.forEach(c => {
                if (c.uid !== b.ownerUid && c.alive && !c.isReviving) {
                    if (st.mode === 'CTF' && ownerCar && c.team === ownerCar.team) return;
                    const d = Math.hypot(c.x - b.x, c.y - b.y);
                    if (d < minDist) { minDist = d; closest = c; }
                }
            });
            if (closest) {
                const ang = Math.atan2(closest.y - b.y, closest.x - b.x);
                b.vx = Math.cos(ang) * 10;
                b.vy = Math.sin(ang) * 10;
                b.angle = ang;
            }
        }

        b.x += b.vx;
        b.y += b.vy;
        b.distanceTraveled = (b.distanceTraveled || 0) + Math.hypot(b.vx, b.vy);

        if (b.bouncesLeft > 0) {
            let bouncedWall = false;
            if (b.x <= 8 || b.x >= MAP_SIZE - 8) {
                b.vx = -b.vx;
                b.x = Math.max(10, Math.min(MAP_SIZE - 10, b.x));
                bouncedWall = true;
            }
            if (b.y <= 8 || b.y >= MAP_SIZE - 8) {
                b.vy = -b.vy;
                b.y = Math.max(10, Math.min(MAP_SIZE - 10, b.y));
                bouncedWall = true;
            }
            if (bouncedWall) {
                b.bouncesLeft--;
                b.angle = Math.atan2(b.vy, b.vx);
            }
        }

        for (const w of st.walls) {
            if (b.ownerUid !== w.ownerUid) {
                const wallOwner = st.cars.find(c => c.uid === w.ownerUid);
                if (!wallOwner || !ownerCar || st.mode !== 'CTF' || ownerCar.team !== wallOwner.team) {
                    const half = (w.length || 115) / 2;
                    const x1 = w.x - Math.cos(w.angle) * half;
                    const y1 = w.y - Math.sin(w.angle) * half;
                    const x2 = w.x + Math.cos(w.angle) * half;
                    const y2 = w.y + Math.sin(w.angle) * half;
                    if (distanceToSegment(b.x, b.y, x1, y1, x2, y2) < 16) {
                        b.vx = -b.vx;
                        b.vy = -b.vy;
                        b.angle = Math.atan2(b.vy, b.vx);
                        b.ownerUid = w.ownerUid;
                        b.sourceUid = w.ownerUid;
                        b.x += b.vx * 1.2;
                        b.y += b.vy * 1.2;
                        break;
                    }
                }
            }
        }

        let hit = false;
        const hitObs = st.obstacles.find(o => Math.hypot(b.x - o.x, b.y - o.y) < o.r);
        if (hitObs) {
            if (b.bouncesLeft > 0) {
                const dObs = Math.max(1, Math.hypot(b.x - hitObs.x, b.y - hitObs.y));
                const nx = (b.x - hitObs.x) / dObs;
                const ny = (b.y - hitObs.y) / dObs;
                const dot = b.vx * nx + b.vy * ny;
                b.vx = b.vx - 2 * dot * nx;
                b.vy = b.vy - 2 * dot * ny;
                b.angle = Math.atan2(b.vy, b.vx);
                b.x = hitObs.x + nx * (hitObs.r + 6);
                b.y = hitObs.y + ny * (hitObs.r + 6);
                b.bouncesLeft--;
            } else {
                hit = true;
            }
        }

        if (!hit) {
            const hitRadius = b.isEmpArc ? 38 : (b.isHook ? 36 : (b.isCurseOrb ? 34 : (b.isHackArrow ? 32 : 28)));
            const ignoreUid = b.sourceUid || b.ownerUid;
            const target = st.cars.find(c =>
                c.alive && !c.isReviving &&
                c.uid !== ignoreUid && c.uid !== b.ownerUid &&
                Math.hypot(c.x - b.x, c.y - b.y) < hitRadius &&
                (st.mode !== 'CTF' || !ownerCar || c.team !== ownerCar.team)
            );
            if (target) {
                const distRatio = Math.min(1, (b.distanceTraveled || 0) / 1100);
                const falloffMult = 1 - (distRatio * 0.55);
                const applyServerScaledDmg = (victim, baseAmt, atkCar) => {
                    const scaledDmg = Math.max(1, Math.round(baseAmt * falloffMult));
                    if (atkCar && atkCar.alive && atkCar.curseTimer > 0) {
                        const curseCaster = st.cars.find(c => c.uid === atkCar.cursedByUid) || victim;
                        damageServerCar(room, atkCar, scaledDmg, curseCaster);
                    } else {
                        damageServerCar(room, victim, scaledDmg, atkCar);
                    }
                };

                if (b.isCurseOrb) {
                    target.curseTimer = 600;
                    target.cursedByUid = ownerCar ? ownerCar.uid : b.ownerUid;
                } else if (b.isHeart) {
                    target.stunTimer = 180;
                } else if (b.isEmpArc) {
                    target.silenceTimer = 300;
                    target.abilActive = 0;
                    target.invisTimer = 0;
                    applyServerScaledDmg(target, b.dmg || 15, ownerCar);
                } else if (b.isHackArrow) {
                    if (ownerCar && ownerCar.alive && !ownerCar.isReviving) {
                        clearServerMindControlLinks(st, ownerCar);
                        clearServerMindControlLinks(st, target);
                        ownerCar.mindControlTimer = 600;
                        ownerCar.controlledTargetUid = target.uid;
                        target.controlledByUid = ownerCar.uid;
                        target.mindControlTimer = 600;
                    }
                    applyServerScaledDmg(target, b.dmg || 10, ownerCar);
                } else if (b.isHook) {
                    if (ownerCar && ownerCar.alive && !ownerCar.isReviving) {
                        ownerCar.hookTimer = 28;
                        ownerCar.hookTargetUid = target.uid;
                        ownerCar.hookPullSelf = (ownerCar.hp < target.hp);
                        target.stunTimer = Math.max(target.stunTimer || 0, 28);
                    }
                    applyServerScaledDmg(target, b.dmg || 15, ownerCar);
                } else {
                    applyServerScaledDmg(target, b.dmg, ownerCar);
                }
                hit = true;
            }
        }
        if (hit || b.x < 0 || b.x > MAP_SIZE || b.y < 0 || b.y > MAP_SIZE) {
            st.bullets.splice(i, 1);
        }
    }

    if (st.mode === 'DM' || st.mode === 'CTF') {
        if (st.dmTimer <= 0) {
            finishServerMatch(room);
        }
    } else {
        const aliveCars = st.cars.filter(c => c.alive);
        const aliveHumans = st.cars.filter(c => !c.isAI && c.alive);
        // إذا بدأ صاحب الروم الخاص وحده مع إيقاف البوتات، لا تنتهي المباراة فوراً إلا عند موته
        const minAliveToEnd = (st.initialCarsCount && st.initialCarsCount <= 1) ? 0 : 1;
        if (aliveCars.length <= minAliveToEnd || aliveHumans.length === 0) {
            finishServerMatch(room);
        }
    }
}

function updateServerCar(room, car) {
    const st = room.state;
    if (!car.alive) {
        if ((st.mode === 'DM' || st.mode === 'CTF') && car.respawnTimer > 0) {
            car.respawnTimer--;
            if (car.respawnTimer <= 0) {
                car.hp = car.maxHp;
                car.alive = true;
                car.shield = 0;
                car.ammo = car.maxAmmo;
                car.reloadTimer = 0;
                if (st.mode === 'CTF') {
                    car.x = car.team === 'red' ? 200 + Math.random() * 200 : MAP_SIZE - 400 + Math.random() * 200;
                    car.y = MAP_SIZE / 2 - 200 + Math.random() * 400;
                } else {
                    car.x = 300 + Math.random() * (MAP_SIZE - 600);
                    car.y = 300 + Math.random() * (MAP_SIZE - 600);
                }
                car.abilActive = 0;
                car.bonusCarType = -1;
                car.stunTimer = 0;
                car.slowTimer = 0;
                car.silenceTimer = 0;
                car.blindTimer = 0;
                car.invisTimer = 0;
                car.hookTimer = 0;
                car.hookTargetUid = null;
                car.soulReapTimer = 0;
                car.drillTimer = 0;
                car.drillHitUids = [];
                clearServerMindControlLinks(st, car);
            }
        }
        return;
    }

    if (car.isReviving) {
        car.respawnTimer--;
        if (car.respawnTimer <= 0) {
            car.hp = car.maxHp * 0.5;
            car.isReviving = false;
        }
        return;
    }

    if (car.reloadTimer > 0) {
        car.reloadTimer--;
        if (car.reloadTimer <= 0) car.ammo = car.maxAmmo;
    }
    if (car.shieldTimer > 0) {
        car.shieldTimer--;
        if (car.shieldTimer <= 0) {
            car.shield = 0;
        }
    }
    if (car.healOverTimeRemaining > 0) {
        car.healOverTimeRemaining--;
        car.healOverTimeTick = (car.healOverTimeTick || 0) + 1;
        if (car.healOverTimeTick >= 60) {
            car.healOverTimeTick = 0;
            car.hp = Math.min(car.maxHp, car.hp + 10);
            if (car.hasAwakening && car.carType === 1 && st.mode === 'CTF' && car.team) {
                st.cars.forEach(ally => {
                    if (ally.uid !== car.uid && ally.alive && !ally.isReviving && ally.team === car.team) {
                        ally.hp = Math.min(ally.maxHp, ally.hp + 10);
                    }
                });
            }
        }
    }
    if (car.curseTimer > 0) {
        car.curseTimer--;
        if (car.curseTimer <= 0) car.cursedByUid = null;
    }
    if (car.silenceTimer > 0) {
        car.silenceTimer--;
        car.invisTimer = 0;
    }
    if (car.blindTimer > 0) car.blindTimer--;
    if (car.visionTimer > 0) car.visionTimer--;
    if (car.trajectoryTimer > 0) car.trajectoryTimer--;
    if (car.invisTimer > 0) car.invisTimer--;
    if (car.soulReapTimer > 0) car.soulReapTimer--;

    if (car.hookTimer > 0) {
        car.hookTimer--;
        const hookedTarget = car.hookTargetUid ? st.cars.find(c => c.uid === car.hookTargetUid && c.alive && !c.isReviving) : null;
        if (!hookedTarget) {
            car.hookTimer = 0;
            car.hookTargetUid = null;
        } else {
            const mover = car.hookPullSelf ? car : hookedTarget;
            const anchor = car.hookPullSelf ? hookedTarget : car;
            const dist = Math.hypot(anchor.x - mover.x, anchor.y - mover.y);
            if (dist > 78) {
                const pullAng = Math.atan2(anchor.y - mover.y, anchor.x - mover.x);
                const step = Math.min(24, dist - 72);
                mover.x = Math.max(30, Math.min(MAP_SIZE - 30, mover.x + Math.cos(pullAng) * step));
                mover.y = Math.max(30, Math.min(MAP_SIZE - 30, mover.y + Math.sin(pullAng) * step));
            } else {
                car.hookTimer = 0;
                car.hookTargetUid = null;
            }
        }
    }
    if (car.mindControlTimer > 0) {
        car.mindControlTimer--;
        if (car.mindControlTimer <= 0) {
            clearServerMindControlLinks(st, car);
        }
    }

    if (car.controlledTargetUid) {
        const t = st.cars.find(c => c.uid === car.controlledTargetUid);
        if (!t || !t.alive || t.isReviving) {
            clearServerMindControlLinks(st, car);
        }
    }
    if (car.controlledByUid) {
        const ctrlCar = st.cars.find(c => c.uid === car.controlledByUid);
        if (!ctrlCar || !ctrlCar.alive || ctrlCar.isReviving || ctrlCar.mindControlTimer <= 0) {
            car.controlledByUid = null;
        }
    }

    if (car.stunTimer > 0) {
        car.stunTimer--;
        return;
    }

    if (car.shootCD > 0) car.shootCD--;
    if (car.abilCD > 0) car.abilCD--;
    if (car.secCD > 0) car.secCD--;
    if (car.radarTimer > 0) car.radarTimer--;

    const activeController = car.controlledByUid
        ? st.cars.find(c => c.uid === car.controlledByUid && c.alive && !c.isReviving)
        : null;

    if (activeController) {
        let ctrl = {};
        if (!activeController.isAI) {
            ctrl = room.inputs.get(activeController.uid) || {};
        } else {
            ctrl = {
                up: true,
                left: Math.sin(st.timer * 0.08) > 0.3,
                right: Math.cos(st.timer * 0.08) > 0.3,
                shoot: (st.timer % 20 === 0),
                ability: true
            };
        }
        driveServerCar(car, ctrl);
        if (ctrl.reload && car.reloadTimer <= 0 && car.ammo < car.maxAmmo) {
            car.reloadTimer = 90;
        }
        if (ctrl.shoot && car.shootCD <= 0 && car.reloadTimer <= 0) {
            const ammoNeeded = (car.carType === 17) ? 2 : 1;
            if (car.ammo >= ammoNeeded) {
                serverCarShoot(st, car, activeController.uid);
                car.ammo -= ammoNeeded;
                car.shootCD = 12;
                if (car.ammo < ammoNeeded) car.reloadTimer = 90;
            } else {
                car.reloadTimer = 90;
            }
        }
        if (ctrl.ability && car.abilCD <= 0 && car.silenceTimer <= 0) {
            serverCarAbility(st, car);
        }
        if (ctrl.secAbility && car.secCD <= 0 && car.silenceTimer <= 0) {
            serverCarSecondaryAbility(st, car);
        }
    } else if (car.controlledTargetUid && car.mindControlTimer > 0) {
        car.speed *= 0.84;
    } else if (!car.isAI) {
        const control = room.inputs.get(car.uid) || {};
        driveServerCar(car, control);
        if (control.secType) car.secType = control.secType;

        if (control.reload && car.reloadTimer <= 0 && car.ammo < car.maxAmmo) {
            car.reloadTimer = 90;
        }
        if (control.shoot && car.shootCD <= 0 && car.reloadTimer <= 0) {
            const ammoNeeded = (car.carType === 17) ? 2 : 1;
            if (car.ammo >= ammoNeeded) {
                serverCarShoot(st, car);
                car.ammo -= ammoNeeded;
                car.shootCD = 12;
                if (car.ammo < ammoNeeded) car.reloadTimer = 90;
            } else {
                car.reloadTimer = 90;
            }
        }
        if (control.ability && car.abilCD <= 0 && car.silenceTimer <= 0) {
            serverCarAbility(st, car);
        }
        if (control.secAbility && car.secCD <= 0 && car.silenceTimer <= 0) {
            serverCarSecondaryAbility(st, car);
        }
    } else {
        updateServerBotAI(st, car);
    }

    if (car.slowTimer > 0) {
        car.slowTimer--;
        const maxSlowSpeed = car.maxSpeed * 0.42;
        if (car.speed > maxSlowSpeed) car.speed = maxSlowSpeed;
        if (car.speed < -maxSlowSpeed * 0.5) car.speed = -maxSlowSpeed * 0.5;
    }

    if (car.abilActive > 0) {
        car.abilActive--;
        if (carHasTrait(car, 2)) {
            const isAwkArc = !!(car.hasAwakening && car.carType === 2);
            const arcRadius = isAwkArc ? 195 : 125;
            const arcDmg = isAwkArc ? 0.35 : 0.5;
            st.cars.forEach(c => {
                if (c.uid !== car.uid && c.alive && !c.isReviving && Math.hypot(c.x - car.x, c.y - car.y) < arcRadius) {
                    if (st.mode === 'CTF' && c.team === car.team) return;
                    damageServerCar(room, c, arcDmg, car);
                }
            });
        }
        if (car.abilActive <= 0) {
            car.bonusCarType = -1;
        }
    }

    if (car.drillTimer > 0) {
        car.drillTimer--;
        car.speed = car.maxSpeed * 1.95;
        const tipX = car.x + Math.cos(car.angle) * 34;
        const tipY = car.y + Math.sin(car.angle) * 34;
        st.cars.forEach(c => {
            if (c.uid !== car.uid && c.alive && !c.isReviving) {
                if (st.mode === 'CTF' && c.team === car.team) return;
                if (Math.hypot(c.x - tipX, c.y - tipY) < 46) {
                    if (!car.drillHitUids) car.drillHitUids = [];
                    if (!car.drillHitUids.includes(c.uid)) {
                        car.drillHitUids.push(c.uid);
                        damageServerCar(room, c, 28, car);
                        const kbAng = Math.atan2(c.y - car.y, c.x - car.x);
                        c.x = Math.max(30, Math.min(MAP_SIZE - 30, c.x + Math.cos(kbAng) * 45));
                        c.y = Math.max(30, Math.min(MAP_SIZE - 30, c.y + Math.sin(kbAng) * 45));
                    }
                }
            }
        });
        if (car.drillTimer <= 0) {
            car.drillHitUids = [];
        }
    }

    car.x += Math.cos(car.angle) * car.speed;
    car.y += Math.sin(car.angle) * car.speed;

    for (let oi = st.obstacles.length - 1; oi >= 0; oi--) {
        const o = st.obstacles[oi];
        const dist = Math.hypot(car.x - o.x, car.y - o.y);
        const minDist = car.w / 2 + o.r;
        if (dist < minDist) {
            if (car.drillTimer > 0) {
                if (!st.debris) st.debris = [];
                if (!st.respawningObstacles) st.respawningObstacles = [];
                const shardsCount = 4;
                for (let s = 0; s < shardsCount; s++) {
                    const ang = (Math.PI * 2 * s) / shardsCount + Math.random() * 0.6;
                    const dDist = 18 + Math.random() * Math.max(15, o.r * 0.6);
                    st.debris.push({
                        x: Math.round(Math.max(40, Math.min(MAP_SIZE - 40, o.x + Math.cos(ang) * dDist))),
                        y: Math.round(Math.max(40, Math.min(MAP_SIZE - 40, o.y + Math.sin(ang) * dDist))),
                        r: 13,
                        timer: 600,
                        ownerUid: car.uid,
                        hitCooldowns: {}
                    });
                }
                st.respawningObstacles.push({ timer: 720, r: o.r });
                st.obstacles.splice(oi, 1);
            } else {
                const overlap = minDist - dist;
                const dx = dist ? (car.x - o.x) / dist : 1;
                const dy = dist ? (car.y - o.y) / dist : 0;
                car.x += dx * overlap;
                car.y += dy * overlap;
                car.speed *= 0.5;
            }
        }
    }

    car.x = Math.max(30, Math.min(MAP_SIZE - 30, car.x));
    car.y = Math.max(30, Math.min(MAP_SIZE - 30, car.y));

    for (let i = st.drops.length - 1; i >= 0; i--) {
        if (Math.hypot(car.x - st.drops[i].x, car.y - st.drops[i].y) < 30) {
            car.hp = Math.min(car.maxHp, car.hp + 40);
            st.drops.splice(i, 1);
        }
    }

    if (st.mode === 'BR' && Math.hypot(st.zone.x - car.x, st.zone.y - car.y) > st.zone.radius) {
        damageServerCar(room, car, 0.2, null);
    }
}

function updateServerBotAI(st, car) {
    if (car.ammo <= 0 && car.reloadTimer <= 0) car.reloadTimer = 90;
    let closest = null, minDist = Infinity;
    st.cars.forEach(c => {
        if (c.uid !== car.uid && c.alive && !c.isReviving) {
            if (st.mode === 'CTF' && c.team === car.team) return;
            const d = Math.hypot(c.x - car.x, c.y - car.y);
            if (d < minDist) { minDist = d; closest = c; }
        }
    });

    const turnTowards = (targetAngle, speedMod) => {
        let diff = targetAngle - car.angle;
        while (diff <= -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI) diff -= Math.PI * 2;
        car.angle += diff * speedMod;
    };

    const distToCenter = Math.hypot(st.zone.x - car.x, st.zone.y - car.y);

    if (st.mode === 'BR' && distToCenter > st.zone.radius - 150) {
        turnTowards(Math.atan2(st.zone.y - car.y, st.zone.x - car.x), 0.08);
        car.speed = car.maxSpeed * 0.8;
    } else if (st.mode === 'CTF') {
        const tX = car.team === 'red' ? (car.hasFlag ? st.ctfFlags.red.baseX : st.ctfFlags.blue.x) : (car.hasFlag ? st.ctfFlags.blue.baseX : st.ctfFlags.red.x);
        const tY = car.team === 'red' ? (car.hasFlag ? st.ctfFlags.red.baseY : st.ctfFlags.blue.y) : (car.hasFlag ? st.ctfFlags.blue.baseY : st.ctfFlags.red.y);
        if (car.x < 150 || car.x > MAP_SIZE - 150 || car.y < 150 || car.y > MAP_SIZE - 150) {
            turnTowards(Math.atan2(MAP_SIZE / 2 - car.y, MAP_SIZE / 2 - car.x), 0.15);
        } else {
            turnTowards(Math.atan2(tY - car.y, tX - car.x), 0.08);
        }
        car.speed = car.maxSpeed * 0.8;
        if (closest && minDist < 300 && car.shootCD <= 0 && car.ammo > 0 && car.reloadTimer <= 0) {
            serverCarShoot(st, car);
            car.ammo--;
            car.shootCD = 25;
        }
    } else if (closest && minDist < 500) {
        const angleToEnemy = Math.atan2(closest.y - car.y, closest.x - car.x);
        if (minDist < 120 && car.carType !== 4) {
            turnTowards(angleToEnemy + Math.PI, 0.1);
            car.speed = car.maxSpeed * 0.5;
        } else {
            turnTowards(angleToEnemy, 0.08);
            car.speed = car.maxSpeed * 0.6;
        }
        const diffCheck = Math.abs(car.angle - angleToEnemy) % (Math.PI * 2);
        if ((diffCheck < 0.4 || diffCheck > Math.PI * 2 - 0.4) && car.shootCD <= 0 && car.ammo > 0 && car.reloadTimer <= 0) {
            serverCarShoot(st, car);
            car.ammo--;
            car.shootCD = 25;
        }
        if (car.abilCD <= 0 && car.silenceTimer <= 0) {
            if ((car.carType === 0 && car.hp < 75 && car.shield <= 0) ||
                (car.carType === 1 && car.hp < 60) ||
                (car.carType === 2 && minDist < 150) ||
                (car.carType === 3 && minDist < 350) ||
                (car.carType === 4) ||
                (car.carType === 5 && car.hp < 40) ||
                (car.carType === 6 && minDist < 200) ||
                (car.carType === 7 && minDist < 600) ||
                (car.carType === 8 && car.hp < 30) ||
                (car.carType === 9 && minDist < 250) ||
                (car.carType === 10 && minDist < 420) ||
                (car.carType === 11 && minDist < 260) ||
                (car.carType === 12 && minDist < 420 && (diffCheck < 0.25 || diffCheck > Math.PI * 2 - 0.25)) ||
                (car.carType === 13 && (car.hp < 55 || minDist > 300)) ||
                (car.carType === 14 && minDist < 460 && (diffCheck < 0.3 || diffCheck > Math.PI * 2 - 0.3)) ||
                (car.carType === 15 && closest && closest.hp < 45 && minDist < 360) ||
                (car.carType === 16 && minDist < 340 && (diffCheck < 0.35 || diffCheck > Math.PI * 2 - 0.35))) {
                serverCarAbility(st, car);
            }
        }
    } else {
        car.speed = car.maxSpeed * 0.5;
        if (Math.random() < 0.02) car.angle += (Math.random() - 0.5) * 2;
    }

    const sensorX = car.x + Math.cos(car.angle) * 150;
    const sensorY = car.y + Math.sin(car.angle) * 150;
    for (const obs of st.obstacles) {
        if (Math.hypot(sensorX - obs.x, sensorY - obs.y) < obs.r) {
            car.angle += 0.15;
            car.speed *= 0.6;
            break;
        }
    }
}

function createServerBullet(st, car, angOffset, isHeart = false, customDmg = null, isSniper = false, isEmpArc = false, isHackArrow = false, customOwnerUid = null, isHook = false, extraOpts = null) {
    const opts = extraOpts || {};
    let shootAngle = car.angle + angOffset;
    const dmg = isHeart ? 0 : (customDmg !== null ? customDmg : 18);

    if (carHasTrait(car, 4) && car.abilActive > 0 && !isHeart && !isHackArrow && !isEmpArc && !isHook && !opts.isCurseOrb) {
        let closest = null, minDist = Infinity;
        st.cars.forEach(c => {
            if (c.uid !== car.uid && c.alive && !c.isReviving) {
                if (st.mode === 'CTF' && c.team === car.team) return;
                const d = Math.hypot(c.x - car.x, c.y - car.y);
                if (d < minDist) { minDist = d; closest = c; }
            }
        });
        if (closest && minDist < 900) {
            shootAngle = Math.atan2(closest.y - car.y, closest.x - car.x);
        }
    }

    const speed = isHeart ? 10 : (isSniper ? 22 : (isHook ? 21 : (opts.isCurseOrb ? 17 : (isHackArrow ? 18 : (isEmpArc ? 15 : 16)))));
    const perpAngle = shootAngle + Math.PI / 2;
    const lat = opts.lateralOffset || 0;
    st.bullets.push({
        x: car.x + Math.cos(shootAngle) * 28 + Math.cos(perpAngle) * lat,
        y: car.y + Math.sin(shootAngle) * 28 + Math.sin(perpAngle) * lat,
        distanceTraveled: 0,
        vx: Math.round(Math.cos(shootAngle) * speed * 100) / 100,
        vy: Math.round(Math.sin(shootAngle) * speed * 100) / 100,
        angle: Math.round(shootAngle * 1000) / 1000,
        ownerUid: customOwnerUid || car.uid,
        sourceUid: car.uid,
        dmg: dmg,
        isHeart: isHeart,
        isSniper: isSniper,
        isEmpArc: isEmpArc,
        isHackArrow: isHackArrow,
        isHook: isHook,
        isDarkLightBeam: !!opts.isDarkLightBeam,
        bouncesLeft: opts.bouncesLeft || 0,
        isCurseOrb: !!opts.isCurseOrb
    });
}

function serverCarShoot(st, car, customOwnerUid = null) {
    if (car.invisTimer > 0) {
        car.invisTimer = 0;
    }
    if (car.carType === 17) {
        createServerBullet(st, car, 0, false, 11, false, false, false, customOwnerUid, false, { isDarkLightBeam: true, bouncesLeft: 3, lateralOffset: -11 });
        createServerBullet(st, car, 0, false, 11, false, false, false, customOwnerUid, false, { isDarkLightBeam: true, bouncesLeft: 3, lateralOffset: 11 });
    } else {
        createServerBullet(st, car, 0, false, null, false, false, false, customOwnerUid, false);
    }
    if (carHasTrait(car, 3) && car.abilActive > 0) {
        createServerBullet(st, car, 0.2, false, null, false, false, false, customOwnerUid);
        createServerBullet(st, car, -0.2, false, null, false, false, false, customOwnerUid);
    }
}

function executeServerSkillEffect(st, car, skillType) {
    if (skillType === 0) { car.abilCD = Math.max(car.abilCD, 900); car.shield = 100; car.shieldTimer = 300; }
    else if (skillType === 1) { car.abilCD = Math.max(car.abilCD, 600); car.abilActive = Math.max(car.abilActive, 300); car.healOverTimeRemaining = 300; car.healOverTimeTick = 0; }
    else if (skillType === 2) { car.abilCD = Math.max(car.abilCD, 600); car.abilActive = Math.max(car.abilActive, 200); }
    else if (skillType === 3) { car.abilCD = Math.max(car.abilCD, 600); car.abilActive = Math.max(car.abilActive, 200); }
    else if (skillType === 4) { car.abilCD = Math.max(car.abilCD, 600); car.abilActive = Math.max(car.abilActive, 300); }
    else if (skillType === 5) { car.abilCD = Math.max(car.abilCD, 600); car.abilActive = Math.max(car.abilActive, 180); }
    else if (skillType === 6) {
        car.abilCD = Math.max(car.abilCD, 600);
        st.mines.push({ x: Math.round(car.x), y: Math.round(car.y), timer: 300, ownerUid: car.uid });
    }
    else if (skillType === 7) {
        car.abilCD = Math.max(car.abilCD, 900);
        createServerBullet(st, car, 0, true);
    }
    else if (skillType === 8) {
        car.abilCD = Math.max(car.abilCD, 1200);
        car.x = 200 + Math.random() * (MAP_SIZE - 400);
        car.y = 200 + Math.random() * (MAP_SIZE - 400);
        if (car.hasAwakening && car.carType === 8) {
            car.shield = Math.min(100, (car.shield || 0) + 20);
            car.shieldTimer = 0;
        }
    }
    else if (skillType === 9) {
        car.abilCD = Math.max(car.abilCD, 900);
        st.lavas.push({ x: Math.round(car.x), y: Math.round(car.y), timer: 300, ownerUid: car.uid });
    }
    else if (skillType === 10) {
        car.abilCD = Math.max(car.abilCD, 600);
        createServerBullet(st, car, 0, false, 15, false, true, false);
    }
    else if (skillType === 11) {
        car.abilCD = Math.max(car.abilCD, 600);
        st.fogs.push({ x: Math.round(car.x), y: Math.round(car.y), timer: 300, ownerUid: car.uid });
    }
    else if (skillType === 12) {
        car.abilCD = Math.max(car.abilCD, 900);
        createServerBullet(st, car, 0, false, 10, false, false, true);
    }
    else if (skillType === 13) {
        car.abilCD = Math.max(car.abilCD, 600);
        car.invisTimer = 180;
    }
    else if (skillType === 14) {
        car.abilCD = Math.max(car.abilCD, 720);
        createServerBullet(st, car, 0, false, 15, false, false, false, null, true);
    }
    else if (skillType === 15) {
        car.abilCD = Math.max(car.abilCD, 720);
        car.soulReapTimer = 180;
    }
    else if (skillType === 16) {
        car.abilCD = Math.max(car.abilCD, 600);
        car.drillTimer = 55;
        car.drillHitUids = [];
    }
    else if (skillType === 17) {
        car.abilCD = Math.max(car.abilCD, 1800);
        createServerBullet(st, car, 0, false, 0, false, false, false, null, false, { isCurseOrb: true });
    }
}

function serverCarAbility(st, car) {
    if (car.silenceTimer > 0) return;
    car.bonusCarType = -1;
    executeServerSkillEffect(st, car, car.carType);

    if (car.dualSkillReady) {
        car.dualSkillReady = false;
        const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17].filter(t => t !== car.carType);
        const randomSkill = pool[Math.floor(Math.random() * pool.length)];
        car.bonusCarType = randomSkill;
        executeServerSkillEffect(st, car, randomSkill);
    }

    if (car.cdBoostReady && car.abilCD > 0) {
        car.cdBoostReady = false;
        car.abilCD = Math.max(30, Math.floor(car.abilCD * 0.4));
    }
}

function serverCarSecondaryAbility(st, car) {
    if (car.silenceTimer > 0) return;
    const sType = car.secType || 1;
    car.secCD = (sType === 7) ? 900 : ((sType === 6) ? 480 : 420);

    if (sType === 1) {
        car.radarTimer = 600;
    } else if (sType === 2) {
        st.turrets.push({
            x: car.x,
            y: car.y,
            angle: car.angle,
            timer: 720,
            shootCD: 20,
            ownerUid: car.uid,
            team: car.team
        });
    } else if (sType === 3) {
        car.dualSkillReady = true;
    } else if (sType === 4) {
        const wallDist = 70;
        st.walls.push({
            x: car.x + Math.cos(car.angle) * wallDist,
            y: car.y + Math.sin(car.angle) * wallDist,
            angle: car.angle + Math.PI / 2,
            length: 115,
            timer: 480,
            ownerUid: car.uid,
            team: car.team
        });
    } else if (sType === 5) {
        if (car.abilCD > 0) {
            car.abilCD = Math.max(0, Math.floor(car.abilCD * 0.4));
        } else {
            car.cdBoostReady = true;
        }
    } else if (sType === 6) {
        car.visionTimer = 360;
    } else if (sType === 7) {
        car.trajectoryTimer = 360;
    }
}

function damageServerCar(room, car, amt, attacker) {
    const st = room.state;
    if (car.isReviving || !car.alive) return;
    const finalAmt = (carHasTrait(car, 5) && car.abilActive > 0) ? amt * 2 : amt;

    if (attacker && attacker.uid !== car.uid && (st.mode !== 'CTF' || attacker.team !== car.team)) {
        attacker.dmgDealt = (attacker.dmgDealt || 0) + Math.min(car.hp + car.shield, finalAmt);
    }

    if (car.shield > 0) {
        car.shield -= finalAmt;
        if (car.shield <= 0) {
            car.hp += car.shield;
            car.shield = 0;
            car.shieldTimer = 0;
        }
    } else {
        car.hp -= finalAmt;
    }

    if (car.hp <= 0 && car.alive) {
        if (carHasTrait(car, 5) && car.abilActive > 0) {
            car.isReviving = true;
            car.respawnTimer = 180;
            car.hp = 0.1;
            car.abilActive = 0;
            car.bonusCarType = -1;
            return;
        }
        car.alive = false;
        car.hasFlag = null;
        clearServerMindControlLinks(st, car);
        if (st.mode === 'DM' || st.mode === 'CTF') {
            car.respawnTimer = 180;
        } else {
            car.rank = st.cars.filter(c => c.alive).length + 1;
        }

        if (attacker && attacker.uid !== car.uid && (st.mode !== 'CTF' || attacker.team !== car.team)) {
            attacker.kills = (attacker.kills || 0) + 1;
            if (attacker.soulReapTimer > 0 && attacker.alive) {
                attacker.soulReapTimer = 0;
                if (attacker.hp >= attacker.maxHp - 0.5) {
                    attacker.maxHp = Math.min(200, attacker.maxHp + 10);
                    attacker.hp = attacker.maxHp;
                } else {
                    attacker.hp = Math.min(attacker.maxHp, attacker.hp + 10);
                }
            }
        }

        io.to(room.id).emit('killEvent', {
            killer: attacker ? attacker.id : 'The Storm',
            killerHasPass: !!(attacker && attacker.hasPass),
            victim: car.id
        });
    }
}

function finishServerMatch(room) {
    if (!room || room.finished) return;
    room.finished = true;
    if (room.simInterval) clearInterval(room.simInterval);
    if (room.netInterval) clearInterval(room.netInterval);

    const finalSnap = buildRoomSnapshot(room, false);
    if (room.state && Array.isArray(room.state.cars)) {
        const sortedByKills = [...room.state.cars].sort((a, b) => (b.kills || 0) - (a.kills || 0));
        room.state.cars.forEach((c, idx) => {
            if (!c || c.isAI) return;
            const rankNum = c.rank || (idx + 1);
            recordServerLeaderboardEntry({
                uid: c.uid,
                name: c.id || 'Driver',
                country: c.country || 'INTL',
                kills: Math.floor(Number(c.kills) || 0),
                damage: Math.floor(Number(c.dmgDealt) || 0),
                wins: rankNum === 1 ? 1 : 0
            });
        });
    }
    io.to(room.id).emit('matchEnded', { state: finalSnap });

    room.players.forEach(p => {
        if (p.socket) {
            p.socket.leave(room.id);
            if (p.socket.currentRoomId === room.id) {
                p.socket.currentRoomId = null;
            }
        }
    });
    delete rooms[room.id];
}

function buildRoomSnapshot(room, includeStatic = false) {
    const st = room.state;
    if (!st) return null;
    const snap = {
        map: st.map,
        mode: st.mode,
        introTimer: st.introTimer || 0,
        timer: st.timer,
        dmTimer: st.dmTimer,
        redScore: st.redScore,
        blueScore: st.blueScore,
        ctfFlags: {
            red: { x: Math.round(st.ctfFlags.red.x), y: Math.round(st.ctfFlags.red.y), baseX: st.ctfFlags.red.baseX, baseY: st.ctfFlags.red.baseY, hasCarrier: !!st.ctfFlags.red.carrierUid },
            blue: { x: Math.round(st.ctfFlags.blue.x), y: Math.round(st.ctfFlags.blue.y), baseX: st.ctfFlags.blue.baseX, baseY: st.ctfFlags.blue.baseY, hasCarrier: !!st.ctfFlags.blue.carrierUid }
        },
        zone: {
            x: st.zone.x,
            y: st.zone.y,
            radius: Math.round(st.zone.radius * 10) / 10
        },
        cars: st.cars.map(c => ({
            uid: c.uid, id: c.id, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10,
            angle: Math.round(c.angle * 1000) / 1000, speed: Math.round(c.speed * 100) / 100,
            hp: Math.round(c.hp * 10) / 10, maxHp: c.maxHp, alive: c.alive,
            isAI: c.isAI, carType: c.carType, secType: c.secType || 1, secCD: c.secCD || 0,
            radarTimer: c.radarTimer || 0, visionTimer: c.visionTimer || 0, trajectoryTimer: c.trajectoryTimer || 0, dualSkillReady: !!c.dualSkillReady,
            bonusCarType: typeof c.bonusCarType === 'number' ? c.bonusCarType : -1, cdBoostReady: !!c.cdBoostReady, team: c.team, hasFlag: c.hasFlag,
            hasPass: !!c.hasPass, hasAwakening: !!c.hasAwakening, isReviving: c.isReviving, respawnTimer: c.respawnTimer,
            stunTimer: c.stunTimer, slowTimer: c.slowTimer || 0,
            silenceTimer: c.silenceTimer || 0, curseTimer: c.curseTimer || 0, blindTimer: c.blindTimer || 0,
            invisTimer: c.invisTimer || 0, hookTimer: c.hookTimer || 0,
            hookTargetUid: c.hookTargetUid || null,
            soulReapTimer: c.soulReapTimer || 0, drillTimer: c.drillTimer || 0,
            mindControlTimer: c.mindControlTimer || 0,
            controlledTargetUid: c.controlledTargetUid || null,
            controlledByUid: c.controlledByUid || null,
            shield: Math.round(c.shield), shieldTimer: c.shieldTimer || 0, ammo: c.ammo, maxAmmo: c.maxAmmo, reloadTimer: c.reloadTimer || 0, abilActive: c.abilActive, abilCD: c.abilCD,
            shootCD: c.shootCD, kills: c.kills, dmgDealt: Math.round(c.dmgDealt || 0),
            flagsScored: c.flagsScored || 0, rank: c.rank
        })),
        drops: st.drops,
        mines: st.mines.map(m => ({ x: Math.round(m.x), y: Math.round(m.y), timer: m.timer })),
        lavas: st.lavas.map(l => ({ x: Math.round(l.x), y: Math.round(l.y), timer: l.timer })),
        fogs: st.fogs.map(f => ({ x: Math.round(f.x), y: Math.round(f.y), timer: f.timer })),
        turrets: st.turrets.map(t => ({ x: Math.round(t.x), y: Math.round(t.y), angle: t.angle, timer: t.timer })),
        walls: st.walls.map(w => ({ x: Math.round(w.x), y: Math.round(w.y), angle: w.angle, length: w.length || 115, timer: w.timer })),
        debris: (st.debris || []).map(d => ({ x: Math.round(d.x), y: Math.round(d.y), r: d.r || 13, timer: d.timer })),
        bullets: st.bullets.map(b => ({
            x: Math.round(b.x), y: Math.round(b.y),
            vx: b.vx, vy: b.vy, angle: b.angle || 0,
            isHeart: !!b.isHeart, isSniper: !!b.isSniper,
            isEmpArc: !!b.isEmpArc, isHackArrow: !!b.isHackArrow, isHook: !!b.isHook, isDarkLightBeam: !!b.isDarkLightBeam, isCurseOrb: !!b.isCurseOrb
        }))
    };

    if (includeStatic) {
        snap.obstacles = st.obstacles;
    }

    return snap;
}

function leaveRoom(socket) {
    const roomId = socket.currentRoomId;
    if (!roomId) return;
    socket.leave(roomId);
    socket.currentRoomId = null;

    const room = rooms[roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== socket.id);
    room.inputs.delete(socket.id);

    if (room.players.length === 0) {
        if (room.lobbyTimer) clearInterval(room.lobbyTimer);
        if (room.simInterval) clearInterval(room.simInterval);
        if (room.netInterval) clearInterval(room.netInterval);
        delete rooms[roomId];
    } else if (!room.started) {
        if (room.isPrivate) {
            if (room.hostId === socket.id) {
                room.hostId = room.players[0].id;
            }
            broadcastPrivateRoomState(roomId);
        } else {
            broadcastLobbyState(roomId);
        }
    } else if (room.state) {
        const leavingCar = room.state.cars.find(c => c.uid === socket.id);
        if (leavingCar) {
            clearServerMindControlLinks(room.state, leavingCar);
            leavingCar.isAI = true;
        }
    }
}


// ================= Polar.sh Checkout & Webhook Gem Delivery =================
const crypto = require('crypto');

const POLAR_GEM_PACKS = Object.freeze({
    'a270d8d4-e2f4-4aff-afc3-401d1ca4e52a': { gems: 100,   priceUsd: '0.99',  label: '100 Gems Pack' },
    'cf3ba177-b737-457d-9aab-c4602940f81a': { gems: 550,   priceUsd: '4.99',  label: '550 Gems Pack' },
    '549c7806-997f-4139-a14b-36469928635c': { gems: 1200,  priceUsd: '9.99',  label: '1200 Gems Pack' },
    '331ff154-1e9f-4b6c-aa2b-85f91aa881f6': { gems: 2600,  priceUsd: '19.99', label: '2600 Gems Pack' },
    '1bdfbc13-d26e-4384-a4a6-6720137c45cc': { gems: 6800,  priceUsd: '49.99', label: '6800 Gems Pack' },
    'e8352f00-80e0-443b-a924-5a68395a83d8': { gems: 14500, priceUsd: '99.99', label: '14500 Gems Pack' }
});

const processedPolarOrders = new Set();
const inFlightPolarOrders = new Set();
const pendingPolarGemClaims = new Map(); // accountKey -> [{ orderId, productId, gems, label, ts }]
const claimedPolarOrderIds = new Set();

let polarAdminDb = null;
function getPolarFirestoreAdmin() {
    if (polarAdminDb) return polarAdminDb;
    try {
        const admin = require('firebase-admin');
        if (!admin.apps.length) {
            if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
                const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
                admin.initializeApp({ credential: admin.credential.cert(svc) });
            } else {
                admin.initializeApp({ projectId: 'battlecars-666f9' });
            }
        }
        polarAdminDb = admin.firestore();
        return polarAdminDb;
    } catch (e) {
        return null;
    }
}

function getPolarApiBase() {
    const mode = (process.env.POLAR_ENV || process.env.POLAR_MODE || 'production').trim().toLowerCase();
    return mode === 'sandbox' ? 'https://sandbox-api.polar.sh' : 'https://api.polar.sh';
}

app.post('/api/polar/create-checkout', async (req, res) => {
    const token = (process.env.POLAR_ACCESS_TOKEN || '').trim();
    if (!token) {
        return res.status(503).json({
            ok: false,
            message: 'Polar payment gateway is not configured on Render yet (missing POLAR_ACCESS_TOKEN).'
        });
    }

    const body = req.body || {};
    const productId = String(body.productId || '').trim();
    const pack = POLAR_GEM_PACKS[productId];
    if (!pack) {
        return res.status(400).json({ ok: false, message: 'Invalid gem pack productId.' });
    }

    const accountKey = String(body.accountKey || '').trim().slice(0, 128);
    const uid = String(body.uid || '').trim().slice(0, 128);
    const successUrl = String(body.successUrl || 'https://battlecars.netlify.app/?polar_status=success').slice(0, 300);

    try {
        const polarResp = await fetch(`${getPolarApiBase()}/v1/checkouts/`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                products: [productId],
                success_url: successUrl,
                metadata: {
                    accountKey: accountKey || uid || 'guest',
                    uid: uid || '',
                    productId,
                    gems: String(pack.gems)
                }
            })
        });

        const data = await polarResp.json().catch(() => ({}));
        if (!polarResp.ok || !data || !data.url) {
            console.error('Polar checkout error:', polarResp.status, data);
            return res.status(502).json({
                ok: false,
                message: (data && (data.detail || data.message)) ? String(data.detail || data.message) : 'Failed to create Polar checkout session.'
            });
        }

        return res.json({ ok: true, checkoutUrl: data.url, checkoutId: data.id || '' });
    } catch (err) {
        console.error('Polar checkout network error:', err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, message: 'Network error while creating checkout session.' });
    }
});

function verifyPolarWebhookSignature(rawBodyStr, headers) {
    const secret = (process.env.POLAR_WEBHOOK_SECRET || '').trim();
    if (!secret) return true;
    if (!rawBodyStr) return false;

    const webhookId = headers['webhook-id'] || headers['svix-id'] || '';
    const webhookTs = headers['webhook-timestamp'] || headers['svix-timestamp'] || '';
    const webhookSig = headers['webhook-signature'] || headers['svix-signature'] || headers['x-polar-signature'] || '';

    if (!webhookSig) return false;

    const cleanSecret = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : secret;

    if (webhookId && webhookTs) {
        const signedContent = `${webhookId}.${webhookTs}.${rawBodyStr}`;
        const expectedB64 = crypto.createHmac('sha256', cleanSecret).update(signedContent).digest('base64');
        const parts = String(webhookSig).split(/[\s,]+/);
        for (const p of parts) {
            const val = p.includes(',') ? p.split(',')[1] : p;
            if (val === expectedB64) return true;
        }
    }

    const expectedHex = crypto.createHmac('sha256', cleanSecret).update(rawBodyStr).digest('hex');
    return String(webhookSig).includes(expectedHex);
}

app.post('/api/polar/webhook', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
    const rawStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    if (!verifyPolarWebhookSignature(rawStr, req.headers || {})) {
        return res.status(401).json({ ok: false, message: 'Invalid webhook signature.' });
    }

    let payload = null;
    try {
        payload = JSON.parse(rawStr);
    } catch (_) {
        return res.status(400).json({ ok: false, message: 'Invalid JSON payload.' });
    }

    const eventType = payload && payload.type ? String(payload.type) : '';
    const dataObj = (payload && payload.data) ? payload.data : {};

    // Strictly fulfill ONLY on 'order.paid' so checkout.updated never double-credits the same purchase
    if (eventType !== 'order.paid') {
        return res.json({ ok: true, ignored: true, eventType });
    }

    const orderId = String(dataObj.id || dataObj.order_id || '').trim();
    const checkoutId = String(dataObj.checkout_id || (dataObj.checkout && dataObj.checkout.id) || '').trim();
    const dedupeKey = orderId || checkoutId;

    if (!dedupeKey) {
        console.warn('Polar order.paid missing order id');
        return res.status(400).json({ ok: false, message: 'Missing order id.' });
    }

    if (processedPolarOrders.has(dedupeKey) || inFlightPolarOrders.has(dedupeKey) || (checkoutId && processedPolarOrders.has(checkoutId))) {
        return res.json({ ok: true, duplicate: true, orderId: dedupeKey });
    }

    const meta = (dataObj.metadata && typeof dataObj.metadata === 'object')
        ? dataObj.metadata
        : ((dataObj.checkout && dataObj.checkout.metadata) ? dataObj.checkout.metadata : {});

    // Resolve productId strictly from Polar order/product fields first, then metadata
    let productId = String(dataObj.product_id || (dataObj.product && dataObj.product.id) || '').trim();
    if (!productId && Array.isArray(dataObj.items) && dataObj.items.length > 0) {
        const firstItem = dataObj.items[0] || {};
        productId = String(firstItem.product_id || (firstItem.product && firstItem.product.id) || '').trim();
    }
    if (!productId && meta.productId) {
        productId = String(meta.productId).trim();
    }

    const pack = POLAR_GEM_PACKS[productId];
    if (!pack) {
        console.warn('Polar order.paid unknown productId:', { orderId: dedupeKey, productId, meta });
        return res.json({ ok: true, warning: 'Unknown productId', productId });
    }

    // Exact 1x face-value gem amount from POLAR_GEM_PACKS (never multiplied by quantity or duplicate events)
    const gemsAmount = pack.gems;
    const accountKey = String(meta.accountKey || meta.uid || '').trim();

    if (!accountKey || gemsAmount <= 0) {
        console.warn('Polar order.paid missing accountKey:', { orderId: dedupeKey, productId, meta });
        return res.json({ ok: true, warning: 'Missing accountKey' });
    }

    inFlightPolarOrders.add(dedupeKey);
    try {
        // Persistent deduplication in Firestore so Render restarts or retries never double-grant
        const dbAdmin = getPolarFirestoreAdmin();
        if (dbAdmin) {
            try {
                const orderRef = dbAdmin.collection('polar_orders').doc(dedupeKey);
                let alreadyProcessed = false;
                await dbAdmin.runTransaction(async (tx) => {
                    const snap = await tx.get(orderRef);
                    if (snap.exists) {
                        alreadyProcessed = true;
                        return;
                    }
                    tx.set(orderRef, {
                        orderId: dedupeKey,
                        checkoutId: checkoutId || null,
                        productId,
                        gems: gemsAmount,
                        accountKey,
                        uid: meta.uid ? String(meta.uid) : null,
                        createdAt: Date.now()
                    });
                });
                if (alreadyProcessed) {
                    processedPolarOrders.add(dedupeKey);
                    if (checkoutId) processedPolarOrders.add(checkoutId);
                    return res.json({ ok: true, duplicate: true, orderId: dedupeKey });
                }
            } catch (txErr) {
                console.warn('Polar Firestore order dedupe warning:', txErr && txErr.message ? txErr.message : txErr);
            }
        }

        processedPolarOrders.add(dedupeKey);
        if (checkoutId) processedPolarOrders.add(checkoutId);

        if (!claimedPolarOrderIds.has(dedupeKey)) {
            const list = pendingPolarGemClaims.get(accountKey) || [];
            if (!list.some(item => item.orderId === dedupeKey)) {
                list.push({
                    orderId: dedupeKey,
                    productId,
                    gems: gemsAmount,
                    label: pack.label,
                    ts: Date.now()
                });
                pendingPolarGemClaims.set(accountKey, list);
            }
        }

        console.log(`Polar order.paid verified: order=${dedupeKey}, pack=${pack.label}, gems=+${gemsAmount}, account=${accountKey}`);
        return res.json({ ok: true, grantedGems: gemsAmount, orderId: dedupeKey, accountKey });
    } finally {
        inFlightPolarOrders.delete(dedupeKey);
    }
});

app.get('/api/polar/claim', (req, res) => {
    const accountKey = String((req.query && req.query.accountKey) || '').trim();
    if (!accountKey) return res.json({ ok: true, claims: [] });
    const rawList = pendingPolarGemClaims.get(accountKey) || [];
    pendingPolarGemClaims.delete(accountKey);

    const uniqueClaims = [];
    for (const item of rawList) {
        if (!item || !item.orderId) continue;
        if (claimedPolarOrderIds.has(item.orderId)) continue;
        claimedPolarOrderIds.add(item.orderId);
        const pack = item.productId ? POLAR_GEM_PACKS[item.productId] : null;
        const exactGems = pack ? pack.gems : Math.max(0, Math.floor(Number(item.gems) || 0));
        if (exactGems > 0) {
            uniqueClaims.push({
                orderId: item.orderId,
                productId: item.productId || '',
                gems: exactGems,
                label: pack ? pack.label : `${exactGems} Gems`
            });
        }
    }

    return res.json({ ok: true, claims: uniqueClaims });
});

server.listen(port, () => {
    console.log(`Street War Dedicated Server running on port ${port}`);
});