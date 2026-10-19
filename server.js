const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();
const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 2;
const WIN_SCORE = 10;

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function makeBoard(round) {
  const hue = Math.floor(Math.random() * 360);
  const saturation = 68 + Math.floor(Math.random() * 15);
  const lightness = 48 + Math.floor(Math.random() * 8);
  const difference = Math.max(3, 19 - Math.floor((round - 1) / 2) * 2);
  const direction = Math.random() < 0.5 ? -1 : 1;
  const base = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
  const odd = `hsl(${hue}, ${saturation}%, ${Math.max(12, Math.min(88, lightness + difference * direction))}%)`;
  const oddIndex = Math.floor(Math.random() * 16);
  const colors = Array.from({ length: 16 }, (_, i) => i === oddIndex ? odd : base);
  return { colors, oddIndex };
}

function publicPlayers(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: p.connected
  }));
}

function sendRoomState(room) {
  io.to(room.code).emit("room-state", {
    code: room.code,
    status: room.status,
    hostId: room.hostId,
    players: publicPlayers(room),
    round: room.round,
    winScore: WIN_SCORE
  });
}

function sendBoard(room) {
  room.board = makeBoard(room.round);
  room.roundLocked = false;
  io.to(room.code).emit("new-round", {
    round: room.round,
    colors: room.board.colors,
    winScore: WIN_SCORE
  });
  sendRoomState(room);
}

function finishRoom(room, winnerId, reason) {
  room.status = "finished";
  room.roundLocked = true;
  const winner = room.players.find(p => p.id === winnerId);
  io.to(room.code).emit("match-over", {
    winnerId: winnerId || null,
    winnerName: winner ? winner.name : null,
    reason
  });
  sendRoomState(room);
}

io.on("connection", socket => {
  socket.on("create-room", ({ name } = {}, callback = () => {}) => {
    const cleanName = String(name || "Игрок 1").trim().slice(0, 18) || "Игрок 1";
    const code = makeCode();
    const room = {
      code,
      hostId: socket.id,
      players: [{ id: socket.id, name: cleanName, score: 0, connected: true }],
      status: "waiting",
      round: 0,
      board: null,
      roundLocked: false
    };
    rooms.set(code, room);
    socket.join(code);
    callback({ ok: true, code, playerId: socket.id });
    sendRoomState(room);
  });

  socket.on("join-room", ({ code, name } = {}, callback = () => {}) => {
    const cleanCode = String(code || "").trim().toUpperCase();
    const cleanName = String(name || "Игрок 2").trim().slice(0, 18) || "Игрок 2";
    const room = rooms.get(cleanCode);

    if (!room) return callback({ ok: false, error: "Комната не найдена. Проверь код." });
    if (room.status !== "waiting") return callback({ ok: false, error: "Матч уже начался или завершился." });
    if (room.players.length >= MAX_PLAYERS) return callback({ ok: false, error: "В комнате уже два игрока." });

    room.players.push({ id: socket.id, name: cleanName, score: 0, connected: true });
    socket.join(cleanCode);
    callback({ ok: true, code: cleanCode, playerId: socket.id });
    sendRoomState(room);
  });

  socket.on("start-match", ({ code } = {}, callback = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return callback({ ok: false, error: "Комната не найдена." });
    if (room.hostId !== socket.id) return callback({ ok: false, error: "Начать матч может создатель комнаты." });
    if (room.players.length < 2) return callback({ ok: false, error: "Подожди, пока подключится второй игрок." });
    if (room.status !== "waiting") return callback({ ok: false, error: "Матч уже запущен." });

    room.status = "playing";
    room.round = 1;
    room.players.forEach(p => p.score = 0);
    callback({ ok: true });
    sendBoard(room);
  });

  socket.on("choose-tile", ({ code, index } = {}, callback = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.status !== "playing") return callback({ ok: false, error: "Сейчас нет активного матча." });
    if (!Number.isInteger(index) || index < 0 || index > 15) return callback({ ok: false, error: "Некорректный квадрат." });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return callback({ ok: false, error: "Ты не участник этой комнаты." });
    if (room.roundLocked) return callback({ ok: false, error: "Раунд уже завершён." });

    if (index !== room.board.oddIndex) {
      room.roundLocked = true;
      const opponent = room.players.find(p => p.id !== socket.id);
      io.to(room.code).emit("wrong-answer", {
        playerId: socket.id,
        playerName: player.name,
        opponentName: opponent ? opponent.name : null
      });
      finishRoom(room, opponent ? opponent.id : null, "wrong-answer");
      callback({ ok: true, correct: false });
      return;
    }

    room.roundLocked = true;
    player.score += 1;
    io.to(room.code).emit("point-scored", {
      playerId: player.id,
      playerName: player.name,
      score: player.score,
      round: room.round
    });
    sendRoomState(room);
    callback({ ok: true, correct: true });

    if (player.score >= WIN_SCORE) {
      finishRoom(room, player.id, "target-score");
      return;
    }

    room.round += 1;
    setTimeout(() => {
      if (room.status === "playing") sendBoard(room);
    }, 650);
  });

  socket.on("leave-room", ({ code } = {}) => {
    const cleanCode = String(code || "").toUpperCase();
    const room = rooms.get(cleanCode);
    if (!room) return;
    socket.leave(cleanCode);
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== -1) room.players.splice(playerIndex, 1);
    if (room.players.length === 0) {
      rooms.delete(cleanCode);
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    if (room.status === "playing") {
      finishRoom(room, room.players[0].id, "opponent-left");
    } else {
      sendRoomState(room);
    }
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.find(p => p.id === socket.id);
      if (!player) continue;
      player.connected = false;
      if (room.status === "playing") {
        const opponent = room.players.find(p => p.id !== socket.id);
        finishRoom(room, opponent ? opponent.id : null, "disconnect");
      } else {
        sendRoomState(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Игра запущена: http://localhost:${PORT}`);
});
