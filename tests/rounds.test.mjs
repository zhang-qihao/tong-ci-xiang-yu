import assert from 'node:assert/strict'
import WebSocket from 'ws'

const url = process.env.TEST_URL || 'ws://127.0.0.1:3012/ws'
const sockets = []
async function client(name) {
  const socket = new WebSocket(`${url}?name=${encodeURIComponent(name)}`)
  sockets.push(socket)
  const messages = []
  socket.on('message', (raw) => messages.push(JSON.parse(raw)))
  const send = (message) => socket.send(JSON.stringify(message))
  const wait = async (type) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const index = messages.findIndex((message) => message.type === type)
      if (index >= 0) return messages.splice(index, 1)[0]
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`Timeout: ${type}`)
  }
  await wait('connected')
  return { send, wait }
}

async function play(total, matchAtEnd = false, mode = 'system_words') {
  const a = await client('甲')
  const b = await client('乙')
  a.send({ type: 'create_room', name: '轮数回归', mode, ...(total === undefined ? {} : { maxRounds: total }) })
  const { room } = await a.wait('room_joined')
  assert.equal(room.maxRounds, total ?? 10)
  b.send({ type: 'join_room', roomId: room.id })
  const joined = await b.wait('room_joined')
  assert.equal(joined.room.maxRounds, total ?? 10)
  a.send({ type: 'start_game' })
  if (mode === 'player_words') {
    await a.wait('opening_started')
    await b.wait('opening_started')
    a.send({ type: 'submit_answer', answer: '星星' })
    b.send({ type: 'submit_answer', answer: '大海' })
  }
  const count = total ?? 10
  for (let round = 2; round <= count; round++) {
    const started = await a.wait('round_started')
    await b.wait('round_started')
    assert.equal(started.room.round, round)
    assert.equal(started.room.maxRounds, count)
    a.send({ type: 'submit_answer', answer: `甲${round}` })
    b.send({ type: 'submit_answer', answer: matchAtEnd && round === count ? `甲${round}` : `乙${round}` })
  }
  const finished = await a.wait('game_finished')
  assert.equal(finished.status, matchAtEnd ? 'matched' : 'max_rounds')
  assert.equal(finished.history.length + 1, count)
  assert.equal(finished.history.at(-1).round, count)
  assert.equal(finished.room.initialWords.length, 2)
  a.send({ type: 'leave_room' })
  b.send({ type: 'leave_room' })
  console.log(`PASS total=${count}, result=${finished.status}`)
}

try {
  const invalid = await client('边界')
  for (const maxRounds of [1, 31, 3.5, '10']) {
    invalid.send({ type: 'create_room', maxRounds })
    assert.match((await invalid.wait('error')).message, /2 到 30/)
  }
  console.log('PASS invalid round limits rejected')
  await play(2)
  await play(undefined)
  await play(30)
  await play(2, true)
  await play(3, false, 'player_words')
} finally {
  sockets.forEach((socket) => socket.close())
}
