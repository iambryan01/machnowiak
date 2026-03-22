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
let tableCards = []; // Karty aktualnie leżące na stole w tej rundzie
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
            
            // Logika Blefu: Czy to była najwyższa karta?
            const realValues = player.hand.map(c => cardValues[c.value]);
            const wasActuallyHighest = cardValues[card.value] >= Math.max(...realValues, 0);

            const move = { 
                playerIdx: pIdx, 
                playerName: player.name, 
                card: card, 
                wasBlef: !wasActuallyHighest 
            };
            
            tableCards.push(move);
            lastMove = move;

            io.emit('new-card-on-table', { card: card, playerName: player.name });
            
            // Sprawdź czy runda się skończyła
            if (tableCards.length === players.length) {
                setTimeout(resolveRound, 2000); // Czekaj 2 sekundy przed zebraniem kart
            } else {
                currentPlayerIndex = (currentPlayerIndex + 1) % players.length;
                nextTurn();
            }
        }
    });

    socket.on('check-blef', () => {
        if (!lastMove || lastMove.playerIdx === players.findIndex(p => p.id === socket.id)) return;
        
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        const attacker = players[lastMove.playerIdx];
        const checker = players[checkerIdx];

        if (lastMove.wasBlef) {
            // Sukces sprawdzającego
            attacker.hand.push(...gameDeck.splice(0, 4));
            io.emit('blef-result', { msg: `🔥 ZŁAPANY! ${attacker.name} kłamał! Dobiera 4 karty.` });
        } else {
            // Atakujący mówił prawdę - zasada Machnowiaka (wymiana ręki)
            const count = attacker.hand.length;
            attacker.hand = gameDeck.splice(0, count + 2); // Uproszczona wymiana
            checker.hand.push(...gameDeck.splice(0, 3));
            io.emit('blef-result', { msg: `✅ CZYSTO! ${attacker.name} mówił prawdę. ${checker.name} dobiera 3.` });
        }
        
        updateAllHands();
    });

    function resolveRound() {
        let winnerIdx = -1;
        let maxVal = -100;

        tableCards.forEach(move => {
            let val = cardValues[move.card.value];
            
            // Specjalne moce (nie działają w Rundzie 1)
            if (!isFirstRound) {
                if (move.card.value === '2') val *= 2; // HEWI
                if (move.card.value === '8') {
                    val = (move.card.suit === '♥' || move.card.suit === '♦') ? -8 : -4; // BOGUŚ
                }
            }
            
            if (val > maxVal) {
                maxVal = val;
                winnerIdx = move.playerIdx;
            }
        });

        // Kary za nieprzebicie (Zasada Porażki)
        players.forEach((p, idx) => {
            const myMove = tableCards.find(m => m.playerIdx === idx);
            if (idx !== winnerIdx && myMove) {
                p.hand.push(...gameDeck.splice(0, 1));
            }
        });

        io.emit('clear-table');
        io.emit('update-status', `Rundę wygrał: ${players[winnerIdx].name}!`);
        
        tableCards = [];
        lastMove = null;
        isFirstRound = false;
        currentPlayerIndex = winnerIdx; // Zwycięzca zaczyna
        
        updateAllHands();
        setTimeout(nextTurn, 2000);
    }

    function nextTurn() {
        io.emit('update-status', `Tura: ${players[currentPlayerIndex].name}${isFirstRound ? ' (RUNDA 1 - rzuć najwyższą!)' : ''}`);
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    }

    function updateAllHands() {
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        io.emit('update-players', players.map(p => ({name: p.name, cards: p.hand.length})));
    }
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log('MACHNOWIAK 2.0 LIVE ON ' + PORT));