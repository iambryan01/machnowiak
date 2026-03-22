const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

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
let gameStarted = false;
let tableCards = []; 
let isFirstRound = true;
let lastMove = null;

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        if (gameStarted) return socket.emit('error-msg', 'Gra już trwa!');
        players.push({ id: socket.id, name: name, hand: [], sksUsed: false });
        io.emit('update-players', players.map(p => ({name: p.name, cards: 0})));
        io.emit('update-status', `Oczekiwanie... (${players.length} graczy)`);
    });

    socket.on('start-game', () => {
        if (players.length < 1) return;
        gameStarted = true;
        isFirstRound = true;
        gameDeck = createDeck();
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.sksUsed = false;
            io.to(p.id).emit('init-hand', p.hand);
        });
        nextTurn();
    });

    socket.on('play-card', (card) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        if (pIdx !== currentPlayerIndex || !gameStarted) return;

        const player = players[pIdx];
        const cardInHandIdx = player.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
        
        if (cardInHandIdx > -1) {
            player.hand.splice(cardInHandIdx, 1);
            const realHandValues = player.hand.map(c => cardValues[c.value]);
            const isBlef = cardValues[card.value] < Math.max(...realHandValues, 0);

            const move = { 
                playerIdx: pIdx, 
                playerName: player.name, 
                card: card, 
                wasBlef: isBlef,
                power: calculatePower(card)
            };
            
            tableCards.push(move);
            lastMove = move;

            io.emit('new-card-on-table', { card: card, playerName: player.name });
            
            if (tableCards.length === players.length) {
                setTimeout(resolveRound, 2000);
            } else {
                currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
                nextTurn();
            }
        }
    });

    function calculatePower(card) {
        if (isFirstRound) return cardValues[card.value];
        if (card.value === '2') return 18; // HEWI: Silna karta przebijająca
        if (card.value === '8') {
            return (card.suit === '♥' || card.suit === '♦') ? -8 : -4; // BOGUŚ
        }
        if (card.value === 'Joker') return 25; // JOHNY
        return cardValues[card.value];
    }

    socket.on('sks-action', () => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        const p = players[pIdx];
        if (p.sksUsed || p.hand.length === 0 || tableCards.length === 0) return;

        p.sksUsed = true;
        const randomCardIdx = Math.floor(Math.random() * p.hand.length);
        const sksCard = p.hand.splice(randomCardIdx, 1)[0];
        
        io.emit('update-status', `📢 SKS! ${p.name} losuje kartę: ${sksCard.value}${sksCard.suit}`);
        
        // Aktualizacja siły gracza w tej rundzie
        const myMove = tableCards.find(m => m.playerIdx === pIdx);
        if (myMove) {
            myMove.power += calculatePower(sksCard);
        }
        
        io.to(p.id).emit('init-hand', p.hand);
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    });

    socket.on('check-blef', () => {
        if (!lastMove || lastMove.playerIdx === players.findIndex(p => p.id === socket.id)) return;
        const attacker = players[lastMove.playerIdx];
        const checker = players[players.findIndex(p => p.id === socket.id)];

        if (lastMove.wasBlef) {
            attacker.hand.push(...gameDeck.splice(0, 4));
            io.emit('blef-result', { msg: `🔥 ZŁAPANY! ${attacker.name} kłamał. Bierze 4 karty!` });
        } else {
            attacker.hand = gameDeck.splice(0, 2); 
            checker.hand.push(...gameDeck.splice(0, 3));
            io.emit('blef-result', { msg: `✅ CZYSTO! ${checker.name} dobiera 3 karne.` });
        }
        updateAllHands();
    });

    function resolveRound() {
        let maxPower = -100;
        let winners = [];

        tableCards.forEach(m => {
            if (m.power > maxPower) {
                maxPower = m.power;
                winners = [m.playerIdx];
            } else if (m.power === maxPower) {
                winners.push(m.playerIdx);
            }
        });

        if (winners.length > 1) {
            io.emit('update-status', `⚔️ BUŁA! Remis!`);
            winners.forEach(i => players[i].hand.push(...gameDeck.splice(0, 2)));
            players.forEach((p, i) => { if (!winners.includes(i)) p.hand.push(...gameDeck.splice(0, 4)); });
        } else {
            const winIdx = winners[0];
            players.forEach((p, i) => { if (i !== winIdx) p.hand.push(...gameDeck.splice(0, 1)); });
            currentPlayerIndex = winIdx;
            io.emit('update-status', `Zwycięzca starcia: ${players[winIdx].name}`);
        }

        tableCards = [];
        lastMove = null;
        isFirstRound = false;
        updateAllHands();
        setTimeout(nextTurn, 2000);
    }

    function nextTurn() {
        if (!gameStarted) return;
        const p = players[currentPlayerIndex];
        if (p.hand.length === 0) {
            io.emit('update-status', `🏆 GRĘ WYGRAŁ: ${p.name}!`);
            gameStarted = false;
            return;
        }
        io.emit('update-status', `Tura: ${p.name}${isFirstRound ? ' (RUNDA 1)' : ''}`);
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    }

    function updateAllHands() {
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log('MACHNOWIAK 2.0 FINAL READY'));
