// ─────────────────────────────────────────────
//  CONSTANTS & HELPERS
// ─────────────────────────────────────────────
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeRoomCode() {
  return Array.from({ length: 5 }, () =>
    ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
  ).join('');
}

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RED_SUITS = new Set(['♥', '♦']);

function makeDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ rank, suit });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function dealCards(deck, playerCount) {
  const hands = Array.from({ length: playerCount }, () => []);
  deck.forEach((card, i) => hands[i % playerCount].push(card));
  return hands;
}

function nextRank(rank) {
  return RANKS[(RANKS.indexOf(rank) + 1) % RANKS.length];
}

function prevRank(rank) {
  return RANKS[(RANKS.indexOf(rank) - 1 + RANKS.length) % RANKS.length];
}

function getValidRanks(rank) {
  if (rank === null) return [...RANKS]; // free choice after cheat
  return [prevRank(rank), rank, nextRank(rank)];
}

function cardLabel(card) {
  return `${card.rank}${card.suit}`;
}

function sortHand(hand) {
  return [...hand].sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
}

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
const state = {
  isHost: false,
  myId: null,        // PeerJS peer ID
  myName: '',
  roomCode: '',      // host's peer ID used as room code

  // Host-only: map of peerId -> { name, conn }
  connections: {},

  // Ordered player list: [{ id, name }]
  players: [],

  // Game state (host is authoritative)
  started: false,
  hands: {},         // peerId -> [card, ...]
  handSizes: {},     // peerId -> number (opponents' hand sizes)
  pile: [],          // all cards played so far (face-down)
  pileHistory: [],   // [{ peerId, claimedRank, cards[] }] per turn played
  currentTurnIndex: 0,
  currentRank: '7',
  lastPlayerId: null, // who played last (cheat is allowed for everyone else)

  selectedCards: [],
  chosenRank: null, // rank the player picks to claim (same, +1, or -1)
  pendingWinner: null, // peerId of player who emptied hand, awaiting cheat window
  winCountdown: 0, // seconds remaining in cheat window
};

let peer = null;
let hostConn = null; // guest-only connection to host

// ─────────────────────────────────────────────
//  UI HELPERS
// ─────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

let toastTimer = null;
function showToast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

function log(msg, highlight = false) {
  const el = document.getElementById('game-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (highlight ? ' highlight' : '');
  entry.textContent = msg;
  el.appendChild(entry);
  el.parentElement.scrollTop = el.parentElement.scrollHeight;
}

// ─────────────────────────────────────────────
//  RENDER HAND
// ─────────────────────────────────────────────
function makeCardEl(card, selected, clickable) {
  const isRed = RED_SUITS.has(card.suit);
  const el = document.createElement('div');
  el.className = 'playing-card' +
    (isRed ? ' red' : '') +
    (selected ? ' selected' : '') +
    (clickable ? '' : ' no-action');
  el.innerHTML =
    `<div class="card-corner tl"><span class="cr">${card.rank}</span><span class="cs">${card.suit}</span></div>` +
    `<div class="card-center">${card.suit}</div>` +
    `<div class="card-corner br"><span class="cr">${card.rank}</span><span class="cs">${card.suit}</span></div>`;
  return el;
}

function renderHand() {
  const hand = sortHand(state.hands[state.myId] || []);
  const container = document.getElementById('hand-cards');
  container.innerHTML = '';
  const myTurn = isMyTurn();

  hand.forEach(card => {
    const isSelected = state.selectedCards.some(
      c => c.rank === card.rank && c.suit === card.suit
    );
    const el = makeCardEl(card, isSelected, myTurn);
    el.addEventListener('click', () => toggleCardSelection(card));
    container.appendChild(el);
  });

  document.getElementById('hand-count').textContent = hand.length;
  updatePlayButton();
}

function renderPile() {
  const visual = document.getElementById('pile-visual');
  visual.innerHTML = '';
  const count = state.pile.length;
  document.getElementById('pile-count').textContent = count;

  const displayCount = Math.min(count, 6);
  for (let i = 0; i < displayCount; i++) {
    const c = document.createElement('div');
    c.className = 'pile-card';
    const frac = displayCount <= 1 ? 0 : i / (displayCount - 1);
    const angle = (frac - 0.5) * 18;
    const xOff  = (frac - 0.5) * 10;
    const yOff  = i * 1.5;
    c.style.transform = `translate(${xOff}px, ${yOff}px) rotate(${angle}deg)`;
    c.style.zIndex = i;
    visual.appendChild(c);
  }
}

function renderOpponents() {
  const area = document.getElementById('opponents-area');
  area.innerHTML = '';
  const currentId = state.players[state.currentTurnIndex]?.id;

  state.players
    .filter(p => p.id !== state.myId)
    .forEach(p => {
      const badge = document.createElement('div');
      badge.className = 'opp-badge' + (p.id === currentId ? ' active-turn' : '');

      const count = (state.isHost
        ? (state.hands[p.id]?.length ?? 0)
        : (state.handSizes[p.id] ?? '?'));

      badge.innerHTML =
        `<div class="opp-name">${p.name}</div>` +
        `<div class="opp-cards-wrap">` +
          `<span class="opp-card-icon"></span>` +
          `<span class="opp-count">${count}</span>` +
        `</div>`;
      area.appendChild(badge);
    });
}

function toggleCardSelection(card) {
  if (!isMyTurn()) return;
  const idx = state.selectedCards.findIndex(
    c => c.rank === card.rank && c.suit === card.suit
  );
  if (idx >= 0) {
    state.selectedCards.splice(idx, 1);
  } else {
    state.selectedCards.push(card);
  }
  renderHand();
}

function updatePlayButton() {
  const myTurn = isMyTurn();
  const hasSelected = state.selectedCards.length > 0;
  const first = isFirstPlay();
  const hasRank = first || state.chosenRank !== null;
  document.getElementById('btn-play').disabled = !(myTurn && hasSelected && hasRank);
  document.getElementById('selected-info').textContent =
    hasSelected ? `${state.selectedCards.length} card(s) selected` : 'Select cards to play';

  // Show/hide rank picker (hidden on first play — forced to 7)
  const picker = document.getElementById('rank-picker');
  if (myTurn && hasSelected && !first) {
    const valid = getValidRanks(state.currentRank);
    const lowEl = document.getElementById('rank-low');
    const sameEl = document.getElementById('rank-same');
    const highEl = document.getElementById('rank-high');

    if (state.currentRank === null) {
      // Free choice: show all 13 ranks as buttons
      picker.innerHTML = '<span class="rank-picker-label">Claim as:</span>';
      RANKS.forEach(r => {
        const btn = document.createElement('button');
        btn.className = 'rank-btn' + (state.chosenRank === r ? ' active' : '');
        btn.textContent = r;
        btn.addEventListener('click', () => { state.chosenRank = r; renderHand(); });
        picker.appendChild(btn);
      });
    } else {
      // Normal: 3 buttons (low, same, high)
      picker.innerHTML =
        '<span class="rank-picker-label">Claim as:</span>' +
        '<button class="rank-btn" id="rank-low"></button>' +
        '<button class="rank-btn" id="rank-same"></button>' +
        '<button class="rank-btn" id="rank-high"></button>';
      document.getElementById('rank-low').textContent = valid[0];
      document.getElementById('rank-same').textContent = valid[1];
      document.getElementById('rank-high').textContent = valid[2];
      [document.getElementById('rank-low'), document.getElementById('rank-same'), document.getElementById('rank-high')].forEach(btn => {
        btn.classList.toggle('active', state.chosenRank === btn.textContent);
        btn.addEventListener('click', () => { state.chosenRank = btn.textContent; renderHand(); });
      });
    }
    picker.style.display = '';
  } else {
    picker.style.display = 'none';
  }
}

function isMyTurn() {
  return state.players[state.currentTurnIndex]?.id === state.myId;
}

// ─────────────────────────────────────────────
//  RENDER GAME HEADER
// ─────────────────────────────────────────────
function renderHeader() {
  const currentPlayer = state.players[state.currentTurnIndex];
  document.getElementById('current-player-label').textContent =
    currentPlayer?.id === state.myId ? 'Your' : (currentPlayer?.name || '—');
  if (isFirstPlay()) {
    document.getElementById('current-rank-label').textContent = '7 (first play)';
  } else if (state.currentRank === null) {
    document.getElementById('current-rank-label').textContent = 'any rank';
  } else {
    const valid = getValidRanks(state.currentRank);
    document.getElementById('current-rank-label').textContent = `${valid[0]} / ${valid[1]} / ${valid[2]}`;
  }

  // Cheat button: enabled when pile has cards and you weren't the last to play
  const pileHasCards = state.pile.length > 0;
  document.getElementById('btn-cheat').disabled = !pileHasCards || state.lastPlayerId === state.myId;

  renderPile();
  renderOpponents();
}

// ─────────────────────────────────────────────
//  WAITING ROOM UI
// ─────────────────────────────────────────────
function renderPlayerList() {
  const list = document.getElementById('player-list');
  list.innerHTML = '';
  state.players.forEach(p => {
    const li = document.createElement('li');
    li.textContent = p.name;
    if (p.id === state.roomCode) li.classList.add('host');
    list.appendChild(li);
  });
  document.getElementById('player-count').textContent = state.players.length;
  document.getElementById('btn-start').disabled = state.players.length < 2;
}

// ─────────────────────────────────────────────
//  NETWORKING — SEND HELPERS
// ─────────────────────────────────────────────
function broadcast(msg) {
  // Host sends to all guests
  Object.values(state.connections).forEach(({ conn }) => conn.send(msg));
}

function sendToHost(msg) {
  hostConn?.send(msg);
}

function sendToPlayer(peerId, msg) {
  state.connections[peerId]?.conn.send(msg);
}

// ─────────────────────────────────────────────
//  GAME LOGIC (host only)
// ─────────────────────────────────────────────
function hostStartGame() {
  const deck = shuffle(makeDeck());
  const hands = dealCards(deck, state.players.length);
  state.hands = {};
  state.players.forEach((p, i) => { state.hands[p.id] = hands[i]; });
  state.pile = [];
  state.pileHistory = [];
  state.currentRank = '7';
  state.lastPlayerId = null;
  state.started = true;

  // Player who holds 7♦ goes first
  const starterIdx = state.players.findIndex(p =>
    state.hands[p.id].some(c => c.rank === '7' && c.suit === '♦')
  );
  state.currentTurnIndex = starterIdx >= 0 ? starterIdx : 0;

  const starterName = state.players[state.currentTurnIndex]?.name || 'Someone';

  // Send each player their own hand + shared state (guests first, host last)
  let hostMsg = null;
  state.players.forEach(p => {
    const msg = {
      type: 'game-start',
      players: state.players,
      hand: state.hands[p.id],
      currentTurnIndex: state.currentTurnIndex,
      currentRank: state.currentRank,
      pileSize: state.pile.length,
      starterName,
    };
    if (p.id === state.myId) {
      hostMsg = msg;
    } else {
      sendToPlayer(p.id, msg);
    }
  });
  if (hostMsg) applyGameStart(hostMsg);
}

function hostHandlePlay({ peerId, cards, claimedRank }) {
  // Validate it's their turn
  if (state.players[state.currentTurnIndex].id !== peerId) return;
  // First play must be 7; after cheat (null) any rank is valid; otherwise +/-1 or same
  const validRanks = getValidRanks(state.currentRank);
  if (!validRanks.includes(claimedRank)) return;

  // Remove cards from player's hand
  cards.forEach(played => {
    const hand = state.hands[peerId];
    const idx = hand.findIndex(c => c.rank === played.rank && c.suit === played.suit);
    if (idx >= 0) hand.splice(idx, 1);
  });

  // Add to pile
  state.pile.push(...cards);
  state.pileHistory.push({ peerId, claimedRank, cards });
  state.lastPlayerId = peerId;

  // Advance turn; current rank becomes whatever was claimed
  state.currentTurnIndex = (state.currentTurnIndex + 1) % state.players.length;
  state.currentRank = claimedRank;

  const playerName = state.players.find(p => p.id === peerId)?.name || peerId;
  const logMsg = `${playerName} played ${cards.length} card(s) as ${claimedRank}`;

  // Check if someone emptied their hand
  const potentialWinner = state.players.find(p => state.hands[p.id].length === 0);

  const updateMsg = {
    type: 'game-update',
    currentTurnIndex: state.currentTurnIndex,
    currentRank: state.currentRank,
    pileSize: state.pile.length,
    logMsg,
    lastPlayerId: state.lastPlayerId,
    handSizes: Object.fromEntries(state.players.map(p => [p.id, state.hands[p.id].length])),
    pendingWinner: potentialWinner ? potentialWinner.id : null,
  };

  // Send each player their updated hand (guests first, host last)
  let hostUpdateMsg = null;
  state.players.forEach(p => {
    const msg = { ...updateMsg, hand: state.hands[p.id] };
    if (p.id === state.myId) hostUpdateMsg = msg;
    else sendToPlayer(p.id, msg);
  });
  if (hostUpdateMsg) applyGameUpdate(hostUpdateMsg);

  // Start 10-second cheat window if someone emptied their hand
  if (potentialWinner) {
    hostStartWinCountdown(potentialWinner.id);
  }
}

let winTimer = null;
let winTickTimer = null;

function hostStartWinCountdown(winnerPeerId) {
  state.pendingWinner = winnerPeerId;
  let remaining = 10;

  const tick = () => {
    // Broadcast countdown to all players
    const msg = { type: 'win-countdown', seconds: remaining, winnerId: winnerPeerId };
    Object.values(state.connections).forEach(({ conn }) => conn.send(msg));
    applyWinCountdown(msg);
  };

  tick(); // send immediately (10)
  winTickTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(winTickTimer);
      winTickTimer = null;
      hostConfirmWin(winnerPeerId);
    } else {
      tick();
    }
  }, 1000);
}

function hostCancelWinCountdown() {
  state.pendingWinner = null;
  clearInterval(winTickTimer);
  winTickTimer = null;
  const msg = { type: 'win-cancelled' };
  Object.values(state.connections).forEach(({ conn }) => conn.send(msg));
  applyWinCancelled();
}

function hostConfirmWin(winnerPeerId) {
  state.pendingWinner = null;
  const msg = { type: 'game-over', winnerId: winnerPeerId };
  Object.values(state.connections).forEach(({ conn }) => conn.send(msg));
  endGame(winnerPeerId);
}

function applyWinCountdown(msg) {
  state.pendingWinner = msg.winnerId;
  state.winCountdown = msg.seconds;
  const name = state.players.find(p => p.id === msg.winnerId)?.name || 'Someone';
  document.getElementById('btn-cheat').textContent = `Call Cheat! (${msg.seconds}s)`;
}

function applyWinCancelled() {
  state.pendingWinner = null;
  state.winCountdown = 0;
  document.getElementById('btn-cheat').textContent = 'Call Cheat!';
}

function hostHandleCheat({ callerPeerId }) {
  if (state.pileHistory.length === 0) return;

  // Cancel pending win countdown if active
  if (state.pendingWinner) {
    hostCancelWinCountdown();
  }

  const lastPlay = state.pileHistory[state.pileHistory.length - 1];
  const wasCheating = lastPlay.cards.some(c => c.rank !== lastPlay.claimedRank);

  const callerName = state.players.find(p => p.id === callerPeerId)?.name || callerPeerId;
  const accusedName = state.players.find(p => p.id === lastPlay.peerId)?.name || lastPlay.peerId;

  let loserPeerId;
  let resultMsg;

  if (wasCheating) {
    loserPeerId = lastPlay.peerId;
    resultMsg = `${accusedName} WAS cheating! ${accusedName} takes the pile.`;
  } else {
    loserPeerId = callerPeerId;
    resultMsg = `${accusedName} was honest! ${callerName} takes the pile.`;
  }

  // Reveal what was actually played
  const revealed = lastPlay.cards.map(cardLabel).join(', ');
  const revealMsg = `Cards revealed: ${revealed} (claimed: ${lastPlay.claimedRank})`;

  // Give pile to loser
  state.hands[loserPeerId].push(...state.pile);
  state.pile = [];
  state.pileHistory = [];
  state.lastPlayerId = null;

  // If caught cheating, caller plays next; if wrong call, the caller (loser) plays next
  const nextPlayerId = wasCheating ? callerPeerId : loserPeerId;
  state.currentTurnIndex = state.players.findIndex(p => p.id === nextPlayerId);

  // After a cheat call, next player can claim any rank
  state.currentRank = null;

  // Send each player the cheat result (guests first, host last)
  let hostCheatMsg = null;
  state.players.forEach(p => {
    const msg = {
      type: 'cheat-result',
      resultMsg,
      revealMsg,
      currentTurnIndex: state.currentTurnIndex,
      currentRank: state.currentRank,
      pileSize: state.pile.length,
      hand: state.hands[p.id],
      lastPlayerId: state.lastPlayerId,
      handSizes: Object.fromEntries(state.players.map(pl => [pl.id, state.hands[pl.id].length])),
    };
    if (p.id === state.myId) hostCheatMsg = msg;
    else sendToPlayer(p.id, msg);
  });
  if (hostCheatMsg) applyCheatResult(hostCheatMsg);
}

// ─────────────────────────────────────────────
//  CLIENT-SIDE STATE UPDATES
// ─────────────────────────────────────────────
function applyGameStart(msg) {
  state.players = msg.players;
  state.hands[state.myId] = msg.hand;
  state.handSizes = {};
  state.lastPlayerId = null;
  state.currentTurnIndex = msg.currentTurnIndex;
  state.currentRank = msg.currentRank;
  state.pile = [];
  state.pileHistory = [];
  state.selectedCards = [];
  state.chosenRank = null;
  state.pendingWinner = null;
  state.winCountdown = 0;
  state.started = true;

  document.getElementById('btn-cheat').textContent = 'Call Cheat!';
  document.getElementById('game-log').innerHTML = '';
  const starterLabel = msg.starterName
    ? `${msg.starterName} has the 7♦ and goes first`
    : 'Game started';
  log(`${starterLabel}. First play must be 7s.`);
  showScreen('screen-game');
  renderHand();
  renderHeader();
}

function applyGameUpdate(msg) {
  state.hands[state.myId] = msg.hand;
  if (msg.handSizes) state.handSizes = msg.handSizes;
  if ('lastPlayerId' in msg) state.lastPlayerId = msg.lastPlayerId;
  state.currentTurnIndex = msg.currentTurnIndex;
  state.currentRank = msg.currentRank;
  if (!state.isHost) state.pile = new Array(msg.pileSize); // guests only track size
  state.selectedCards = [];
  state.chosenRank = null;

  log(msg.logMsg);
  if (msg.pendingWinner) {
    const name = state.players.find(p => p.id === msg.pendingWinner)?.name || 'Someone';
    log(`${name} played their last card! 10s to call cheat...`, true);
  }
  renderHand();
  renderHeader();
}

function applyCheatResult(msg) {
  state.hands[state.myId] = msg.hand;
  if (msg.handSizes) state.handSizes = msg.handSizes;
  if ('lastPlayerId' in msg) state.lastPlayerId = msg.lastPlayerId;
  state.currentTurnIndex = msg.currentTurnIndex;
  state.currentRank = msg.currentRank;
  state.pile = new Array(msg.pileSize);
  state.selectedCards = [];
  state.chosenRank = null;

  state.pendingWinner = null;
  state.winCountdown = 0;
  document.getElementById('btn-cheat').textContent = 'Call Cheat!';

  log(msg.revealMsg);
  log(msg.resultMsg, true);
  showToast(msg.resultMsg, 4000);
  renderHand();
  renderHeader();
}

function endGame(winnerPeerId) {
  const winner = state.players.find(p => p.id === winnerPeerId);
  const isMe = winnerPeerId === state.myId;
  document.getElementById('end-title').textContent = isMe ? '🎉 You Win!' : 'Game Over';
  document.getElementById('end-message').textContent =
    isMe ? 'You got rid of all your cards!' : `${winner?.name || 'Someone'} won the game!`;
  setTimeout(() => showScreen('screen-end'), 1500);
}

// ─────────────────────────────────────────────
//  PEER SETUP
// ─────────────────────────────────────────────
function createPeer(id) {
  return new Promise((resolve, reject) => {
    const p = new Peer(id);
    p.on('open', peerId => resolve({ p, peerId }));
    p.on('error', err => {
      if (err.type === 'unavailable-id') {
        // ID taken — retry with a new code
        p.destroy();
        createPeer('cheat-' + makeRoomCode()).then(resolve).catch(reject);
      } else {
        reject(err);
      }
    });
  });
}

function setupHostHandlers() {
  peer.on('connection', conn => {
    conn.on('open', () => {
      // Temporarily hold connection until we get their name
    });

    conn.on('data', msg => {
      if (msg.type === 'join') {
        const { name, peerId } = msg;
        state.connections[peerId] = { conn, name };
        state.players.push({ id: peerId, name });

        // Ack back to new player with current player list
        conn.send({ type: 'join-ack', players: state.players });

        // Notify existing players
        broadcast({ type: 'player-joined', players: state.players });

        // Update host's own waiting room
        renderPlayerList();

      } else if (msg.type === 'play') {
        hostHandlePlay(msg);

      } else if (msg.type === 'call-cheat') {
        hostHandleCheat({ callerPeerId: msg.peerId });
      }
    });

    conn.on('close', () => {
      const entry = Object.entries(state.connections).find(([, v]) => v.conn === conn);
      if (entry) {
        const [peerId] = entry;
        delete state.connections[peerId];
        state.players = state.players.filter(p => p.id !== peerId);
        if (!state.started) {
          broadcast({ type: 'player-joined', players: state.players });
          renderPlayerList();
        }
      }
    });
  });
}

function setupGuestHandlers(conn) {
  conn.on('data', msg => {
    if (msg.type === 'join-ack' || msg.type === 'player-joined') {
      state.players = msg.players;
      renderPlayerList();

    } else if (msg.type === 'game-start') {
      applyGameStart(msg);

    } else if (msg.type === 'game-update') {
      applyGameUpdate(msg);

    } else if (msg.type === 'cheat-result') {
      applyCheatResult(msg);

    } else if (msg.type === 'win-countdown') {
      applyWinCountdown(msg);

    } else if (msg.type === 'win-cancelled') {
      applyWinCancelled();

    } else if (msg.type === 'game-over') {
      endGame(msg.winnerId);
    }
  });

  conn.on('close', () => {
    showToast('Connection to host lost.', 5000);
  });
}

// ─────────────────────────────────────────────
//  ACTIONS
// ─────────────────────────────────────────────
function isFirstPlay() {
  return state.currentRank === '7' && state.pile.length === 0;
}

function playCards() {
  const first = isFirstPlay();
  const rank = first ? '7' : state.chosenRank;
  if (!isMyTurn() || state.selectedCards.length === 0 || !rank) return;

  const msg = {
    type: 'play',
    peerId: state.myId,
    cards: state.selectedCards,
    claimedRank: rank,
  };

  if (state.isHost) {
    hostHandlePlay(msg);
  } else {
    sendToHost(msg);
  }
}

function callCheat() {
  if (state.pile.length === 0) return;

  const msg = { type: 'call-cheat', peerId: state.myId };

  if (state.isHost) {
    hostHandleCheat({ callerPeerId: state.myId });
  } else {
    sendToHost(msg);
  }
}

// ─────────────────────────────────────────────
//  BUTTON EVENTS
// ─────────────────────────────────────────────
document.getElementById('btn-create').addEventListener('click', async () => {
  const name = document.getElementById('input-name').value.trim();
  if (!name) { showToast('Enter your name first'); return; }

  state.myName = name;
  state.isHost = true;

  try {
    const shortCode = makeRoomCode();
    const { p, peerId } = await createPeer('cheat-' + shortCode);
    peer = p;
    state.myId = peerId;
    state.roomCode = peerId;
    // Display only the short code portion (after 'cheat-')
    const displayCode = peerId.startsWith('cheat-') ? peerId.slice(6) : peerId;
    state.players = [{ id: peerId, name }];

    setupHostHandlers();

    document.getElementById('room-code-display').textContent = displayCode;
    renderPlayerList();
    showScreen('screen-waiting');
  } catch (e) {
    showToast('Failed to create room: ' + e.message);
  }
});

document.getElementById('btn-join').addEventListener('click', async () => {
  const name = document.getElementById('input-name').value.trim();
  const roomCode = document.getElementById('input-room').value.trim();
  if (!name) { showToast('Enter your name first'); return; }
  if (!roomCode) { showToast('Enter a room code'); return; }

  // Accept full peer IDs (UUID) or short 5-char codes (prepend 'cheat-')
  const fullRoomId = roomCode.includes('-') ? roomCode : 'cheat-' + roomCode.toUpperCase();
  state.myName = name;
  state.isHost = false;
  state.roomCode = fullRoomId;

  try {
    const { p, peerId } = await createPeer('guest-' + makeRoomCode());
    peer = p;
    state.myId = peerId;

    // Catch peer-level errors (e.g. peer-unavailable) that fire after open
    peer.on('error', err => {
      if (err.type === 'peer-unavailable') {
        showToast('Room not found. Check the code and try again.');
      } else {
        showToast('Error: ' + (err.message || err.type));
      }
    });

    const conn = peer.connect(fullRoomId, { reliable: true });
    hostConn = conn;

    // Timeout if connection never opens
    const connTimeout = setTimeout(() => {
      if (!state.started && !state.players.length > 1) {
        showToast('Could not connect. Check the room code.');
      }
    }, 8000);

    conn.on('open', () => {
      clearTimeout(connTimeout);
      conn.send({ type: 'join', name, peerId });
      setupGuestHandlers(conn);

      document.getElementById('room-code-display').textContent = roomCode;
      renderPlayerList();
      showScreen('screen-waiting');
    });

    conn.on('error', e => showToast('Connection error: ' + e.message));

  } catch (e) {
    showToast('Failed to join: ' + e.message);
  }
});

document.getElementById('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(state.roomCode)
    .then(() => showToast('Room code copied!'))
    .catch(() => showToast('Copy failed — share the code manually'));
});

document.getElementById('btn-start').addEventListener('click', () => {
  if (!state.isHost) return;
  hostStartGame();
});

document.getElementById('btn-play').addEventListener('click', playCards);
document.getElementById('btn-cheat').addEventListener('click', callCheat);

document.getElementById('btn-restart').addEventListener('click', () => {
  // Reset state and go back to lobby
  if (peer) { peer.destroy(); peer = null; }
  hostConn = null;
  Object.assign(state, {
    isHost: false, myId: null, myName: '', roomCode: '',
    connections: {}, players: [], started: false,
    hands: {}, pile: [], pileHistory: [],
    currentTurnIndex: 0, currentRank: '7', selectedCards: [], chosenRank: null,
    pendingWinner: null, winCountdown: 0,
  });
  document.getElementById('input-room').value = '';
  showScreen('screen-lobby');
});
