import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { nanoid } from 'nanoid';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// In-memory storage for rooms
const rooms = new Map();

// Word list
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

// Helper function to generate word hint (e.g., "apple" -> "_ _ _ _ _")
const generateWordHint = (word) => {
  return word.split('').map(() => '_').join(' ');
};

// Helper function to get 3 random words
const getRandomWords = () => {
  const randomWords = [];
  while (randomWords.length < 3) {
    const index = Math.floor(Math.random() * words.length);
    const word = words[index];
    if (!randomWords.includes(word)) {
      randomWords.push(word);
    }
  }
  return randomWords.join(', ');
};

// Clean up disconnected players and empty rooms
const cleanupRooms = () => {
  for (const [roomId, room] of rooms.entries()) {
    const activePlayers = room.players.filter(player => player.isConnected);
    
    // If no connected players, remove the room
    if (activePlayers.length === 0) {
      rooms.delete(roomId);
      continue;
    }
    
    // Update the players list
    room.players = activePlayers;
    
    // If the host disconnected, assign a new host
    if (!room.players.some(player => player.isHost)) {
      room.players[0].isHost = true;
    }
  }
};

// Run cleanup every minute
setInterval(cleanupRooms, 60000);

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  
  // Create a new room
  socket.on('create_room', ({ username }, callback) => {
    if (!username || username.trim() === '') {
      return callback({ success: false, error: 'Username is required' });
    }
    
    // Generate a room ID (6 uppercase characters)
    const roomId = nanoid(6).toUpperCase();
    
    // Create a new room
    rooms.set(roomId, {
      id: roomId,
      players: [
        {
          id: socket.id,
          username,
          score: 0,
          isHost: true,
          isConnected: true
        }
      ],
      gameState: {
        status: 'waiting',
        currentRound: 0,
        totalRounds: 3,
        timeLeft: 0,
        currentDrawer: null,
        word: '',
        wordHint: '',
      },
      createdAt: Date.now()
    });
    
    // Join the socket to the room
    socket.join(roomId);
    
    // Set user data
    socket.data.roomId = roomId;
    socket.data.username = username;
    
    // Send success response
    callback({ success: true, roomId });
    
    // Broadcast room update
    io.to(roomId).emit('room_update', { players: rooms.get(roomId).players });
  });
  
  // Join an existing room
  socket.on('join_room', ({ username, roomId }, callback) => {
    if (!username || username.trim() === '') {
      return callback({ success: false, error: 'Username is required' });
    }
    
    if (!roomId || !rooms.has(roomId)) {
      return callback({ success: false, error: 'Room not found' });
    }
    
    const room = rooms.get(roomId);
    
    // Check if the game is already in progress
    if (room.gameState.status !== 'waiting') {
      return callback({ success: false, error: 'Game already in progress' });
    }
    
    // Add player to the room
    room.players.push({
      id: socket.id,
      username,
      score: 0,
      isHost: false,
      isConnected: true
    });
    
    // Join the socket to the room
    socket.join(roomId);
    
    // Set user data
    socket.data.roomId = roomId;
    socket.data.username = username;
    
    // Send success response
    callback({ success: true });
    
    // Send system message
    io.to(roomId).emit('system_message', { message: `${username} joined the room` });
    
    // Broadcast room update
    io.to(roomId).emit('room_update', { players: room.players });
  });
  
  // Start the game
  socket.on('start_game', ({ roomId }) => {
    if (!roomId || !rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    
    // Verify that the sender is the host
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;
    
    // Check if there are enough players (at least 2)
    if (room.players.length < 2) {
      socket.emit('error', { message: 'Need at least 2 players to start' });
      return;
    }
    
    // Reset all player scores
    room.players.forEach(p => {
      p.score = 0;
    });
    
    // Initialize game state
    room.gameState = {
      status: 'selecting',
      currentRound: 1,
      totalRounds: room.players.length * 2, // Each player draws twice
      timeLeft: 0,
      currentDrawer: room.players[0].id, // First player starts
      word: getRandomWords(), // For the drawer to choose from
      wordHint: '',
    };
    
    // Broadcast game state update
    io.to(roomId).emit('game_state', room.gameState);
    io.to(roomId).emit('system_message', { message: 'Game started! First player is choosing a word.' });
  });
  
  // Player selects a word
  socket.on('select_word', ({ roomId, word }) => {
    if (!roomId || !rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    
    // Verify that the sender is the current drawer
    if (room.gameState.currentDrawer !== socket.id) return;
    
    // Update game state
    room.gameState.status = 'drawing';
    room.gameState.word = word;
    room.gameState.wordHint = generateWordHint(word);
    room.gameState.timeLeft = 60; // 60 seconds per round
    
    // Start the timer
    const timerId = setInterval(() => {
      const room = rooms.get(roomId);
      if (!room) {
        clearInterval(timerId);
        return;
      }
      
      room.gameState.timeLeft--;
      io.to(roomId).emit('game_state', room.gameState);
      
      // If time runs out or everyone has guessed correctly
      if (room.gameState.timeLeft <= 0 || allPlayersGuessedCorrectly(room)) {
        clearInterval(timerId);
        endRound(roomId);
      }
    }, 1000);
    
    // Broadcast game state (different for drawer and guessers)
    socket.emit('game_state', room.gameState); // Drawer sees the full word
    
    // Other players see the hint
    const hiddenState = { ...room.gameState, word: '' };
    socket.to(roomId).emit('game_state', hiddenState);
    
    io.to(roomId).emit('system_message', { message: 'Round started! Guess the word.' });
  });
  
  // Drawing data
  socket.on('draw', ({ roomId, start, end, color, size }) => {
    if (!roomId || !rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    
    // Verify that the sender is the current drawer
    if (room.gameState.currentDrawer !== socket.id) return;
    
    // Broadcast drawing data to all other players
    socket.to(roomId).emit('draw_data', { start, end, color, size });
  });
  
  // Clear canvas
  socket.on('clear_canvas', ({ roomId }) => {
    if (!roomId || !rooms.has(roomId)) return;
    
    const room = rooms.get(roomId);
    
    // Verify that the sender is the current drawer
    if (room.gameState.currentDrawer !== socket.id) return;
    
    // Broadcast clear canvas event to all players
    io.to(roomId).emit('clear_canvas');
  });
  
  // Chat message
  socket.on('chat', ({ roomId, message }) => {
    if (!roomId || !rooms.has(roomId) || !socket.data.username) return;
    
    // Broadcast chat message to all players
    io.to(roomId).emit('chat_message', {
      id: Date.now().toString(),
      sender: socket.data.username,
      text: message,
      type: 'normal',
      timestamp: Date.now()
    });
  });
  
  // Guess message
  socket.on('guess', ({ roomId, message }) => {
    if (!roomId || !rooms.has(roomId) || !socket.data.username) return;
    
    const room = rooms.get(roomId);
    
    // Only allow guesses during drawing phase
    if (room.gameState.status !== 'drawing') return;
    
    // Verify that the sender is not the drawer
    if (room.gameState.currentDrawer === socket.id) return;
    
    // Check if the player already guessed correctly
    const player = room.players.find(p => p.id === socket.id);
    if (player.hasGuessedCorrectly) return;
    
    // Normalize guess and word for comparison
    const normalizedGuess = message.toLowerCase().trim();
    const normalizedWord = room.gameState.word.toLowerCase().trim();
    
    // Check if the guess is correct
    if (normalizedGuess === normalizedWord) {
      // Mark player as having guessed correctly
      player.hasGuessedCorrectly = true;
      
      // Calculate score based on time left
      const scoreGain = Math.round(room.gameState.timeLeft * 10 / 6) + 50;
      player.score += scoreGain;
      
      // Award points to the drawer
      const drawer = room.players.find(p => p.id === room.gameState.currentDrawer);
      if (drawer) {
        drawer.score += 25; // Drawer gets points when someone guesses correctly
      }
      
      // Broadcast the correct guess
      io.to(roomId).emit('correct_guess', { username: socket.data.username });
      io.to(roomId).emit('room_update', { players: room.players });
      
      // If all players have guessed correctly, end the round
      if (allPlayersGuessedCorrectly(room)) {
        endRound(roomId);
      }
    } else {
      // Broadcast the incorrect guess to all players
      io.to(roomId).emit('chat_message', {
        id: Date.now().toString(),
        sender: socket.data.username,
        text: message,
        type: 'normal',
        timestamp: Date.now()
      });
    }
  });
  
  // Leave room
  socket.on('leave_room', ({ roomId }) => {
    handlePlayerDisconnect(socket);
  });
  
  // Disconnect
  socket.on('disconnect', () => {
    handlePlayerDisconnect(socket);
  });
});

// Helper function to check if all non-drawer players have guessed correctly
function allPlayersGuessedCorrectly(room) {
  const nonDrawerPlayers = room.players.filter(p => p.id !== room.gameState.currentDrawer && p.isConnected);
  return nonDrawerPlayers.every(p => p.hasGuessedCorrectly);
}

// Helper function to end the current round
function endRound(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Reset guessed correctly flags
  room.players.forEach(p => {
    p.hasGuessedCorrectly = false;
  });
  
  // Send round end notification
  io.to(roomId).emit('round_end', { 
    word: room.gameState.word,
    scores: room.players.reduce((acc, p) => {
      acc[p.id] = p.score;
      return acc;
    }, {})
  });
  
  // Update game state to round_end temporarily
  room.gameState.status = 'round_end';
  io.to(roomId).emit('game_state', room.gameState);
  
  // Wait 5 seconds before starting the next round
  setTimeout(() => {
    // Check if room still exists
    if (!rooms.has(roomId)) return;
    
    room.gameState.currentRound++;
    
    // If all rounds are completed, end the game
    if (room.gameState.currentRound > room.gameState.totalRounds) {
      endGame(roomId);
      return;
    }
    
    // Find the next drawer
    const currentDrawerIndex = room.players.findIndex(p => p.id === room.gameState.currentDrawer);
    let nextDrawerIndex = (currentDrawerIndex + 1) % room.players.length;
    
    // Set the next drawer
    room.gameState.currentDrawer = room.players[nextDrawerIndex].id;
    room.gameState.status = 'selecting';
    room.gameState.word = getRandomWords();
    room.gameState.wordHint = '';
    
    // Broadcast game state update
    io.to(roomId).emit('game_state', room.gameState);
    io.to(roomId).emit('system_message', { 
      message: `Round ${room.gameState.currentRound} starting! ${room.players[nextDrawerIndex].username} is choosing a word.` 
    });
  }, 5000);
}

// Helper function to end the game
function endGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Sort players by score
  const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);
  
  // Update game state
  room.gameState.status = 'game_end';
  io.to(roomId).emit('game_state', room.gameState);
  
  // Send game end notification
  io.to(roomId).emit('system_message', { 
    message: `Game ended! Winner: ${sortedPlayers[0].username} with ${sortedPlayers[0].score} points!` 
  });
  
  // Reset game after 10 seconds
  setTimeout(() => {
    if (!rooms.has(roomId)) return;
    
    // Reset game state
    room.gameState = {
      status: 'waiting',
      currentRound: 0,
      totalRounds: 3,
      timeLeft: 0,
      currentDrawer: null,
      word: '',
      wordHint: '',
    };
    
    // Reset scores
    room.players.forEach(p => {
      p.score = 0;
      p.hasGuessedCorrectly = false;
    });
    
    // Broadcast updates
    io.to(roomId).emit('game_state', room.gameState);
    io.to(roomId).emit('room_update', { players: room.players });
    io.to(roomId).emit('system_message', { message: 'Game reset. Ready for a new game!' });
  }, 10000);
}

// Helper function to handle player disconnection
function handlePlayerDisconnect(socket) {
  const roomId = socket.data.roomId;
  
  if (!roomId || !rooms.has(roomId)) return;
  
  const room = rooms.get(roomId);
  const player = room.players.find(p => p.id === socket.id);
  
  if (!player) return;
  
  // Mark the player as disconnected
  player.isConnected = false;
  
  // Leave the socket room
  socket.leave(roomId);
  
  // Send notification
  io.to(roomId).emit('system_message', { message: `${player.username} left the room` });
  
  // If all players have left, remove the room
  const connectedPlayers = room.players.filter(p => p.isConnected);
  
  if (connectedPlayers.length === 0) {
    rooms.delete(roomId);
    return;
  }
  
  // If the host left, assign a new host
  if (player.isHost && connectedPlayers.length > 0) {
    connectedPlayers[0].isHost = true;
  }
  
  // If current drawer left during drawing phase, end the round
  if (room.gameState.status === 'drawing' && room.gameState.currentDrawer === socket.id) {
    io.to(roomId).emit('system_message', { message: 'The drawer left. Ending round.' });
    endRound(roomId);
  }
  
  // Update room state
  io.to(roomId).emit('room_update', { players: room.players });
}

// Start the server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
