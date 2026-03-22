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
let lastPlayerIdx = -1; // Indeks gracza, który ostatnio rzucił kartę
let lastMoveWasBlef = false; // Czy ostatni ruch był blefem

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
        updatePlayerList();
    });

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, 
            count: p.hand.length,
            isCurrent: idx === lastPlayerIdx
        })));
    }

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
        io.emit('update-status', "GRA RUSZYŁA!");
        updatePlayerList();
    });

    socket.on('play-card', (card) => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];
        if (!gameStarted || p.hasPlayed) return;

        const cardIdx = p.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
        if (cardIdx === -1) return;

        // --- LOGIKA BLEFU ---
        // Sprawdzamy, czy gracz rzucił swoją najwyższą kartę
        const handValues = p.hand.map(c => cardValues[c.value] || 0);
        const maxValInHand = Math.max(...handValues, 0);
        lastMoveWasBlef = cardValues[card.value] < maxValInHand;
        lastPlayerIdx = pIdx;

        p.currentCombo.push(p.hand.splice(cardIdx, 1)[0]);
        
        let req = 1;
        if (p.currentCombo.some(c => c.value === '8')) req++;
        if (p.currentCombo.some(c => c.value === '2')) req++;
        if (p.currentCombo.some(c => c.value === 'Joker')) req += 2;

        if (p.currentCombo.length < req) {
            io.to(p.id).emit('init-hand', p.hand);
            io.to(p.id).emit('update-status', `Combo... rzuć jeszcze ${req - p.currentCombo.length}`);
        } else {
            if (p.currentCombo.some(c => c.value === '8')) {
                const targets = players.filter(pl => pl.id !== p.id).map(pl => pl.name);
                io.to(p.id).emit('show-target-menu', targets);
            } else {
                finishTurn(p);
            }
        }
        updatePlayerList();
    });

    socket.on('check-blef', () => {
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        const nextInLine = (lastPlayerIdx + 1) % players.length;

        if (checkerIdx !== nextInLine) {
            return socket.emit('update-status', "Tylko następny gracz w kolejce może sprawdzić blef!");
        }

        const attacker = players[lastPlayerIdx];
        const checker = players[checkerIdx];

        if (!lastMoveWasBlef) { 
            // SUKCES (Atakujący mówił prawdę)
            const oldHandCount = attacker.hand.length;
            gameDeck.push(...attacker.hand); // Karty na spód talii
            attacker.hand = gameDeck.splice(0, Math.max(0, oldHandCount - 2)); 
            
            // Menu wyboru dla atakującego (bez Jokera)
            const pool = gameDeck.splice(0, 10).filter(c => c.value !== 'Joker');
            io.to(attacker.id).emit('show-pick-menu', { pool: pool, count: 2, targetIdx: lastPlayerIdx, title: "Nagroda! Wybierz 2 karty dla siebie:" });
            io.emit('update-status', `✅ ${attacker.name} mówił prawdę! Wybiera nagrodę.`);
        } else {
            // PORAŻKA (Atakujący kłamał)
            const oldHandCount = attacker.hand.length;
            gameDeck.push(...attacker.hand);
            attacker.hand = gameDeck.splice(0, oldHandCount - 2 + 4); // nowa ręka + 4 karne
            
            // Menu wyboru dla sprawdzającego (wybiera najgorsze dla ofiary)
            const pool = gameDeck.splice(0, 10);
            io.to(checker.id).emit('show-pick-menu', { pool: pool, count: 2, targetIdx: lastPlayerIdx, title: `Złapałeś go! Wybierz 2 karty dla ${attacker.name}:` });
            io.emit('update-status', `🔥 ZŁAPANY! ${attacker.name} blefował.`);
        }
        updatePlayerList();
    });

    socket.on('pick-finished', (data) => {
        const p = players[data.targetIdx];
        p.hand.push(...data.pickedCards);
        updatePlayerList();
        io.to(p.id).emit('init-hand', p.hand);
    });

    socket.on('target-selected', (t) => {
        const p = players.find(pl => pl.id === socket.id);
        p.target = t;
        finishTurn(p);
    });

    function finishTurn(p) {
        p.hasPlayed = true;
        tableCards.push({ playerIdx: players.indexOf(p), playerName: p.name, cards: [...p.currentCombo], target: p.target });
        io.emit('card-placed', { playerName: p.name });
        io.to(p.id).emit('init-hand', p.hand);
        if (tableCards.length === players.length) setTimeout(resolveRound, 2000);
        updatePlayerList();
    }

    function calculatePower(cards) {
        let pwr = 0;
        const base = cards.filter(c => c.value !== '8' && c.value !== '2' && c.value !== 'Joker');
        if (cards.some(c => c.value === '2')) pwr = base.length > 0 ? cardValues[base[0].value] * 2 : 4;
        else if (cards.some(c => c.value === 'Joker')) pwr = base.reduce((s, c) => s + cardValues[c.value], 0);
        else pwr = base.reduce((s, c) => s + cardValues[c.value], 0);
        return pwr;
    }

    function resolveRound() {
        let results = tableCards.map(m => ({ playerIdx: m.playerIdx, playerName: m.playerName, power: calculatePower(m.cards), m: m }));

        tableCards.forEach(m => {
            const eight = m.cards.find(c => c.value === '8');
            if (eight && m.target) {
                const penalty = (eight.suit === '♥' || eight.suit === '♦') ? 8 : 4;
                const target = results.find(r => r.playerName === m.target);
                if (target) target.power -= penalty;
            }
        });

        io.emit('reveal-detailed', results.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));

        let maxP = Math.max(...results.map(r => r.power));
        let top = results.filter(r => r.power === maxP);

        if (top.length > 1) {
            io.emit('update-status', "⚔️ BUŁA! Rozpoczynam dogrywkę...");
            let inBula = top.map(t => ({ ...t, totalBulaPower: t.power }));
            let winnerFound = false;

            while (!winnerFound) {
                inBula.forEach(playerBula => {
                    let extra = gameDeck.splice(0, 2);
                    let roundPower = 0;
                    
                    extra.forEach((c, idx) => {
                        if (c.value === 'Joker') {
                            players[playerBula.playerIdx].hand.push(c);
                            extra.splice(idx, 1);
                            io.to(players[playerBula.playerIdx].id).emit('init-hand', players[playerBula.playerIdx].hand);
                        }
                    });

                    if (extra.length === 2) {
                        if (extra[0].value === '2' || extra[1].value === '2') {
                            let other = extra.find(c => c.value !== '2') || {value: '2'};
                            roundPower = cardValues[other.value] * 2;
                        } else {
                            roundPower = cardValues[extra[0].value] + cardValues[extra[1].value];
                        }
                    } else if (extra.length === 1) {
                        roundPower = cardValues[extra[0].value];
                    }

                    extra.forEach(c => {
                        if (c.value === '8') {
                            let penalty = (c.suit === '♥' || c.suit === '♦') ? 8 : 4;
                            inBula.forEach(other => { if (other !== playerBula) other.totalBulaPower -= penalty; });
                        }
                    });

                    playerBula.totalBulaPower += roundPower;
                });

                let bulaMax = Math.max(...inBula.map(p => p.totalBulaPower));
                let bulaWinners = inBula.filter(p => p.totalBulaPower === bulaMax);

                if (bulaWinners.length === 1) {
                    winnerFound = true;
                    let bulaMin = Math.min(...inBula.map(p => p.totalBulaPower));
                    let loser = inBula.find(p => p.totalBulaPower === bulaMin);
                    players[loser.playerIdx].hand.push(...gameDeck.splice(0, 4));
                    gameDeck.push(...tableCards.flatMap(m => m.cards));
                    io.emit('update-status', `Bułę przegrywa ${loser.playerName}! (+4 karne)`);
                } 
            }
        } else {
            let minP = Math.min(...results.map(r => r.power));
            let loserIdx = results.find(r => r.power === minP).playerIdx;
            players[loserIdx].hand.push(...tableCards.flatMap(m => m.cards));
            io.emit('update-status', `${players[loserIdx].name} zabiera stół.`);
        }

        tableCards = [];
        players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; });
        updateAllHands();
    }

    function updateAllHands() {
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        io.emit('update-player-list', players.map((p, idx) => ({name: p.name, count: p.hand.length, isCurrent: idx === lastPlayerIdx})));
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log('MACHNOWIAK 2.0 - FULL RULES READY'));
