const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const port = process.env.PORT || 9000;

let queues = { br: [], dm: [], ctf: [] };
let matchmakingTimers = {};

app.get('/', (req, res) => {
    res.send('Street War Server is Running!');
});

io.on('connection', (socket) => {
    console.log('لاعب متصل:', socket.id);

    socket.on('findMatch', (data) => {
        const mode = data.mode || 'br';
        socket.gameMode = mode;
        socket.playerData = data;

        if (!queues[mode]) queues[mode] = [];
        
        // إزالة اللاعب إذا كان موجوداً سابقاً لتجنب التكرار
        queues[mode] = queues[mode].filter(s => s.id !== socket.id);
        queues[mode].push(socket);

        socket.emit('matchmakingStatus', '🔍 جاري البحث عن منافسين...');

        const maxPlayers = 10;

        // إذا توفر لاعبين حقيقيين أو أكثر
        if (queues[mode].length >= 2) {
            const player1 = queues[mode].shift();
            const player2 = queues[mode].shift();

            clearTimeout(matchmakingTimers[player1.id]);
            clearTimeout(matchmakingTimers[player2.id]);

            const roomId = `room_${mode}_${player1.id}_${player2.id}`;
            player1.join(roomId);
            player2.join(roomId);

            const totalBots = maxPlayers - 2;

            player1.emit('matchFound', {
                role: 'host', roomId: roomId, mode: mode, botsCount: totalBots, opponent: player2.playerData
            });
            player2.emit('matchFound', {
                role: 'guest', roomId: roomId, mode: mode, botsCount: totalBots, opponent: player1.playerData
            });
        } else {
            // مؤقت 8 ثوانٍ: إذا لم يدخل لاعب آخر، يبدأ اللعب فردياً مع البوتات
            clearTimeout(matchmakingTimers[socket.id]);
            matchmakingTimers[socket.id] = setTimeout(() => {
                const idx = queues[mode].findIndex(s => s.id === socket.id);
                if (idx !== -1) {
                    const p1 = queues[mode].splice(idx, 1)[0];
                    const roomId = `room_${mode}_solo_${p1.id}`;
                    p1.join(roomId);

                    p1.emit('matchFound', {
                        role: 'host', roomId: roomId, mode: mode, botsCount: maxPlayers - 1, opponent: null
                    });
                }
            }, 8000);
        }
    });

    socket.on('cancelMatchmaking', () => {
        clearTimeout(matchmakingTimers[socket.id]);
        if (socket.gameMode && queues[socket.gameMode]) {
            queues[socket.gameMode] = queues[socket.gameMode].filter(s => s.id !== socket.id);
        }
        socket.emit('matchmakingStatus', 'تم إلغاء البحث.');
    });

    socket.on('sendPacket', (data) => {
        socket.to(data.roomId).emit('receivePacket', data.packet);
    });

    socket.on('disconnect', () => {
        clearTimeout(matchmakingTimers[socket.id]);
        if (socket.gameMode && queues[socket.gameMode]) {
            queues[socket.gameMode] = queues[socket.gameMode].filter(s => s.id !== socket.id);
        }
        console.log('غادر اللاعب:', socket.id);
    });
});

server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});