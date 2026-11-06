const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingInterval: 5000,
    pingTimeout: 10000
});

app.get('/ping', (req, res) => {
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

io.on('connection', (socket) => {
    socket.on('pingCheck', (sentAt, callback) => {
        if (typeof callback === 'function') callback(sentAt);
        socket.emit('pongCheck', sentAt);
    });

    socket.on('findMatch', (data = {}) => {
        leaveRoom(socket);

        const mode = (data.mode || 'br').toLowerCase();
        const playerName = (data.name || 'Player').toString().substring(0, 14);
        const playerCar = Number.isInteger(data.car) ? data.car : 0;
        const playerHasPass = !!data.hasPass;

        let targetRoomId = Object.keys(rooms).find(id => {
            const r = rooms[id];
            return r && r.mode === mode && !r.started && !r.isPrivate && r.players.length < 10;
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
            hasPass: playerHasPass,
            socket: socket
        });

        broadcastLobbyState(targetRoomId);

        if (room.players.length >= 10) {
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
                if (room.countdown <= 0 || room.players.length >= 10) {
                    clearInterval(room.lobbyTimer);
                    room.lobbyTimer = null;
                    startGame(targetRoomId);
                } else {
                    broadcastLobbyState(targetRoomId);
                }
            }, 1000);
        }
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
        mode: mode,
        isPrivate: isPrivate,
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

function broadcastLobbyState(roomId) {
    const room = rooms[roomId];
    if (!room || room.started) return;
    const playersList = room.players.map(p => ({ id: p.id, name: p.name, car: p.car, hasPass: !!p.hasPass }));
    io.to(roomId).emit('lobbyUpdate', {
        roomId: roomId,
        playersCount: room.players.length,
        maxPlayers: 10,
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

    const realPlayersData = room.players.map(p => ({
        id: p.id,
        name: p.name,
        car: p.car,
        hasPass: !!p.hasPass
    }));
    const botsCount = Math.max(0, 10 - realPlayersData.length);

    initServerWorld(room, realPlayersData, botsCount);

    const initialSnapshot = buildRoomSnapshot(room);

    room.players.forEach((p) => {
        p.socket.emit('matchFound', {
            role: 'player',
            serverAuthoritative: true,
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
        io.to(roomId).emit('serverState', buildRoomSnapshot(room));
    }, 40);
}

function initServerWorld(room, realPlayers, botsCount) {
    const mode = room.mode.toUpperCase();
    const mapIndex = Math.floor(Math.random() * 5);

    const obstacles = [];
    for (let i = 0; i < 40; i++) {
        obstacles.push({
            x: 100 + Math.random() * (MAP_SIZE - 200),
            y: 100 + Math.random() * (MAP_SIZE - 200),
            r: 30 + Math.random() * 50
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

        cars.push(createServerCar(pData.id, pData.name, sX, sY, false, pData.car, team, !!pData.hasPass));
    });

    for (let i = 0; i < botsCount; i++) {
        const bType = Math.random() > 0.3 ? Math.floor(Math.random() * 5) : Math.floor(Math.random() * 5) + 5;
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
        cars.push(createServerCar(`bot_${i}`, bName, bX, bY, true, bType, team, false));
    }

    room.state = {
        map: mapIndex,
        mode: mode,
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
        bullets: []
    };
}

function createServerCar(uid, name, x, y, isAI, carType, team, hasPass = false) {
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
        hasPass: !!hasPass,
        w: 38,
        h: 65,
        alive: true,
        shootCD: 0,
        abilCD: 0,
        abilActive: 0,
        shield: 0,
        stunTimer: 0,
        slowTimer: 0,
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
            x: st.zone.x + (Math.random() - 0.5) * st.zone.radius * 1.5,
            y: st.zone.y + (Math.random() - 0.5) * st.zone.radius * 1.5,
            r: 20,
            type: Math.random() > 0.5 ? 'hp' : 'shield'
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

    // تحديث الحمم في السيرفر: تفعيل slowTimer بالتساوي على جميع الأعداء (لاعبين وبوتات)
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
            }
        }

        b.x += b.vx;
        b.y += b.vy;

        let hit = st.obstacles.some(o => Math.hypot(b.x - o.x, b.y - o.y) < o.r);
        if (!hit) {
            const target = st.cars.find(c =>
                c.alive && !c.isReviving && c.uid !== b.ownerUid &&
                Math.hypot(c.x - b.x, c.y - b.y) < 28 &&
                (st.mode !== 'CTF' || !ownerCar || c.team !== ownerCar.team)
            );
            if (target) {
                if (b.isHeart) target.stunTimer = 180;
                else damageServerCar(room, target, b.dmg, ownerCar);
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
        if (aliveCars.length <= 1 || aliveHumans.length === 0) {
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
                if (st.mode === 'CTF') {
                    car.x = car.team === 'red' ? 200 + Math.random() * 200 : MAP_SIZE - 400 + Math.random() * 200;
                    car.y = MAP_SIZE / 2 - 200 + Math.random() * 400;
                } else {
                    car.x = 300 + Math.random() * (MAP_SIZE - 600);
                    car.y = 300 + Math.random() * (MAP_SIZE - 600);
                }
                car.abilActive = 0;
                car.stunTimer = 0;
                car.slowTimer = 0;
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

    if (car.stunTimer > 0) {
        car.stunTimer--;
        return;
    }

    if (!car.isAI) {
        const control = room.inputs.get(car.uid) || {};
        driveServerCar(car, control);
        if (control.shoot && car.shootCD <= 0) {
            serverCarShoot(st, car);
            car.shootCD = 12;
        }
        if (control.ability && car.abilCD <= 0) {
            serverCarAbility(st, car);
        }
    } else {
        updateServerBotAI(st, car);
    }

    // تطبيق التباطؤ بعد حساب سرعة البوت أو اللاعب لضمان المساواة الكاملة
    if (car.slowTimer > 0) {
        car.slowTimer--;
        const maxSlowSpeed = car.maxSpeed * 0.42;
        if (car.speed > maxSlowSpeed) car.speed = maxSlowSpeed;
        if (car.speed < -maxSlowSpeed * 0.5) car.speed = -maxSlowSpeed * 0.5;
    }

    if (car.shootCD > 0) car.shootCD--;
    if (car.abilCD > 0) car.abilCD--;
    if (car.abilActive > 0) {
        car.abilActive--;
        if (car.carType === 2) {
            st.cars.forEach(c => {
                if (c.uid !== car.uid && c.alive && !c.isReviving && Math.hypot(c.x - car.x, c.y - car.y) < 150) {
                    if (st.mode === 'CTF' && c.team === car.team) return;
                    damageServerCar(room, c, 0.5, car);
                }
            });
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
            if (st.drops[i].type === 'hp') car.hp = Math.min(car.maxHp, car.hp + 40);
            else car.shield = 50;
            st.drops.splice(i, 1);
        }
    }

    if (st.mode === 'BR' && Math.hypot(st.zone.x - car.x, st.zone.y - car.y) > st.zone.radius) {
        damageServerCar(room, car, 0.2, null);
    }
}

function updateServerBotAI(st, car) {
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
        if (closest && minDist < 300 && car.shootCD <= 0) {
            serverCarShoot(st, car);
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
        if ((diffCheck < 0.4 || diffCheck > Math.PI * 2 - 0.4) && car.shootCD <= 0) {
            serverCarShoot(st, car);
            car.shootCD = 25;
        }
        if (car.abilCD <= 0) {
            if ((car.carType === 1 && car.hp < 60) ||
                (car.carType === 2 && minDist < 150) ||
                (car.carType === 3 && minDist < 350) ||
                (car.carType === 4) ||
                (car.carType === 5 && car.hp < 40) ||
                (car.carType === 6 && minDist < 200) ||
                (car.carType === 7 && minDist < 600) ||
                (car.carType === 8 && car.hp < 30) ||
                (car.carType === 9 && minDist < 250)) {
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

function createServerBullet(st, car, angOffset, isHeart = false) {
    let shootAngle = car.angle + angOffset;
    const dmg = isHeart ? 0 : 18;

    if (car.carType === 4 && car.abilActive > 0 && !isHeart) {
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

    st.bullets.push({
        x: car.x + Math.cos(shootAngle) * 25,
        y: car.y + Math.sin(shootAngle) * 25,
        vx: Math.cos(shootAngle) * (isHeart ? 10 : 16),
        vy: Math.sin(shootAngle) * (isHeart ? 10 : 16),
        ownerUid: car.uid,
        dmg: dmg,
        isHeart: isHeart
    });
}

function serverCarShoot(st, car) {
    createServerBullet(st, car, 0, false);
    if (car.carType === 3 && car.abilActive > 0) {
        createServerBullet(st, car, 0.2, false);
        createServerBullet(st, car, -0.2, false);
    }
}

function serverCarAbility(st, car) {
    if (car.carType === 0) return;
    if (car.carType === 1) { car.abilCD = 600; car.abilActive = 200; car.hp = Math.min(100, car.hp + 50); }
    else if (car.carType === 2) { car.abilCD = 600; car.abilActive = 200; }
    else if (car.carType === 3) { car.abilCD = 600; car.abilActive = 200; }
    else if (car.carType === 4) { car.abilCD = 600; car.abilActive = 300; }
    else if (car.carType === 5) { car.abilCD = 600; car.abilActive = 180; }
    else if (car.carType === 6) {
        car.abilCD = 600;
        st.mines.push({ x: car.x, y: car.y, timer: 300, ownerUid: car.uid });
    }
    else if (car.carType === 7) {
        car.abilCD = 900;
        createServerBullet(st, car, 0, true);
    }
    else if (car.carType === 8) {
        car.abilCD = 1200;
        car.x = 200 + Math.random() * (MAP_SIZE - 400);
        car.y = 200 + Math.random() * (MAP_SIZE - 400);
    }
    else if (car.carType === 9) {
        car.abilCD = 900;
        st.lavas.push({ x: car.x, y: car.y, timer: 300, ownerUid: car.uid });
    }
}

function damageServerCar(room, car, amt, attacker) {
    const st = room.state;
    if (car.isReviving || !car.alive) return;
    const finalAmt = (car.carType === 5 && car.abilActive > 0) ? amt * 2 : amt;

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
        if (car.carType === 5 && car.abilActive > 0) {
            car.isReviving = true;
            car.respawnTimer = 180;
            car.hp = 0.1;
            car.abilActive = 0;
            return;
        }
        car.alive = false;
        car.hasFlag = null;
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

    const finalSnap = buildRoomSnapshot(room);
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

function buildRoomSnapshot(room) {
    const st = room.state;
    if (!st) return null;
    return {
        map: st.map,
        mode: st.mode,
        timer: st.timer,
        dmTimer: st.dmTimer,
        redScore: st.redScore,
        blueScore: st.blueScore,
        ctfFlags: {
            red: { x: st.ctfFlags.red.x, y: st.ctfFlags.red.y, baseX: st.ctfFlags.red.baseX, baseY: st.ctfFlags.red.baseY, hasCarrier: !!st.ctfFlags.red.carrierUid },
            blue: { x: st.ctfFlags.blue.x, y: st.ctfFlags.blue.y, baseX: st.ctfFlags.blue.baseX, baseY: st.ctfFlags.blue.baseY, hasCarrier: !!st.ctfFlags.blue.carrierUid }
        },
        zone: st.zone,
        cars: st.cars.map(c => ({
            uid: c.uid, id: c.id, x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10,
            angle: Math.round(c.angle * 1000) / 1000, speed: Math.round(c.speed * 100) / 100,
            hp: Math.round(c.hp * 10) / 10, maxHp: c.maxHp, alive: c.alive,
            isAI: c.isAI, carType: c.carType, team: c.team, hasFlag: c.hasFlag,
            hasPass: !!c.hasPass, isReviving: c.isReviving, respawnTimer: c.respawnTimer,
            stunTimer: c.stunTimer, slowTimer: c.slowTimer || 0,
            shield: Math.round(c.shield), abilActive: c.abilActive, abilCD: c.abilCD,
            shootCD: c.shootCD, kills: c.kills, dmgDealt: Math.round(c.dmgDealt || 0),
            flagsScored: c.flagsScored || 0, rank: c.rank
        })),
        obstacles: st.obstacles,
        drops: st.drops,
        mines: st.mines.map(m => ({ x: m.x, y: m.y, timer: m.timer })),
        lavas: st.lavas.map(l => ({ x: l.x, y: l.y, timer: l.timer })),
        bullets: st.bullets.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), vx: b.vx, vy: b.vy, isHeart: !!b.isHeart }))
    };
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
        broadcastLobbyState(roomId);
    } else if (room.state) {
        const leavingCar = room.state.cars.find(c => c.uid === socket.id);
        if (leavingCar) leavingCar.isAI = true;
    }
}

server.listen(port, () => {
    console.log(`Street War Dedicated Server running on port ${port}`);
});