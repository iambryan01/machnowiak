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
let sksResponses = 0;
let roundTimer = null;

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
        if (gameStarted) return;
        players.push({ id: socket.id, name, hand: [], hasPlayed: false, currentCombo: [], target: null, sksUsed: false });
        updatePlayerList();
    });

    socket.on('start-game', () => resetGame());
    
    socket.on('new-game-request', () => {
        gameStarted = false;
        tableCards = [];
        sksResponses = 0;
        if(roundTimer) clearInterval(roundTimer);
        players.forEach(p => { p.hand = []; p.hasPlayed = false; p.sksUsed = false; });
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
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        if (!canCheckBlef || checkerIdx !== (lastPlayerIdx + 1) % players.length) {
            socket.emit('error-msg', "Możesz sprawdzić blef tylko przed dodaniem swojej karty!");
            return;
        }

        canCheckBlef = false;
        const attacker = players[lastPlayerIdx];
        const checker = players[checkerIdx];
        
        if (lastMoveWasBlef) {
            io.emit('update-status', `🚨 ${checker.name} przyłapał ${attacker.name} na kłamstwie!`);
            const oldHandCount = attacker.hand.length;
            attacker.hand = gameDeck.splice(0, Math.max(0, oldHandCount - 2) + 4);
            const pool = gameDeck.splice(0, 10);
            io.to(checker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: `Wybierz 2 karty dla gracza ${attacker.name}:` });
        } else {
            io.emit('update-status', `✅ ${attacker.name} mówił prawdę! ${checker.name} dostaje 3 karty.`);
            checker.hand.push(...gameDeck.splice(0, 3));
            const oldHandCount = attacker.hand.length;
            attacker.hand = gameDeck.splice(0, Math.max(0, oldHandCount - 2));
            const pool = gameDeck.splice(0, 10);
            io.to(attacker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: `Wybierz dla siebie 2 karty:` });
        }
        updatePlayerList();
    });

    socket.on('sks-decision', (decision) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        const p = players[pIdx];
        sksResponses++;

        if (decision && !p.sksUsed) {
            p.sksUsed = true;
            const sksCard = gameDeck.shift();
            const tableMove = tableCards.find(m => m.playerIdx === pIdx);
            
            if (sksCard.value === 'Joker') {
                p.hand.push(sksCard);
                io.emit('update-status', `${p.name} SKS: Joker do ręki!`);
                io.to(p.id).emit('init-hand', p.hand);
            } else if (tableMove) {
                tableMove.cards.push(sksCard);
            }
            // Po każdym SKS sprawdzamy stan stołu i generujemy odpowiedni komunikat
            resolveRound(true, p.name); 
        }

        if (sksResponses >= players.length) {
            sksResponses = 0;
            startRoundCountdown();
        }
    });

    function startRoundCountdown() {
        let timeLeft = 15;
        if(roundTimer) clearInterval(roundTimer);
        roundTimer = setInterval(() => {
            io.emit('update-timer', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roundTimer);
                cleanTable();
            }
            timeLeft--;
        }, 1000);
    }

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
        players.forEach(pl => {
            const tableData = tableCards.map(m => ({
                playerName: m.playerName, playerIdx: m.playerIdx,
                cards: m.playerIdx === players.indexOf(pl) ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });
        io.emit('update-status', "");
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

    function resolveRound(isSksUpdate, sksUser = null) {
        let results = tableCards.map(m => ({ 
            playerIdx: m.playerIdx, playerName: m.playerName, power: calculatePower(m.cards), m: m 
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

        let maxP = Math.max(...results.map(r => r.power));
        let minP = Math.min(...results.map(r => r.power));
        let top = results.filter(r => r.power === maxP);
        let loser = results.find(r => r.power === minP);

        // LOGIKA KOMUNIKATÓW SKS (Punkt 1 i 2)
        if (isSksUpdate && sksUser) {
            if (top.length > 1 && top.some(t => t.playerName === sksUser)) {
                io.emit('update-status', `BUŁA! ${sksUser} wyrównał SKS-em!`);
            } else if (loser.playerName === sksUser) {
                io.emit('update-status', `${sksUser} użył SKS, ale nadal zabiera karty.`);
            } else {
                io.emit('update-status', `${sksUser} użył SKS i teraz ${loser.playerName} zabiera karty!`);
            }
        }

        if (top.length > 1) {
            top.forEach(t => {
                let extras = gameDeck.splice(0, 2);
                extras.forEach(c => {
                    if (c.value === 'Joker') {
                        players[t.playerIdx].hand.push(c);
                        io.to(players[t.playerIdx].id).emit('init-hand', players[t.playerIdx].hand);
                    } else { t.m.cards.push(c); }
                });
            });
            io.emit('update-status', "⚔️ BUŁA!");
            setTimeout(() => resolveRound(false), 2000);
        } else if (!isSksUpdate) {
            // Finałowe zabranie kart
            if (tableCards.some(m => m.cards.length > 5)) {
                players[loser.playerIdx].hand.push(...gameDeck.splice(0, 4));
                gameDeck.push(...tableCards.flatMap(m => m.cards));
                io.emit('update-status', `PO BULI: ${loser.playerName} dostaje 4 karne!`);
            } else {
                players[loser.playerIdx].hand.push(...tableCards.flatMap(m => m.cards));
                io.emit('update-status', `${loser.playerName} zabiera karty!`);
            }
            io.emit('show-sks-modal'); 
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
