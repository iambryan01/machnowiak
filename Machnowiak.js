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
let currentPlayerIdx = 0;
let lastMoveWasBlef = false;
let canCheckBlef = false;
let sksResponses = 0;
let roundTimer = null;
let wasBulaInRound = false;

// Stan oczekujący na pick-cards po sprawdzeniu blefu
let pendingBlefPickup = null;

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

function replenishDeckIfNeeded(needed) {
    while (gameDeck.length < needed) {
        gameDeck.push(...createDeck());
    }
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
        wasBulaInRound = false;
        currentPlayerIdx = 0;
        pendingBlefPickup = null;
        if (roundTimer) clearInterval(roundTimer);
        players.forEach(p => { p.hand = []; p.hasPlayed = false; p.sksUsed = false; p.currentCombo = []; p.target = null; });
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
        pendingBlefPickup = null;
        if (roundTimer) clearInterval(roundTimer);
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.hasPlayed = false;
            p.currentCombo = [];
            p.target = null;
            p.sksUsed = false;
            io.to(p.id).emit('init-hand', p.hand);
        });
        io.emit('game-begun');
        io.emit('clear-table');
        io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
    }

    // ── ZAGRANIE COMBO ───────────────────────────────────────────────────────

    socket.on('play-combo', ({ cards, target }) => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];

        if (!gameStarted || p.hasPlayed || pIdx !== currentPlayerIdx) {
            socket.emit('error-msg', "To nie Twoja tura!");
            return;
        }

        // Weryfikacja kart
        const handCopy = [...p.hand];
        for (const card of cards) {
            const idx = handCopy.findIndex(c => c.value === card.value && c.suit === card.suit);
            if (idx === -1) { socket.emit('error-msg', "Nie masz takiej karty!"); return; }
            handCopy.splice(idx, 1);
        }

        for (const card of cards) {
            const idx = p.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
            p.hand.splice(idx, 1);
        }

        p.currentCombo = [...cards];
        p.target = target || null;

        // Blef: czy zagrał niższą kartę niż ma w ręce?
        const maxHandVal = p.hand.length > 0 ? Math.max(...p.hand.map(c => cardValues[c.value] || 0)) : 0;
        const comboMaxVal = Math.max(...cards.map(c => cardValues[c.value] || 0));
        lastMoveWasBlef = comboMaxVal < maxHandVal;
        lastPlayerIdx = pIdx;
        canCheckBlef = true;

        io.to(p.id).emit('init-hand', p.hand);
        finishTurn(p);
    });

    // ── SPRAWDZANIE BLEFA ────────────────────────────────────────────────────

    socket.on('check-blef', () => {
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        if (!canCheckBlef || checkerIdx !== currentPlayerIdx) {
            socket.emit('error-msg', "Tylko aktualny gracz może sprawdzić poprzednika!");
            return;
        }

        canCheckBlef = false;
        if (roundTimer) clearInterval(roundTimer);

        const attacker = players[lastPlayerIdx];
        const checker = players[checkerIdx];

        io.emit('reveal-blef-anim', { player: attacker.name, cards: attacker.currentCombo });

        pendingBlefPickup = { attackerIdx: lastPlayerIdx, checkerIdx, wasBlef: lastMoveWasBlef };

        replenishDeckIfNeeded(20);
        const pool = gameDeck.splice(0, 10);

        if (lastMoveWasBlef) {
            // ── BLEF ZŁAPANY ─────────────────────────────────────────────────
            // Atakujący: automat losuje (handCount - 2) kart + 4 karne
            // Checker wybiera atakującemu 2 dodatkowe kary z puli
            io.emit('update-status', `🚨 ${checker.name} złapał ${attacker.name} na blefie!`);

            const oldCount = attacker.hand.length;
            const autoCount = Math.max(0, oldCount - 2);
            replenishDeckIfNeeded(autoCount + 4);
            attacker.hand = gameDeck.splice(0, autoCount + 4); // auto losowane
            io.to(attacker.id).emit('init-hand', attacker.hand);

            // Checker wybiera 2 kary dla atakującego
            io.to(checker.id).emit('show-pick-menu', {
                pool,
                count: 2,
                targetIdx: lastPlayerIdx,
                title: `🎯 Złapałeś ${attacker.name}! Wybierz mu 2 NAJGORSZE karty:`
            });

        } else {
            // ── NIE BYŁO BLEFA ───────────────────────────────────────────────
            // Checker: dostaje 4 karne karty
            // Atakujący: automat losuje (handCount - 2) kart, sam wybiera sobie 2 z puli
            io.emit('update-status', `✅ ${attacker.name} nie kłamał! ${checker.name} dostaje 4 karne.`);

            replenishDeckIfNeeded(4);
            checker.hand.push(...gameDeck.splice(0, 4));
            io.to(checker.id).emit('init-hand', checker.hand);

            const oldCount = attacker.hand.length;
            const autoCount = Math.max(0, oldCount - 2);
            replenishDeckIfNeeded(autoCount);
            attacker.hand = gameDeck.splice(0, autoCount);
            io.to(attacker.id).emit('init-hand', attacker.hand);

            // Atakujący wybiera sobie 2 najlepsze z puli
            io.to(attacker.id).emit('show-pick-menu', {
                pool,
                count: 2,
                targetIdx: lastPlayerIdx,
                title: `🤩 Nie kłamałeś! Wybierz sobie 2 NAJLEPSZE karty:`
            });
        }
    });

    // ── ODBIÓR WYBRANYCH KART (pick-cards) ──────────────────────────────────
    // Ten event był ZUPEŁNIE NIEOBSŁUGIWANY w poprzedniej wersji!

    socket.on('pick-cards', ({ cards, targetIdx }) => {
        if (!pendingBlefPickup) return;

        const { attackerIdx, checkerIdx, wasBlef } = pendingBlefPickup;
        const attacker = players[attackerIdx];
        const checker = players[checkerIdx];

        if (wasBlef) {
            // Checker wybrał 2 kary dla atakującego → dodaj do ręki atakującego
            attacker.hand.push(...cards);
            io.to(attacker.id).emit('init-hand', attacker.hand);
            io.emit('update-status', `💀 ${attacker.name} dostał kary od ${checker.name}! Stół reset.`);
        } else {
            // Atakujący wybrał sobie 2 dobre karty → dodaj do jego ręki
            attacker.hand.push(...cards);
            io.to(attacker.id).emit('init-hand', attacker.hand);
            io.emit('update-status', `✅ ${attacker.name} wybrał 2 karty dla siebie. Stół reset.`);
        }

        updatePlayerList();
        pendingBlefPickup = null;

        // Reset stołu
        setTimeout(() => {
            const allOnTable = tableCards.flatMap(m => m.cards);
            gameDeck.push(...allOnTable.filter(c => c.value !== 'Joker'));

            tableCards = [];
            players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; });
            currentPlayerIdx = wasBlef ? checkerIdx : attackerIdx;
            io.emit('clear-table');
            io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
            updatePlayerList();
            players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        }, 1500);
    });

    // ── SKS ──────────────────────────────────────────────────────────────────

    socket.on('sks-decision', (decision) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        const p = players[pIdx];

        if (decision && !p.sksUsed) {
            p.sksUsed = true;
            replenishDeckIfNeeded(1);
            const sksCard = gameDeck.shift();

            if (!sksCard) { advanceSks(); return; }

            const tableMove = tableCards.find(m => m.playerIdx === pIdx);

            if (sksCard.value === 'Joker') {
                // Joker trafia do ręki, nie na stół
                p.hand.push(sksCard);
                io.to(p.id).emit('init-hand', p.hand);
                advanceSks();

            } else if (sksCard.value === '8') {
                // 8 trafia na stół i wymaga wyboru celu
                if (tableMove) tableMove.cards.push(sksCard);
                // Zapisz że ta 8 jest z SKS (ostatnia karta w combo)
                if (!tableMove.sksEights) tableMove.sksEights = [];
                tableMove.sksEights.push({ cardIdx: tableMove.cards.length - 1, target: null });
                io.to(p.id).emit('show-target-menu', players.filter(pl => pl.id !== p.id).map(pl => pl.name));
                // advanceSks() wywoła target-selected

            } else {
                // Karta 3-7, 9-A lub 2: trafia na stół i wpływa na punkty
                if (tableMove) tableMove.cards.push(sksCard);
                advanceSks();
            }
        } else {
            sksResponses++;
            checkAllSks();
        }
    });

    function advanceSks() {
        sksResponses++;
        checkAllSks();
    }

    function checkAllSks() {
        if (sksResponses >= players.length) {
            sksResponses = 0;
            startRoundCountdown();
        }
    }

    socket.on('target-selected', (targetName) => {
        const p = players.find(pl => pl.id === socket.id);
        if (!p) return;
        p.target = targetName;

        // Jeśli SKS z ósemką - przypisz cel do ostatniej nieprzypisanej 8 w sksEights
        const tableMove = tableCards.find(m => m.playerIdx === players.indexOf(p));
        if (tableMove && tableMove.sksEights) {
            const unassigned = tableMove.sksEights.find(e => e.target === null);
            if (unassigned) unassigned.target = targetName;
        }

        if (!p.hasPlayed) {
            finishTurn(p);
        } else {
            advanceSks();
        }
    });

    // ── ODLICZANIE ───────────────────────────────────────────────────────────

    function startRoundCountdown() {
        let timeLeft = 15;
        if (roundTimer) clearInterval(roundTimer);
        io.emit('update-timer', timeLeft);
        roundTimer = setInterval(() => {
            timeLeft--;
            io.emit('update-timer', timeLeft);
            if (timeLeft <= 0) {
                clearInterval(roundTimer);
                roundTimer = null;
                cleanTable();
            }
        }, 1000);
    }

    function finishTurn(p) {
        p.hasPlayed = true;
        tableCards.push({
            playerIdx: players.indexOf(p),
            playerName: p.name,
            cards: [...p.currentCombo],
            target: p.target,
            sksEights: []
        });

        currentPlayerIdx = (currentPlayerIdx + 1) % players.length;

        players.forEach(pl => {
            const tableData = tableCards.map(m => ({
                playerName: m.playerName,
                playerIdx: m.playerIdx,
                cards: m.playerIdx === players.indexOf(pl) ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });

        if (tableCards.length === players.length) {
            canCheckBlef = false;
            io.emit('update-status', '🔍 Wszyscy zagrali! Rozstrzyganie...');
            setTimeout(() => resolveRound(false), 1500);
        } else {
            io.emit('update-status', `Tura: ${players[currentPlayerIdx].name}`);
        }
        updatePlayerList();
    }

    // ── LICZENIE PUNKTÓW ─────────────────────────────────────────────────────

    function calculatePower(cards) {
        const base = cards.filter(c => c.value !== '8' && c.value !== '2' && c.value !== 'Joker');
        let pwr = base.reduce((s, c) => s + (cardValues[c.value] || 0), 0);
        if (cards.some(c => c.value === '2')) pwr *= 2;
        return pwr;
    }

    function resolveRound() {
        let res = tableCards.map(m => ({
            playerIdx: m.playerIdx,
            playerName: m.playerName,
            power: calculatePower(m.cards),
            m: m
        }));

        // Zastosuj efekty ósemek z głównego combo
        tableCards.forEach(move => {
            const mainEights = move.cards.filter((c, idx) => {
                if (c.value !== '8') return false;
                // Sprawdź czy to nie jest ósemka z SKS
                return !move.sksEights || !move.sksEights.some(e => e.cardIdx === idx);
            });
            mainEights.forEach(card => {
                if (move.target) {
                    const penalty = (card.suit === '♥' || card.suit === '♦') ? 8 : 4;
                    const t = res.find(r => r.playerName === move.target);
                    if (t) t.power -= penalty;
                }
            });

            // Ósemki z SKS
            if (move.sksEights) {
                move.sksEights.forEach(e => {
                    if (e.target) {
                        const card = move.cards[e.cardIdx];
                        if (card && card.value === '8') {
                            const penalty = (card.suit === '♥' || card.suit === '♦') ? 8 : 4;
                            const t = res.find(r => r.playerName === e.target);
                            if (t) t.power -= penalty;
                        }
                    }
                });
            }
        });

        io.emit('reveal-detailed', res.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));

        const maxP = Math.max(...res.map(r => r.power));
        const minP = Math.min(...res.map(r => r.power));
        const top = res.filter(r => r.power === maxP);
        const loser = res.find(r => r.power === minP);

        if (top.length > 1 && !wasBulaInRound) {
            wasBulaInRound = true;
            const names = top.map(t => t.playerName).join(" i ");
            io.emit('update-status', `⚔️ BUŁA między: ${names}! Dogrywka...`);

            top.forEach(t => {
                replenishDeckIfNeeded(2);
                const ex = gameDeck.splice(0, 2);
                ex.forEach(c => {
                    if (c.value === 'Joker') {
                        players[t.playerIdx].hand.push(c);
                        io.to(players[t.playerIdx].id).emit('init-hand', players[t.playerIdx].hand);
                    } else {
                        t.m.cards.push(c);
                    }
                });
            });
            setTimeout(() => resolveRound(), 3000);

        } else {
            const all = tableCards.flatMap(m => m.cards);
            const valid = all.filter(c => c.value !== 'Joker');

            if (wasBulaInRound) {
                replenishDeckIfNeeded(4);
                players[loser.playerIdx].hand.push(...gameDeck.splice(0, 4));
                gameDeck.push(...valid);
                io.emit('update-status', `💀 Po dogrywce przegrywa ${loser.playerName} (${loser.power} pkt) i bierze 4 karne!`);
            } else {
                players[loser.playerIdx].hand.push(...valid);
                io.emit('update-status', `🃏 Rundę przegrywa ${loser.playerName} (${loser.power} pkt) i zbiera karty ze stołu!`);
            }

            io.to(players[loser.playerIdx].id).emit('init-hand', players[loser.playerIdx].hand);
            wasBulaInRound = false;
            players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; p.sksUsed = false; });
            tableCards = [];
            updatePlayerList();

            setTimeout(() => io.emit('show-sks-modal'), 2000);
        }
    }

    function cleanTable() {
        const allOnTable = tableCards.flatMap(m => m.cards);
        gameDeck.push(...allOnTable.filter(c => c.value !== 'Joker'));
        tableCards = [];
        currentPlayerIdx = 0;
        players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; });
        io.emit('clear-table');
        io.emit('update-status', `NOWA RUNDA - Zaczyna: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
    }

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, count: p.hand.length, isCurrent: idx === currentPlayerIdx, sksUsed: p.sksUsed
        })));
    }

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        updatePlayerList();
    });
});

http.listen(3000, '0.0.0.0');
console.log('Serwer działa na porcie 3000');
