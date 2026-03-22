const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Serwowanie plików statycznych
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const cardValues = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'Joker': 20 };

function createDeck() {
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = ['♠', '♣', '♥', '♦'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) deck.push({ value: v, suit: s });
    }
    deck.push({ value: 'Joker', suit: '🃏' });
    return deck.sort(() => Math.random() - 0.5);
}

let gameDeck = [];
let players = [];
let currentPlayerIndex = 0;
let lastPlayedMove = null;
let gameStarted = false;

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        if (gameStarted) return socket.emit('error-msg', 'Gra już trwa!');
        if (players.length >= 6) return socket.emit('error-msg', 'Pokój jest pełny!');
        players.push({ id: socket.id, name: name, hand: [], sksUsed: false });
        io.emit('update-players', players.map(p => ({name: p.name, cards: 0})));
        io.emit('update-status', `Oczekiwanie na start... (${players.length}/6)`);
    });

    socket.on('start-game', () => {
        if (gameStarted || players.length < 1) return;
        gameStarted = true;
        gameDeck = createDeck();
        currentPlayerIndex = 0;
        players.forEach(player => {
            player.hand = gameDeck.splice(0, 5);
            io.to(player.id).emit('init-hand', player.hand);
        });
        io.emit('game-begun');
        io.emit('update-players', players.map(p => ({name: p.name, cards: 5})));
        io.emit('update-status', `Tura: ${players[currentPlayerIndex].name}`);
    });

    socket.on('play-card', (card) => {
        if (!gameStarted || socket.id !== players[currentPlayerIndex].id) return;
        const player = players[currentPlayerIndex];
        const cardIdx = player.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
        if (cardIdx !== -1) {
            const handValues = player.hand.map(c => cardValues[c.value] || 0);
            const playedValue = cardValues[card.value] || 0;
            const isBlef = playedValue < Math.max(...handValues);
            player.hand.splice(cardIdx, 1);
            lastPlayedMove = { attackerIdx: currentPlayerIndex, card: card, wasBlef: isBlef };
            io.emit('new-card-on-table', { card: card, playerName: player.name });
            currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
            io.emit('update-status', `Tura: ${players[currentPlayerIndex].name}`);
            io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
        }
    });

    socket.on('check-blef', () => {
        if (!lastPlayedMove) return;
        const attacker = players[lastPlayedMove.attackerIdx];
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        if (lastPlayedMove.wasBlef) {
            attacker.hand.push(...gameDeck.splice(0, 4));
            io.to(attacker.id).emit('init-hand', attacker.hand);
            io.emit('blef-result', { msg: `ZŁAPANY! ${attacker.name} dobiera 4!` });
        } else {
            players[checkerIdx].hand.push(...gameDeck.splice(0, 3));
            io.to(players[checkerIdx].id).emit('init-hand', players[checkerIdx].hand);
            io.emit('blef-result', { msg: `CZYSTO! Sprawdzający dobiera 3!` });
        }
        lastPlayedMove = null;
        io.emit('clear-table');
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (players.length === 0) gameStarted = false;
    });
});

// KLUCZOWA ZMIANA: Port dynamiczny dla hostingu
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log('Serwer działa na porcie: ' + PORT);
});