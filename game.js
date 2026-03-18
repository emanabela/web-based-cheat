// ─────────────────────────────────────────────
//  CONSTANTS & HELPERS
// ─────────────────────────────────────────────
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
  pile: [],          // all cards played so far (face-down)
  pileHistory: [],   // [{ peerId, claimedRank, cards[] }] per turn played
  currentTurnIndex: 0,
  currentRank: 'A',

  selectedCards: [],
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
function renderHand() {
  const hand = sortHand(state.hands[state.myId] || []);
  const container = document.getElementById('hand-cards');
  container.innerHTML = '';

  hand.forEach(card => {
    const chip = document.createElement('div');
    chip.className = 'card-chip' + (RED_SUITS.has(card.suit) ? ' red' : '');
    chip.textContent = cardLabel(card);

    const isSelected = state.selectedCards.some(
      c => c.rank === card.rank && c.suit === card.suit
    );
    if (isSelected) chip.classList.add('selected');

    chip.addEventListener('click', () => toggleCardSelection(card));
    container.appendChild(chip);
  });

  document.getElementById('hand-count').textContent = hand.length;
  updatePlayButton();
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
  document.getElementById('btn-play').disabled = !(myTurn && hasSelected);
  document.getElementById('selected-info').textContent =
    hasSelected ? `${state.selectedCards.length} card(s) selected` : 'Select cards to play';
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
  document.getElementById('current-rank-label').textContent = state.currentRank;
  document.getElementById('pile-count').textContent = state.pile.length;

  // Cheat button: enabled only when pile has cards and it's not your turn
  const pileHasCards = state.pile.length > 0;
  document.getElementById('btn-cheat').disabled = !pileHasCards || isMyTurn();
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
  state.currentTurnIndex = 0;
  state.currentRank = 'A';
  state.started = true;

  // Send each player their own hand + shared state
  state.players.forEach(p => {
    const msg = {
      type: 'game-start',
      players: state.players,
      hand: state.hands[p.id],
      currentTurnIndex: state.currentTurnIndex,
      currentRank: state.currentRank,
      pileSize: state.pile.length,
    };
    if (p.id === state.myId) {
      applyGameStart(msg);
    } else {
      sendToPlayer(p.id, msg);
    }
  });
}

function hostHandlePlay({ peerId, cards, claimedRank }) {
  // Validate it's their turn and rank matches
  if (state.players[state.currentTurnIndex].id !== peerId) return;
  if (claimedRank !== state.currentRank) return;

  // Remove cards from player's hand
  cards.forEach(played => {
    const hand = state.hands[peerId];
    const idx = hand.findIndex(c => c.rank === played.rank && c.suit === played.suit);
    if (idx >= 0) hand.splice(idx, 1);
  });

  // Add to pile
  state.pile.push(...cards);
  state.pileHistory.push({ peerId, claimedRank, cards });

  // Advance turn
  state.currentTurnIndex = (state.currentTurnIndex + 1) % state.players.length;
  state.currentRank = nextRank(state.currentRank);

  const playerName = state.players.find(p => p.id === peerId)?.name || peerId;
  const logMsg = `${playerName} played ${cards.length} card(s) as ${claimedRank}`;

  // Check win
  const winner = state.players.find(p => state.hands[p.id].length === 0);

  const updateMsg = {
    type: 'game-update',
    currentTurnIndex: state.currentTurnIndex,
    currentRank: state.currentRank,
    pileSize: state.pile.length,
    logMsg,
    handSizes: Object.fromEntries(state.players.map(p => [p.id, state.hands[p.id].length])),
    winner: winner ? winner.id : null,
  };

  // Send each player their updated hand
  state.players.forEach(p => {
    const msg = { ...updateMsg, hand: state.hands[p.id] };
    if (p.id === state.myId) applyGameUpdate(msg);
    else sendToPlayer(p.id, msg);
  });
}

function hostHandleCheat({ callerPeerId }) {
  if (state.pileHistory.length === 0) return;

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

  // Turn goes to the loser (they play next)
  state.currentTurnIndex = state.players.findIndex(p => p.id === loserPeerId);
  state.currentRank = nextRank(
    RANKS[(RANKS.indexOf(state.currentRank) - 1 + RANKS.length) % RANKS.length]
  );
  // Actually: after cheat call, rank resets — loser starts fresh with any rank
  // Convention: loser can play any rank, so we just advance normally from current
  state.currentRank = state.currentRank; // keep rank as-is, loser's turn picks up

  const winner = state.players.find(p => state.hands[p.id].length === 0);

  state.players.forEach(p => {
    const msg = {
      type: 'cheat-result',
      resultMsg,
      revealMsg,
      currentTurnIndex: state.currentTurnIndex,
      currentRank: state.currentRank,
      pileSize: state.pile.length,
      hand: state.hands[p.id],
      handSizes: Object.fromEntries(state.players.map(pl => [pl.id, state.hands[pl.id].length])),
      winner: winner ? winner.id : null,
    };
    if (p.id === state.myId) applyCheatResult(msg);
    else sendToPlayer(p.id, msg);
  });
}

// ─────────────────────────────────────────────
//  CLIENT-SIDE STATE UPDATES
// ─────────────────────────────────────────────
function applyGameStart(msg) {
  state.players = msg.players;
  state.hands[state.myId] = msg.hand;
  state.currentTurnIndex = msg.currentTurnIndex;
  state.currentRank = msg.currentRank;
  state.pile = [];
  state.pileHistory = [];
  state.selectedCards = [];
  state.started = true;

  document.getElementById('game-log').innerHTML = '';
  log('Game started! First rank: ' + state.currentRank);
  showScreen('screen-game');
  renderHand();
  renderHeader();
}

function applyGameUpdate(msg) {
  state.hands[state.myId] = msg.hand;
  state.currentTurnIndex = msg.currentTurnIndex;
  state.currentRank = msg.currentRank;
  state.pile = new Array(msg.pileSize); // we only track size client-side
  state.selectedCards = [];

  log(msg.logMsg);
  renderHand();
  renderHeader();

  if (msg.winner) {
    endGame(msg.winner);
  }
}

function applyCheatResult(msg) {
  state.hands[state.myId] = msg.hand;
  state.currentTurnIndex = msg.currentTurnIndex;
  state.currentRank = msg.currentRank;
  state.pile = new Array(msg.pileSize);
  state.selectedCards = [];

  log(msg.revealMsg);
  log(msg.resultMsg, true);
  showToast(msg.resultMsg, 4000);
  renderHand();
  renderHeader();

  if (msg.winner) {
    endGame(msg.winner);
  }
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
    const p = id ? new Peer(id) : new Peer();
    p.on('open', peerId => resolve({ p, peerId }));
    p.on('error', reject);
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
    }
  });

  conn.on('close', () => {
    showToast('Connection to host lost.', 5000);
  });
}

// ─────────────────────────────────────────────
//  ACTIONS
// ─────────────────────────────────────────────
function playCards() {
  if (!isMyTurn() || state.selectedCards.length === 0) return;

  const msg = {
    type: 'play',
    peerId: state.myId,
    cards: state.selectedCards,
    claimedRank: state.currentRank,
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
    const { p, peerId } = await createPeer();
    peer = p;
    state.myId = peerId;
    state.roomCode = peerId;
    state.players = [{ id: peerId, name }];

    setupHostHandlers();

    document.getElementById('room-code-display').textContent = peerId;
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

  state.myName = name;
  state.isHost = false;
  state.roomCode = roomCode;

  try {
    const { p, peerId } = await createPeer();
    peer = p;
    state.myId = peerId;

    const conn = peer.connect(roomCode, { reliable: true });
    hostConn = conn;

    conn.on('open', () => {
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
    currentTurnIndex: 0, currentRank: 'A', selectedCards: [],
  });
  document.getElementById('input-room').value = '';
  showScreen('screen-lobby');
});
