const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// In-memory game store
const games = new Map();

function generateCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

io.on('connection', (socket) => {
  let currentGameCode = null;
  let currentPlayerName = null;

  socket.on('create-game', ({ playerName }, cb) => {
    const code = generateCode();
    const game = {
      code,
      host: socket.id,
      hostName: playerName,
      prompt: '',
      players: [{ id: socket.id, name: playerName }],
      state: 'lobby', // lobby | playing | between-rounds | finished
      round: 0,
      totalRounds: 0,
      stories: [],       // array of arrays: stories[storyIndex][paragraphIndex]
      assignments: [],    // assignments[playerIndex] = storyIndex they're writing
      roundTime: 90,
      timerInterval: null,
      timeRemaining: 0,
    };
    games.set(code, game);
    currentGameCode = code;
    currentPlayerName = playerName;
    socket.join(code);
    cb({ success: true, code, isHost: true });
    io.to(code).emit('lobby-update', {
      players: game.players.map(p => p.name),
      hostName: game.hostName,
    });
  });

  socket.on('join-game', ({ code, playerName }, cb) => {
    const game = games.get(code);
    if (!game) return cb({ success: false, error: 'Game not found' });
    if (game.state !== 'lobby') return cb({ success: false, error: 'Game already in progress' });
    if (game.players.some(p => p.name === playerName)) {
      return cb({ success: false, error: 'Name already taken' });
    }

    game.players.push({ id: socket.id, name: playerName });
    currentGameCode = code;
    currentPlayerName = playerName;
    socket.join(code);
    cb({ success: true, code, isHost: false });
    io.to(code).emit('lobby-update', {
      players: game.players.map(p => p.name),
      hostName: game.hostName,
    });
  });

  socket.on('set-time', ({ time }) => {
    const game = games.get(currentGameCode);
    if (!game || socket.id !== game.host) return;
    const allowed = [10, 60, 90, 120];
    if (allowed.includes(time)) game.roundTime = time;
  });

  socket.on('set-prompt', ({ prompt }) => {
    const game = games.get(currentGameCode);
    if (!game || socket.id !== game.host) return;
    game.prompt = prompt;
    io.to(currentGameCode).emit('prompt-updated', { prompt });
  });

  socket.on('start-game', () => {
    const game = games.get(currentGameCode);
    if (!game || socket.id !== game.host) return;
    if (game.players.length < 2) return;
    if (game.state !== 'lobby') return;

    game.totalRounds = game.players.length;
    game.round = 0;

    // Each player starts their own story
    game.stories = game.players.map(() => []);

    // Initial assignment: player i writes on story i
    game.assignments = game.players.map((_, i) => i);

    game.state = 'between-rounds';
    io.to(currentGameCode).emit('game-started', {
      prompt: game.prompt,
      totalRounds: game.totalRounds,
    });

    // Immediately signal host can start first round
    io.to(currentGameCode).emit('between-rounds', {
      round: game.round + 1,
      totalRounds: game.totalRounds,
    });
  });

  socket.on('start-round', () => {
    const game = games.get(currentGameCode);
    if (!game || socket.id !== game.host) return;
    if (game.state !== 'between-rounds') return;

    game.round++;
    game.state = 'playing';
    game.timeRemaining = game.roundTime;

    // Send each player their view: only the previous paragraph (or prompt if round 1)
    game.players.forEach((player, playerIndex) => {
      const storyIndex = game.assignments[playerIndex];
      const story = game.stories[storyIndex];
      let previousParagraph = '';
      if (story.length > 0) {
        previousParagraph = story[story.length - 1].text;
      }
      io.to(player.id).emit('round-start', {
        round: game.round,
        totalRounds: game.totalRounds,
        prompt: game.prompt,
        previousParagraph,
        timeRemaining: game.timeRemaining,
        totalTime: game.roundTime,
      });
    });

    // Track who has submitted this round
    game.submittedThisRound = new Set();

    // Start countdown
    if (game.timerInterval) clearInterval(game.timerInterval);
    game.timerInterval = setInterval(() => {
      game.timeRemaining--;
      io.to(currentGameCode).emit('timer-tick', { timeRemaining: game.timeRemaining });
      if (game.timeRemaining <= 0) {
        clearInterval(game.timerInterval);
        game.timerInterval = null;
        game.state = 'time-up';
        const allNames = game.players.map(p => p.name);
        const pending = game.players
          .filter(p => !game.submittedThisRound.has(p.id))
          .map(p => p.name);
        io.to(currentGameCode).emit('time-up', { pending, allPlayers: allNames });
      }
    }, 1000);
  });

  socket.on('end-round', () => {
    const game = games.get(currentGameCode);
    if (!game || socket.id !== game.host) return;
    if (game.state !== 'time-up') return;
    endRound(game, currentGameCode);
  });

  socket.on('submit-paragraph', ({ text }) => {
    const game = games.get(currentGameCode);
    if (!game || (game.state !== 'playing' && game.state !== 'time-up')) return;

    const playerIndex = game.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;

    const storyIndex = game.assignments[playerIndex];
    const story = game.stories[storyIndex];

    // Only allow one submission per round per player
    const alreadySubmitted = story.some(
      p => p.round === game.round && p.authorId === socket.id
    );
    if (alreadySubmitted) return;

    story.push({
      text: text.trim(),
      author: game.players[playerIndex].name,
      authorId: socket.id,
      round: game.round,
    });

    game.submittedThisRound.add(socket.id);
    socket.emit('paragraph-accepted');

    // Broadcast updated submission status
    const pending = game.players
      .filter(p => !game.submittedThisRound.has(p.id))
      .map(p => p.name);
    io.to(currentGameCode).emit('submission-update', { pending });
  });

  socket.on('disconnect', () => {
    if (!currentGameCode) return;
    const game = games.get(currentGameCode);
    if (!game) return;

    if (game.state === 'lobby') {
      game.players = game.players.filter(p => p.id !== socket.id);
      if (game.players.length === 0) {
        games.delete(currentGameCode);
      } else {
        if (game.host === socket.id) {
          game.host = game.players[0].id;
          game.hostName = game.players[0].name;
        }
        io.to(currentGameCode).emit('lobby-update', {
          players: game.players.map(p => p.name),
          hostName: game.hostName,
        });
      }
    }
    // During active game, we leave them in for simplicity
  });
});

function endRound(game, code) {
  game.state = 'between-rounds';

  // Fill in empty submissions for players who didn't submit
  game.players.forEach((player, playerIndex) => {
    const storyIndex = game.assignments[playerIndex];
    const story = game.stories[storyIndex];
    const submitted = story.some(p => p.round === game.round);
    if (!submitted) {
      story.push({
        text: '(No submission)',
        author: player.name,
        authorId: player.id,
        round: game.round,
      });
    }
  });

  if (game.round >= game.totalRounds) {
    // Game over
    game.state = 'finished';
    const storiesData = game.stories.map((story, i) => ({
      startedBy: game.players[i].name,
      paragraphs: story.map(p => ({ text: p.text, author: p.author })),
    }));
    io.to(code).emit('game-finished', { stories: storiesData, prompt: game.prompt });
    return;
  }

  // Rotate assignments: each player gets the next story
  game.assignments = game.assignments.map(
    (storyIndex) => (storyIndex + 1) % game.players.length
  );

  io.to(code).emit('between-rounds', {
    round: game.round + 1,
    totalRounds: game.totalRounds,
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Pass the Story running on http://localhost:${PORT}`);
});
