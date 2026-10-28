const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const port = process.env.PORT || 9000;

// طابور الانتظار للبحث عن مباريات
let queue = [];
let rooms = {};

io.on('connection', (socket) => {
    console.log('لاعب متصل:', socket.id);

    // عند إرسال طلب بحث عن مباراة
    socket.on('findMatch', (playerData) => {
        socket.playerData = playerData;

        // التحقق مما إذا كان اللاعب موجوداً مسبقاً في الطابور
        if (!queue.includes(socket)) {
            queue.push(socket);
            socket.emit('matchmakingStatus', '🔍 جاري البحث عن منافس...');
        }

        // إذا توفر لاعبان في الطابور، أنشئ مباراة فوراً
        if (queue.length >= 2) {
            const player1 = queue.shift();
            const player2 = queue.shift();
            const roomId = `room_${player1.id}_${player2.id}`;

            player1.join(roomId);
            player2.join(roomId);

            rooms[roomId] = { p1: player1.id, p2: player2.id };

            // إعلام اللاعبين ببدء المباراة وتحديد الأدوار (Host / Guest)
            player1.emit('matchFound', { role: 'host', roomId: roomId, opponent: player2.playerData });
            player2.emit('matchFound', { role: 'guest', roomId: roomId, opponent: player1.playerData });
        }
    });

    // إلغاء البحث
    socket.on('cancelMatchmaking', () => {
        queue = queue.filter(s => s.id !== socket.id);
        socket.emit('matchmakingStatus', 'تم إلغاء البحث.');
    });

    // تبادل البيانات أثناء اللعب بين اللاعبين في نفس الغرفة
    socket.on('sendPacket', (data) => {
        socket.to(data.roomId).emit('receivePacket', data.packet);
    });

    // عند انقطاع الاتصال
    socket.on('disconnect', () => {
        queue = queue.filter(s => s.id !== socket.id);
        console.log('غادر اللاعب:', socket.id);
    });
});

server.listen(port, () => {
    console.log(`Socket.io Matchmaking Server running on port ${port}`);
});