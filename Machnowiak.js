const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const cardValues = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'Joker': 20 };

let gameDeck = [];
let players = [];
let gameStarted = false;
let tableCards = []; 
let isFirstRound = true;
let lastMove = null;

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

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        if (gameStarted) return;
        players.push({ id: socket.id, name: name, hand: [], sksUsed: false, hasPlayed: false });
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    });

    socket.on('start-game', () => {
        if (players.length < 2) return;
        gameStarted = true;
        isFirstRound = true;
        gameDeck = createDeck();
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.sksUsed = false;
            p.hasPlayed = false;
            io.to(p.id).emit('init-hand', p.hand);
        });
        io.emit('update-status', "GRA RUSZYŁA! Rzuć kartę (zakryta).");
        io.emit('game-begun');
    });

    socket.on('play-card', (card) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (!gameStarted || players[pIdx].hasPlayed) return;

        const player = players[pIdx];
        const cardInHandIdx = player.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
        
        if (cardInHandIdx > -1) {
            player.hand.splice(cardInHandIdx, 1);
            player.hasPlayed = true;

            const realValues = player.hand.map(c => cardValues[c.value] || 0);
            const isBlef = cardValues[card.value] < Math.max(...realValues, 0);

            const move = { 
                playerIdx: pIdx, 
                playerName: player.name, 
                card: card, 
                wasBlef: isBlef,
                power: calculatePower(card)
            };
            
            tableCards.push(move);
            lastMove = move;

            io.emit('card-placed', { playerName: player.name });
            io.to(player.id).emit('init-hand', player.hand);
            
            if (tableCards.length === players.length) {
                io.emit('update-status', "Wszyscy rzucili! Możecie SPRAWDZAĆ lub czekamy na odsłonięcie...");
                setTimeout(resolveRound, 4000); // 4 sekundy na reakcję blefu
            }
        }
    });

    function calculatePower(card) {
        if (isFirstRound) return cardValues[card.value] || 0;
        if (card.value === '2') return 18; // HEWI
        if (card.value === 'Joker') return 25; // JOHNY
        if (card.value === '8') return (card.suit === '♥' || card.suit === '♦') ? -8 : -4; // BOGUŚ
        return cardValues[card.value] || 0;
    }

    socket.on('check-blef', () => {
        if (!lastMove || tableCards.length < players.length) return;
        const checker = players.find(p => p.id === socket.id);
        const attacker = players[lastMove.playerIdx];

        if (lastMove.wasBlef) {
            attacker.hand.push(...gameDeck.splice(0, 4));
            io.emit('blef-result', { msg: `🔥 ZŁAPANY! ${attacker.name} brał udział w blefie. +4 karty!` });
        } else {
            checker.hand.push(...gameDeck.splice(0, 3));
            io.emit('blef-result', { msg: `✅ CZYSTO! ${checker.name} dobiera 3 karne.` });
        }
        updateAllHands();
    });

    socket.on('sks-action', () => {
        const p = players.find(p => p.id === socket.id);
        if (!p || p.sksUsed || p.hand.length === 0) return;
        p.sksUsed = true;
        const sksCard = p.hand.splice(Math.floor(Math.random()*p.hand.length), 1)[0];
        const move = tableCards.find(m => m.playerIdx === players.indexOf(p));
        if (move) move.power += calculatePower(sksCard);
        io.emit('update-status', `🧨 SKS! ${p.name} dorzucił kartę!`);
        updateAllHands();
    });

    function resolveRound() {
        if (tableCards.length === 0) return;
        io.emit('reveal-cards', tableCards);

        let minPower = 100;
        let loserIdx = -1;
        let maxPower = -100;
        let winnerIdx = -1;

        tableCards.forEach(m => {
            if (m.power < minPower) { minPower = m.power; loserIdx = m.playerIdx; }
            if (m.power > maxPower) { maxPower = m.power; winnerIdx = m.playerIdx; }
        });

        const cardsToTake = tableCards.map(m => m.card);
        players[loserIdx].hand.push(...cardsToTake);
        
        io.emit('update-status', `Koniec starcia: ${players[loserIdx].name} zabiera stół!`);

        tableCards = [];
        isFirstRound = false;
        players.forEach(p => p.hasPlayed = false);
        updateAllHands();
        setTimeout(() => {
            io.emit('clear-table');
            io.emit('update-status', "Nowa runda - rzucajcie!");
        }, 3000);
    }

    function updateAllHands() {
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log('MACHNOWIAK 2.0 FINAL READY'));
