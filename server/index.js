// server/index.js (or your main server file)
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { nanoid } from 'nanoid';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Allow all origins for development. For production, restrict this.
    methods: ["GET", "POST"]
  }
});

// --- In-memory Storage ---
const rooms = new Map(); // Room ID -> Room Object
const playerSocketMap = new Map(); // Socket ID -> Room ID (for quick disconnect lookup)

// --- Configuration ---
const DEFAULT_TOTAL_ROUNDS = 3;
const TIME_FOR_WORD_SELECTION = 15; // seconds
const DEFAULT_ROUND_DURATION = 60; // seconds
const TIME_BETWEEN_ROUNDS = 5; // seconds
const MAX_WORD_CHOICES = 3;
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute
const MAX_ROOM_AGE_HOURS = 4; // Rooms older than this might be cleaned up

// --- Word List ---
const words = [
  "apple", "banana", "car", "dog", "elephant", "fish", "guitar", "house",
  "island", "jacket", "kite", "lamp", "mountain", "notebook", "ocean",
  "pizza", "queen", "robot", "sun", "tree", "umbrella", "violin", "window",
  "xylophone", "yacht", "zebra", "airplane", "beach", "castle", "dinosaur",
  "earth", "fire", "giraffe", "helicopter", "ice cream", "jungle", "kangaroo",
  "lighthouse", "moon", "ninja", "octopus", "penguin", "rainbow", "spaceship",
  "tiger", "unicorn", "volcano", "waterfall", "fox", "yogurt", "zombie",
  "astronaut", "ballet", "cactus", "dragon", "energy", "forest", "galaxy",
  "honeybee", "island", "jigsaw", "kangaroo", "lizard", "meteor", "necklace",
  "oyster", "pyramid", "quokka", "rocket", "satellite", "tornado", "utopia",
  "vortex", "whale", "zeppelin", "avocado", "basketball", "campfire",
  "diamond", "eclipse", "fireworks", "glacier", "hourglass", "iceberg",
  "jukebox", "koala", "lantern", "meadow", "nightmare", "overture", "parrot",
  "quest", "riddle", "starfish", "treasure", "underwater", "violet", "windmill"
];


// --- Helper Functions ---
const generateWordHint = (word) => {
  if (!word) return '';
  return word.split('').map(char => (char === ' ' ? ' ' : '_')).join(' ');
};

const getRandomWords = (count = 1) => {
  if (words.length === 0) return count === 1 ? "default" : ["default"];
  const availableWords = [...words];
  const selectedWords = new Set();
  const numToSelect = Math.min(count, availableWords.length);

  while (selectedWords.size < numToSelect) {
    const randomIndex = Math.floor(Math.random() * availableWords.length);
    selectedWords.add(availableWords.splice(randomIndex, 1)[0]);
  }
  return count === 1 ? [...selectedWords][0] || "default" : [...selectedWords];
};


io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create_room', (data, callback) => {
    const username = data?.username;

    if (typeof callback !== 'function') {
      console.error(`[create_room] No callback provided by client ${socket.id}`);
      return;
    }
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return callback({ success: false, error: 'Username is required and must be a string.' });
    }

    const roomId = nanoid(6).toUpperCase();
    const newPlayer = {
      id: socket.id,
      username: username.trim(),
      score: 0,
      isHost: true,
      isConnected: true,
      hasGuessedCorrectly: false,
    };

    rooms.set(roomId, {
      id: roomId,
      players: [newPlayer],
      gameState: {
        status: 'waiting',
        currentRound: 0,
        totalRounds: DEFAULT_TOTAL_ROUNDS,
        timeLeft: 0,
        currentDrawer: null,
        word: '',
        wordHint: '',
        winnerId: null,
        roundDuration: DEFAULT_ROUND_DURATION,
      },
      wordChoices: [],
      gameTimerId: null,
      roundEndTimerId: null,
      lastDrawerIndex: -1,
      createdAt: Date.now()
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.username = newPlayer.username;
    playerSocketMap.set(socket.id, roomId);

    console.log(`Room ${roomId} created by ${newPlayer.username} (${socket.id})`);
    callback({ success: true, roomId });

    io.to(roomId).emit('game_state', rooms.get(roomId).gameState);
    io.to(roomId).emit('room_update', { players: rooms.get(roomId).players });
  });

  socket.on('join_room', (data, callback) => {
    const username = data?.username;
    const roomId = data?.roomId;

    if (typeof callback !== 'function') {
      console.error(`[join_room] No callback provided by client ${socket.id}`);
      return;
    }
    if (!username || typeof username !== 'string' || username.trim() === '') {
      return callback({ success: false, error: 'Username is required.' });
    }
    if (!roomId || typeof roomId !== 'string' || !rooms.has(roomId)) {
      return callback({ success: false, error: 'Room not found or invalid Room ID.' });
    }

    const room = rooms.get(roomId);
    const trimmedUsername = username.trim();

    const existingPlayerWithSocketId = room.players.find(p => p.id === socket.id);
    if (existingPlayerWithSocketId) { // Player is rejoining with same socket ID
        existingPlayerWithSocketId.isConnected = true;
        existingPlayerWithSocketId.username = trimmedUsername; // Allow username update on rejoin
        socket.data.username = trimmedUsername;
        console.log(`Player ${trimmedUsername} (${socket.id}) re-activated in room ${roomId}`);
    } else {
        // New player or player with new socket ID
        const existingPlayerWithUsername = room.players.find(p => p.username.toLowerCase() === trimmedUsername.toLowerCase() && p.isConnected);
        if (existingPlayerWithUsername) {
            return callback({ success: false, error: `Username "${trimmedUsername}" is already taken by an active player in this room.` });
        }

        // If game in progress, consider if player can join (e.g. as spectator or if allowed)
        // For now, allow joining if not 'drawing' or 'selecting' or if room is small
        if (room.gameState.status !== 'waiting' && room.players.filter(p => p.isConnected).length >= 8 /* Max players example */) {
             return callback({ success: false, error: 'Room is full or game is in a critical phase for new joins.' });
        }

        const newPlayer = {
          id: socket.id,
          username: trimmedUsername,
          score: 0, // New players start with 0 score even if joining mid-game
          isHost: room.players.filter(p => p.isConnected).length === 0, // First to connect if no active host
          isConnected: true,
          hasGuessedCorrectly: false,
        };
        room.players.push(newPlayer);
        socket.data.username = newPlayer.username;
        console.log(`${newPlayer.username} (${socket.id}) joined room ${roomId}`);
        socket.to(roomId).emit('system_message', { message: `${newPlayer.username} has joined the room.`, type: 'info' });
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    playerSocketMap.set(socket.id, roomId);

    callback({ success: true, roomId: room.id });

    socket.emit('game_state', room.gameState); // Send full state to joining/rejoining player
    io.to(roomId).emit('room_update', { players: room.players }); // Update all players
  });

  socket.on('client_reconnected_to_room', ({ roomId }) => {
    if (!roomId || !rooms.has(roomId)) {
        socket.emit('room_closed'); // Tell client room is gone
        return;
    }
    const room = rooms.get(roomId);
    const player = room.players.find(p => p.id === socket.id);

    if (player) {
        player.isConnected = true;
        socket.join(roomId); // Ensure they are in the socket.io room
        socket.data.roomId = roomId;
        if (player.username) socket.data.username = player.username;
        playerSocketMap.set(socket.id, roomId);

        console.log(`Player ${player.username || socket.id} reconnected to room ${roomId}.`);
        socket.emit('game_state', room.gameState);
        io.to(roomId).emit('room_update', { players: room.players });
    } else {
        // Player data not found, might need to fully rejoin with username
        console.log(`Socket ${socket.id} tried to reconnect to ${roomId}, but no player data. Requesting full rejoin.`);
        socket.emit('request_rejoin_details', { roomId });
    }
  });


  socket.on('start_game', (data) => {
    const roomId = data?.roomId;
    const requestedTotalRounds = data?.totalRounds;

    if (!roomId || !rooms.has(roomId)) {
      socket.emit('error_message', { message: `Room ${roomId} not found.` });
      return;
    }

    const room = rooms.get(roomId);
    const player = room.players.find(p => p.id === socket.id);

    if (!player || !player.isHost) {
      socket.emit('error_message', { message: 'Only the host can start/restart the game.' });
      return;
    }

    const connectedPlayers = room.players.filter(p => p.isConnected);
    if (connectedPlayers.length < 2) {
      socket.emit('error_message', { message: 'Need at least 2 connected players.' });
      return;
    }

    if (room.gameTimerId) clearInterval(room.gameTimerId);
    if (room.roundEndTimerId) clearTimeout(room.roundEndTimerId);

    room.players.forEach(p => {
      p.score = 0;
      p.hasGuessedCorrectly = false;
    });

    let firstDrawer = connectedPlayers.find(p => p.isHost && p.isConnected) || connectedPlayers[0];
    room.lastDrawerIndex = room.players.findIndex(p => p.id === firstDrawer.id);

    const newTotalRounds = (typeof requestedTotalRounds === 'number' && requestedTotalRounds >= 1)
                            ? requestedTotalRounds
                            : DEFAULT_TOTAL_ROUNDS;

    room.gameState = {
      ...room.gameState,
      status: 'selecting',
      currentRound: 1,
      totalRounds: newTotalRounds,
      timeLeft: TIME_FOR_WORD_SELECTION,
      currentDrawer: firstDrawer.id,
      word: '',
      wordHint: '',
      winnerId: null,
    };

    room.wordChoices = getRandomWords(MAX_WORD_CHOICES);

    io.to(roomId).emit('system_message', { message: `Game starting with ${room.gameState.totalRounds} rounds! ${firstDrawer.username} is choosing a word.`, type: 'info' });
    io.to(roomId).emit('game_state', room.gameState);
    io.to(roomId).emit('room_update', { players: room.players });
    io.to(firstDrawer.id).emit('word_choices', { words: room.wordChoices });

    room.gameTimerId = setInterval(() => handleTimerTick(roomId, 'selecting'), 1000);
  });

  socket.on('select_word', ({ roomId, word }) => {
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (room.gameState.currentDrawer !== socket.id || room.gameState.status !== 'selecting') {
      socket.emit('error_message', { message: "Not your turn or not in selection phase."});
      return;
    }
    if (!room.wordChoices.includes(word)) {
      socket.emit('error_message', {message: "Invalid word selected."});
      return;
    }

    clearInterval(room.gameTimerId);

    room.gameState.status = 'drawing';
    room.gameState.word = word;
    room.gameState.wordHint = generateWordHint(word);
    room.gameState.timeLeft = room.gameState.roundDuration || DEFAULT_ROUND_DURATION;

    io.to(roomId).emit('game_state', room.gameState);
    io.to(roomId).emit('system_message', { message: `${socket.data.username} has selected a word. Start drawing!`, type: 'info' });

    room.gameTimerId = setInterval(() => handleTimerTick(roomId, 'drawing'), 1000);
  });

  socket.on('draw', (data) => {
    const roomId = data?.roomId; // Client sends roomId with draw data
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (room.gameState.currentDrawer !== socket.id || room.gameState.status !== 'drawing') return;
    socket.to(roomId).emit('draw_data', data); // Broadcast validated data
  });

  socket.on('clear_canvas', ({ roomId }) => {
    if (!roomId || !rooms.has(roomId)) return;
    const room = rooms.get(roomId);

    if (room.gameState.currentDrawer !== socket.id || room.gameState.status !== 'drawing') return;
    io.to(roomId).emit('clear_canvas_broadcast');
  });

  socket.on('chat_message', ({ roomId, text }) => {
    if (!roomId || !rooms.has(roomId) || !socket.data.username || !text || typeof text !== 'string') return;
    const trimmedText = text.trim();
    if (trimmedText === '') return;

    io.to(roomId).emit('new_chat_message', {
      id: nanoid(8),
      senderId: socket.id,
      senderUsername: socket.data.username,
      text: trimmedText,
      type: 'normal',
      timestamp: Date.now()
    });
  });

  socket.on('guess', ({ roomId, guess }) => {
    if (!roomId || !rooms.has(roomId) || !socket.data.username || !guess || typeof guess !== 'string') return;

    const room = rooms.get(roomId);
    const player = room.players.find(p => p.id === socket.id);
    const trimmedGuess = guess.trim();
    if (trimmedGuess === '') return;


    if (!player || !player.isConnected) return;
    if (room.gameState.status !== 'drawing') {
      socket.emit('system_message', { message: "You can only guess while someone is drawing.", type: 'error' });
      return;
    }
    if (room.gameState.currentDrawer === socket.id) {
      socket.emit('system_message', { message: "You cannot guess your own word!", type: 'error' });
      return;
    }
    if (player.hasGuessedCorrectly) {
      socket.emit('system_message', { message: "You've already guessed correctly!", type: 'info' });
      return;
    }

    const normalizedGuess = trimmedGuess.toLowerCase();
    const normalizedWord = room.gameState.word.toLowerCase().trim();

    if (normalizedGuess === normalizedWord) {
      player.hasGuessedCorrectly = true;
      const timeBonus = Math.max(0, room.gameState.timeLeft);
      const scoreGain = 50 + Math.floor(timeBonus * 1.5);
      player.score += scoreGain;

      const drawer = room.players.find(p => p.id === room.gameState.currentDrawer);
      if (drawer) drawer.score += 20;

      io.to(roomId).emit('new_chat_message', {
        id: nanoid(8),
        senderUsername: "System", // Or player.username for "guessed the word!"
        text: `${player.username} guessed the word! (+${scoreGain} points)`,
        type: 'correct_guess',
        timestamp: Date.now()
      });
      io.to(roomId).emit('room_update', { players: room.players });

      const allGuessed = room.players
        .filter(p => p.isConnected && p.id !== room.gameState.currentDrawer)
        .every(p => p.hasGuessedCorrectly);

      if (allGuessed) {
        io.to(roomId).emit('system_message', { message: "Everyone guessed the word!", type: 'info' });
        endRound(roomId, "all_guessed");
      }
    } else {
      io.to(roomId).emit('new_chat_message', {
        id: nanoid(8),
        senderId: socket.id,
        senderUsername: player.username,
        text: trimmedGuess,
        type: 'normal',
        timestamp: Date.now()
      });
    }
  });

  socket.on('leave_room', () => {
    handlePlayerDisconnect(socket, "user_left_event");
  });

  socket.on('disconnect', (reason) => {
    console.log(`User disconnected: ${socket.id}, Reason: ${reason}`);
    handlePlayerDisconnect(socket, `socket_closed: ${reason}`);
  });
});

// --- Game Logic Helper Functions ---
function handleTimerTick(roomId, phase) {
    const room = rooms.get(roomId);
    if (!room || room.gameState.status !== phase) {
        if (room && room.gameTimerId) clearInterval(room.gameTimerId);
        return;
    }

    room.gameState.timeLeft--;
    io.to(roomId).emit('game_state', { timeLeft: room.gameState.timeLeft, status: room.gameState.status, currentDrawer: room.gameState.currentDrawer }); // Send only necessary updates

    if (room.gameState.timeLeft <= 0) {
        clearInterval(room.gameTimerId); // Stop this timer
        room.gameTimerId = null;

        if (phase === 'selecting') {
            const autoSelectedWord = room.wordChoices[Math.floor(Math.random() * room.wordChoices.length)] || getRandomWords(1);
            const drawer = room.players.find(p => p.id === room.gameState.currentDrawer);
            io.to(roomId).emit('system_message', { message: `${drawer?.username || 'Drawer'} ran out of time. Word auto-selected.`, type: 'info' });

            room.gameState.status = 'drawing';
            room.gameState.word = autoSelectedWord;
            room.gameState.wordHint = generateWordHint(autoSelectedWord);
            room.gameState.timeLeft = room.gameState.roundDuration || DEFAULT_ROUND_DURATION;
            io.to(roomId).emit('game_state', room.gameState);
            room.gameTimerId = setInterval(() => handleTimerTick(roomId, 'drawing'), 1000);

        } else if (phase === 'drawing') {
            io.to(roomId).emit('system_message', { message: "Time's up for drawing!", type: 'info' });
            endRound(roomId, "time_up");
        }
    }
}

function endRound(roomId, reason = "unknown") {
  const room = rooms.get(roomId);
  if (!room || room.gameState.status === 'round_end' || room.gameState.status === 'game_end') {
    if (room && room.gameTimerId) clearInterval(room.gameTimerId);
    return;
  }

  console.log(`[endRound] Room ${roomId}. Reason: ${reason}. Current status: ${room.gameState.status}`);
  if (room.gameTimerId) clearInterval(room.gameTimerId);
  room.gameTimerId = null;

  io.to(roomId).emit('round_end_details', {
    word: room.gameState.word,
    scores: room.players.reduce((acc, p) => { acc[p.id] = p.score; return acc; }, {})
  });

  room.gameState.status = 'round_end';
  room.gameState.timeLeft = TIME_BETWEEN_ROUNDS;
  io.to(roomId).emit('game_state', room.gameState);

  room.players.forEach(p => { p.hasGuessedCorrectly = false; });

  if (room.roundEndTimerId) clearTimeout(room.roundEndTimerId); // Clear previous if any
  room.roundEndTimerId = setTimeout(() => {
    if (!rooms.has(roomId)) return;
    const currentRoom = rooms.get(roomId); // Get fresh room state
    if (currentRoom.gameState.currentRound >= currentRoom.gameState.totalRounds) {
      endGame(roomId);
    } else {
      startNextRound(roomId);
    }
  }, TIME_BETWEEN_ROUNDS * 1000);
}

function startNextRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.gameState.currentRound++;

  const connectedPlayers = room.players.filter(p => p.isConnected);
  if (connectedPlayers.length < 1) { // Technically need 2 to play (1 drawer, 1 guesser)
    io.to(roomId).emit('system_message', { message: "Not enough players to continue. Game paused.", type: "error"});
    room.gameState.status = 'waiting';
    room.gameState.currentDrawer = null; room.gameState.word = ''; room.gameState.wordHint = '';
    io.to(roomId).emit('game_state', room.gameState);
    return;
  }
   // If only 1 player left, also pause.
  if (connectedPlayers.length < 2 && room.gameState.status !== 'waiting') {
    io.to(roomId).emit('system_message', { message: "Waiting for more players to resume.", type: 'info' });
    room.gameState.status = 'waiting'; // Go to waiting if not enough to meaningfully play
    room.gameState.currentDrawer = null; room.gameState.word = ''; room.gameState.wordHint = '';
    io.to(roomId).emit('game_state', room.gameState);
    return;
  }


  let nextDrawerIndex = (room.lastDrawerIndex + 1);
  let attempts = 0;
  while (attempts < room.players.length) {
      const potentialDrawerIndex = nextDrawerIndex % room.players.length;
      if (room.players[potentialDrawerIndex]?.isConnected) {
          room.lastDrawerIndex = potentialDrawerIndex;
          break;
      }
      nextDrawerIndex++;
      attempts++;
  }
   if (attempts >= room.players.length) { // Should be caught by connectedPlayers check
        console.error(`[startNextRound] No connected drawer found in room ${roomId}`);
        room.gameState.status = 'waiting';
        io.to(roomId).emit('game_state', room.gameState);
        io.to(roomId).emit('system_message', {message: "Error finding next drawer. Game paused.", type: 'error'});
        return;
   }

  const nextDrawer = room.players[room.lastDrawerIndex];

  room.gameState.status = 'selecting';
  room.gameState.currentDrawer = nextDrawer.id;
  room.gameState.word = '';
  room.gameState.wordHint = '';
  room.gameState.timeLeft = TIME_FOR_WORD_SELECTION;
  room.wordChoices = getRandomWords(MAX_WORD_CHOICES);

  io.to(roomId).emit('system_message', { message: `Round ${room.gameState.currentRound} of ${room.gameState.totalRounds}! ${nextDrawer.username} is choosing.`, type: 'info' });
  io.to(roomId).emit('game_state', room.gameState);
  io.to(nextDrawer.id).emit('word_choices', { words: room.wordChoices });

  if (room.gameTimerId) clearInterval(room.gameTimerId);
  room.gameTimerId = setInterval(() => handleTimerTick(roomId, 'selecting'), 1000);
}

function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.gameTimerId) clearInterval(room.gameTimerId);
  if (room.roundEndTimerId) clearTimeout(room.roundEndTimerId);
  room.gameTimerId = null; room.roundEndTimerId = null;

  const sortedPlayers = [...room.players]
    .filter(p => p.isConnected || p.score > 0)
    .sort((a, b) => b.score - a.score);
  const winner = sortedPlayers.length > 0 ? sortedPlayers[0] : null;

  room.gameState.status = 'game_end';
  room.gameState.winnerId = winner ? winner.id : null;
  room.gameState.timeLeft = 0;
  io.to(roomId).emit('game_state', room.gameState);

  const winnerMessage = winner ? `Winner is ${winner.username} with ${winner.score} points!` : "No winner could be determined.";
  io.to(roomId).emit('system_message', { message: `Game Over! ${winnerMessage} Host can restart the game.`, type: 'info' });
}

function handlePlayerDisconnect(socket, reason = "unknown") {
  const roomId = socket.data.roomId || playerSocketMap.get(socket.id);
  const username = socket.data.username || "Player";

  playerSocketMap.delete(socket.id);

  if (!roomId || !rooms.has(roomId)) {
    console.log(`Player ${username} (${socket.id}) disconnected, no active room. Reason: ${reason}`);
    return;
  }

  const room = rooms.get(roomId);
  const player = room.players.find(p => p.id === socket.id);

  if (!player || !player.isConnected) { // Already marked or not found
    console.log(`Player ${username} (${socket.id}) from room ${roomId} already processed or not found. Reason: ${reason}`);
    return;
  }

  player.isConnected = false;
  console.log(`${player.username} (${socket.id}) marked disconnected from ${roomId}. Reason: ${reason}`);
  io.to(roomId).emit('system_message', { message: `${player.username} has left.`, type: 'info' });

  const connectedPlayers = room.players.filter(p => p.isConnected);

  if (connectedPlayers.length === 0 && room.gameState.status !== 'game_end') { // Don't delete if game just ended, host might restart
    console.log(`All players left room ${roomId}. Deleting room.`);
    if (room.gameTimerId) clearInterval(room.gameTimerId);
    if (room.roundEndTimerId) clearTimeout(room.roundEndTimerId);
    rooms.delete(roomId);
    return;
  }

  let hostChanged = false;
  if (player.isHost && connectedPlayers.length > 0) {
    const newHost = connectedPlayers[0];
    newHost.isHost = true;
    hostChanged = true;
    io.to(roomId).emit('system_message', { message: `${newHost.username} is now the host.`, type: 'info' });
  }
  // Always send room_update if host might have changed or player list definitely changed
  io.to(roomId).emit('room_update', { players: room.players });


  if (room.gameState.currentDrawer === socket.id && (room.gameState.status === 'selecting' || room.gameState.status === 'drawing')) {
    io.to(roomId).emit('system_message', { message: `Drawer (${player.username}) left. Ending round.`, type: 'info' });
    if (room.gameTimerId) clearInterval(room.gameTimerId); room.gameTimerId = null; // Stop current phase timer
    endRound(roomId, "drawer_disconnected");
  } else if (connectedPlayers.length < 2 && room.gameState.status !== 'waiting' && room.gameState.status !== 'game_end') {
    io.to(roomId).emit('system_message', { message: "Not enough players. Game paused.", type: "error" });
    if (room.gameTimerId) clearInterval(room.gameTimerId); room.gameTimerId = null;
    if (room.roundEndTimerId) clearTimeout(room.roundEndTimerId); room.roundEndTimerId = null;
    room.gameState.status = 'waiting';
    room.gameState.currentDrawer = null; room.gameState.word = ''; room.gameState.wordHint = '';
    io.to(roomId).emit('game_state', room.gameState);
  }
}

// --- Room Cleanup ---
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  for (const [roomId, room] of rooms.entries()) {
    const roomAgeMs = now - (room.createdAt || now);
    const activePlayers = room.players.filter(p => p.isConnected);

    // Delete very old rooms or rooms empty for a while (e.g. 30 mins if not just ended)
    let shouldDelete = false;
    if (roomAgeMs > MAX_ROOM_AGE_HOURS * 60 * 60 * 1000) {
        shouldDelete = true;
        console.log(`[Cleanup] Deleting very old room ${roomId}.`);
    } else if (activePlayers.length === 0 && room.gameState.status !== 'game_end' && roomAgeMs > 30 * 60 * 1000) {
        // Empty for 30 mins and not just finished a game (where host might restart)
        shouldDelete = true;
        console.log(`[Cleanup] Deleting empty room ${roomId}.`);
    }


    if (shouldDelete) {
      if (room.gameTimerId) clearInterval(room.gameTimerId);
      if (room.roundEndTimerId) clearTimeout(room.roundEndTimerId);
      rooms.delete(roomId);
      cleanedCount++;
      // Clean up playerSocketMap entries for this room
      for (const [socketId, rId] of playerSocketMap.entries()) {
          if (rId === roomId) playerSocketMap.delete(socketId);
      }
    }
  }
  if (cleanedCount > 0) console.log(`[Cleanup] Cleaned ${cleanedCount} inactive/old rooms.`);
}, CLEANUP_INTERVAL_MS);


// --- Server Start ---
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
