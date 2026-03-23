const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const cardValues = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 0, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'Joker': 0 };

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
        if (gameStarted) return;
        players.push({ id: socket.id, name, hand: [], hasPlayed: false, currentCombo: [], target: null, sksUsed: false });
        updatePlayerList();
    });

    socket.on('disconnect', () => {
        const index = players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
            const playerName = players[index].name;
            players.splice(index, 1);
            if (!gameStarted) {
                updatePlayerList();
            } else {
                io.emit('update-status', `🏃 Gracz ${playerName} opuścił grę.`);
                if (index === currentPlayerIdx) currentPlayerIdx = 0;
                updatePlayerList();
            }
        }
    });

    socket.on('start-game', () => resetGame());
    
    socket.on('new-game-request', () => {
        gameStarted = false;
        tableCards = [];
        sksResponses = 0;
        wasBulaInRound = false;
        currentPlayerIdx = 0;
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
        currentPlayerIdx = 0; 
        canCheckBlef = false;
        wasBulaInRound = false;
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.hasPlayed = false;
            p.currentCombo = [];
            p.sksUsed = false;
            io.to(p.id).emit('init-hand', p.hand);
        });
        io.emit('game-begun');
        io.emit('clear-table');
        io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
    }

    socket.on('play-card', (card) => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];
        
        if (!gameStarted || p.hasPlayed || pIdx !== currentPlayerIdx) {
            socket.emit('error-msg', "To nie Twoja tura!");
            return;
        }

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
        if (!canCheckBlef || checkerIdx !== currentPlayerIdx) {
            socket.emit('error-msg', "Tylko gracz wykonujący ruch może sprawdzić poprzednika!");
            return;
        }

        canCheckBlef = false;
        const attacker = players[lastPlayerIdx];
        const checker = players[checkerIdx];
        const pool = gameDeck.splice(0, 10);
        
        io.emit('reveal-blef-anim', { player: attacker.name, cards: attacker.currentCombo });

        let winnerIdx;
        if (lastMoveWasBlef) {
            io.emit('update-status', `🚨 ${checker.name} złapał ${attacker.name} na blefie!`);
            winnerIdx = checkerIdx;
            let currentCount = attacker.hand.length;
            attacker.hand = gameDeck.splice(0, Math.max(0, currentCount - 2) + 4);
            io.to(checker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: `DAJ 2 KARTY DLA ${attacker.name}:` });
        } else {
            io.emit('update-status', `✅ ${attacker.name} nie kłamał! ${checker.name} dostaje karne.`);
            winnerIdx = lastPlayerIdx;
            checker.hand.push(...gameDeck.splice(0, 4));
            io.to(checker.id).emit('init-hand', checker.hand);
            let currentCount = attacker.hand.length;
            attacker.hand = gameDeck.splice(0, Math.max(0, currentCount - 2));
            io.to(attacker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: `WYBIERZ DLA SIEBIE 2 KARTY:` });
        }

        setTimeout(() => {
            const allOnTable = tableCards.flatMap(m => m.cards);
            gameDeck.push(...allOnTable.filter(c => c.value !== 'Joker'));
            tableCards = [];
            players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; p.sksUsed = false; });
            currentPlayerIdx = winnerIdx;
            io.emit('clear-table');
            io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
            updatePlayerList();
        }, 3000);
    });

    // --- POPRAWIONY SYSTEM SKS ---
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
                io.emit('update-status', `${p.name} wylosował Jokera z SKS do ręki!`);
                advanceSks();
            } else {
                // Dorzucamy kartę do stosu na stole
                if (tableMove) {
                    tableMove.cards.push(sksCard);
                } else {
                    // Fail-safe: jeśli z jakiegoś powodu nie ma ruchu na stole, tworzymy go
                    tableCards.push({ playerIdx: pIdx, playerName: p.name, cards: [sksCard], target: null });
                }

                if (sksCard.value === '8') {
                    io.emit('update-status', `${p.name} trafił Ósemkę z SKS! Wybiera cel...`);
                    io.to(p.id).emit('show-target-menu', players.filter(pl => pl.id !== p.id).map(pl => pl.name));
                } else {
                    io.emit('update-status', `${p.name} dołożył ${sksCard.value}${sksCard.suit} z SKS.`);
                    advanceSks();
                }
            }
        } else {
            p.sksUsed = true; // Zaznaczamy jako użyte nawet przy "NIE", żeby przycisk zniknął
            advanceSks();
        }
    });

    function advanceSks() {
        sksResponses++;
        checkAllSks();
    }

    function checkAllSks() {
        if (sksResponses >= players.length) {
            sksResponses = 0;
            // Resetujemy sksUsed dla wszystkich przed kolejną rundą (zapewnia, że SKS pojawi się znów)
            players.forEach(p => p.sksUsed = false);
            startRoundCountdown();
        }
    }

    socket.on('target-selected', (t) => {
        const p = players.find(pl => pl.id === socket.id);
        const pIdx = players.indexOf(p);
        p.target = t;
        let move = tableCards.find(m => m.playerIdx === pIdx);
        if(move) move.target = t;

        if (!p.hasPlayed) {
            finishTurn(p);
        } else {
            // To był wybór celu po SKS
            advanceSks();
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

    function finishTurn(p) {
        p.hasPlayed = true;
        tableCards.push({ playerIdx: players.indexOf(p), playerName: p.name, cards: [...p.currentCombo], target: p.target });
        io.emit('play-sound', 'card');
        currentPlayerIdx = (currentPlayerIdx + 1) % players.length;
        
        players.forEach(pl => {
            const tableData = tableCards.map(m => ({
                playerName: m.playerName, playerIdx: m.playerIdx,
                cards: m.playerIdx === players.indexOf(pl) ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });

        if (tableCards.length === players.length) {
            canCheckBlef = false; 
            setTimeout(() => resolveRound(false), 1500);
        } else {
            io.emit('update-status', `Tura: ${players[currentPlayerIdx].name}`);
        }
        updatePlayerList();
    }

    function calculatePower(cards) {
        if (!cards || cards.length === 0) return 0;
        let sum = 0;
        let hasTwo = false;
        
        cards.forEach(c => {
            if (c.value === '2') hasTwo = true;
            sum += (cardValues[c.value] || 0);
        });
        
        return hasTwo ? sum * 2 : sum;
    }

    function resolveRound(isSks) {
        let res = tableCards.map(m => ({ 
            playerIdx: m.playerIdx, playerName: m.playerName, power: calculatePower(m.cards), m: m 
        }));

        tableCards.forEach(move => {
            move.cards.forEach(card => {
                if (card.value === '8' && move.target) {
                    const penalty = (card.suit === '♥' || card.suit === '♦') ? 8 : 4;
                    const targetData = res.find(r => r.playerName === move.target);
                    if (targetData) targetData.power -= penalty;
                }
            });
        });

        io.emit('reveal-detailed', res.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));

        let powers = res.map(r => r.power);
        let maxP = Math.max(...powers);
        let minP = Math.min(...powers);
        let top = res.filter(r => r.power === maxP);
        let loser = res.find(r => r.power === minP);

        if (top.length > 1) {
            wasBulaInRound = true;
            io.emit('update-status', `⚔️ BUŁA! Dogrywka...`);
            top.forEach(t => {
                let ex = gameDeck.splice(0, 2);
                ex.forEach(c => {
                    if (c.value === 'Joker') {
                        players[t.playerIdx].hand.push(c);
                        io.to(players[t.playerIdx].id).emit('init-hand', players[t.playerIdx].hand);
                    } else t.m.cards.push(c);
                });
            });
            setTimeout(() => resolveRound(false), 3000);
        } else {
            const all = tableCards.flatMap(m => m.cards);
            if (wasBulaInRound) {
                players[loser.playerIdx].hand.push(...gameDeck.splice(0, 4));
                io.emit('update-status', `💀 ${loser.playerName} bierze 4 karne.`);
            } else {
                players[loser.playerIdx].hand.push(...all.filter(c => c.value !== 'Joker'));
                io.emit('update-status', `🃏 ${loser.playerName} zbiera karty.`);
            }
            wasBulaInRound = false; 
            setTimeout(() => io.emit('show-sks-modal'), 2000);
        }
    }

    function cleanTable() {
        gameDeck.push(...tableCards.flatMap(m => m.cards).filter(c => c.value !== 'Joker'));
        tableCards = [];
        currentPlayerIdx = 0;
        players.forEach(p => { 
            p.hasPlayed = false; 
            p.currentCombo = []; 
            p.target = null; 
            p.sksUsed = false; // Resetowanie SKS na początku nowej rundy
        });
        io.emit('clear-table');
        updatePlayerList();
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
    }

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, count: p.hand.length, isCurrent: idx === currentPlayerIdx, sksUsed: p.sksUsed
        })));
    }
});

http.listen(3000, '0.0.0.0');
