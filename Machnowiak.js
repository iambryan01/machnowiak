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
            }
        } else {
            if (gameStarted) return;
            players.push({ id: socket.id, name, hand: [], hasPlayed: false, currentCombo: [], target: null, sksUsed: false });
        }
        updatePlayerList();
    });

    socket.on('start-game', () => resetGame());

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

        // ODKLIKNIĘCIE
        const comboIdx = p.currentCombo.findIndex(c => c.value === card.value && c.suit === card.suit);
        if (comboIdx !== -1) {
            const returnedCard = p.currentCombo.splice(comboIdx, 1)[0];
            p.hand.push(returnedCard);
            io.to(p.id).emit('init-hand', p.hand);
            return;
        }

        // DODANIE DO COMBO
        const handIdx = p.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
        if (handIdx === -1) return;
        const selectedCard = p.hand.splice(handIdx, 1)[0];
        p.currentCombo.push(selectedCard);

        // LOGIKA WYMAGAŃ
        let required = 1;
        const hasFunction = p.currentCombo.some(c => ['2', '8', 'Joker'].includes(c.value));
        
        if (p.currentCombo.some(c => c.value === '8')) required = 2;
        else if (p.currentCombo.some(c => c.value === '2')) required = 2;
        else if (p.currentCombo.some(c => c.value === 'Joker')) required = 3;

        // CZY RZUCAMY NA STÓŁ?
        if (!hasFunction || p.currentCombo.length >= required) {
            const handValues = p.hand.map(c => cardValues[c.value] || 0);
            const comboValues = p.currentCombo.map(c => cardValues[c.value] || 0);
            lastMoveWasBlef = (Math.max(...comboValues) < Math.max(...handValues, 0));
            lastPlayerIdx = pIdx;
            canCheckBlef = true;

            if (p.currentCombo.some(c => c.value === '8')) {
                io.to(p.id).emit('show-target-menu', players.filter(pl => pl.id !== p.id).map(pl => pl.name));
            } else {
                finishTurn(p);
            }
        } else {
            // Tylko wysuwamy (odświeżamy rękę gracza, by karta zniknęła z rzędu)
            io.to(p.id).emit('init-hand', p.hand);
            io.to(p.id).emit('update-status', "Wybierz kartę uzupełniającą...");
        }
    });

    socket.on('target-selected', (targetName) => {
        const p = players.find(pl => pl.id === socket.id);
        if (!p) return;
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
        p.currentCombo = [];
        currentPlayerIdx = (currentPlayerIdx + 1) % players.length;
        
        // WIDOK STOŁU: Ty widzisz swoje, inni null (zakryte)
        players.forEach((pl, idx) => {
            const personalTable = tableCards.map(m => ({
                playerName: m.playerName,
                playerIdx: m.playerIdx,
                cards: (m.playerIdx === idx) ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', personalTable);
        });

        io.emit('update-status', `Tura: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
    }

    socket.on('pick-cards', (data) => {
        const target = players[data.targetIdx];
        if (target && data.cards) {
            target.hand.push(...data.cards);
            io.to(target.id).emit('init-hand', target.hand);
            io.emit('update-status', `${target.name} otrzymał karty.`);
            updatePlayerList();
        }
    });

    socket.on('check-blef', () => {
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        if (!canCheckBlef || checkerIdx !== currentPlayerIdx) return;
        canCheckBlef = false;
        const attacker = players[lastPlayerIdx];
        const checker = players[checkerIdx];
        const pool = gameDeck.splice(0, 10);
        
        io.emit('reveal-blef-anim', { player: attacker.name, cards: tableCards[tableCards.length-1].cards });

        if (lastMoveWasBlef) {
            attacker.hand.push(...gameDeck.splice(0, 4));
            io.to(checker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: `WYBIERZ 2 DLA ${attacker.name}:` });
        } else {
            checker.hand.push(...gameDeck.splice(0, 4));
            io.to(attacker.id).emit('show-pick-menu', { pool, count: 2, targetIdx: lastPlayerIdx, title: `WYBIERZ SOBIE 2:` });
        }
        setTimeout(() => resetTableAfterBlef(lastMoveWasBlef ? checkerIdx : lastPlayerIdx), 4000);
    });

    function resetTableAfterBlef(nextIdx) {
        tableCards = [];
        currentPlayerIdx = nextIdx;
        players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; });
        io.emit('clear-table');
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        updatePlayerList();
    }

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, count: p.hand.length, isCurrent: idx === currentPlayerIdx
        })));
    }
});

http.listen(process.env.PORT || 3000, '0.0.0.0');
