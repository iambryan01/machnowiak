const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const cardValues = {
    '2': 0, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
    '8': 0, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'Joker': 0
};

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
let pendingBlefPickup = null;

// ── DEBUG ─────────────────────────────────────────────────────────────────────
const DEBUG = true;
function dbg(...args) {
    if (DEBUG) console.log('[DBG]', ...args);
}

function createDeck() {
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const suits  = ['♠','♣','♥','♦'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push({ value: v, suit: s });
    deck.push({ value: 'Joker', suit: '🃏' }, { value: 'Joker', suit: '🃏' });
    return deck.sort(() => Math.random() - 0.5);
}

function replenish(needed) {
    while (gameDeck.length < needed) gameDeck.push(...createDeck());
}

// ── WALIDACJA COMBO ───────────────────────────────────────────────────────────
// Zwraca null jeśli ok, string z błędem jeśli niedozwolone.
function validateCombo(cards) {
    if (cards.length === 0) return 'Puste combo.';

    const hasJoker  = cards.some(c => c.value === 'Joker');
    const hasTwo    = cards.some(c => c.value === '2');
    const hasEight  = cards.some(c => c.value === '8');
    const jokerCount = cards.filter(c => c.value === 'Joker').length;

    // Niedozwolone: 2 Jokery razem
    if (jokerCount > 1) return 'Nie można zagrać dwóch Jokerów naraz.';

    // Niedozwolone: Joker + karta zerowa (2 lub 8) bez karty bazowej
    // Joker wymaga dokładnie 2 kart nie-Jokerów
    if (hasJoker) {
        const nonJokers = cards.filter(c => c.value !== 'Joker');
        if (nonJokers.length !== 2) return 'Joker wymaga dokładnie 2 dodatkowych kart.';
        // Nie można: Joker + tylko karty zerowe (2, 8, Joker)
        const nonZero = nonJokers.filter(c => !['2','8','Joker'].includes(c.value));
        if (nonZero.length === 0) return 'Joker musi zawierać przynajmniej jedną kartę z wartością punktową.';
        return null; // ok
    }

    // "2": musi być z dokładnie 1 kartą bazową (nie-zerową lub 8)
    if (hasTwo) {
        if (cards.length < 2) return 'Dwójka wymaga drugiej karty.';
        if (cards.length > 3) return 'Zbyt wiele kart z dwójką.'; // 8+2+karta = 3 max
        const others = cards.filter(c => c.value !== '2');
        // Niedozwolone: 2 + same zera (np. 2+8 bez karty bazowej nie ma sensu punktowo,
        // ale 8+2+As jest ok — 8 odejmuje, 2 podwaja Asa)
        // Zasada: musi być przynajmniej 1 karta z wartością > 0 poza dwójką
        const hasBase = others.some(c => !['2','8','Joker'].includes(c.value));
        if (!hasBase) return 'Dwójka musi zawierać kartę z wartością punktową.';
        return null;
    }

    // "8" solo lub 8 + karta(y)
    if (hasEight) {
        if (cards.length > 2) return 'Z ósemką można zagrać maksymalnie 1 dodatkową kartę.';
        // Nie można: 8 + Joker (oba zerowe bez sensu)
        if (cards.length === 2) {
            const other = cards.find(c => c.value !== '8');
            if (other && ['Joker','8'].includes(other.value)) {
                return 'Ósemka może być połączona tylko z kartą punktową.';
            }
        }
        return null;
    }

    // Normalna karta solo
    if (cards.length > 1) return 'Zwykłą kartę można zagrać solo.';
    return null;
}

io.on('connection', (socket) => {

    socket.on('join', (name) => {
        if (gameStarted) return;
        players.push({ id: socket.id, name, hand: [], hasPlayed: false, currentCombo: [], target: null, sksUsed: false, waitingForTarget: false });
        dbg(`JOIN: ${name}, gracze: ${players.map(p=>p.name).join(', ')}`);
        updatePlayerList();
    });

    socket.on('start-game', () => {
        if (players.length === 0) return;
        resetGame();
    });

    socket.on('new-game-request', () => {
        gameStarted = false;
        tableCards = [];
        sksResponses = 0;
        wasBulaInRound = false;
        currentPlayerIdx = 0;
        pendingBlefPickup = null;
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
        players.forEach(p => {
            p.hand = []; p.hasPlayed = false; p.sksUsed = false;
            p.currentCombo = []; p.target = null; p.waitingForTarget = false;
        });
        io.emit('reset-client-ui');
        updatePlayerList();
    });

    function resetGame() {
        if (players.length === 0) return;
        gameStarted = true;
        gameDeck = createDeck();
        tableCards = [];
        lastPlayerIdx = -1;
        currentPlayerIdx = 0;
        canCheckBlef = false;
        wasBulaInRound = false;
        pendingBlefPickup = null;
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.hasPlayed = false; p.currentCombo = [];
            p.target = null; p.sksUsed = false; p.waitingForTarget = false;
            io.to(p.id).emit('init-hand', p.hand);
        });
        io.emit('game-begun');
        io.emit('clear-table');
        io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
        dbg(`RESET GRY. Gracz startowy: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
        broadcastDebug();
    }

    // ── ZAGRANIE COMBO ────────────────────────────────────────────────────────

    socket.on('play-combo', ({ cards, target }) => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];
        if (!p) return;

        dbg(`PLAY-COMBO od ${p.name}: ${JSON.stringify(cards)}, target: ${target}, currentPlayerIdx: ${currentPlayerIdx}, pIdx: ${pIdx}, hasPlayed: ${p.hasPlayed}`);

        if (!gameStarted || p.hasPlayed || pIdx !== currentPlayerIdx) {
            socket.emit('error-msg', `To nie Twoja tura! (current: ${players[currentPlayerIdx]?.name}, ty: ${p.name})`);
            dbg(`ODRZUCONO: gameStarted=${gameStarted}, hasPlayed=${p.hasPlayed}, pIdx=${pIdx}, currentPlayerIdx=${currentPlayerIdx}`);
            return;
        }

        // Walidacja kombinacji
        const comboErr = validateCombo(cards);
        if (comboErr) { socket.emit('error-msg', comboErr); return; }

        // Weryfikacja posiadania kart
        const handCopy = [...p.hand];
        for (const card of cards) {
            const i = handCopy.findIndex(c => c.value === card.value && c.suit === card.suit);
            if (i === -1) { socket.emit('error-msg', 'Nie masz takiej karty!'); return; }
            handCopy.splice(i, 1);
        }
        for (const card of cards) {
            const i = p.hand.findIndex(c => c.value === card.value && c.suit === card.suit);
            p.hand.splice(i, 1);
        }

        p.currentCombo = [...cards];
        p.target = target || null;

        // Wykrycie blefu
        const maxHandVal  = p.hand.length > 0 ? Math.max(...p.hand.map(c => cardValues[c.value] || 0)) : 0;
        const comboMaxVal = Math.max(...cards.map(c => cardValues[c.value] || 0));
        lastMoveWasBlef = comboMaxVal < maxHandVal;
        lastPlayerIdx = pIdx;
        canCheckBlef = true;

        dbg(`${p.name} zagrywa. blef=${lastMoveWasBlef}`);
        io.to(p.id).emit('init-hand', p.hand);

        // ── KLUCZOWA POPRAWKA ────────────────────────────────────────────────
        // Jeśli w combo jest ósemka ale target nie jest jeszcze podany,
        // NIE finalizuj tury — ustaw flagę i poczekaj na target-selected.
        // Dzięki temu currentPlayerIdx NIE przesuwa się i następny gracz
        // nie dostaje błędu "to nie Twoja tura".
        const needsTarget = cards.some(c => c.value === '8') && !target;
        if (needsTarget) {
            dbg(`${p.name} zagrywa ósemkę — czeka na cel. Tura NIE przesuwa się.`);
            p.waitingForTarget = true;
            // Wyślij menu celu z serwera (na wypadek gdyby klient sam nie pokazał)
            // Klient powinien już pokazać menu, ale serwer też może je wysłać
            return; // czekamy na target-selected
        }

        finishTurn(p);
    });

    // ── BLEF ─────────────────────────────────────────────────────────────────

    socket.on('check-blef', () => {
        const checkerIdx = players.findIndex(p => p.id === socket.id);
        if (!canCheckBlef || checkerIdx !== currentPlayerIdx) {
            socket.emit('error-msg', 'Tylko aktualny gracz może sprawdzić poprzednika!'); return;
        }

        canCheckBlef = false;
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }

        const attacker = players[lastPlayerIdx];
        const checker  = players[checkerIdx];
        if (!attacker || !checker) return;

        dbg(`BLEF: ${checker.name} sprawdza ${attacker.name}. Był blef: ${lastMoveWasBlef}`);
        io.emit('reveal-blef-anim', { player: attacker.name, cards: attacker.currentCombo });
        pendingBlefPickup = { attackerIdx: lastPlayerIdx, checkerIdx, wasBlef: lastMoveWasBlef };

        replenish(20);
        const pool = gameDeck.splice(0, 10);

        if (lastMoveWasBlef) {
            io.emit('update-status', `🚨 ${checker.name} złapał ${attacker.name} na blefie!`);
            const autoCount = Math.max(0, attacker.hand.length - 2);
            replenish(autoCount + 4);
            attacker.hand = gameDeck.splice(0, autoCount + 4);
            io.to(attacker.id).emit('init-hand', attacker.hand);
            io.to(checker.id).emit('show-pick-menu', {
                pool, count: 2, targetIdx: lastPlayerIdx,
                title: `🎯 Złapałeś ${attacker.name}! Wybierz mu 2 NAJGORSZE karty:`
            });
        } else {
            io.emit('update-status', `✅ ${attacker.name} nie kłamał! ${checker.name} dostaje 4 karne.`);
            replenish(4);
            checker.hand.push(...gameDeck.splice(0, 4));
            io.to(checker.id).emit('init-hand', checker.hand);
            const autoCount = Math.max(0, attacker.hand.length - 2);
            replenish(autoCount);
            attacker.hand = gameDeck.splice(0, autoCount);
            io.to(attacker.id).emit('init-hand', attacker.hand);
            io.to(attacker.id).emit('show-pick-menu', {
                pool, count: 2, targetIdx: lastPlayerIdx,
                title: `🤩 Nie kłamałeś! Wybierz sobie 2 NAJLEPSZE karty:`
            });
        }
        broadcastDebug();
    });

    socket.on('pick-cards', ({ cards, targetIdx }) => {
        if (!pendingBlefPickup) return;
        const { attackerIdx, checkerIdx, wasBlef } = pendingBlefPickup;
        const attacker = players[attackerIdx];
        const checker  = players[checkerIdx];
        if (!attacker || !checker) return;

        attacker.hand.push(...cards);
        io.to(attacker.id).emit('init-hand', attacker.hand);
        io.emit('update-status', wasBlef
            ? `💀 ${attacker.name} dostał kary od ${checker.name}! Reset stołu.`
            : `✅ ${attacker.name} wybrał karty dla siebie. Reset stołu.`
        );
        updatePlayerList();
        pendingBlefPickup = null;

        setTimeout(() => {
            if (players.length === 0) return;
            const allOnTable = tableCards.flatMap(m => m.cards);
            gameDeck.push(...allOnTable.filter(c => c.value !== 'Joker'));
            tableCards = [];
            players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
            currentPlayerIdx = wasBlef ? checkerIdx : attackerIdx;
            if (currentPlayerIdx >= players.length) currentPlayerIdx = 0;
            io.emit('clear-table');
            io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
            updatePlayerList();
            players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
            broadcastDebug();
        }, 1500);
    });

    // ── SKS ───────────────────────────────────────────────────────────────────

    socket.on('sks-decision', (decision) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        const p = players[pIdx];
        if (!p) { advanceSks(); return; }

        dbg(`SKS od ${p.name}: decision=${decision}, sksUsed=${p.sksUsed}`);

        if (decision && !p.sksUsed) {
            p.sksUsed = true;
            replenish(1);
            const sksCard = gameDeck.shift();
            if (!sksCard) { advanceSks(); return; }

            dbg(`${p.name} losuje SKS: ${sksCard.value}${sksCard.suit}`);
            const tableMove = tableCards.find(m => m.playerIdx === pIdx);

            if (sksCard.value === 'Joker') {
                p.hand.push(sksCard);
                io.to(p.id).emit('init-hand', p.hand);
                advanceSks();
            } else if (sksCard.value === '8') {
                if (tableMove) {
                    tableMove.cards.push(sksCard);
                    if (!tableMove.sksEights) tableMove.sksEights = [];
                    tableMove.sksEights.push({ cardIdx: tableMove.cards.length - 1, target: null });
                }
                refreshTableFor(pIdx);
                io.to(p.id).emit('show-target-menu', players.filter(pl => pl.id !== p.id).map(pl => pl.name));
            } else {
                if (tableMove) tableMove.cards.push(sksCard);
                refreshTableFor(pIdx);
                advanceSks();
            }
        } else {
            sksResponses++;
            checkAllSks();
        }
    });

    function refreshTableFor(changedPIdx) {
        players.forEach(pl => {
            const plIdx = players.indexOf(pl);
            const tableData = tableCards.map(m => ({
                playerName: m.playerName, playerIdx: m.playerIdx,
                cards: m.playerIdx === plIdx ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });
    }

    function advanceSks() {
        sksResponses++;
        dbg(`SKS responses: ${sksResponses}/${players.length}`);
        checkAllSks();
    }

    function checkAllSks() {
        if (sksResponses >= players.length) {
            sksResponses = 0;
            recalcAndShowTable();
            startRoundCountdown();
        }
    }

    function recalcAndShowTable() {
        if (tableCards.length === 0) return;
        const res = calcResults();
        io.emit('reveal-detailed', res.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));
    }

    // ── TARGET SELECTED ───────────────────────────────────────────────────────

    socket.on('target-selected', (targetName) => {
        const p = players.find(pl => pl.id === socket.id);
        if (!p) return;
        const pIdx = players.indexOf(p);
        dbg(`TARGET od ${p.name}: ${targetName}, hasPlayed=${p.hasPlayed}, waitingForTarget=${p.waitingForTarget}`);

        // SKS ósemka
        const tableMove = tableCards.find(m => m.playerIdx === pIdx);
        if (tableMove && tableMove.sksEights) {
            const unassigned = tableMove.sksEights.find(e => e.target === null);
            if (unassigned) unassigned.target = targetName;
        }

        if (!p.hasPlayed) {
            // Gracz dopiero zagrał z ósemką — teraz finalizuj turę
            p.target = targetName;
            p.waitingForTarget = false;
            dbg(`${p.name} wybrał cel ${targetName} — finiszTurn`);
            finishTurn(p);
        } else {
            // SKS ósemka po turze
            refreshTableFor(pIdx);
            advanceSks();
        }
    });

    // ── ODLICZANIE ────────────────────────────────────────────────────────────

    function startRoundCountdown() {
        let timeLeft = 15;
        if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
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
        p.waitingForTarget = false;
        tableCards.push({
            playerIdx: players.indexOf(p),
            playerName: p.name,
            cards: [...p.currentCombo],
            target: p.target,
            sksEights: []
        });

        currentPlayerIdx = (currentPlayerIdx + 1) % players.length;
        dbg(`finishTurn: ${p.name} skończył. Następny: ${players[currentPlayerIdx]?.name} (idx ${currentPlayerIdx}). Stół: ${tableCards.length}/${players.length}`);

        players.forEach(pl => {
            const plIdx = players.indexOf(pl);
            const tableData = tableCards.map(m => ({
                playerName: m.playerName, playerIdx: m.playerIdx,
                cards: m.playerIdx === plIdx ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });

        if (tableCards.length === players.length) {
            canCheckBlef = false;
            io.emit('update-status', '🔍 Wszyscy zagrali! Rozstrzyganie...');
            dbg('Wszyscy zagrali — resolveRound');
            setTimeout(() => resolveRound(), 1500);
        } else {
            io.emit('update-status', `Tura: ${players[currentPlayerIdx].name}`);
        }
        updatePlayerList();
        broadcastDebug();
    }

    // ── PUNKTY ────────────────────────────────────────────────────────────────

    function calculatePower(cards) {
        const base = cards.filter(c => c.value !== '8' && c.value !== '2' && c.value !== 'Joker');
        let pwr = base.reduce((s, c) => s + (cardValues[c.value] || 0), 0);
        if (cards.some(c => c.value === '2')) pwr *= 2;
        return pwr;
    }

    function calcResults() {
        let res = tableCards.map(m => ({
            playerIdx: m.playerIdx, playerName: m.playerName,
            power: calculatePower(m.cards), m: m
        }));

        tableCards.forEach(move => {
            move.cards.forEach((card, cardIdx) => {
                if (card.value !== '8') return;
                const isSksEight = move.sksEights && move.sksEights.some(e => e.cardIdx === cardIdx);
                let targetName = isSksEight
                    ? (move.sksEights.find(e => e.cardIdx === cardIdx)?.target || null)
                    : move.target;
                if (targetName) {
                    const penalty = (card.suit === '♥' || card.suit === '♦') ? 8 : 4;
                    const t = res.find(r => r.playerName === targetName);
                    if (t) t.power -= penalty;
                }
            });
        });

        return res;
    }

    function resolveRound() {
        const res = calcResults();
        dbg('resolveRound wyniki:', res.map(r => `${r.playerName}:${r.power}`).join(', '));
        io.emit('reveal-detailed', res.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));

        const maxP = Math.max(...res.map(r => r.power));
        const minP = Math.min(...res.map(r => r.power));
        const top   = res.filter(r => r.power === maxP);
        const loser = res.find(r => r.power === minP);

        if (top.length > 1 && !wasBulaInRound) {
            wasBulaInRound = true;
            const names = top.map(t => t.playerName).join(' i ');
            io.emit('update-status', `⚔️ BUŁA między: ${names}! Dogrywka...`);
            dbg(`BUŁA: ${names}`);
            top.forEach(t => {
                replenish(2);
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
            const all   = tableCards.flatMap(m => m.cards);
            const valid = all.filter(c => c.value !== 'Joker');

            if (wasBulaInRound) {
                replenish(4);
                players[loser.playerIdx].hand.push(...gameDeck.splice(0, 4));
                gameDeck.push(...valid);
                io.emit('update-status', `💀 Po dogrywce przegrywa ${loser.playerName} (${loser.power} pkt) i bierze 4 karne!`);
            } else {
                players[loser.playerIdx].hand.push(...valid);
                io.emit('update-status', `🃏 Rundę przegrywa ${loser.playerName} (${loser.power} pkt) i zbiera karty!`);
            }

            io.to(players[loser.playerIdx].id).emit('init-hand', players[loser.playerIdx].hand);
            wasBulaInRound = false;
            // sksUsed NIE jest resetowane (raz na grę)
            players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
            tableCards = [];
            updatePlayerList();
            dbg('Koniec rundy — SKS modal za 2s');
            broadcastDebug();
            setTimeout(() => io.emit('show-sks-modal'), 2000);
        }
    }

    function cleanTable() {
        if (players.length === 0) { tableCards = []; gameStarted = false; return; }
        const allOnTable = tableCards.flatMap(m => m.cards);
        gameDeck.push(...allOnTable.filter(c => c.value !== 'Joker'));
        tableCards = [];
        currentPlayerIdx = 0;
        players.forEach(p => { p.hasPlayed = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
        io.emit('clear-table');
        io.emit('update-status', `NOWA RUNDA - Zaczyna: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        broadcastDebug();
    }

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, count: p.hand.length, isCurrent: idx === currentPlayerIdx,
            sksUsed: p.sksUsed, waitingForTarget: p.waitingForTarget
        })));
    }

    // ── DEBUG BROADCAST ───────────────────────────────────────────────────────
    function broadcastDebug() {
        if (!DEBUG) return;
        const state = {
            gameStarted, currentPlayerIdx,
            currentPlayer: players[currentPlayerIdx]?.name || '?',
            tableCards: tableCards.map(m => ({ player: m.playerName, cards: m.cards.map(c => `${c.value}${c.suit}`).join('+'), target: m.target })),
            players: players.map(p => ({
                name: p.name, handCount: p.hand.length,
                hasPlayed: p.hasPlayed, sksUsed: p.sksUsed,
                waitingForTarget: p.waitingForTarget
            })),
            canCheckBlef, wasBulaInRound, sksResponses
        };
        io.emit('debug-state', state);
    }

    socket.on('disconnect', () => {
        const idx = players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
            dbg(`DISCONNECT: ${players[idx].name}`);
            players.splice(idx, 1);
            if (players.length === 0) {
                gameStarted = false; currentPlayerIdx = 0;
                if (roundTimer) { clearInterval(roundTimer); roundTimer = null; }
            } else {
                if (currentPlayerIdx >= players.length) currentPlayerIdx = 0;
            }
        }
        updatePlayerList();
        broadcastDebug();
    });
});

http.listen(3000, '0.0.0.0');
console.log('Serwer działa na porcie 3000');