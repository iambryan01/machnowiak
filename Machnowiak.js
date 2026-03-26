const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));
app.get('/favicon.png', (req, res) => res.sendFile(path.join(__dirname, 'favicon.png')));
app.use('/img', express.static(path.join(__dirname, 'img')));

const cardValues = {
    '2': 0, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7,
    '8': 0, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14, 'Joker': 0
};

let gameDeck = [];
let players = [];
let gameStarted = false;
let gameResolving = false;
let tableRevealed = false;
let tableCards = [];
let lastPlayerIdx = -1;
let currentPlayerIdx = 0;
let lastMoveWasBlef = false;
let canCheckBlef = false;
let sksResponses = 0;
let wasBulaInRound = false;
let roundEndTimer = null;
let pendingBlefPickup = null;
let sksInProgress = false;

const DEBUG = true;
function dbg(...args) { if (DEBUG) console.log('[DBG]', ...args); }

function createDeck() {
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    const suits  = ['♠','♣','♥','♦'];
    let deck = [];
    for (let s of suits) for (let v of values) deck.push({ value: v, suit: s });
    deck.push({ value: 'Joker', suit: '🃏' });
    return deck.sort(() => Math.random() - 0.5);
}

function replenish(needed) {
    while (gameDeck.length < needed) gameDeck.push(...createDeck());
}

// ── WALIDACJA COMBO ───────────────────────────────────────────────────────────
// Zasady:
//   solo          = 1 karta punktowa (3–A)
//   8 + base      = ósemka + 1 karta punktowa; 8 odejmuje punkty celowi
//   2 + base      = dwójka + 1 karta punktowa; podwaja siłę
//   8 + 2 + base  = ósemka + dwójka + 1 karta punktowa; obie zasady
//   Joker + x + y = Joker + 2 karty (min 1 punktowa)
//   8 + Joker + x + y           = ósemka + Joker + 2 bazowe (4 karty)
//   8 + 2 + Joker + x + y       = ósemka + dwójka + Joker + 2 bazowe (5 kart)
function validateCombo(cards) {
    if (cards.length === 0) return 'Puste combo.';

    const hasJoker   = cards.some(c => c.value === 'Joker');
    const hasTwo     = cards.some(c => c.value === '2');
    const hasEight   = cards.some(c => c.value === '8');
    const jokerCount = cards.filter(c => c.value === 'Joker').length;

    if (jokerCount > 1) return 'Nie można zagrać dwóch Jokerów naraz.';

    // ── Nowe combo: 8 (+ opcjonalnie 2) + Joker + 2 karty bazowe ─────────────
    if (hasJoker && hasEight) {
        const base = cards.filter(c => !['2','8','Joker'].includes(c.value));
        if (base.length !== 2) return 'Combo z Jokerem i ósemką wymaga dokładnie 2 kart punktowych.';
        const expected = hasTwo ? 5 : 4;
        if (cards.length !== expected)
            return `Combo ${hasTwo ? '8+2+Joker' : '8+Joker'} wymaga dokładnie ${expected} kart.`;
        return null;
    }

    if (hasJoker) {
        const nonJokers = cards.filter(c => c.value !== 'Joker');
        if (nonJokers.length !== 2) return 'Joker wymaga dokładnie 2 dodatkowych kart.';
        const nonZero = nonJokers.filter(c => !['2','8','Joker'].includes(c.value));
        if (nonZero.length === 0) return 'Joker musi zawierać przynajmniej jedną kartę punktową.';
        return null;
    }

    if (hasTwo) {
        if (hasEight) {
            if (cards.length !== 3) return 'Kombinacja 8+2 wymaga dokładnie 3 kart (8, 2, karta punktowa).';
            const base = cards.filter(c => !['2','8','Joker'].includes(c.value));
            if (base.length !== 1) return 'Kombinacja 8+2 musi zawierać dokładnie 1 kartę punktową.';
            return null;
        }
        if (cards.length !== 2) return 'Dwójka wymaga dokładnie 1 karty bazowej (łącznie 2 karty).';
        const other = cards.find(c => c.value !== '2');
        if (!other || ['2','8','Joker'].includes(other.value)) return 'Dwójka musi być z kartą punktową (3–A).';
        return null;
    }

    if (hasEight) {
        if (cards.length === 1) return 'Ósemka musi być zagrana z kartą punktową (3–A).';
        if (cards.length > 2) return 'Z ósemką można zagrać max 1 dodatkową kartę (lub użyj Jokera).';
        if (cards.length === 2) {
            const other = cards.find(c => c.value !== '8');
            if (other && ['8','2'].includes(other.value)) return 'Ósemka + karta punktowa (3–A) tylko.';
        }
        return null;
    }

    if (cards.length > 1) return 'Zwykłą kartę można zagrać solo.';
    return null;
}

// ── SPRAWDŹ WYGRANYCH (0 kart w ręce) ────────────────────────────────────────
function checkWinners() {
    const winners = players.filter(p => p.hand.length === 0);
    if (winners.length > 0) {
        winners.forEach(w => {
            dbg(`WYGRANA: ${w.name} ma 0 kart`);
            io.emit('player-won', w.name);
        });
        return true;
    }
    return false;
}

io.on('connection', (socket) => {

    socket.on('join', (name) => {
        if (gameStarted) return;
        if (!name || !name.trim()) return;
        let uniqueName = name.trim();
        let counter = 2;
        while (players.some(p => p.name === uniqueName)) uniqueName = `${name.trim()} (${counter++})`;
        players.push({ id: socket.id, name: uniqueName, hand: [], hasPlayed: false, skippedRound: false, currentCombo: [], target: null, sksUsed: false, waitingForTarget: false });
        dbg(`JOIN: ${uniqueName}`);
        updatePlayerList();
    });

    socket.on('start-game', () => {
        if (players.length === 0) return;
        if (players[0]?.id !== socket.id) return; // tylko host może startować
        resetGame();
    });

    socket.on('new-game-request', () => {
        gameStarted = false;
        gameResolving = false;
        tableCards = [];
        sksResponses = 0;
        wasBulaInRound = false;
        currentPlayerIdx = 0;
        pendingBlefPickup = null;
        tableRevealed = false;
        sksInProgress = false;
        if (roundEndTimer) { clearTimeout(roundEndTimer); roundEndTimer = null; }
        players.forEach(p => { p.hand = []; p.hasPlayed = false; p.skippedRound = false; p.sksUsed = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
        io.emit('reset-client-ui');
        updatePlayerList();
    });

    function resetGame() {
        if (players.length === 0) return;
        gameStarted = true;
        gameResolving = false;
        gameDeck = createDeck();
        tableCards = [];
        lastPlayerIdx = -1;
        currentPlayerIdx = 0;
        canCheckBlef = false;
        wasBulaInRound = false;
        pendingBlefPickup = null;
        tableRevealed = false;
        sksInProgress = false;
        if (roundEndTimer) { clearTimeout(roundEndTimer); roundEndTimer = null; }
        players.forEach(p => {
            p.hand = gameDeck.splice(0, 5);
            p.hasPlayed = false; p.skippedRound = false; p.currentCombo = [];
            p.target = null; p.sksUsed = false; p.waitingForTarget = false;
            io.to(p.id).emit('init-hand', p.hand);
        });
        io.emit('game-begun');
        io.emit('clear-table');
        io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
        broadcastDebug();
    }

    // ── ZAGRANIE COMBO ────────────────────────────────────────────────────────

    socket.on('play-combo', ({ cards, target }) => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];
        if (!p) return;

        dbg(`PLAY-COMBO od ${p.name}: ${cards.map(c=>c.value+c.suit).join('+')}, target:${target}, cur:${currentPlayerIdx}, pIdx:${pIdx}`);

        if (!gameStarted || gameResolving || p.hasPlayed || pIdx !== currentPlayerIdx) {
            socket.emit('error-msg', `To nie Twoja tura! (current: ${players[currentPlayerIdx]?.name})`); return;
        }

        const comboErr = validateCombo(cards);
        if (comboErr) { socket.emit('error-msg', comboErr); return; }

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
        p.originalComboCount = cards.length;
        p.target = target || null;

        const maxHandVal  = p.hand.length > 0 ? Math.max(...p.hand.map(c => cardValues[c.value] || 0)) : 0;
        const comboMaxVal = Math.max(...cards.map(c => cardValues[c.value] || 0));
        lastMoveWasBlef = comboMaxVal < maxHandVal;
        lastPlayerIdx = pIdx;
        canCheckBlef = true;
        io.emit('blef-status', true);

        dbg(`${p.name} zagrywa. ręka po: ${p.hand.length} kart. blef=${lastMoveWasBlef}`);
        io.to(p.id).emit('init-hand', p.hand);

        const needsTarget = cards.some(c => c.value === '8') && !target;
        if (needsTarget) {
            p.waitingForTarget = true;
            dbg(`${p.name} czeka na cel dla ósemki`);
            return;
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
        io.emit('blef-status', false);
        gameResolving = true;
        io.emit('set-resolving');
        if (roundEndTimer) { clearTimeout(roundEndTimer); roundEndTimer = null; }

        const attacker = players[lastPlayerIdx];
        const checker  = players[checkerIdx];
        if (!attacker || !checker) return;

        dbg(`BLEF: ${checker.name} sprawdza ${attacker.name}. blef=${lastMoveWasBlef}, ręka attackera: ${attacker.hand.length}`);
        io.emit('reveal-blef-anim', { player: attacker.name, cards: attacker.currentCombo });

        replenish(20);
        const pool = gameDeck.splice(0, 10);

        if (lastMoveWasBlef) {
            // ── BLEF ZŁAPANY ─────────────────────────────────────────────────
            io.emit('update-status', `🚨 ${checker.name} złapał ${attacker.name} na blefie!`);
            const autoCount = Math.max(0, attacker.hand.length - 2);
            replenish(autoCount + 4);
            attacker.hand = gameDeck.splice(0, autoCount + 4);
            io.to(attacker.id).emit('init-hand', attacker.hand);
            pendingBlefPickup = { attackerIdx: lastPlayerIdx, checkerIdx, wasBlef: true };
            io.to(checker.id).emit('show-pick-menu', {
                pool, count: 2, targetIdx: lastPlayerIdx,
                title: `🎯 Złapałeś ${attacker.name}! Wybierz mu 2 NAJGORSZE karty:`
            });

        } else {
            // ── NIE BYŁO BLEFA ───────────────────────────────────────────────
            // Sprawdź: czy atakujący zagrał ostatnie karty (ręka = 0)?
            // Jeśli tak — wygrał, nie dobiera kart.
            if (attacker.hand.length === 0) {
                dbg(`${attacker.name} zagrał ostatnie karty i nie blefował — WYGRANA`);
                io.emit('update-status', `🏆 ${attacker.name} zagrał ostatnią kartę i nie kłamał!`);
                checker.hand.push(...gameDeck.splice(0, 4));
                io.to(checker.id).emit('init-hand', checker.hand);
                // Ogłoś wygraną
                io.emit('player-won', attacker.name);
                // Reset stołu
                setTimeout(() => {
                    gameResolving = false;
                    tableRevealed = false;
                    const allOnTable = tableCards.flatMap(m => m.cards);
                    gameDeck.push(...allOnTable.filter(c => c.value !== 'Joker'));
                    tableCards = [];
                    players.forEach(p => { p.hasPlayed = false; p.skippedRound = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
                    currentPlayerIdx = checkerIdx;
                    if (currentPlayerIdx >= players.length) currentPlayerIdx = 0;
                    io.emit('clear-table');
                    updatePlayerList();
                    players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
                    broadcastDebug();
                }, 2000);
                return;
            }

            // Normalny przypadek: atakujący ma karty, nie blefował
            io.emit('update-status', `✅ ${attacker.name} nie kłamał! ${checker.name} dostaje 4 karne.`);
            replenish(4);
            checker.hand.push(...gameDeck.splice(0, 4));
            io.to(checker.id).emit('init-hand', checker.hand);
            // Atakujący wymienia karty i wybiera sobie 2 z puli
            const autoCount = Math.max(0, attacker.hand.length - 2);
            replenish(autoCount);
            attacker.hand = gameDeck.splice(0, autoCount);
            io.to(attacker.id).emit('init-hand', attacker.hand);
            pendingBlefPickup = { attackerIdx: lastPlayerIdx, checkerIdx, wasBlef: false };
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

        // Sprawdź wygrane po rozdaniu kart
        if (checkWinners()) {
            setTimeout(() => {
                tableCards = [];
                tableRevealed = false;
                players.forEach(p => { p.hasPlayed = false; p.skippedRound = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
                io.emit('clear-table');
                updatePlayerList();
            }, 1500);
            return;
        }

        setTimeout(() => {
            if (players.length === 0) return;
            gameResolving = false;
            tableRevealed = false;
            const allOnTable = tableCards.flatMap(m => m.cards);
            gameDeck.push(...allOnTable.filter(c => c.value !== 'Joker'));
            tableCards = [];
            players.forEach(p => { p.hasPlayed = false; p.skippedRound = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
            currentPlayerIdx = wasBlef ? checkerIdx : attackerIdx;
            if (currentPlayerIdx >= players.length) currentPlayerIdx = 0;
            io.emit('clear-table');
            io.emit('update-status', `ZACZYNA: ${players[currentPlayerIdx].name}`);
            updatePlayerList();
            players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
            broadcastDebug();
        }, 1500);
    });

    // ── DOBIERZ KARTĘ ─────────────────────────────────────────────────────────

    socket.on('draw-card', () => {
        const pIdx = players.findIndex(pl => pl.id === socket.id);
        const p = players[pIdx];
        if (!p || !gameStarted || gameResolving || p.hasPlayed || pIdx !== currentPlayerIdx) return;

        // Dobierz 3 karty
        replenish(3);
        for (let i = 0; i < 3; i++) { const c = gameDeck.shift(); if (c) p.hand.push(c); }
        io.to(p.id).emit('init-hand', p.hand);

        // Pomiń kolejkę — brak wpisu na stole
        p.hasPlayed = true;
        p.skippedRound = true;
        p.currentCombo = [];
        p.originalComboCount = 0;
        p.target = null;
        lastMoveWasBlef = false;
        lastPlayerIdx = pIdx;
        canCheckBlef = false;
        io.emit('blef-status', false);
        currentPlayerIdx = (currentPlayerIdx + 1) % players.length;

        io.emit('update-status', `${p.name} pominął turę i dobrał 3 karty.`);

        // Aktualizacja widoku stołu (bez zmiany stanu zakrytości)
        players.forEach(pl => {
            const plIdx = players.indexOf(pl);
            const tableData = tableCards.map(m => ({
                playerName: m.playerName, playerIdx: m.playerIdx,
                cards: m.playerIdx === plIdx ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });

        updatePlayerList();
        checkRoundComplete();
        broadcastDebug();
    });

    // ── SKS ───────────────────────────────────────────────────────────────────

    socket.on('sks-decision', (decision) => {
        const pIdx = players.findIndex(p => p.id === socket.id);
        const p = players[pIdx];
        if (!p) { advanceSks(); return; }

        if (decision && !p.sksUsed) {
            p.sksUsed = true;
            replenish(1);
            const sksCard = gameDeck.shift();
            if (!sksCard) { advanceSks(); return; }

            dbg(`${p.name} SKS: ${sksCard.value}${sksCard.suit}`);
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
                io.to(p.id).emit('sks-card-placed');
                refreshTableFor(pIdx);
                io.to(p.id).emit('show-target-menu', players.filter(pl => pl.id !== p.id).map(pl => pl.name));
            } else {
                if (tableMove) tableMove.cards.push(sksCard);
                io.to(p.id).emit('sks-card-placed');
                refreshTableFor(pIdx);
                advanceSks();
            }
        } else {
            sksResponses++;
            checkAllSks();
        }
    });

    function showSksToEligible() {
        sksResponses = 0;
        sksInProgress = true;
        let anyEligible = false;
        players.forEach(p => {
            if (!p.sksUsed && !p.skippedRound) {
                io.to(p.id).emit('show-sks-modal');
                anyEligible = true;
            } else {
                sksResponses++;
            }
        });
        if (!anyEligible || sksResponses >= players.length) checkAllSks();
    }

    function refreshTableFor() {
        if (tableRevealed) { recalcAndShowTable(); return; }
        players.forEach(pl => {
            const plIdx = players.indexOf(pl);
            const tableData = tableCards.map(m => ({
                playerName: m.playerName, playerIdx: m.playerIdx,
                cards: m.playerIdx === plIdx ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });
    }

    function advanceSks() { sksResponses++; checkAllSks(); }

    function checkAllSks() {
        if (sksResponses >= players.length) {
            sksResponses = 0;
            sksInProgress = false;
            recalcAndShowTable();
            setTimeout(() => resolveRound(), 3000);
        }
    }

    function recalcAndShowTable() {
        if (tableCards.length === 0) return;
        tableRevealed = true;
        const res = calcResults();
        io.emit('reveal-detailed', res.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));
    }

    socket.on('target-selected', (targetName) => {
        const p = players.find(pl => pl.id === socket.id);
        if (!p) return;
        const pIdx = players.indexOf(p);

        const tableMove = tableCards.find(m => m.playerIdx === pIdx);
        if (tableMove && tableMove.sksEights) {
            const unassigned = tableMove.sksEights.find(e => e.target === null);
            if (unassigned) unassigned.target = targetName;
        }

        if (!p.hasPlayed) {
            p.target = targetName;
            p.waitingForTarget = false;
            finishTurn(p);
        } else {
            refreshTableFor(pIdx);
            advanceSks();
        }
    });

    function finishTurn(p) {
        p.hasPlayed = true;
        p.waitingForTarget = false;
        tableCards.push({
            playerIdx: players.indexOf(p), playerName: p.name,
            cards: [...p.currentCombo], target: p.target, sksEights: [],
            originalCount: p.originalComboCount || p.currentCombo.length
        });

        currentPlayerIdx = (currentPlayerIdx + 1) % players.length;
        dbg(`finishTurn: ${p.name}. Następny: ${players[currentPlayerIdx]?.name}. Stół: ${tableCards.length}/${players.length}`);

        players.forEach(pl => {
            const plIdx = players.indexOf(pl);
            const tableData = tableCards.map(m => ({
                playerName: m.playerName, playerIdx: m.playerIdx,
                cards: m.playerIdx === plIdx ? m.cards : null
            }));
            io.to(pl.id).emit('update-table-hidden', tableData);
        });

        checkRoundComplete();
        updatePlayerList();
        broadcastDebug();
    }

    function checkRoundComplete() {
        const active = players.filter(pl => !pl.skippedRound);
        if (active.length === 0) {
            gameResolving = true;
            io.emit('set-resolving');
            io.emit('update-status', 'Wszyscy pominęli turę — nowa runda.');
            setTimeout(() => startNextRound(), 1500);
            return;
        }
        if (active.every(pl => pl.hasPlayed)) {
            gameResolving = true;
            io.emit('set-resolving');
            io.emit('update-status', '🔍 Wszyscy zagrali! Możesz sprawdzić blefa przez 5 sekund...');
            roundEndTimer = setTimeout(() => {
                roundEndTimer = null;
                canCheckBlef = false;
                io.emit('blef-status', false);
                io.emit('update-status', '🔍 Odkrywanie kart...');
                recalcAndShowTable();
                setTimeout(() => {
                    io.emit('update-status', 'SKS — użyj swojej szansy!');
                    showSksToEligible();
                }, 2000);
            }, 5000);
        } else {
            io.emit('update-status', `Tura: ${players[currentPlayerIdx].name}`);
        }
    }

    // ── PUNKTY ────────────────────────────────────────────────────────────────

    function calculatePower(cards, originalCount) {
        const oc = (originalCount !== undefined) ? originalCount : cards.length;
        const origCards = cards.slice(0, oc);
        const extraCards = cards.slice(oc);

        const origBase = origCards.filter(c => !['8','2','Joker'].includes(c.value));
        let pwr = origBase.reduce((s, c) => s + (cardValues[c.value] || 0), 0);
        if (origCards.some(c => c.value === '2')) pwr *= 2;

        // Karty dobrane w bule/SKS NIE podwajają się
        const extraBase = extraCards.filter(c => !['8','2','Joker'].includes(c.value));
        pwr += extraBase.reduce((s, c) => s + (cardValues[c.value] || 0), 0);

        return pwr;
    }

    function calcResults() {
        let res = tableCards.map(m => ({
            playerIdx: m.playerIdx, playerName: m.playerName,
            power: calculatePower(m.cards, m.originalCount), m: m
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
        dbg('resolveRound:', res.map(r => `${r.playerName}:${r.power}`).join(', '));

        // Edge case: nikt nie zagrał lub tylko 1 gracz (reszta pominęła)
        if (res.length <= 1) {
            if (res.length === 1) io.emit('update-status', `✅ ${res[0].playerName} jedyny grający — bez kary!`);
            const all = tableCards.flatMap(m => m.cards);
            gameDeck.push(...all.filter(c => c.value !== 'Joker'));
            wasBulaInRound = false;
            players.forEach(p => { p.hasPlayed = false; p.skippedRound = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
            tableCards = [];
            updatePlayerList();
            if (checkWinners()) { broadcastDebug(); return; }
            broadcastDebug();
            setTimeout(() => startNextRound(), 2000);
            return;
        }

        io.emit('reveal-detailed', res.map(r => ({ name: r.playerName, cards: r.m.cards, finalPower: r.power })));

        const maxP = Math.max(...res.map(r => r.power));
        const minP = Math.min(...res.map(r => r.power));
        const top   = res.filter(r => r.power === maxP);
        const loser = res.find(r => r.power === minP);

        if (top.length > 1 && !wasBulaInRound) {
            wasBulaInRound = true;
            const names = top.map(t => t.playerName).join(' i ');
            io.emit('update-status', `⚔️ BUŁA między: ${names}! Dogrywka...`);
            top.forEach(t => {
                const tp = players.find(p => p.name === t.playerName);
                replenish(2);
                const ex = gameDeck.splice(0, 2);
                ex.forEach(c => {
                    if (c.value === 'Joker') {
                        if (tp) { tp.hand.push(c); io.to(tp.id).emit('init-hand', tp.hand); }
                    } else {
                        t.m.cards.push(c);
                    }
                });
            });
            setTimeout(() => resolveRound(), 8000);
        } else {
            const all   = tableCards.flatMap(m => m.cards);
            const valid = all.filter(c => c.value !== 'Joker');

            // Karty ze stołu wracają do talii, przegrany losuje 4 nowe
            gameDeck.push(...valid);
            const loserPlayer = players.find(p => p.name === loser.playerName);
            if (loserPlayer) {
                replenish(4);
                loserPlayer.hand.push(...gameDeck.splice(0, 4));
                io.to(loserPlayer.id).emit('init-hand', loserPlayer.hand);
            }

            if (wasBulaInRound) {
                io.emit('update-status', `💀 Po dogrywce przegrywa ${loser.playerName} (${loser.power} pkt) i bierze 4 karne z talii!`);
            } else {
                io.emit('update-status', `🃏 Rundę przegrywa ${loser.playerName} (${loser.power} pkt) i bierze 4 karty z talii!`);
            }
            wasBulaInRound = false;
            players.forEach(p => { p.hasPlayed = false; p.skippedRound = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
            tableCards = [];
            updatePlayerList();

            // Sprawdź wygrane po rozdaniu kart przegranemu
            if (checkWinners()) {
                broadcastDebug();
                return;
            }

            broadcastDebug();
            setTimeout(() => startNextRound(), 2000);
        }
    }

    function startNextRound() {
        if (players.length === 0) return;
        gameResolving = false;
        tableRevealed = false;
        players.forEach(p => { p.skippedRound = false; });
        currentPlayerIdx = Math.floor(Math.random() * players.length);
        io.emit('clear-table');
        io.emit('round-preparing');
        io.emit('update-status', `NOWA RUNDA - Zaczyna: ${players[currentPlayerIdx].name}`);
        updatePlayerList();
        players.forEach(p => io.to(p.id).emit('init-hand', p.hand));
        broadcastDebug();
    }

    function updatePlayerList() {
        io.emit('update-player-list', players.map((p, idx) => ({
            name: p.name, count: p.hand.length, isCurrent: idx === currentPlayerIdx,
            sksUsed: p.sksUsed, waitingForTarget: p.waitingForTarget, isHost: idx === 0
        })));
    }

    function broadcastDebug() {
        if (!DEBUG) return;
        io.emit('debug-state', {
            gameStarted, currentPlayerIdx,
            currentPlayer: players[currentPlayerIdx]?.name || '?',
            tableCards: tableCards.map(m => ({ player: m.playerName, cards: m.cards.map(c=>`${c.value}${c.suit}`).join('+'), target: m.target })),
            players: players.map(p => ({ name: p.name, handCount: p.hand.length, hasPlayed: p.hasPlayed, sksUsed: p.sksUsed, waitingForTarget: p.waitingForTarget })),
            canCheckBlef, wasBulaInRound, sksResponses
        });
    }

    socket.on('disconnect', () => {
        const idx = players.findIndex(p => p.id === socket.id);
        if (idx === -1) { updatePlayerList(); broadcastDebug(); return; }

        dbg(`DISCONNECT: ${players[idx].name}`);
        const disconnectedName = players[idx].name;

        // ── Blef pick — gracz odłączył się w trakcie wyboru kart ─────────────
        if (pendingBlefPickup) {
            const { attackerIdx, checkerIdx } = pendingBlefPickup;
            if (idx === attackerIdx || idx === checkerIdx) {
                pendingBlefPickup = null;
                players.splice(idx, 1);
                if (players.length === 0) {
                    gameStarted = false; gameResolving = false; currentPlayerIdx = 0;
                } else {
                    if (idx < currentPlayerIdx) currentPlayerIdx--;
                    if (currentPlayerIdx >= players.length) currentPlayerIdx = 0;
                    gameResolving = false; tableRevealed = false;
                    tableCards = [];
                    players.forEach(p => { p.hasPlayed = false; p.skippedRound = false; p.currentCombo = []; p.target = null; p.waitingForTarget = false; });
                    io.emit('clear-table');
                    io.emit('update-status', 'Gracz opuścił grę — reset rundy.');
                    setTimeout(() => startNextRound(), 1500);
                }
                updatePlayerList(); broadcastDebug(); return;
            }
        }

        players.splice(idx, 1);

        if (players.length === 0) {
            gameStarted = false; gameResolving = false; currentPlayerIdx = 0;
            if (roundEndTimer) { clearTimeout(roundEndTimer); roundEndTimer = null; }
            sksInProgress = false; pendingBlefPickup = null; tableCards = [];
            updatePlayerList(); broadcastDebug(); return;
        }

        if (idx < currentPlayerIdx) currentPlayerIdx--;
        if (currentPlayerIdx >= players.length) currentPlayerIdx = 0;

        // Usuń wpis ze stołu i napraw indeksy
        tableCards = tableCards.filter(m => m.playerName !== disconnectedName);
        tableCards.forEach(m => { if (m.playerIdx > idx) m.playerIdx--; });

        // ── Faza roundEndTimer ────────────────────────────────────────────────
        if (roundEndTimer) {
            clearTimeout(roundEndTimer); roundEndTimer = null;
            canCheckBlef = false;
            io.emit('blef-status', false);
            const active = players.filter(pl => !pl.skippedRound);
            if (active.length === 0) {
                setTimeout(() => startNextRound(), 1500);
            } else if (active.every(pl => pl.hasPlayed)) {
                io.emit('update-status', '🔍 Odkrywanie kart...');
                recalcAndShowTable();
                setTimeout(() => { io.emit('update-status', 'SKS — użyj swojej szansy!'); showSksToEligible(); }, 2000);
            } else {
                gameResolving = false;
                io.emit('update-status', `Tura: ${players[currentPlayerIdx]?.name}`);
            }
        // ── Faza SKS ─────────────────────────────────────────────────────────
        } else if (sksInProgress) {
            checkAllSks();
        // ── Normalna tura ─────────────────────────────────────────────────────
        } else if (!gameResolving && gameStarted) {
            checkRoundComplete();
        }

        updatePlayerList();
        broadcastDebug();
    });
});

http.listen(3000, '0.0.0.0');
console.log('Serwer działa na porcie 3000');