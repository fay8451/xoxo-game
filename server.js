const express = require("express")
const http = require("http")
const https = require("https")
const WebSocket = require("ws")
const cors = require("cors")
const path = require("path")
const fs = require("fs")

// Create Express app
const app = express()
app.use(cors())
app.use(express.json())

// Serve static files
app.use(express.static(path.join(__dirname, ".")))

// Create HTTP or HTTPS server based on environment
let server

// Check if we're in production and have SSL certificates
if (process.env.NODE_ENV === "production" && fs.existsSync("./ssl/privkey.pem") && fs.existsSync("./ssl/cert.pem")) {
  // SSL options for HTTPS
  const sslOptions = {
    key: fs.readFileSync("./ssl/privkey.pem"),
    cert: fs.readFileSync("./ssl/cert.pem"),
  }

  // Create HTTPS server
  server = https.createServer(sslOptions, app)
  console.log("Server running in HTTPS mode with WSS support")
} else {
  // Create HTTP server for development
  server = http.createServer(app)
  console.log("Server running in HTTP mode (development). For production, place SSL certificates in ./ssl/ folder")
}

// Create WebSocket server
const wss = new WebSocket.Server({ server })

// Store active game rooms
const gameRooms = new Map()

// Set up ping interval (30 seconds)
const PING_INTERVAL = 30000

// Set up disconnection thresholds
const DISCONNECT_THRESHOLD = 2 // Number of missed pings before considering permanently disconnected
const ROOM_CLEANUP_DELAY = 60000 // Time to wait before removing a room with a disconnected player (1 minute)
const ROOM_PRESERVE_TIME = 3600000 // Time to preserve a room after both players disconnect (1 hour)
const WINS_TO_ULTIMATE_VICTORY = 3 // Number of wins needed for ultimate victory

// Function to check for dead connections and handle room cleanup
function heartbeat() {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("Terminating inactive client")

      // Increment disconnection counter
      ws.disconnectCount = (ws.disconnectCount || 0) + 1

      // If client has missed too many pings, consider it permanently disconnected
      if (ws.disconnectCount >= DISCONNECT_THRESHOLD) {
        handlePermanentDisconnect(ws)
      }

      return ws.terminate()
    }

    // Reset the alive flag for the next ping cycle
    ws.isAlive = false
    ws.ping()
  })

  // Check for rooms with disconnected players that need cleanup
  checkRoomsForCleanup()
}

// Handle permanent disconnection
function handlePermanentDisconnect(ws) {
  if (!ws.roomCode || !ws.player) return

  const room = gameRooms.get(ws.roomCode)
  if (!room) return

  console.log(`Player ${ws.player} in room ${ws.roomCode} is permanently disconnected`)

  // Mark the player as permanently disconnected
  room.players[ws.player].permanentlyDisconnected = true
  room.players[ws.player].disconnectedAt = Date.now()

  // Store the player's name for potential reconnection
  if (!room.players[ws.player].originalName) {
    room.players[ws.player].originalName = room.players[ws.player].name
  }

  // Notify the other player
  const otherPlayer = ws.player === "X" ? "O" : "X"
  if (room.players[otherPlayer].ws && room.players[otherPlayer].ws.readyState === WebSocket.OPEN) {
    room.players[otherPlayer].ws.send(
      JSON.stringify({
        type: "OPPONENT_DISCONNECTED",
        message: "Your opponent has disconnected. The game will end soon if they don't reconnect.",
      }),
    )
  }
}

// Check rooms for cleanup
function checkRoomsForCleanup() {
  const now = Date.now()

  gameRooms.forEach((room, roomCode) => {
    // Check if any player is permanently disconnected
    const xDisconnected = room.players.X.permanentlyDisconnected
    const oDisconnected = room.players.O.permanentlyDisconnected

    // If both players are disconnected, mark the room for delayed cleanup
    if (xDisconnected && oDisconnected) {
      if (!room.markedForCleanup) {
        console.log(`Marking room ${roomCode} for cleanup - both players disconnected`)
        room.markedForCleanup = true
        room.cleanupTime = now + ROOM_PRESERVE_TIME
      } else if (now > room.cleanupTime) {
        console.log(`Removing room ${roomCode} - cleanup time reached`)
        gameRooms.delete(roomCode)
      }
      return
    }

    // If one player is disconnected for too long, notify the other and remove the room
    if (xDisconnected && room.players.X.disconnectedAt) {
      const disconnectTime = now - room.players.X.disconnectedAt

      if (disconnectTime > ROOM_CLEANUP_DELAY) {
        console.log(`Removing room ${roomCode} - player X disconnected for too long`)

        // Notify player O if still connected
        if (room.players.O.ws && room.players.O.ws.readyState === WebSocket.OPEN) {
          room.players.O.ws.send(
            JSON.stringify({
              type: "ROOM_CLOSED",
              message: "Your opponent has been disconnected for too long. The game is ending.",
            }),
          )
        }

        gameRooms.delete(roomCode)
      }
    }

    if (oDisconnected && room.players.O.disconnectedAt) {
      const disconnectTime = now - room.players.O.disconnectedAt

      if (disconnectTime > ROOM_CLEANUP_DELAY) {
        console.log(`Removing room ${roomCode} - player O disconnected for too long`)

        // Notify player X if still connected
        if (room.players.X.ws && room.players.X.ws.readyState === WebSocket.OPEN) {
          room.players.X.ws.send(
            JSON.stringify({
              type: "ROOM_CLOSED",
              message: "Your opponent has been disconnected for too long. The game is ending.",
            }),
          )
        }

        gameRooms.delete(roomCode)
      }
    }
  })
}

// Set up the interval for ping-pong heartbeat
const pingInterval = setInterval(heartbeat, PING_INTERVAL)

// Clean up interval on server close
wss.on("close", () => {
  clearInterval(pingInterval)
})

// WebSocket connection handler
wss.on("connection", (ws) => {
  console.log("Client connected")

  // Mark the connection as alive when it first connects
  ws.isAlive = true
  ws.disconnectCount = 0

  // Handle pong messages
  ws.on("pong", () => {
    ws.isAlive = true
    ws.disconnectCount = 0 // Reset disconnect counter on successful pong

    // If player was marked as permanently disconnected, update their status
    if (ws.roomCode && ws.player) {
      const room = gameRooms.get(ws.roomCode)
      if (room && room.players[ws.player]) {
        if (room.players[ws.player].permanentlyDisconnected) {
          console.log(`Player ${ws.player} in room ${ws.roomCode} has reconnected`)
          room.players[ws.player].permanentlyDisconnected = false
          room.players[ws.player].disconnectedAt = null

          // Notify the other player
          const otherPlayer = ws.player === "X" ? "O" : "X"
          if (room.players[otherPlayer].ws && room.players[otherPlayer].ws.readyState === WebSocket.OPEN) {
            room.players[otherPlayer].ws.send(
              JSON.stringify({
                type: "OPPONENT_RECONNECTED",
                message: "Your opponent has reconnected.",
              }),
            )
          }
        }
      }
    }
  })

  // Handle messages from clients
  ws.on("message", (message) => {
    try {
      const event = JSON.parse(message.toString())
      console.log("Received event:", event.type)

      switch (event.type) {
        case "CREATE_ROOM":
          handleCreateRoom(ws, event)
          break
        case "JOIN_ROOM":
          handleJoinRoom(ws, event)
          break
        case "MAKE_MOVE":
          handleMakeMove(ws, event)
          break
        case "RESET_GAME":
          handleResetGame(event)
          break
        case "LEAVE_ROOM":
          handleLeaveRoom(ws, event)
          break
        case "RECONNECT_TO_ROOM":
          handleReconnectToRoom(ws, event)
          break
        case "RESET_SCORES":
          handleResetScores(event)
          break
        // เพิ่มการจัดการข้อความทดสอบ
        case "TEST_CONNECTION":
          handleTestConnection(ws, event)
          break
        // เพิ่มการจัดการข้อความ PING
        case "PING":
          handlePing(ws, event)
          break
      }
    } catch (error) {
      console.error("Error processing message:", error)
    }
  })

  // Handle client disconnection
  ws.on("close", () => {
    console.log("Client disconnected")
    handlePlayerDisconnect(ws)
  })
})

// Create a new game room
function handleCreateRoom(ws, event) {
  const { roomCode, playerName } = event

  // Create new game room
  gameRooms.set(roomCode, {
    board: Array(9).fill(null),
    currentTurn: "X", // X always starts the first game
    players: {
      X: {
        name: playerName,
        ws,
        connected: true,
        permanentlyDisconnected: false,
        disconnectedAt: null,
        originalName: playerName,
        score: 0, // Initialize score for player X
      },
      O: {
        name: "",
        ws: null,
        connected: false,
        permanentlyDisconnected: false,
        disconnectedAt: null,
        originalName: "",
        score: 0, // Initialize score for player O
      },
    },
    status: "waiting",
    winner: null,
    markedForCleanup: false,
    cleanupTime: null,
    ultimateWinner: null, // Track the ultimate winner
    lastWinner: null, // Track the last winner to determine who starts next
  })

  // Store room info on the websocket object for easy reference
  ws.roomCode = roomCode
  ws.player = "X"

  // Confirm room creation to the client
  ws.send(
    JSON.stringify({
      type: "ROOM_CREATED",
      roomCode,
      player: "X",
    }),
  )
}

// Join an existing game room
function handleJoinRoom(ws, event) {
  const { roomCode, playerName } = event
  const room = gameRooms.get(roomCode)

  // Check if room exists
  if (!room) {
    ws.send(
      JSON.stringify({
        type: "ERROR",
        message: "Room not found",
      }),
    )
    return
  }

  // Check if this player is trying to reconnect
  const isPlayerX = room.players.X.originalName === playerName
  const isPlayerO = room.players.O.originalName === playerName

  if (isPlayerX) {
    // Player X is reconnecting
    return handleReconnectToRoom(ws, { roomCode, playerName, player: "X" })
  } else if (isPlayerO) {
    // Player O is reconnecting
    return handleReconnectToRoom(ws, { roomCode, playerName, player: "O" })
  }

  // This is a new player trying to join
  // Check if room is full (both players connected and not permanently disconnected)
  if (
    room.players.O.connected &&
    !room.players.O.permanentlyDisconnected &&
    room.players.X.connected &&
    !room.players.X.permanentlyDisconnected
  ) {
    ws.send(
      JSON.stringify({
        type: "ERROR",
        message: "Room is full",
      }),
    )
    return
  }

  // Join room as player O
  room.players.O = {
    name: playerName,
    ws,
    connected: true,
    permanentlyDisconnected: false,
    disconnectedAt: null,
    originalName: playerName,
    score: 0, // Initialize score for player O
  }
  room.status = "playing"
  ws.roomCode = roomCode
  ws.player = "O"

  // Notify the joining player
  ws.send(
    JSON.stringify({
      type: "ROOM_JOINED",
      roomCode,
      player: "O",
      gameState: {
        board: room.board,
        currentTurn: room.currentTurn,
        players: {
          X: {
            name: room.players.X.name,
            connected: true,
            score: room.players.X.score,
          },
          O: {
            name: playerName,
            connected: true,
            score: 0,
          },
        },
        status: "playing",
        ultimateWinner: room.ultimateWinner,
        lastWinner: room.lastWinner,
      },
    }),
  )

  // Notify the room creator
  if (room.players.X.ws && room.players.X.ws.readyState === WebSocket.OPEN) {
    room.players.X.ws.send(
      JSON.stringify({
        type: "OPPONENT_JOINED",
        opponentName: playerName,
        gameState: {
          board: room.board,
          currentTurn: room.currentTurn,
          players: {
            X: {
              name: room.players.X.name,
              connected: true,
              score: room.players.X.score,
            },
            O: {
              name: playerName,
              connected: true,
              score: 0,
            },
          },
          status: "playing",
          ultimateWinner: room.ultimateWinner,
          lastWinner: room.lastWinner,
        },
      }),
    )
  }
}

// Handle player reconnecting to a room
function handleReconnectToRoom(ws, event) {
  const { roomCode, playerName, player } = event
  const room = gameRooms.get(roomCode)

  // Check if room exists
  if (!room) {
    ws.send(
      JSON.stringify({
        type: "ERROR",
        message: "Room not found",
      }),
    )
    return
  }

  // Determine which player is reconnecting
  const playerSymbol = player || (room.players.X.originalName === playerName ? "X" : "O")

  // Check if this player was originally in this room
  if (room.players[playerSymbol].originalName !== playerName) {
    ws.send(
      JSON.stringify({
        type: "ERROR",
        message: "You were not originally in this room",
      }),
    )
    return
  }

  // Update player connection
  room.players[playerSymbol].ws = ws
  room.players[playerSymbol].connected = true
  room.players[playerSymbol].permanentlyDisconnected = false
  room.players[playerSymbol].disconnectedAt = null

  // Update websocket properties
  ws.roomCode = roomCode
  ws.player = playerSymbol

  // If room was marked for cleanup, unmark it
  if (room.markedForCleanup) {
    room.markedForCleanup = false
    room.cleanupTime = null
  }

  // Notify the reconnecting player
  ws.send(
    JSON.stringify({
      type: "RECONNECTED_TO_ROOM",
      roomCode,
      player: playerSymbol,
      gameState: {
        board: room.board,
        currentTurn: room.currentTurn,
        players: {
          X: {
            name: room.players.X.name,
            connected: room.players.X.connected && !room.players.X.permanentlyDisconnected,
            score: room.players.X.score,
          },
          O: {
            name: room.players.O.name,
            connected: room.players.O.connected && !room.players.O.permanentlyDisconnected,
            score: room.players.O.score,
          },
        },
        status: room.status,
        winner: room.winner,
        ultimateWinner: room.ultimateWinner,
        lastWinner: room.lastWinner,
      },
    }),
  )

  // Notify the other player if connected
  const otherSymbol = playerSymbol === "X" ? "O" : "X"
  if (room.players[otherSymbol].ws && room.players[otherSymbol].ws.readyState === WebSocket.OPEN) {
    room.players[otherSymbol].ws.send(
      JSON.stringify({
        type: "OPPONENT_RECONNECTED",
        message: `${playerName} has reconnected to the game.`,
        opponentName: playerName,
      }),
    )
  }

  console.log(`Player ${playerSymbol} (${playerName}) reconnected to room ${roomCode}`)
}

// Handle a player's move
function handleMakeMove(ws, event) {
  const { roomCode, position, player, moveId } = event

  console.log(`Received move from ${player} at position ${position} with moveId ${moveId}`)

  // Send immediate ACK response
  ws.send(
    JSON.stringify({
      type: "MOVE_ACK",
      moveId: moveId, // Echo back the moveId if provided
      position: position,
      received: true,
      timestamp: Date.now(),
    }),
  )
  console.log(`Sent ACK for move at position ${position}`)

  const room = gameRooms.get(roomCode)

  // Validate move
  if (!room) {
    console.log("Room not found:", roomCode)
    return
  }
  if (room.status !== "playing") {
    console.log("Game not in playing state:", room.status)
    return
  }
  if (room.currentTurn !== player) {
    console.log("Not player's turn. Current turn:", room.currentTurn)
    return
  }
  if (room.board[position] !== null) {
    console.log("Position already occupied:", position)
    return
  }

  // Update board
  room.board[position] = player

  // Check for winner
  const winner = calculateWinner(room.board)
  if (winner) {
    room.status = "ended"
    room.winner = winner
    room.lastWinner = winner // Store the last winner

    // Increment the winner's score
    room.players[winner].score += 1

    // Check if this player has reached the ultimate victory threshold
    if (room.players[winner].score >= WINS_TO_ULTIMATE_VICTORY) {
      room.ultimateWinner = winner
    }

    console.log(`Player ${winner} won the game.`)
  } else if (!room.board.includes(null)) {
    room.status = "draw"
  } else {
    // Switch turns
    room.currentTurn = player === "X" ? "O" : "X"
  }

  // Prepare game state update
  const gameState = {
    board: room.board,
    currentTurn: room.currentTurn,
    status: room.status,
    winner: room.winner,
    players: {
      X: {
        name: room.players.X.name,
        connected: room.players.X.connected && !room.players.X.permanentlyDisconnected,
        score: room.players.X.score,
      },
      O: {
        name: room.players.O.name,
        connected: room.players.O.connected && !room.players.O.permanentlyDisconnected,
        score: room.players.O.score,
      },
    },
    ultimateWinner: room.ultimateWinner,
    lastWinner: room.lastWinner,
  }

  console.log("Sending game update after move")

  // Notify both players
  if (room.players.X.ws && room.players.X.ws.readyState === WebSocket.OPEN) {
    room.players.X.ws.send(
      JSON.stringify({
        type: "GAME_UPDATE",
        gameState,
      }),
    )
  }

  if (room.players.O.ws && room.players.O.ws.readyState === WebSocket.OPEN) {
    room.players.O.ws.send(
      JSON.stringify({
        type: "GAME_UPDATE",
        gameState,
      }),
    )
  }
}

// Reset the game
function handleResetGame(event) {
  const { roomCode } = event
  const room = gameRooms.get(roomCode)

  if (!room) {
    console.log("Room not found for reset:", roomCode)
    return
  }

  console.log(`Resetting game in room ${roomCode}`)

  // Reset game state but keep scores
  room.board = Array(9).fill(null)
  room.status = "playing"
  room.winner = null

  // X always starts first (revert to original behavior)
  room.currentTurn = "X"
  console.log("Game reset: X will start the next game")

  // Prepare game state update
  const gameState = {
    board: room.board,
    currentTurn: room.currentTurn,
    status: room.status,
    winner: room.winner,
    players: {
      X: {
        name: room.players.X.name,
        connected: room.players.X.connected && !room.players.X.permanentlyDisconnected,
        score: room.players.X.score,
      },
      O: {
        name: room.players.O.name,
        connected: room.players.O.connected && !room.players.O.permanentlyDisconnected,
        score: room.players.O.score,
      },
    },
    ultimateWinner: room.ultimateWinner,
    lastWinner: room.lastWinner,
  }

  console.log("Reset game state:", gameState)

  // Notify both players
  if (room.players.X.ws && room.players.X.ws.readyState === WebSocket.OPEN) {
    room.players.X.ws.send(
      JSON.stringify({
        type: "GAME_RESET",
        gameState,
      }),
    )
  }

  if (room.players.O.ws && room.players.O.ws.readyState === WebSocket.OPEN) {
    room.players.O.ws.send(
      JSON.stringify({
        type: "GAME_RESET",
        gameState,
      }),
    )
  }
}

// Reset scores
function handleResetScores(event) {
  const { roomCode } = event
  const room = gameRooms.get(roomCode)

  if (!room) {
    console.log("Room not found for score reset:", roomCode)
    return
  }

  console.log(`Resetting scores in room ${roomCode}`)

  // Reset scores and ultimate winner
  room.players.X.score = 0
  room.players.O.score = 0
  room.ultimateWinner = null
  room.lastWinner = null // Reset last winner too

  // Reset game state
  room.board = Array(9).fill(null)
  room.currentTurn = "X" // X starts first after scores reset
  room.status = "playing"
  room.winner = null

  // Prepare game state update
  const gameState = {
    board: room.board,
    currentTurn: room.currentTurn,
    status: room.status,
    winner: room.winner,
    players: {
      X: {
        name: room.players.X.name,
        connected: room.players.X.connected && !room.players.X.permanentlyDisconnected,
        score: room.players.X.score,
      },
      O: {
        name: room.players.O.name,
        connected: room.players.O.connected && !room.players.O.permanentlyDisconnected,
        score: room.players.O.score,
      },
    },
    ultimateWinner: null,
    lastWinner: null,
  }

  console.log("Reset scores game state:", gameState)

  // Notify both players
  if (room.players.X.ws && room.players.X.ws.readyState === WebSocket.OPEN) {
    room.players.X.ws.send(
      JSON.stringify({
        type: "SCORES_RESET",
        gameState,
      }),
    )
  }

  if (room.players.O.ws && room.players.O.ws.readyState === WebSocket.OPEN) {
    room.players.O.ws.send(
      JSON.stringify({
        type: "SCORES_RESET",
        gameState,
      }),
    )
  }
}

// Handle a player leaving
function handleLeaveRoom(ws, event) {
  const { roomCode, player } = event
  const room = gameRooms.get(roomCode)

  if (!room) return

  // Mark player as disconnected
  if (player === "X" || player === "O") {
    room.players[player].connected = false
    room.players[player].ws = null
  }

  // Notify other player
  const otherPlayer = player === "X" ? "O" : "X"
  if (room.players[otherPlayer].ws && room.players[otherPlayer].ws.readyState === WebSocket.OPEN) {
    room.players[otherPlayer].ws.send(
      JSON.stringify({
        type: "OPPONENT_LEFT",
      }),
    )
  }

  // If both players are disconnected, mark room for delayed cleanup
  if (!room.players.X.connected && !room.players.O.connected) {
    if (!room.markedForCleanup) {
      console.log(`Marking room ${roomCode} for cleanup - both players left`)
      room.markedForCleanup = true
      room.cleanupTime = Date.now() + ROOM_PRESERVE_TIME
    }
  }
}

// Handle player disconnection
function handlePlayerDisconnect(ws) {
  if (!ws.roomCode || !ws.player) return

  handleLeaveRoom(ws, {
    roomCode: ws.roomCode,
    player: ws.player,
  })
}

// Check if there's a winner
function calculateWinner(board) {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8], // rows
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8], // columns
    [0, 4, 8],
    [2, 4, 6], // diagonals
  ]

  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a]
    }
  }

  return null
}

// Handle test connection message
function handleTestConnection(ws, event) {
  console.log("Received test connection message:", event)

  // ตรวจสอบว่าเป็นการทดสอบจาก Electron หรือไม่
  const isElectron = event.electron === true

  // ส่งข้อความตอบกลับพร้อมข้อมูลเพิ่มเติม
  const responseMessage = {
    type: "TEST_CONNECTION_RESPONSE",
    originalTimestamp: event.timestamp,
    responseTimestamp: Date.now(),
    message: "Test connection successful!",
    secure: event.secure,
    electron: isElectron,
    serverInfo: {
      nodeVersion: process.version,
      wsProtocol: ws._socket.encrypted ? "WSS" : "WS",
      remoteAddress: ws._socket.remoteAddress,
      environment: process.env.NODE_ENV || "development",
      server: "Tic-Tac-Toe WSS Server",
    },
  }

  console.log("Sending test response:", responseMessage)
  ws.send(JSON.stringify(responseMessage))
}

// Handle ping message
function handlePing(ws, event) {
  console.log("Received PING message with timestamp:", event.timestamp)

  // ส่งข้อความ pong กลับไปยังไคลเอนต์พร้อมข้อมูลเพิ่มเติม
  const pongMessage = {
    type: "PONG",
    originalTimestamp: event.timestamp,
    responseTimestamp: Date.now(),
    serverTime: new Date().toISOString(),
  }

  console.log("Sending PONG response")
  ws.send(JSON.stringify(pongMessage))
}

// API endpoint to check if a room exists
app.get("/api/room/:code", (req, res) => {
  const roomCode = req.params.code
  const roomExists = gameRooms.has(roomCode)

  res.json({ exists: roomExists })
})

// Create SSL directory if it doesn't exist
if (!fs.existsSync("./ssl")) {
  fs.mkdirSync("./ssl")
  console.log("Created ./ssl directory for SSL certificates")
}

// Start the server
const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
  console.log(`WebSocket ${process.env.NODE_ENV === "production" ? "Secure (WSS)" : "WS"} server is ready`)
})
