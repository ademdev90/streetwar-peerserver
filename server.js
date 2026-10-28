const { PeerServer } = require('peer');

const port = process.env.PORT || 9000;
const server = PeerServer({
    port: port,
    path: '/streetwar'
});

console.log(`PeerJS Server running on port ${port}`);