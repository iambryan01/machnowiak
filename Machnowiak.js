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
let lastPlayerIdx = -1;
let lastMoveWasBlef = false;
let canCheckBlef = false; // Nowa flaga: czy w tym momencie można sprawdzić blef

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
        players.push({ 
            id: socket.id, 
            name: name, 
            hand: [], 
            hasPlayed: false, 
            currentCombo: [], 
            target: null,
            sksUsed: false 
        });
        updatePlayerList();
    });

    // Reset gry (Punkt 6)
    socket.on('start-game', () => resetGame());
    socket.on('new-game-request', () => resetGame());

    function resetGame() {
        gameStarted = true;
        gameDeck = createDeck();
        tableCards = [];
        lastPlayerIdx = -1;
        canCheckBlef = false;
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.hasPlayed = false;
            p.currentCombo = [];
            p.sksUsed = false;
            io.to(p.id).emit('init-hand', p.hand);
        });
        io.emit('clear-table');
        io.emit('update-status', "NOWA GRA ROZPOCZĘTA!");
        updatePlayerList();
    }

    socket.on('play-card', (card) => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];
        if (!gameStarted || p.hasPlayed) return;

        // Logika Blefu (Punkt 3) - przed rzuceniem karty flaga canCheckBlef staje się true dla poprzedniego ruchu
        const handValues = p.hand.map(c => cardValues[c.value] || 0);
        const maxValInHand = Math.max(...handValues, 0);
        lastMoveWasBlef = cardValues[card.value] < maxValInHand;
        lastPlayerIdx = pIdx;
        canCheckBlef = true;

        p.currentCombo.push(p.hand.splice(p.hand.findIndex(c => c.value === card.value && c.suit === card.suit), 1)[0]);
        
        // Sprawdzanie combo (2, 8, Joker)
        let req = 1;
        if (p.currentCombo.some(c => c.value === '8')) req++;
        if (p.currentCombo.some(c => c.value === '2')) req++;
        if (p.currentCombo.some(c => c.value === 'Joker')) req += 2;

        if (p.currentCombo.length < req) {
            io.to(p.id).emit('init-hand', p.hand);
        } else {
            if (p.currentCombo.some(c => c.value === '8')) {
                const targets = players.filter(pl => pl.id !== p.id).map(pl => pl.name);
                io.to(p.id).emit('show-target-menu', targets);
            } else {
                finishTurn(p);
            }
        }
    });

    socket.on('check-blef', () => {
        if (!canCheckBlef) return socket.emit('update-status', "Nie można teraz sprawdzić blefu!");
        
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        const nextInLine = (lastPlayerIdx + 1) % players.length;

        if (checkerIdx !== nextInLine) {
            return socket.emit('update-status', "Tylko następny gracz może sprawdzić!");
        }

        canCheckBlef = false; // Raz sprawdzone zamyka okno blefu
        const attacker = players[lastPlayerIdx];
        const oldHandCount = attacker.hand.length;

        // Karty idą na spód talii (Punkt 1)
        gameDeck.push(...attacker.hand);

        if (!lastMoveWasBlef) {
            attacker.hand = gameDeck.splice(0, Math.max(0, oldHandCount - 2));
            const pool = gameDeck.splice(0, 10).filter(c => c.value !== 'Joker');
            io.to(attacker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: "PRAWDA! Wybierz nagrodę:" });
        } else {
            attacker.hand = gameDeck.splice(0, oldHandCount + 2);
            const pool = gameDeck.splice(0, 10);
            io.to(players[checkerIdx].id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: "ZŁAPANY! Wybierz mu karty:" });
        }
        updatePlayerList();
    });

    // Obsługa SKS (Punkt 5)
    socket.on('use-sks', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        const p = players[pIdx];
        if (p.sksUsed || !gameStarted) return;

        p.sksUsed = true;
        const sksCard = gameDeck.shift(); // Karta z talii

        if (sksCard.value === 'Joker') {
            p.hand.push(sksCard);
            io.to(p.id).emit('init-hand', p.hand);
            io.emit('update-status', `${p.name} SKS: Joker do ręki!`);
        } else {
            const tableMove = tableCards.find(m => m.playerIdx === pIdx);
            if (tableMove) {
                tableMove.cards.push(sksCard);
                io.emit('update-status', `${p.name} SKS: Dorzucił ${sksCard.value}${sksCard.suit}!`);
                // Po SKS przeliczamy rundę jeszcze raz
                resolveRound(true); 
            }
        }
        updatePlayerList();
    });

    function finishTurn(p) {
        p.hasPlayed = true;
        tableCards.push({ playerIdx: players.indexOf(p), playerName: p.name, cards: [...p.currentCombo], target: p.target });
        io.emit('card-placed', { playerName: p.name });
        io.to(p.id).emit('init-hand', p.hand);
        
        if (tableCards.length === players.length) {
            canCheckBlef = false; // Koniec rundy = koniec szansy na blef
            setTimeout(() => resolveRound(false), 1000);
        }
        updatePlayerList();
    }

    function calculatePower(cards) {
        let pwr = 0;
        const base = cards.filter(c => c.value !== '8' && c.value !== '2' && c.value !== 'Joker');
        pwr = base.reduce((s, c) => s + cardValues[c.value], 0);
        if (cards.some(c => c.value === '2')) pwr *= 2;
        return pwr;
    }

    function resolveRound(isSksUpdate) {
        let results = tableCards.map(m => ({ 
            playerIdx: m.playerIdx, playerName: m.playerName, 
            power: calculatePower(m.cards), m: m 
        }));

        // Ósemki
        tableCards.forEach(m => {
            const eight = m.cards.find(c => c.value === '8');
            if (eight && m.target) {
                const penalty = (eight.suit === '♥' || eight.suit === '♦') ? 8 : 4;
                const target = results.find(r => r.playerName === m.target);
                if (target) target.power -= penalty;
            }
        });

        io.emit('reveal-detailed', results.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));

        if (!isSksUpdate) {
            let maxP = Math.max(...results.map(r => r.power));
            let top = results.filter(r => r.power === maxP);

            if (top.length > 1) {
                handleBula(top);
            } else {
                let minP = Math.min(...results.map(r => r.power));
                let loser = results.find(r => r.power === minP);
                
                // Opóźnienie, żeby gracze widzieli co się stało (Punkt 1)
                setTimeout(() => {
                    players[loser.playerIdx].hand.push(...tableCards.flatMap(m => m.cards));
                    io.emit('update-status', `${loser.playerName} zabiera stół.`);
                    io.emit('show-sks-modal'); // Pytamy o SKS po zebraniu kart
                    cleanTable();
                }, 3000);
            }
        }
    }

    function handleBula(top) {
        io.emit('update-status', "⚔️ BUŁA!");
        let bulaVisuals = [];
        top.forEach(t => {
            let extra = gameDeck.splice(0, 2);
            // Tu uproszczona logika Jokera/Siły (Punkt 2: Wysyłamy do frontendu co kto dobrał)
            bulaVisuals.push({ name: t.playerName, cards: extra });
        });
        io.emit('reveal-bula', bulaVisuals);
        // ... (reszta logiki buły)
    }

    function cleanTable() {
        tableCards = [];
        players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; });
        updatePlayerList();
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
    }

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, count: p.hand.length, isCurrent: idx === lastPlayerIdx, sksUsed: p.sksUsed
        })));
    }
});

http.listen(process.env.PORT || 3000, '0.0.0.0');
