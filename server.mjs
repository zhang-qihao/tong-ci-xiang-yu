import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { createServer as createViteServer } from 'vite'
import { QUESTION_BANKS } from './src/wordBank.js'

const root = fileURLToPath(new URL('.', import.meta.url))
const isProduction = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT || 3001)
const rooms = new Map()
const clients = new Map()
const DEFAULT_ROUNDS = 10
const MAX_ROUNDS = 30

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

function randomCode() {
  let code = ''
  do code = Math.random().toString(36).slice(2, 8).toUpperCase()
  while (rooms.has(code))
  return code
}

function randomWords(category = 'all') {
  const bank = QUESTION_BANKS[category] || QUESTION_BANKS.all
  const pool = [...new Set(bank.flat())]
  const first = pool[Math.floor(Math.random() * pool.length)]
  let second = pool[Math.floor(Math.random() * pool.length)]
  while (normalizeWord(first) === normalizeWord(second)) second = pool[Math.floor(Math.random() * pool.length)]
  return [first, second]
}

function normalizeWord(value = '') {
  return value.trim().replace(/[\s，。！？、,.!?]/g, '').toLowerCase()
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    host: room.hostName,
    players: room.players.size,
    max: 2,
    time: room.time,
    maxRounds: room.maxRounds,
    category: room.category,
    status: room.status,
  }
}

function publicRoom(room) {
  return {
    ...roomSummary(room),
    playersDetail: [...room.players.values()].map((player) => ({ id: player.id, name: player.name, isHost: player.id === room.hostId })),
    round: room.round,
    mode: room.mode,
    initialWords: room.initialWords,
    currentWords: room.currentWords,
    deadlineAt: room.deadlineAt,
    history: room.history,
  }
}

function send(client, message) {
  if (client?.readyState === 1) client.send(JSON.stringify(message))
}

function sendError(client, message) {
  send(client, { type: 'error', message })
}

function broadcastRoom(room, message) {
  for (const [socket, player] of clients.entries()) {
    if (room.players.has(player.id)) send(socket, message)
  }
}

function broadcastLobby() {
  const message = { type: 'rooms', rooms: [...rooms.values()].filter((room) => room.status !== 'finished').map(roomSummary) }
  for (const socket of clients.keys()) send(socket, message)
}

function clearRoomTimer(room) {
  if (room.timer) clearTimeout(room.timer)
  room.timer = null
}

function finishRoom(room, status, extra = {}) {
  clearRoomTimer(room)
  room.status = 'finished'
  broadcastRoom(room, { type: 'game_finished', status, history: room.history, room: publicRoom(room), ...extra })
  broadcastLobby()
}

function startOpening(room) {
  clearRoomTimer(room)
  room.status = 'opening'
  room.round = 0
  room.currentWords = null
  room.answers = new Map()
  room.startedAt = Date.now()
  room.deadlineAt = room.startedAt + room.time * 1000
  broadcastRoom(room, { type: 'opening_started', room: publicRoom(room) })
  room.timer = setTimeout(() => timeoutRound(room), room.time * 1000 + 50)
}

function startRound(room, words) {
  clearRoomTimer(room)
  const firstRound = room.round === 0
  room.status = 'playing'
  room.round = firstRound ? 2 : room.round + 1
  room.currentWords = [...words]
  if (firstRound) room.initialWords = [...words]
  room.answers = new Map()
  room.startedAt = Date.now()
  room.deadlineAt = room.startedAt + room.time * 1000
  broadcastRoom(room, { type: 'round_started', room: publicRoom(room) })
  room.timer = setTimeout(() => timeoutRound(room), room.time * 1000 + 50)
}

function revealOpening(room) {
  const players = [...room.players.values()]
  const answers = players.map((player) => room.answers.get(player.id) || null)
  if (answers.some((answer) => !answer)) return timeoutRound(room)
  room.currentWords = [...answers]
  room.initialWords = [...answers]
  broadcastRoom(room, { type: 'opening_revealed', room: publicRoom(room) })
  setTimeout(() => {
    if (room.status === 'opening') startRound(room, answers)
  }, 650)
}

function revealRound(room) {
  const players = [...room.players.values()]
  const answers = players.map((player) => room.answers.get(player.id) || null)
  const [answerA, answerB] = answers
  const matched = Boolean(answerA && answerB && normalizeWord(answerA) === normalizeWord(answerB))
  const entry = {
    round: room.round,
    words: room.currentWords,
    answers,
    matched,
    status: matched ? 'matched' : 'unmatched',
  }
  room.history.push(entry)
  broadcastRoom(room, { type: 'round_revealed', entry, room: publicRoom(room) })
  if (matched) {
    finishRoom(room, 'matched')
  } else if (room.round >= room.maxRounds) {
    finishRoom(room, 'max_rounds')
  } else {
    setTimeout(() => {
      if (room.status === 'playing' && room.history.at(-1) === entry) startRound(room, [answerA, answerB])
    }, 900)
  }
}

function timeoutRound(room) {
  if (!['opening', 'playing'].includes(room.status) || room.answers.size === 2) return
  const players = [...room.players.values()]
  const answers = players.map((player) => room.answers.get(player.id) || null)
  if (room.status === 'opening') {
    room.history.push({ round: 0, words: [null, null], answers, matched: false, status: 'timeout' })
  } else {
    room.history.push({ round: room.round, words: room.currentWords, answers, matched: false, status: 'timeout' })
  }
  finishRoom(room, 'timeout')
}

function leaveRoom(client) {
  const player = clients.get(client)
  if (!player?.roomId) return
  const room = rooms.get(player.roomId)
  player.roomId = null
  if (!room) return broadcastLobby()
  room.players.delete(player.id)
  clearRoomTimer(room)
  if (room.players.size === 0) rooms.delete(room.id)
  else if (['opening', 'playing'].includes(room.status)) finishRoom(room, 'abandoned')
  else broadcastRoom(room, { type: 'room_updated', room: publicRoom(room) })
  broadcastLobby()
}

function removePlayer(client) {
  const player = clients.get(client)
  if (!player) return
  const replacement = [...clients.entries()].some(([socket, activePlayer]) => socket !== client && activePlayer.id === player.id)
  if (replacement) {
    clients.delete(client)
    return
  }
  if (player.roomId) {
    const room = rooms.get(player.roomId)
    if (room) {
      room.players.delete(player.id)
      clearRoomTimer(room)
      if (room.players.size === 0) rooms.delete(room.id)
      else if (['opening', 'playing'].includes(room.status)) finishRoom(room, 'abandoned')
      else broadcastRoom(room, { type: 'room_updated', room: publicRoom(room) })
    }
  }
  clients.delete(client)
  broadcastLobby()
}

function joinRoom(client, room, name) {
  const player = clients.get(client)
  if (room.players.size >= 2 && !room.players.has(player.id)) return sendError(client, '这个房间已经坐满了')
  player.roomId = room.id
  player.name = name || player.name
  room.players.set(player.id, player)
  send(client, { type: 'room_joined', room: publicRoom(room), playerId: player.id })
  broadcastRoom(room, { type: 'room_updated', room: publicRoom(room) })
  broadcastLobby()
}

function handleMessage(client, payload) {
  const player = clients.get(client)
  if (!player || !payload?.type) return
  const currentRoom = player.roomId ? rooms.get(player.roomId) : null
  switch (payload.type) {
    case 'list_rooms':
      broadcastLobby()
      break
    case 'update_name': {
      const name = String(payload.name || '').trim().slice(0, 12)
      if (!name) return sendError(client, '昵称不能为空')
      player.name = name
      if (currentRoom && currentRoom.hostId === player.id) currentRoom.hostName = name
      send(client, { type: 'name_updated', name })
      if (currentRoom) broadcastRoom(currentRoom, { type: 'room_updated', room: publicRoom(currentRoom) })
      broadcastLobby()
      break
    }
    case 'create_room': {
      if (currentRoom) return sendError(client, '你已经在一个房间里了')
      const maxRounds = payload.maxRounds ?? DEFAULT_ROUNDS
      if (!Number.isInteger(maxRounds) || maxRounds < 2 || maxRounds > MAX_ROUNDS) {
        return sendError(client, '单局轮数必须是 2 到 30 的整数（含起始轮）')
      }
      const room = {
        maxRounds,
        id: randomCode(), name: String(payload.name || '无名相遇').trim().slice(0, 18) || '无名相遇',
        hostId: player.id, hostName: player.name,
        mode: payload.mode === 'player_words' ? 'player_words' : 'system_words',
        category: QUESTION_BANKS[payload.category] ? payload.category : 'all',
        time: [30, 60, 90, 120].includes(payload.time) ? payload.time : 60,
        players: new Map(), status: 'waiting', round: 0, initialWords: null, currentWords: null, deadlineAt: null,
        answers: new Map(), history: [], timer: null,
      }
      rooms.set(room.id, room)
      joinRoom(client, room, player.name)
      break
    }
    case 'join_room': {
      if (currentRoom) return sendError(client, '你已经在一个房间里了')
      const room = rooms.get(String(payload.roomId || '').trim().toUpperCase())
      if (!room) return sendError(client, '没有找到这个房间')
      if (room.status !== 'waiting') return sendError(client, '这局游戏已经开始或结束了')
      joinRoom(client, room, player.name)
      break
    }
    case 'leave_room':
      leaveRoom(client)
      break
    case 'set_time':
      if (!currentRoom || currentRoom.hostId !== player.id || currentRoom.status !== 'waiting') return
      if ([30, 60, 90, 120].includes(payload.time)) currentRoom.time = payload.time
      broadcastRoom(currentRoom, { type: 'room_updated', room: publicRoom(currentRoom) })
      break
    case 'start_game':
      if (!currentRoom || currentRoom.hostId !== player.id) return sendError(client, '只有房主可以开始游戏')
      if (currentRoom.players.size !== 2) return sendError(client, '等另一位玩家加入后再开始')
      if (currentRoom.status !== 'waiting') return
      if (currentRoom.mode === 'player_words') startOpening(currentRoom)
      else startRound(currentRoom, randomWords(currentRoom.category))
      break
    case 'submit_answer': {
      if (!currentRoom || !['opening', 'playing'].includes(currentRoom.status) || currentRoom.answers.has(player.id)) return
      const answer = String(payload.answer || '').trim().slice(0, 12)
      if (!answer) return sendError(client, '请输入一个词')
      if (Date.now() > currentRoom.deadlineAt) return timeoutRound(currentRoom)
      if (currentRoom.status === 'opening' && [...currentRoom.answers.values()].some((existing) => normalizeWord(existing) === normalizeWord(answer))) {
        return sendError(client, '起始词不能和对方相同，请换一个')
      }
      currentRoom.answers.set(player.id, answer)
      broadcastRoom(currentRoom, { type: 'answer_status', playerId: player.id, submitted: true })
      if (currentRoom.answers.size === 2) {
        clearRoomTimer(currentRoom)
        setTimeout(() => currentRoom.status === 'opening' ? revealOpening(currentRoom) : revealRound(currentRoom), 650)
      }
      break
    }
    case 'play_again':
      if (!currentRoom || currentRoom.players.size !== 2 || currentRoom.hostId !== player.id) return sendError(client, '只有房主可以发起下一局')
      clearRoomTimer(currentRoom)
      currentRoom.status = 'waiting'
      currentRoom.round = 0
      currentRoom.initialWords = null
      currentRoom.currentWords = null
      currentRoom.deadlineAt = null
      currentRoom.answers = new Map()
      currentRoom.history = []
      broadcastRoom(currentRoom, { type: 'play_again_ready', room: publicRoom(currentRoom) })
      broadcastLobby()
      break
    default:
      break
  }
}

const httpServer = createServer()
const websocketServer = new WebSocketServer({ noServer: true })

websocketServer.on('connection', (socket, request) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  const playerId = url.searchParams.get('playerId') || randomUUID()
  for (const [oldSocket, oldPlayer] of clients.entries()) {
    if (oldPlayer.id === playerId) oldSocket.close(4001, 'reconnected')
  }
  const name = (url.searchParams.get('name') || '匿名玩家').slice(0, 12)
  const player = { id: playerId, name, roomId: null }
  clients.set(socket, player)
  send(socket, { type: 'connected', playerId })
  broadcastLobby()
  socket.on('message', (raw) => {
    try { handleMessage(socket, JSON.parse(raw.toString())) } catch { sendError(socket, '无法理解这次操作') }
  })
  socket.on('close', () => removePlayer(socket))
})

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`)
  if (url.pathname !== '/ws') return socket.destroy()
  websocketServer.handleUpgrade(request, socket, head, (ws) => websocketServer.emit('connection', ws, request))
})

if (isProduction) {
  httpServer.on('request', (request, response) => {
    const requested = request.url.split('?')[0]
    const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '')
    const filePath = normalize(join(root, 'dist', relative))
    const distRoot = normalize(join(root, 'dist'))
    const safePath = filePath.startsWith(distRoot) ? filePath : join(distRoot, 'index.html')
    if (existsSync(safePath) && statSync(safePath).isFile()) {
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(safePath)] || 'application/octet-stream' })
      response.end(readFileSync(safePath))
    } else {
      response.writeHead(200, { 'Content-Type': mimeTypes['.html'] })
      response.end(readFileSync(join(distRoot, 'index.html')))
    }
  })
} else {
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: false }, appType: 'spa' })
  httpServer.on('request', (request, response) => vite.middlewares(request, response, () => response.end()))
}

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`同词相遇已启动: http://0.0.0.0:${port}`)
  console.log(`局域网访问: http://<你的局域网IP>:${port}`)
})
