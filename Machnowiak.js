const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const cardValues = { '2': 0, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 0, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'Joker': 0 };

let gameDeck = [];
let players = [];
let gameStarted = false;
let tableCards = []; 
let lastPlayerIdx = -1;
let currentPlayerIdx = 0; 
let lastMoveWasBlef = false;
let canCheckBlef = false; 
let sksResponses = 0;
let roundTimer = null;
let wasBulaInRound = false;

function createDeck() {
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const suits = ['♠', '♣', '♥', '♦'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) deck.push({ value: v, suit: s });
    }
    deck.push({ value: 'Joker', suit: '🃏' }, { value: 'Joker', suit: '🃏' });
    return deck.sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        let existingPlayer = players.find(p => p.name === name);
        
        if (existingPlayer) {
            existingPlayer.id = socket.id; 
            if (gameStarted) {
                socket.emit('game-begun');
                socket.emit('init-hand', existingPlayer.hand);
                const tableData = tableCards.map(m => ({
                    playerName: m.playerName, playerIdx: m.playerIdx,
                    cards: m.playerIdx === players.indexOf(existingPlayer) ? m.cards : null
                }));
                socket.emit('update-table-hidden', tableData);
            }
        } else {
            if (gameStarted) {
                socket.emit('error-msg', "Gra trwa.");
                return;
            }
            players.push({ id: socket.id, name, hand: [], hasPlayed: false, currentCombo: [], target: null, sksUsed: false });
        }
        updatePlayerList();
    });

    socket.on('start-game', () => resetGame());

    socket.on('new-game-request', () => {
        gameStarted = false;
        tableCards = [];
        players.forEach(p => { p.hand = []; p.hasPlayed = false; p.sksUsed = false; });
        io.emit('reset-client-ui');
        updatePlayerList();
    });

    function resetGame() {
        if (players.length < 2) return;
        gameStarted = true;
        gameDeck = createDeck();
        tableCards = [];
        currentPlayerIdx = 0; 
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.hasPlayed = false;
            p.currentCombo = [];
            p.sksUsed = false;
            io.to(p.id).emit('init-hand', p.hand);
        });
        io.emit('game-begun');
        io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
    }

    socket.on('play-card', (card) => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];
        if (!gameStarted || p.hasPlayed || pIdx !== currentPlayerIdx) return;

        const handValues = p.hand.map(c => cardValues[c.value] || 0);
        lastMoveWasBlef = (cardValues[card.value] < Math.max(...handValues, 0));
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
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        if (!canCheckBlef || checkerIdx !== currentPlayerIdx) return;

        canCheckBlef = false;
        const attacker = players[lastPlayerIdx];
        const checker = players[checkerIdx];
        const pool = gameDeck.splice(0, 10);
        
        io.emit('reveal-blef-anim', { player: attacker.name, cards: attacker.currentCombo });

        if (lastMoveWasBlef) {
            io.emit('update-status', `🚨 ${attacker.name} ZŁAPANY!`);
            const oldHandSize = attacker.hand.length;
            attacker.hand = gameDeck.splice(0, Math.max(0, oldHandSize - 2));
            attacker.hand.push(...gameDeck.splice(0, 4));
            io.to(checker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: `WYBIERZ 2 KARTY DLA ${attacker.name}:` });
        } else {
            io.emit('update-status', `✅ ${attacker.name} CZYSTY! ${checker.name} bierze 4.`);
            checker.hand.push(...gameDeck.splice(0, 4));
            io.to(checker.id).emit('init-hand', checker.hand);
            const oldHandSize = attacker.hand.length;
            attacker.hand = gameDeck.splice(0, Math.max(0, oldHandSize - 2));
            io.to(attacker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: `WYBIERZ SOBIE 2 KARTY:` });
        }

        setTimeout(() => resetTableAfterBlef(lastMoveWasBlef ? checkerIdx : lastPlayerIdx), 3000);
    });

    socket.on('pick-cards', (data) => {
        const target = players[data.targetIdx];
        if (target && data.cards) {
            target.hand.push(...data.cards);
            io.to(target.id).emit('init-hand', target.hand);
            updatePlayerList();
        }
    });

    socket.on('sks-decision', (decision) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        const p = players[pIdx];
        if (decision && !p.sksUsed) {
            p.sksUsed = true;
            const sksCard = gameDeck.shift();
            let tableMove = tableCards.find(m => m.playerIdx === pIdx);
            
            if (sksCard.value === 'Joker') {
                p.hand.push(sksCard);
                io.to(p.id).emit('init-hand', p.hand);
                advanceSks();
            } else {
                if (tableMove) tableMove.cards.push(sksCard);
                else tableCards.push({ playerIdx: pIdx, playerName: p.name, cards: [sksCard], target: null });

                io.emit('update-table-hidden', tableCards.map(m => ({ playerName: m.playerName, playerIdx: m.playerIdx, cards: m.cards })));

                if (sksCard.value === '8') {
                    io.to(p.id).emit('show-target-menu', players.filter(pl => pl.id !== p.id).map(pl => pl.name));
                } else {
                    advanceSks();
                }
            }
        } else {
            p.sksUsed = true;
            advanceSks();
        }
    });

    function calculatePower(cards) {
        let sum = 0; let mult = 1;
        cards.forEach(c => {
            if (c.value === '2') mult *= 2;
            sum += (cardValues[c.value] || 0);
        });
        return sum * mult;
    }

    function resolveRound() {
        let res = tableCards.map(m => ({ 
            playerIdx: m.playerIdx, playerName: m.playerName, power: calculatePower(m.cards), m: m 
        }));

        tableCards.forEach(move => {
            move.cards.forEach(card => {
                if (card.value === '8' && move.target) {
                    const penalty = (card.suit === '♥' || card.suit === '♦') ? 8 : 4;
                    const t = res.find(r => r.playerName === move.target);
                    if (t) t.power -= penalty;
                }
            });
        });

        io.emit('reveal-detailed', res.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));

        let powers = res.map(r => r.power);
        let minP = Math.min(...powers);
        let maxP = Math.max(...powers);
        let top = res.filter(r => r.power === maxP);
        let loser = res.find(r => r.power === minP);

        if (top.length > 1) {
            wasBulaInRound = true;
            top.forEach(t => {
                let ex = gameDeck.splice(0, 2);
                ex.forEach(c => {
                    if (c.value === 'Joker') players[t.playerIdx].hand.push(c);
                    else t.m.cards.push(c);
                });
            });
            setTimeout(() => resolveRound(), 3000);
        } else {
            const all = tableCards.flatMap(m => m.cards);
            if (wasBulaInRound) players[loser.playerIdx].hand.push(...gameDeck.splice(0, 4));
            else players[loser.playerIdx].hand.push(...all.filter(c => c.value !== 'Joker'));
            
            wasBulaInRound = false; 
            updatePlayerList();
            setTimeout(() => io.emit('show-sks-modal'), 2000);
        }
    }

    function resetTableAfterBlef(nextIdx) {
        gameDeck.push(...tableCards.flatMap(m => m.cards).filter(c => c.value !== 'Joker'));
        tableCards = [];
        currentPlayerIdx = nextIdx;
        players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; p.sksUsed = false; });
        io.emit('clear-table');
        updatePlayerList();
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
    }

    function advanceSks() {
        sksResponses++;
        if (sksResponses >= players.length) {
            sksResponses = 0;
            startRoundCountdown();
        }
    }

    function startRoundCountdown() {
        let timeLeft = 10;
        if(roundTimer) clearInterval(roundTimer);
        roundTimer = setInterval(() => {
            io.emit('update-timer', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roundTimer);
                tableCards = [];
                players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; p.sksUsed = false; });
                currentPlayerIdx = 0;
                io.emit('clear-table');
                updatePlayerList();
                players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
            }
            timeLeft--;
        }, 1000);
    }

    function finishTurn(p) {
        p.hasPlayed = true;
        tableCards.push({ playerIdx: players.indexOf(p), playerName: p.name, cards: [...p.currentCombo], target: p.target });
        currentPlayerIdx = (currentPlayerIdx + 1) % players.length;
        
        if (tableCards.length === players.length) {
            canCheckBlef = false; 
            setTimeout(() => resolveRound(), 1500);
        } else {
            io.emit('update-status', `Tura: ${players[currentPlayerIdx].name}`);
        }
        updatePlayerList();
    }

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, count: p.hand.length, isCurrent: idx === currentPlayerIdx, sksUsed: p.sksUsed
        })));
    }
});

http.listen(process.env.PORT || 3000, '0.0.0.0');
