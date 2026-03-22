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
let canCheckBlef = false; 

function createDeck() {
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = ['♠', '♣', '♥', '♦'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) deck.push({ value: v, suit: s });
    }
    deck.push({ value: 'Joker', suit: '🃏' }, { value: 'Joker', suit: '🃏' }); // Dwa Jokery w talii
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        if (gameStarted) return;
        players.push({ 
            id: socket.id, name, hand: [], hasPlayed: false, 
            currentCombo: [], target: null, sksUsed: false 
        });
        updatePlayerList();
    });

    socket.on('start-game', () => resetGame());
    socket.on('new-game-request', () => {
        gameStarted = false;
        io.emit('reset-client-ui');
        updatePlayerList();
    });

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
        io.emit('game-begun');
        io.emit('clear-table');
        io.emit('update-status', "NOWA RUNDA");
        updatePlayerList();
    }

    socket.on('play-card', (card) => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];
        if (!gameStarted || p.hasPlayed) return;

        lastMoveWasBlef = (cardValues[card.value] < Math.max(...p.hand.map(c => cardValues[c.value] || 0)));
        lastPlayerIdx = pIdx;
        canCheckBlef = true;

        const cardIdx = p.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
        p.currentCombo.push(p.hand.splice(cardIdx, 1)[0]);
        
        let req = 1;
        if (p.currentCombo.some(c => c.value === '8')) req++;
        if (p.currentCombo.some(c => c.value === '2')) req++;
        if (p.currentCombo.some(c => c.value === 'Joker')) req += 2;

        if (p.currentCombo.length < req) {
            io.to(p.id).emit('init-hand', p.hand);
        } else {
            if (p.currentCombo.some(c => c.value === '8')) {
                io.to(p.id).emit('show-target-menu', players.filter(pl => pl.id !== p.id).map(pl => pl.name));
            } else {
                finishTurn(p);
            }
        }
    });

    socket.on('check-blef', () => {
        if (!canCheckBlef) return;
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        if (checkerIdx !== (lastPlayerIdx + 1) % players.length) return;

        canCheckBlef = false;
        const attacker = players[lastPlayerIdx];
        const checker = players[checkerIdx];
        const oldHandCount = attacker.hand.length;
        gameDeck.push(...attacker.hand);

        if (!lastMoveWasBlef) {
            attacker.hand = gameDeck.splice(0, Math.max(0, oldHandCount - 2));
            const pool = gameDeck.splice(0, 10).filter(c => c.value !== 'Joker');
            io.to(attacker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: "PRAWDA! Wybierz nagrodę:" });
        } else {
            attacker.hand = gameDeck.splice(0, oldHandCount + 2);
            const pool = gameDeck.splice(0, 10);
            io.to(checker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: "ZŁAPANY! Wybierz mu karty:" });
        }
        updatePlayerList();
    });

    socket.on('use-sks', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        const p = players[pIdx];
        if (p.sksUsed || !gameStarted) return;

        p.sksUsed = true;
        const sksCard = gameDeck.shift(); 
        const tableMove = tableCards.find(m => m.playerIdx === pIdx);

        if (sksCard.value === 'Joker') {
            p.hand.push(sksCard); // Joker ląduje w ręce
            io.to(p.id).emit('init-hand', p.hand);
            io.emit('update-status', `${p.name} SKS: Joker do ręki!`);
        } else if (tableMove) {
            tableMove.cards.push(sksCard);
            io.emit('update-status', `${p.name} dołożył z SKS!`);
        }
        
        resolveRound(true); 
        updatePlayerList();
    });

    socket.on('pick-finished', (data) => {
        players[data.targetIdx].hand.push(...data.pickedCards);
        updatePlayerList();
        io.to(players[data.targetIdx].id).emit('init-hand', players[data.targetIdx].hand);
    });

    socket.on('target-selected', (t) => {
        const p = players.find(pl => pl.id === socket.id);
        p.target = t;
        finishTurn(p);
    });

    function finishTurn(p) {
        p.hasPlayed = true;
        tableCards.push({ playerIdx: players.indexOf(p), playerName: p.name, cards: [...p.currentCombo], target: p.target });
        
        // Punkt 5: Wyślij informację o zakrytych kartach, ale gracze widzą tylko swoje
        players.forEach(pl => {
            const tableData = tableCards.map(m => ({
                playerName: m.playerName,
                playerIdx: m.playerIdx,
                cards: m.playerIdx === players.indexOf(pl) ? m.cards : null // Tylko właściciel widzi swoje karty
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });

        io.emit('update-status', ""); // Czyści "NOWA RUNDA" po pierwszym ruchu

        if (tableCards.length === players.length) {
            canCheckBlef = false; 
            setTimeout(() => resolveRound(false), 1500);
        }
        updatePlayerList();
    }

    function calculatePower(cards) {
        let pwr = 0;
        const base = cards.filter(c => c.value !== '8' && c.value !== '2' && c.value !== 'Joker');
        pwr = base.reduce((s, c) => s + (cardValues[c.value] || 0), 0);
        if (cards.some(c => c.value === '2')) pwr *= 2;
        return pwr;
    }

    function resolveRound(isSksUpdate) {
        let results = tableCards.map(m => ({ 
            playerIdx: m.playerIdx, playerName: m.playerName, 
            power: calculatePower(m.cards), m: m 
        }));

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
                // Punkt 1 & 2: Buła bez komunikatów, Joker do ręki
                let bulaData = top.map(t => {
                    let extras = gameDeck.splice(0, 2);
                    let finalBulaCards = [];
                    extras.forEach(c => {
                        if (c.value === 'Joker') {
                            players[t.playerIdx].hand.push(c); // Punkt 2: Joker do ręki
                            io.to(players[t.playerIdx].id).emit('init-hand', players[t.playerIdx].hand);
                        } else {
                            finalBulaCards.push(c);
                            t.m.cards.push(c); // Dodaj do stosu na stole
                        }
                    });
                    return { playerName: t.playerName, extras: finalBulaCards };
                });
                io.emit('update-status', "⚔️ BUŁA!");
                setTimeout(() => resolveRound(true), 2000);
            } else {
                let minP = Math.min(...results.map(r => r.power));
                let loser = results.find(r => r.power === minP);
                setTimeout(() => {
                    // Punkt 6: Przekazanie kart i czyszczenie
                    players[loser.playerIdx].hand.push(...tableCards.flatMap(m => m.cards));
                    io.emit('update-status', `${loser.playerName} zabiera karty!`);
                    io.emit('show-sks-modal'); 
                    setTimeout(cleanTable, 2000);
                }, 2000);
            }
        }
    }

    function cleanTable() {
        tableCards = [];
        players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; });
        io.emit('clear-table');
        io.emit('update-status', "NOWA RUNDA");
        updatePlayerList();
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
    }

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, count: p.hand.length, isCurrent: idx === lastPlayerIdx, sksUsed: p.sksUsed
        })));
    }
});

http.listen(3000, '0.0.0.0');
