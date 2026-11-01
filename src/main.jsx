import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Clock3,
  Copy,
  DoorOpen,
  Flame,
  Hash,
  Search,
  Sparkles,
  UsersRound,
  Wifi,
  X,
} from 'lucide-react'
import { CATEGORY_OPTIONS } from './wordBank.js'
import './styles.css'

const TIME_OPTIONS = [30, 60, 90, 120]

function storageGet(key) {
  try { return window.localStorage.getItem(key) } catch { return null }
}

function storageSet(key, value) {
  try { window.localStorage.setItem(key, value) } catch { /* 某些隐私模式会禁用本地存储 */ }
}

function createPlayerId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID()
  return `player-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function getPlayerId() {
  try {
    const existing = window.sessionStorage.getItem('tong-ci-player-id')
    if (existing) return existing
    const id = createPlayerId()
    window.sessionStorage.setItem('tong-ci-player-id', id)
    return id
  } catch {
    return createPlayerId()
  }
}

function getPlayerName() {
  return storageGet('tong-ci-player-name') || ''
}

function normalizeWord(value = '') {
  return value.trim().replace(/[\s，。！？、,.!?]/g, '').toLowerCase()
}

function App() {
  const socketRef = useRef(null)
  const noticeTimerRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [playerId] = useState(getPlayerId)
  const [playerName, setPlayerName] = useState(getPlayerName)
  const playerNameRef = useRef(playerName)
  const [screen, setScreen] = useState('lobby')
  const [rooms, setRooms] = useState([])
  const [activeRoom, setActiveRoom] = useState(null)
  const [query, setQuery] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [showJoin, setShowJoin] = useState(false)
  const [roomCode, setRoomCode] = useState('')
  const [newRoomName, setNewRoomName] = useState('两个人的脑回路')
  const [newRoomMode, setNewRoomMode] = useState('system_words')
  const [newRoomCategory, setNewRoomCategory] = useState('all')
  const [selectedTime, setSelectedTime] = useState(60)
  const [answer, setAnswer] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [timeLeft, setTimeLeft] = useState(0)
  const [rounds, setRounds] = useState([])
  const [resultType, setResultType] = useState('matched')
  const [copied, setCopied] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [notice, setNotice] = useState('')
  const [showNameSetup, setShowNameSetup] = useState(() => !getPlayerName())

  const send = (message) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false
    socketRef.current.send(JSON.stringify(message))
    return true
  }

  useEffect(() => {
    let disposed = false
    let retryTimer

    const connect = () => {
      if (disposed) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws?playerId=${encodeURIComponent(playerId)}&name=${encodeURIComponent(playerNameRef.current)}`)
      socketRef.current = socket
      socket.onopen = () => {
        setConnected(true)
        send({ type: 'list_rooms' })
      }
      socket.onclose = () => {
        setConnected(false)
        setRestarting(false)
        if (!disposed) retryTimer = window.setTimeout(connect, 1200)
      }
      socket.onerror = () => socket.close()
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data)
          if (message.type === 'name_updated') {
            setPlayerName(message.name)
            playerNameRef.current = message.name
            storageSet('tong-ci-player-name', message.name)
          }
          if (message.type === 'rooms') setRooms(message.rooms)
          if (message.type === 'connected') setConnected(true)
          if (message.type === 'room_joined' || message.type === 'room_updated') {
            setActiveRoom(message.room)
            if (message.type === 'room_updated' && message.room.status === 'waiting') setScreen((current) => current === 'result' ? 'room' : current)
            if (message.type === 'room_joined') {
              setSelectedTime(message.room.time)
              setShowJoin(false)
              setShowCreate(false)
              setRoomCode('')
              setScreen('room')
            }
          }
          if (message.type === 'play_again_ready') {
            setActiveRoom(message.room)
            setRounds([])
            setAnswer('')
            setSubmitted(false)
            setRestarting(false)
            setScreen('room')
          }
          if (message.type === 'round_started') {
            setActiveRoom(message.room)
            setAnswer('')
            setSubmitted(false)
            setRounds(message.room.history || [])
            setScreen('game')
          }
          if (message.type === 'opening_started') {
            setActiveRoom(message.room)
            setAnswer('')
            setSubmitted(false)
            setScreen('opening')
          }
          if (message.type === 'opening_revealed') {
            setActiveRoom(message.room)
            setRounds(message.room.history || [])
          }
          if (message.type === 'answer_status' && message.playerId === playerId) setSubmitted(true)
          if (message.type === 'round_revealed') {
            setActiveRoom(message.room)
            setRounds(message.room.history || [])
          }
          if (message.type === 'game_finished') {
            setActiveRoom(message.room)
            setRounds(message.history || [])
            setResultType(message.status)
            setScreen('result')
          }
          if (message.type === 'error') {
            setRestarting(false)
            setNotice(message.message)
            window.clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = window.setTimeout(() => setNotice(''), 2600)
          }
        } catch {
          setNotice('收到无法识别的房间消息')
        }
      }
    }

    connect()
    return () => {
      disposed = true
      window.clearTimeout(retryTimer)
      socketRef.current?.close()
    }
  }, [playerId])

  useEffect(() => {
    const viewport = window.visualViewport
    const updateViewport = () => {
      document.documentElement.style.setProperty('--visible-height', `${viewport?.height || window.innerHeight}px`)
      document.documentElement.style.setProperty('--visible-top', `${viewport?.offsetTop || 0}px`)
    }
    updateViewport()
    viewport?.addEventListener('resize', updateViewport)
    viewport?.addEventListener('scroll', updateViewport)
    window.addEventListener('resize', updateViewport)
    return () => {
      viewport?.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      window.removeEventListener('resize', updateViewport)
    }
  }, [])

  useEffect(() => {
    if (!['game', 'opening'].includes(screen) || !activeRoom?.deadlineAt) return undefined
    const update = () => setTimeLeft(Math.max(0, Math.ceil((activeRoom.deadlineAt - Date.now()) / 1000)))
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [screen, activeRoom?.deadlineAt])

  const filteredRooms = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return rooms
    return rooms.filter((room) => `${room.id} ${room.name} ${room.host}`.toLowerCase().includes(needle))
  }, [rooms, query])

  const isHost = activeRoom?.playersDetail?.some((player) => player.id === playerId && player.isHost)
  const totalTime = activeRoom?.time || selectedTime

  function requireConnection() {
    if (connected) return true
    setNotice('正在连接房间大厅，请稍候')
    return false
  }

  function requireName() {
    if (playerName.trim()) return true
    setShowNameSetup(true)
    return false
  }

  function openRoom(room) {
    if (!requireName() || !requireConnection()) return
    send({ type: 'join_room', roomId: room.id })
  }

  function updateName(nextName) {
    const name = nextName.trim().slice(0, 12)
    if (!name) {
      setNotice('请先填写昵称')
      return false
    }
    if (name === playerName) {
      setShowNameSetup(false)
      return true
    }
    if (send({ type: 'update_name', name })) {
      setPlayerName(name)
      playerNameRef.current = name
      storageSet('tong-ci-player-name', name)
      setShowNameSetup(false)
      return true
    }
    setNotice('正在连接房间大厅，请稍候')
    return false
  }

  function createRoom() {
    if (!requireName() || !requireConnection()) return
    send({ type: 'create_room', name: newRoomName, mode: newRoomMode, category: newRoomCategory, time: selectedTime })
  }

  function joinByCode() {
    if (!requireName() || !requireConnection() || !roomCode.trim()) return
    send({ type: 'join_room', roomId: roomCode.trim().toUpperCase() })
  }

  function leaveRoom() {
    send({ type: 'leave_room' })
    setActiveRoom(null)
    setRounds([])
    setAnswer('')
    setScreen('lobby')
  }

  function startGame() {
    if (!requireConnection()) return
    send({ type: 'start_game' })
  }

  function submitAnswer(event) {
    event.preventDefault()
    const clean = answer.trim()
    if (!clean || submitted) return
    send({ type: 'submit_answer', answer: clean })
  }

  function copyRoomCode() {
    if (activeRoom?.id) navigator.clipboard?.writeText(activeRoom.id)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  function playAgain() {
    if (!isHost || restarting) return
    setRestarting(true)
    if (!send({ type: 'play_again' })) {
      setRestarting(false)
      setNotice('连接已断开，请稍后重试')
    }
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      {notice && <div className="toast" role="status">{notice}</div>}
      {screen === 'lobby' && <Lobby connected={connected} playerName={playerName} onNameChange={updateName} query={query} setQuery={setQuery} rooms={filteredRooms} onOpen={openRoom} onCreate={() => setShowCreate(true)} onJoin={() => setShowJoin(true)} />}
      {screen === 'room' && activeRoom && <Room room={activeRoom} playerId={playerId} isHost={isHost} selectedTime={selectedTime} setSelectedTime={(time) => { setSelectedTime(time); send({ type: 'set_time', time }) }} onBack={leaveRoom} onCopy={copyRoomCode} copied={copied} onStart={startGame} />}
      {screen === 'opening' && activeRoom && <Opening room={activeRoom} answer={answer} setAnswer={setAnswer} submitted={submitted} timeLeft={timeLeft} totalTime={totalTime} onSubmit={submitAnswer} onBack={leaveRoom} />}
      {screen === 'game' && activeRoom && <Game room={activeRoom} playerId={playerId} answer={answer} setAnswer={setAnswer} submitted={submitted} timeLeft={timeLeft} totalTime={totalTime} onSubmit={submitAnswer} onBack={leaveRoom} />}
      {screen === 'result' && activeRoom && <Result initialWords={activeRoom.initialWords} rounds={rounds} type={resultType} roomCode={activeRoom.id} time={activeRoom.time} isHost={isHost} restarting={restarting} onAgain={playAgain} onHome={leaveRoom} />}
      {showNameSetup && <NameSetupModal connected={connected} initialName={playerName} onSave={updateName} />}
      {showCreate && <CreateModal connected={connected} name={newRoomName} setName={setNewRoomName} mode={newRoomMode} setMode={setNewRoomMode} category={newRoomCategory} setCategory={setNewRoomCategory} time={selectedTime} setTime={setSelectedTime} onClose={() => setShowCreate(false)} onCreate={createRoom} />}
      {showJoin && <JoinModal code={roomCode} setCode={setRoomCode} onClose={() => setShowJoin(false)} onJoin={joinByCode} />}
    </main>
  )
}

function Header({ eyebrow = '同词相遇', onBack, action }) {
  return <header className="topbar">{onBack ? <button className="icon-button" onClick={onBack} aria-label="返回"><ArrowLeft size={19} /></button> : <div className="brand-mark"><span /><span /><span /></div>}<div className="topbar-title">{eyebrow}</div>{action || <div className="topbar-spacer" />}</header>
}

function Lobby({ connected, playerName, onNameChange, query, setQuery, rooms, onOpen, onCreate, onJoin }) {
  const [editingName, setEditingName] = useState(false)
  const [draftName, setDraftName] = useState(playerName)
  function saveName(event) {
    event.preventDefault()
    if (onNameChange(draftName)) setEditingName(false)
  }
  return <div className="page lobby-page">
    <Header action={<div className="lobby-actions"><span className={`connection-state ${connected ? 'online' : ''}`}><Wifi size={13} /> {connected ? '已连接' : '连接中'}</span></div>} />
    <div className="identity-bar">{editingName ? <form onSubmit={saveName} className="name-form"><input value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={12} /><button type="submit">保存</button></form> : <><span>你是 <strong>{playerName}</strong></span><button onClick={() => { setDraftName(playerName); setEditingName(true) }}>修改昵称</button></>}</div>
    <section className="lobby-hero"><div className="hero-kicker"><Sparkles size={15} /> 两条脑回路，走到同一个词</div><h1>同词<br /><em>相遇</em></h1><p>和另一个人，从两个词出发。<br />看看你们会在哪一轮想到一起。</p><div className="lobby-cta-row"><button className="primary-button" onClick={onCreate}>创建房间 <ArrowUpRight size={17} /></button><button className="secondary-button" onClick={onJoin}><Hash size={16} /> 加入房间</button></div></section>
    <section className="rooms-section"><div className="section-heading"><div><span className="section-label">正在发生</span><h2>公开房间</h2></div><span className="room-count">{rooms.length} 间可加入</span></div><div className="search-field"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索房间名或房间号" /><kbd>/</kbd></div><div className="room-list-scroll"><div className="room-list">{rooms.map((room) => <RoomCard key={room.id} room={room} onClick={() => onOpen(room)} />)}{!rooms.length && <div className="empty-state"><span>还没有公开房间</span><small>创建一个，等另一个人进来。</small><button onClick={onCreate}>创建第一个房间</button></div>}</div></div></section>
  </div>
}

function RoomCard({ room, onClick }) {
  const full = room.players >= room.max
  const category = CATEGORY_OPTIONS.find((option) => option.id === room.category)?.label || '综合'
  return <button className="room-card" onClick={onClick} disabled={full}><span className="room-card-icon"><UsersRound size={17} /></span><span className="room-card-copy"><strong>{room.name}</strong><small>{room.id} · {room.host} · {category}</small></span><span className="room-card-meta"><span className={`status-dot ${full ? 'busy' : ''}`} />{full ? '游戏中' : `${room.players}/${room.max}`}</span><ChevronRight className="room-chevron" size={18} /></button>
}

function Room({ room, playerId, isHost, selectedTime, setSelectedTime, onBack, onCopy, copied, onStart }) {
  const players = room.playersDetail || []
  const hasOpponent = players.length >= 2
  const playerWordsMode = room.mode === 'player_words'
  return <div className="page room-page">
    <Header eyebrow="房间" onBack={onBack} action={<span className="room-code-mini">{room.id}</span>} />
    <section className="room-intro"><span className="section-label">你正在进入</span><h1>{room.name}</h1><p>{hasOpponent ? `${players[0]?.name || '玩家'} 和 ${players[1]?.name || '玩家'} 已经到齐。` : '等另一个人进来，然后一起开始。'}</p></section>
    <section className="room-panel"><div className="room-panel-top"><div className="room-badge"><span className="pulse-dot" />公开房间</div><button className="copy-button" onClick={onCopy}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? '已复制' : '复制房间号'}</button></div><div className="room-code-large">{room.id.split('').map((char, index) => <span key={`${char}-${index}`}>{char}</span>)}</div><div className="room-players"><div className="player-with-name"><div className="player avatar-purple">你</div><small>{players.find((player) => player.id === playerId)?.name || '你'}</small></div><div className="connection-line"><span /><span /><span /></div><div className="player-with-name"><div className={`player ${hasOpponent ? 'avatar-mint' : 'avatar-mint waiting-avatar'}`}>{hasOpponent ? '✓' : '?'}</div><small>{players.find((player) => player.id !== playerId)?.name || '等待中'}</small></div></div><p className="waiting-copy">{hasOpponent ? '另一位玩家已经加入' : '房间里还有一个位置'}<br /><small>{hasOpponent ? '准备好后就可以开始这一局。' : '把房间号发给朋友，或者等一个刚好路过的人。'}</small></p></section>
    <section className="settings-panel"><div className="setting-title"><Clock3 size={17} /><div><strong>每轮思考时间</strong><small>{isHost ? '房主可以调整，开始后不能更改' : '由房主设置'}</small></div></div><div className="mode-note"><span>{playerWordsMode ? '双方出词' : '系统出词'}</span><small>{playerWordsMode ? '第一组词由你们各自填写' : `${CATEGORY_OPTIONS.find((option) => option.id === room.category)?.label || '综合'}题库`}</small></div><div className="time-options">{[30, 60, 90, 120].map((seconds) => <button key={seconds} disabled={!isHost || room.status !== 'waiting'} className={selectedTime === seconds ? 'selected' : ''} onClick={() => setSelectedTime(seconds)}>{seconds}<small>秒</small></button>)}</div></section>
    <div className="bottom-action"><button className="primary-button full-button" disabled={!isHost || !hasOpponent || room.status !== 'waiting'} onClick={onStart}>{hasOpponent ? '开始一局' : '等待另一位玩家'} <ArrowUpRight size={18} /></button><span className="micro-copy"><Flame size={13} /> {isHost ? '你是房主' : `房主：${players.find((player) => player.id !== playerId)?.name || '等待中'}`}</span></div>
  </div>
}

function Opening({ room, answer, setAnswer, submitted, timeLeft, totalTime, onSubmit, onBack }) {
  const progress = Math.max(0, Math.min(100, (timeLeft / totalTime) * 100))
  return <div className="page game-page"><Header eyebrow="各自出一个词" onBack={onBack} action={<span className={`timer ${timeLeft <= 10 ? 'urgent' : ''}`}><Clock3 size={15} /> {timeLeft}s</span>} /><div className="timer-track"><span style={{ width: `${progress}%` }} /></div><section className="game-content"><div className="game-note">第一组词，由你们自己写下</div><div className="opening-mark"><span>你们的两个词</span><strong>?</strong></div><p className="game-question">先写下一个你想带进这局的词</p><form className="answer-form" onSubmit={onSubmit}><input disabled={submitted} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={submitted ? '已经写下你的词' : '写下一个词'} maxLength={12} /><div className="input-footer"><span>{answer.length}/12</span><button className="primary-button submit-button" disabled={!answer.trim() || submitted}>{submitted ? '等对方…' : '提交起始词'} {!submitted && <ArrowUpRight size={17} />}</button></div></form><div className="privacy-note"><span className="lock-shape" /> 对方现在看不到你的词</div></section><div className="game-bottom"><span>双方提交后才会揭晓</span><span>最长 {totalTime} 秒</span></div></div>
}

function Game({ room, answer, setAnswer, submitted, timeLeft, totalTime, onSubmit, onBack }) {
  const progress = Math.max(0, Math.min(100, (timeLeft / totalTime) * 100))
  const words = room.currentWords || ['', '']
  return <div className="page game-page"><Header eyebrow={`第 ${room.round} 轮`} onBack={onBack} action={<span className={`timer ${timeLeft <= 10 ? 'urgent' : ''}`}><Clock3 size={15} /> {timeLeft}s</span>} /><div className="timer-track"><span style={{ width: `${progress}%` }} /></div><section className="game-content"><div className="game-note">你们现在看到的是同一组词</div><div className="prompt-pair"><div className="prompt-card purple"><span>词一</span><strong>{words[0]}</strong></div><div className="prompt-symbol">×</div><div className="prompt-card mint"><span>词二</span><strong>{words[1]}</strong></div></div><p className="game-question">看到这两个词，你想到什么？</p><form className="answer-form" onSubmit={onSubmit}><input disabled={submitted} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={submitted ? '已经写下你的答案' : '写下一个词'} maxLength={12} /><div className="input-footer"><span>{answer.length}/12</span><button className="primary-button submit-button" disabled={!answer.trim() || submitted}>{submitted ? '等对方…' : '提交答案'} {!submitted && <ArrowUpRight size={17} />}</button></div></form><div className="privacy-note"><span className="lock-shape" /> 对方现在看不到你的答案</div></section><div className="game-bottom"><span>不着急，认真想一想</span><span>最长 {totalTime} 秒</span></div></div>
}

function Result({ initialWords, rounds, type, roomCode, time, isHost, restarting, onAgain, onHome }) {
  const matched = type === 'matched'
  const capped = type === 'max_rounds'
  const timeline = [
    ...(initialWords?.length === 2 ? [{ round: 1, answers: initialWords, matched: false, initial: true }] : []),
    ...rounds.map((entry) => ({ ...entry, round: (entry.round || 0) + 1 })),
  ]
  const resultLabel = matched ? 'MATCH FOUND' : capped ? 'KEEP CLOSING' : 'TIME OUT'
  const resultTitle = matched ? <>你们的脑回路<br /><em>相遇了</em></> : capped ? <>你们还在<br /><em>慢慢靠近</em></> : <>这次还没有<br /><em>相遇</em></>
  const resultHint = matched ? '最后一轮相遇' : capped ? '已到达本局上限' : '下次再试试'
  return <div className="page result-page"><Header eyebrow="一局结束" action={<button className="icon-button" onClick={onHome} aria-label="关闭"><X size={19} /></button>} /><section className="result-heading"><div className={`result-symbol ${matched ? 'matched' : ''}`}>{matched ? '✦' : '·'}</div><span className="section-label">{resultLabel}</span><h1>{resultTitle}</h1><p>房间 {roomCode} <i>·</i> 共 {timeline.length} 轮 <i>·</i> 每轮 {time} 秒</p></section><section className="trajectory"><div className="trajectory-label"><span>联想轨迹</span><span>{resultHint}</span></div>{timeline.map((entry, index) => { const answers = entry.answers || []; const left = answers[0] || '超时未作答'; const right = answers[1] || '超时未作答'; const isMatch = entry.matched || (!entry.initial && normalizeWord(left) === normalizeWord(right)); return <div className={`trajectory-row ${isMatch ? 'match-row' : ''} ${entry.initial ? 'initial-row' : ''}`} key={`${entry.round || index}-${left}`}><span className="round-label">第 {entry.round || index + 1} 轮{entry.initial ? ' · 起始词' : ''}</span><div className="word-pair"><span className="result-word left">{left}</span><span className="pair-mark">{isMatch ? '=' : '×'}</span><span className="result-word right">{right}</span></div></div> })}</section><div className="result-actions">{isHost && <button className="primary-button full-button" disabled={restarting} onClick={onAgain}>{restarting ? '正在准备…' : '再来一局'} {!restarting && <ArrowUpRight size={18} />}</button>}<button className="secondary-button full-button" onClick={onHome}>回到公开房间</button></div><p className="result-footer">每一次不一样，都是下一次靠近的线索。</p></div>
}

function NameSetupModal({ connected, initialName, onSave }) {
  const [name, setName] = useState(initialName)
  function submit(event) {
    event.preventDefault()
    onSave(name)
  }
  return (
    <div className="modal-backdrop name-setup-backdrop">
      <form className="modal-card name-setup-card" role="dialog" aria-modal="true" aria-labelledby="name-title" onSubmit={submit}>
        <div className="modal-heading"><h2 id="name-title">先认识一下</h2></div>
        <p className="form-hint">写下你的名字，让对方知道在和谁玩。</p>
        <label className="field-label" htmlFor="player-name">玩家昵称</label>
        <input id="player-name" className="text-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={12} placeholder="输入昵称，最多 12 个字" autoComplete="nickname" enterKeyHint="done" required />
        <button type="submit" className="primary-button full-button" disabled={!connected || !name.trim()}>{connected ? '进入大厅' : '正在连接…'}</button>
      </form>
    </div>
  )
}

function CreateModal({ connected, name, setName, mode, setMode, category, setCategory, time, setTime, onClose, onCreate }) {
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="modal-card create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title" onSubmit={(event) => { event.preventDefault(); onCreate() }}>
        <div className="modal-heading"><h2 id="create-title">创建房间</h2><button type="button" className="icon-button" aria-label="关闭创建房间" onClick={onClose}><X size={18} /></button></div>
        <label className="field-label">房间名称<input className="text-input" value={name} onChange={(event) => setName(event.target.value)} maxLength={18} /></label>
        <fieldset className="choice-field"><legend>游戏模式</legend><div className="mode-options">
          <button type="button" aria-pressed={mode === 'system_words'} className={mode === 'system_words' ? 'selected' : ''} onClick={() => setMode('system_words')}><strong>系统出词</strong><small>从选定题库随机抽词</small></button>
          <button type="button" aria-pressed={mode === 'player_words'} className={mode === 'player_words' ? 'selected' : ''} onClick={() => setMode('player_words')}><strong>双方出词</strong><small>各写一个词作为起点</small></button>
        </div></fieldset>
        {mode === 'system_words' ? <fieldset className="choice-field"><legend>选择题库</legend><div className="category-options">{CATEGORY_OPTIONS.map((option) => <button type="button" key={option.id} aria-pressed={category === option.id} className={category === option.id ? 'selected' : ''} onClick={() => setCategory(option.id)}><span>{option.label}</span>{category === option.id && <Check size={14} />}</button>)}</div><p className="form-hint">{CATEGORY_OPTIONS.find((option) => option.id === category)?.description}</p></fieldset> : <p className="form-hint">双方出词模式由玩家提供起始词，不使用系统题库。</p>}
        <fieldset className="choice-field"><legend>每轮思考时间</legend><div className="modal-time-options">{TIME_OPTIONS.map((seconds) => <button type="button" key={seconds} aria-pressed={time === seconds} className={time === seconds ? 'selected' : ''} onClick={() => setTime(seconds)}>{seconds} 秒</button>)}</div></fieldset>
        <button type="submit" className="primary-button full-button" disabled={!connected}>{connected ? '创建房间' : '正在连接…'} <ArrowUpRight size={18} /></button>
      </form>
    </div>
  )
}

function JoinModal({ code, setCode, onClose, onJoin }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><div className="modal-card join-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-heading"><div><span className="section-label">加入房间</span><h2>输入房间号</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><input className="code-input" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="例如 Y9WYMV" maxLength={8} /><button className="primary-button full-button" disabled={code.length < 4} onClick={onJoin}>进入房间 <DoorOpen size={18} /></button></div></div>
}

class AppErrorBoundary extends React.Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return <div className="fatal-error"><div className="fatal-error-mark">!</div><h1>页面暂时无法打开</h1><p>{this.state.error.message || '浏览器环境不支持当前功能'}</p><button className="primary-button" onClick={() => window.location.reload()}>重新加载</button></div>
    }
    return this.props.children
  }
}

const rootElement = document.getElementById('root')
rootElement.dataset.ready = 'true'
createRoot(rootElement).render(<AppErrorBoundary><App /></AppErrorBoundary>)
