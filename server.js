const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const port = process.env.PORT || 9000;

// طوابير الانتظار حسب نمط اللعبة
let queues = {
    br: [],       // Battle Royale (10 Players)
    dm: [],       // Deathmatch (10 Players)
    ctf: []       // Capture The Flag (5v5)
};

let rooms = {};

io.on('connection', (socket) => {
    console.log('لاعب متصل:', socket.id);

    // البحث عن مباراة حسب النمط المختارة
    socket.on('findMatch', (data) => {
        const mode = data.mode || 'br';
        socket.gameMode = mode;
        socket.playerData = data;

        if (!queues[mode]) queues[mode] = [];
        
        // منع التكرار في طابور الانتظار
        if (!queues[mode].includes(socket)) {
            queues[mode].push(socket);
            socket.emit('matchmakingStatus', '🔍 جاري البحث عن منافسين...');
        }

        const maxRealPlayers = mode === 'ctf' ? 10 : 10;
        
        // عند توفر لاعبين اثنين على الأقل، يتم إنشاء الغرفة وإكمال الباقي ببوتات AI
        if (queues[mode].length >= 2) {
            const player1 = queues[mode].shift();
            const player2 = queues[mode].shift();
            const roomId = `room_${mode}_${player1.id}_${player2.id}`;

            player1.join(roomId);
            player2.join(roomId);

            rooms[roomId] = { p1: player1.id, p2: player2.id, mode: mode };

            const totalBots = maxRealPlayers - 2; // حساب عدد البوتات المطلوبة

            player1.emit('matchFound', {
                role: 'host',
                roomId: roomId,
                mode: mode,
                botsCount: totalBots,
                opponent: player2.playerData
            });

            player2.emit('matchFound', {
                role: 'guest',
                roomId: roomId,
                mode: mode,
                botsCount: totalBots,
                opponent: player1.playerData
            });
        }
    });

    // إلغاء البحث
    socket.on('cancelMatchmaking', () => {
        if (socket.gameMode && queues[socket.gameMode]) {
            queues[socket.gameMode] = queues[socket.gameMode].filter(s => s.id !== socket.id);
        }
        socket.emit('matchmakingStatus', 'تم إلغاء البحث.');
    });

    // تبادل البيانات أثناء اللعب بين اللاعبين
    socket.on('sendPacket', (data) => {
        socket.to(data.roomId).emit('receivePacket', data.packet);
    });

    // عند انقطاع الاتصال
    socket.on('disconnect', () => {
        if (socket.gameMode && queues[socket.gameMode]) {
            queues[socket.gameMode] = queues[socket.gameMode].filter(s => s.id !== socket.id);
        }
        console.log('غادر اللاعب:', socket.id);
    });
});

server.listen(port, () => {
    console.log(`Socket.io Server running on port ${port}`);
});