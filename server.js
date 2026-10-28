const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.get('/ping', (req, res) => {
    res.status(200).send('Server is active');
});

app.get('/', (req, res) => {
    res.send('Street War Server Running');
});

const port = process.env.PORT || 9000;
let rooms = {};
const LOBBY_WAIT_TIME = 180; // 3 minutes

io.on('connection', (socket) => {
    socket.on('findMatch', (data) => {
        const mode = data.mode || 'br';
        socket.gameMode = mode;
        socket.playerData = data;

        let roomId = Object.keys(rooms).find(id => rooms[id].mode === mode && !rooms[id].started && rooms[id].players.length < 10);

        if (!roomId) {
            roomId = `room_${mode}_${Date.now()}`;
            rooms[roomId] = {
                id: roomId,
                mode: mode,
                players: [],
                countdown: LOBBY_WAIT_TIME,
                timer: null,
                started: false
            };
        }

        const room = rooms[roomId];
        socket.join(roomId);
        socket.currentRoomId = roomId;

        if (!room.players.some(p => p.id === socket.id)) {
            room.players.push({
                id: socket.id,
                name: data.name || 'Player',
                car: data.car || 0,
                socket: socket
            });
        }

        broadcastLobbyState(roomId);

        if (!room.timer) {
            room.timer = setInterval(() => {
                room.countdown--;
                if (room.countdown <= 0 || room.players.length >= 10) {
                    clearInterval(room.timer);
                    startGame(roomId);
                } else {
                    broadcastLobbyState(roomId);
                }
            }, 1000);
        }
    });

    socket.on('cancelMatchmaking', () => {
        leaveRoom(socket);
    });

    socket.on('sendPacket', (data) => {
        socket.to(data.roomId).emit('receivePacket', data.packet);
    });

    socket.on('disconnect', () => {
        leaveRoom(socket);
    });
});

function broadcastLobbyState(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const playersList = room.players.map(p => ({ id: p.id, name: p.name }));
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
    if (!room || room.started) return;

    room.started = true;
    const maxPlayers = 10;
    const realPlayersCount = room.players.length;
    const botsCount = Math.max(0, maxPlayers - realPlayersCount);

    room.players.forEach((p, index) => {
        p.socket.emit('matchFound', {
            role: index === 0 ? 'host' : 'guest',
            roomId: roomId,
            mode: room.mode,
            botsCount: botsCount,
            totalPlayers: realPlayersCount
        });
    });
}

function leaveRoom(socket) {
    const roomId = socket.currentRoomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(roomId);
    socket.currentRoomId = null;

    if (room.players.length === 0) {
        clearInterval(room.timer);
        delete rooms[roomId];
    } else if (!room.started) {
        broadcastLobbyState(roomId);
    }
}

server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});