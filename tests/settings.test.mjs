import assert from 'node:assert/strict'
import WebSocket from 'ws'

const sockets = []
async function connect(name) {
  const socket = new WebSocket(`${process.env.TEST_URL || 'ws://127.0.0.1:3012/ws'}?name=${encodeURIComponent(name)}`)
  sockets.push(socket)
  const queue = []
  socket.on('message', (raw) => queue.push(JSON.parse(raw)))
  const wait = async (type, predicate = () => true) => {
    const until = Date.now() + 5000
    while (Date.now() < until) {
      const index = queue.findIndex((message) => message.type === type && predicate(message))
      if (index !== -1) return queue.splice(index, 1)[0]
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Timeout waiting for ${type}`)
  }
  await wait('connected')
  return { wait, send: (payload) => socket.send(JSON.stringify(payload)) }
}

try {
  const host = await connect('房主')
  const guest = await connect('玩家')
  host.send({ type: 'create_room' })
  const { room } = await host.wait('room_joined')
  guest.send({ type: 'join_room', roomId: room.id })
  await guest.wait('room_joined')
  const settings = { mode: 'player_words', category: 'games', time: 90, maxRounds: 30 }
  guest.send({ type: 'update_settings', ...settings })
  assert.match((await guest.wait('error')).message, /只有房主/)
  host.send({ type: 'update_settings', ...settings, maxRounds: 31 })
  assert.match((await host.wait('error')).message, /2 到 30/)
  host.send({ type: 'update_settings', ...settings })
  for (const player of [host, guest]) {
    const updated = await player.wait('room_updated', (message) => message.room.maxRounds === 30)
    for (const [key, value] of Object.entries(settings)) assert.equal(updated.room[key], value)
  }
  host.send({ type: 'start_game' })
  const opening = await guest.wait('opening_started')
  assert.equal(opening.room.time, 90)
  assert.equal(opening.room.maxRounds, 30)
  host.send({ type: 'update_settings', ...settings, maxRounds: 10 })
  assert.match((await host.wait('error')).message, /游戏开始后/)
  console.log('PASS host settings sync to both players, invalid/guest/in-game changes rejected, selected mode starts')
} finally {
  sockets.forEach((socket) => socket.close())
}
