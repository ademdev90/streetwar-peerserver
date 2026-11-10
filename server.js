const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
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

app.get('/', (req, res) => {
    res.send(`Street War Dedicated Server Running | Active Rooms: ${Object.keys(rooms).length}`);
});

const port = process.env.PORT || 9000;
const LOBBY_WAIT_TIME = 30;
const MAP_SIZE = 2500;
const BOT_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliet'];

let rooms = {};
let roomSequence = 1;

// تحديد الحد الأقصى للاعبين حسب الطور (6 لاعبين أي 3 ضد 3 في طور سرقة العلم CTF، و10 في البقية)
function getMaxPlayersForMode(mode, squad = 'solo') {
    const m = (mode || 'br').toLowerCase();
    if (m === 'ctf') return 6; // 3v3
    if (squad === 'trio') return 12; // 4 teams of 3
    return 10;
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

io.on('connection', (socket) => {
    if (socket.conn && socket.conn.transport && socket.conn.transport.socket) {
        try { socket.conn.transport.socket.setNoDelay(true); } catch (e) {}
    }

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

        socket.join(targetRoomId);
        socket.currentRoomId = targetRoomId;

        room.players.push({
            id: socket.id,
            name: playerName,
            car: playerCar,
            secAbil: playerSecAbil,
            hasPass: playerHasPass,
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
        hasPass: !!p.hasPass
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

    const cars = [];
    realPlayers.forEach((pData, idx) => {
        const team = mode === 'CTF' ? (idx % 2 === 0 ? 'red' : 'blue') : null;
        const sX = mode === 'CTF'
            ? (team === 'red' ? 200 + Math.random() * 200 : MAP_SIZE - 400 + Math.random() * 200)
            : 300 + Math.random() * (MAP_SIZE - 600);
        const sY = mode === 'CTF'
            ? MAP_SIZE / 2 - 200 + Math.random() * 400
            : 300 + Math.random() * (MAP_SIZE - 600);

        cars.push(createServerCar(pData.id, pData.name, sX, sY, false, pData.car, pData.secAbil, team, !!pData.hasPass));
    });

    for (let i = 0; i < botsCount; i++) {
        const bType = Math.floor(Math.random() * 13);
        const redCount = cars.filter(c => c.team === 'red').length;
        const blueCount = cars.filter(c => c.team === 'blue').length;
        const team = mode === 'CTF' ? (redCount <= blueCount ? 'red' : 'blue') : null;
        const bX = mode === 'CTF'
            ? (team === 'red' ? 200 + Math.random() * 200 : MAP_SIZE - 400 + Math.random() * 200)
            : 300 + Math.random() * (MAP_SIZE - 600);
        const bY = mode === 'CTF'
            ? MAP_SIZE / 2 - 200 + Math.random() * 400
            : 300 + Math.random() * (MAP_SIZE - 600);
        const bName = BOT_NAMES[i] || `Bot_${i + 1}`;
        const botSec = Math.floor(Math.random() * 6) + 1;
        cars.push(createServerCar(`bot_${i}`, bName, bX, bY, true, bType, botSec, team, false));
    }

    room.state = {
        map: mapIndex,
        mode: mode,
        initialCarsCount: cars.length,
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
        bullets: []
    };
}

function createServerCar(uid, name, x, y, isAI, carType, secType, team, hasPass = false) {
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
        dualSkillReady: false,
        bonusCarType: -1,
        cdBoostReady: false,
        hasPass: !!hasPass,
        w: 38,
        h: 65,
        alive: true,
        shootCD: 0,
        abilCD: 0,
        abilActive: 0,
        shield: 0,
        shieldTimer: 0,
        ammo: 12,
        maxAmmo: 12,
        reloadTimer: 0,
        stunTimer: 0,
        slowTimer: 0,
        silenceTimer: 0,
        blindTimer: 0,
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

        let hit = st.obstacles.some(o => Math.hypot(b.x - o.x, b.y - o.y) < o.r);
        if (!hit) {
            const hitRadius = b.isEmpArc ? 38 : (b.isHackArrow ? 32 : 28);
            const ignoreUid = b.sourceUid || b.ownerUid;
            const target = st.cars.find(c =>
                c.alive && !c.isReviving &&
                c.uid !== ignoreUid && c.uid !== b.ownerUid &&
                Math.hypot(c.x - b.x, c.y - b.y) < hitRadius &&
                (st.mode !== 'CTF' || !ownerCar || c.team !== ownerCar.team)
            );
            if (target) {
                if (b.isHeart) {
                    target.stunTimer = 180;
                } else if (b.isEmpArc) {
                    target.silenceTimer = 300;
                    target.abilActive = 0;
                    damageServerCar(room, target, b.dmg || 15, ownerCar);
                } else if (b.isHackArrow) {
                    if (ownerCar && ownerCar.alive && !ownerCar.isReviving) {
                        clearServerMindControlLinks(st, ownerCar);
                        clearServerMindControlLinks(st, target);
                        ownerCar.mindControlTimer = 600;
                        ownerCar.controlledTargetUid = target.uid;
                        target.controlledByUid = ownerCar.uid;
                        target.mindControlTimer = 600;
                    }
                    damageServerCar(room, target, b.dmg || 10, ownerCar);
                } else {
                    damageServerCar(room, target, b.dmg, ownerCar);
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
        if (car.shieldTimer <= 0) car.shield = 0;
    }
    if (car.shield <= 0) car.shield = 0;
    if (car.silenceTimer > 0) car.silenceTimer--;
    if (car.blindTimer > 0) car.blindTimer--;
    if (car.visionTimer > 0) car.visionTimer--;
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
            if (car.ammo > 0) {
                serverCarShoot(st, car, activeController.uid);
                car.ammo--;
                car.shootCD = 12;
                if (car.ammo <= 0) car.reloadTimer = 90;
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
            if (car.ammo > 0) {
                serverCarShoot(st, car);
                car.ammo--;
                car.shootCD = 12;
                if (car.ammo <= 0) car.reloadTimer = 90;
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
            st.cars.forEach(c => {
                if (c.uid !== car.uid && c.alive && !c.isReviving && Math.hypot(c.x - car.x, c.y - car.y) < 150) {
                    if (st.mode === 'CTF' && c.team === car.team) return;
                    damageServerCar(room, c, 0.5, car);
                }
            });
        }
        if (car.abilActive <= 0) {
            car.bonusCarType = -1;
        }
    }

    car.x += Math.cos(car.angle) * car.speed;
    car.y += Math.sin(car.angle) * car.speed;

    st.obstacles.forEach(o => {
        const dist = Math.hypot(car.x - o.x, car.y - o.y);
        const minDist = car.w / 2 + o.r;
        if (dist < minDist) {
            const overlap = minDist - dist;
            const dx = dist ? (car.x - o.x) / dist : 1;
            const dy = dist ? (car.y - o.y) / dist : 0;
            car.x += dx * overlap;
            car.y += dy * overlap;
            car.speed *= 0.5;
        }
    });

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
                (car.carType === 12 && minDist < 420 && (diffCheck < 0.25 || diffCheck > Math.PI * 2 - 0.25))) {
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

function createServerBullet(st, car, angOffset, isHeart = false, customDmg = null, isSniper = false, isEmpArc = false, isHackArrow = false, customOwnerUid = null) {
    let shootAngle = car.angle + angOffset;
    const dmg = isHeart ? 0 : (customDmg !== null ? customDmg : 18);

    if (carHasTrait(car, 4) && car.abilActive > 0 && !isHeart && !isHackArrow && !isEmpArc) {
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

    const speed = isHeart ? 10 : (isSniper ? 22 : (isHackArrow ? 18 : (isEmpArc ? 15 : 16)));
    st.bullets.push({
        x: car.x + Math.cos(shootAngle) * 28,
        y: car.y + Math.sin(shootAngle) * 28,
        vx: Math.round(Math.cos(shootAngle) * speed * 100) / 100,
        vy: Math.round(Math.sin(shootAngle) * speed * 100) / 100,
        angle: Math.round(shootAngle * 1000) / 1000,
        ownerUid: customOwnerUid || car.uid,
        sourceUid: car.uid,
        dmg: dmg,
        isHeart: isHeart,
        isSniper: isSniper,
        isEmpArc: isEmpArc,
        isHackArrow: isHackArrow
    });
}

function serverCarShoot(st, car, customOwnerUid = null) {
    createServerBullet(st, car, 0, false, null, false, false, false, customOwnerUid);
    if (carHasTrait(car, 3) && car.abilActive > 0) {
        createServerBullet(st, car, 0.2, false, null, false, false, false, customOwnerUid);
        createServerBullet(st, car, -0.2, false, null, false, false, false, customOwnerUid);
    }
}

function executeServerSkillEffect(st, car, skillType) {
    if (skillType === 0) { car.abilCD = Math.max(car.abilCD, 900); car.shield = 100; car.shieldTimer = 600; }
    else if (skillType === 1) { car.abilCD = Math.max(car.abilCD, 600); car.abilActive = Math.max(car.abilActive, 200); car.hp = Math.min(100, car.hp + 50); }
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
}

function serverCarAbility(st, car) {
    if (car.silenceTimer > 0) return;
    car.bonusCarType = -1;
    executeServerSkillEffect(st, car, car.carType);

    if (car.dualSkillReady) {
        car.dualSkillReady = false;
        const pool = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter(t => t !== car.carType);
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
    car.secCD = (sType === 6) ? 480 : 420;

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
        if (car.shield < 0) {
            car.hp += car.shield;
            car.shield = 0;
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
            radarTimer: c.radarTimer || 0, visionTimer: c.visionTimer || 0, dualSkillReady: !!c.dualSkillReady,
            bonusCarType: typeof c.bonusCarType === 'number' ? c.bonusCarType : -1, cdBoostReady: !!c.cdBoostReady, team: c.team, hasFlag: c.hasFlag,
            hasPass: !!c.hasPass, isReviving: c.isReviving, respawnTimer: c.respawnTimer,
            stunTimer: c.stunTimer, slowTimer: c.slowTimer || 0,
            silenceTimer: c.silenceTimer || 0, blindTimer: c.blindTimer || 0,
            mindControlTimer: c.mindControlTimer || 0,
            controlledTargetUid: c.controlledTargetUid || null,
            controlledByUid: c.controlledByUid || null,
            shield: Math.round(c.shield), ammo: c.ammo, maxAmmo: c.maxAmmo, reloadTimer: c.reloadTimer || 0, abilActive: c.abilActive, abilCD: c.abilCD,
            shootCD: c.shootCD, kills: c.kills, dmgDealt: Math.round(c.dmgDealt || 0),
            flagsScored: c.flagsScored || 0, rank: c.rank
        })),
        drops: st.drops,
        mines: st.mines.map(m => ({ x: Math.round(m.x), y: Math.round(m.y), timer: m.timer })),
        lavas: st.lavas.map(l => ({ x: Math.round(l.x), y: Math.round(l.y), timer: l.timer })),
        fogs: st.fogs.map(f => ({ x: Math.round(f.x), y: Math.round(f.y), timer: f.timer })),
        turrets: st.turrets.map(t => ({ x: Math.round(t.x), y: Math.round(t.y), angle: t.angle, timer: t.timer })),
        walls: st.walls.map(w => ({ x: Math.round(w.x), y: Math.round(w.y), angle: w.angle, length: w.length || 115, timer: w.timer })),
        bullets: st.bullets.map(b => ({
            x: Math.round(b.x), y: Math.round(b.y),
            vx: b.vx, vy: b.vy, angle: b.angle || 0,
            isHeart: !!b.isHeart, isSniper: !!b.isSniper,
            isEmpArc: !!b.isEmpArc, isHackArrow: !!b.isHackArrow
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

server.listen(port, () => {
    console.log(`Street War Dedicated Server running on port ${port}`);
});