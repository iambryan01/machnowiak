const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const cardValues = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'Joker': 0 };

let gameDeck = [];
let players = [];
let gameStarted = false;
let tableCards = []; 

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
        players.push({ id: socket.id, name: name, hand: [], hasPlayed: false, currentCombo: [], target: null });
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    });

    socket.on('start-game', () => {
        if (players.length < 2) return;
        gameStarted = true;
        gameDeck = createDeck();
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.hasPlayed = false;
            p.currentCombo = [];
            io.to(p.id).emit('init-hand', p.hand);
        });
        io.emit('game-begun');
        io.emit('update-status', "GRA RUSZYŁA! Rzuć kartę.");
    });

    socket.on('play-card', (card) => {
        const p = players.find(pl => pl.id === socket.id);
        if (!gameStarted || p.hasPlayed) return;

        const cardIdx = p.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
        if (cardIdx === -1) return;

        p.currentCombo.push(p.hand.splice(cardIdx, 1)[0]);
        
        // --- DYNAMICZNA LOGIKA KOMBOSÓW ---
        let requiredCards = 1;
        const hasEight = p.currentCombo.some(c => c.value === '8');
        const hasTwo = p.currentCombo.some(c => c.value === '2');
        const hasJoker = p.currentCombo.some(c => c.value === 'Joker');

        if (hasEight) requiredCards++; // +1 karta za 8
        if (hasTwo) requiredCards++;   // +1 karta za 2 (mnożnik)
        if (hasJoker) requiredCards += 2; // +2 karty za Jokera

        // Poprawka: Jeśli masz i 8 i Jokera, musisz rzucić łącznie 4 karty (8, Joker, Karta, Karta)
        // Jeśli masz 8 i 2, musisz rzucić 3 karty (8, 2, Karta)
        
        if (p.currentCombo.length < requiredCards) {
            io.to(p.id).emit('init-hand', p.hand);
            io.to(p.id).emit('update-status', `Combo w toku... Dołóż jeszcze ${requiredCards - p.currentCombo.length} kart(y).`);
        } else {
            if (hasEight) {
                const targets = players.filter(pl => pl.id !== p.id).map(pl => pl.name);
                io.to(p.id).emit('show-target-menu', targets);
            } else {
                finishTurn(p);
            }
        }
    });

    socket.on('target-selected', (targetName) => {
        const p = players.find(pl => pl.id === socket.id);
        p.target = targetName;
        finishTurn(p);
    });

    function finishTurn(p) {
        p.hasPlayed = true;
        tableCards.push({ 
            playerIdx: players.indexOf(p), 
            playerName: p.name, 
            cards: [...p.currentCombo],
            target: p.target 
        });
        io.emit('card-placed', { playerName: p.name });
        io.to(p.id).emit('init-hand', p.hand);
        if (tableCards.length === players.length) setTimeout(resolveRound, 2000);
    }

    function calculatePower(move) {
        let power = 0;
        const hasTwo = move.cards.some(c => c.value === '2');
        const hasJoker = move.cards.some(c => c.value === 'Joker');
        
        // Karty bazowe (te, które dają punkty, a nie są funkcyjne)
        const baseCards = move.cards.filter(c => c.value !== '8' && c.value !== '2' && c.value !== 'Joker');
        
        if (hasTwo && baseCards.length > 0) {
            power = cardValues[baseCards[0].value] * 2;
        } else if (hasJoker) {
            power = baseCards.reduce((sum, c) => sum + cardValues[c.value], 0);
        } else {
            power = baseCards.length > 0 ? cardValues[baseCards[0].value] : 0;
        }
        return power;
    }

    function resolveRound() {
        let scores = tableCards.map(m => ({ playerIdx: m.playerIdx, power: calculatePower(m), m: m }));

        // Atak Ósemek
        tableCards.forEach(m => {
            const eight = m.cards.find(c => c.value === '8');
            if (eight && m.target) {
                const penalty = (eight.suit === '♥' || eight.suit === '♦') ? 8 : 4;
                const targetScore = scores.find(s => players[s.playerIdx].name === m.target);
                if (targetScore) targetScore.power -= penalty;
            }
        });

        io.emit('reveal-detailed', scores.map(s => ({ name: players[s.playerIdx].name, cards: s.m.cards, finalPower: s.power })));

        // Buła i Przegrana
        let maxP = Math.max(...scores.map(s => s.power));
        let top = scores.filter(s => s.power === maxP);

        if (top.length > 1) {
            io.emit('update-status', "⚔️ BUŁA! Dobieranie...");
            top.forEach(w => {
                const extra = gameDeck.splice(0, 2);
                w.power += extra.reduce((sum, c) => sum + cardValues[c.value], 0);
                w.lastCardVal = cardValues[extra[1].value];
            });
            top.sort((a, b) => a.lastCardVal - b.lastCardVal);
            let loser = top[0].playerIdx;
            players[loser].hand.push(...tableCards.flatMap(m => m.cards));
        } else {
            let minP = Math.min(...scores.map(s => s.power));
            let loserIdx = scores.find(s => s.power === minP).playerIdx;
            players[loserIdx].hand.push(...tableCards.flatMap(m => m.cards));
        }

        tableCards = [];
        players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; });
        updateAllHands();
    }

    function updateAllHands() {
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log('MACHNOWIAK 2.0 ULTIMATE READY'));
