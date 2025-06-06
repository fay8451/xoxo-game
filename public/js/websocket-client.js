// Simple WebSocket client for the Tic-Tac-Toe game
class WebSocketClient {
  constructor() {
    this.socket = null
    this.listeners = {}
    this.reconnectAttempts = 0
    this.maxReconnectAttempts = 5
    this.reconnectTimeout = null
    this.serverUrl = null
    this.pingTimeout = null
  }

  // Getter to access the socket
  get socket() {
    return this._socket
  }

  // Setter for the socket
  set socket(value) {
    this._socket = value
  }

  // แก้ไขเมธอด connect ในคลาส WebSocketClient
  connect(url = "ws://localhost:3001") {
    this.serverUrl = url

    // แสดงข้อมูลเกี่ยวกับ URL ที่ใช้เชื่อมต่อ
    console.log("WebSocket Connection Details (Verbose):")
    console.log("- URL:", url)
    console.log("- Protocol:", url.startsWith("wss") ? "WSS (Secure)" : "WS (Not Secure)")
    console.log("- Host:", url.replace(/^(wss?:\/\/)/, "").split("/")[0])
    console.log("- Running in Electron:", !!(window && window.process && window.process.type))
    console.log("- User Agent:", navigator.userAgent)

    return new Promise((resolve, reject) => {
      try {
        this._socket = new WebSocket(url)

        this._socket.onopen = () => {
          console.log("WebSocket connected")
          this.reconnectAttempts = 0
          this.heartbeat() // Start the heartbeat when connection opens
          resolve()
        }

        this._socket.onmessage = (event) => {
          try {
            // Check if it's a ping message (usually handled automatically by browser)
            if (event.data === "ping") {
              this._socket.send("pong")
              this.heartbeat()
              return
            }

            const data = JSON.parse(event.data)
            console.log("Received message:", data.type, data) // Add logging for all messages
            this.heartbeat() // Reset the heartbeat on any message
            this.notifyListeners(data.type, data)
          } catch (error) {
            console.error("Error parsing WebSocket message:", error)
          }
        }

        this._socket.onclose = (event) => {
          console.log(`WebSocket disconnected: ${event.code} ${event.reason}`)
          this.clearHeartbeat()
          this.attemptReconnect()
        }

        this._socket.onerror = (error) => {
          console.error("WebSocket error:", error)
          reject(error)
        }
      } catch (error) {
        console.error("Error connecting to WebSocket:", error)
        reject(error)
      }
    })
  }

  // Reset the heartbeat timeout
  heartbeat() {
    this.clearHeartbeat()

    // Set a timeout to detect if the connection is dead
    this.pingTimeout = setTimeout(() => {
      console.log("Connection timed out, closing socket")
      this.socket.close()
    }, 35000) // Slightly longer than the server's ping interval
  }

  // Clear the heartbeat timeout
  clearHeartbeat() {
    if (this.pingTimeout) {
      clearTimeout(this.pingTimeout)
      this.pingTimeout = null
    }
  }

  // Attempt to reconnect to the server
  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log("Max reconnect attempts reached")
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)

    console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`)

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
    }

    this.reconnectTimeout = setTimeout(() => {
      this.connect(this.serverUrl).catch(() => {
        this.attemptReconnect()
      })
    }, delay)
  }

  // Disconnect from the server
  disconnect() {
    this.clearHeartbeat()

    if (this.socket) {
      this.socket.close()
      this.socket = null
    }

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    this.listeners = {}
  }

  // Send an event to the server
  send(event) {
    if (this.isConnected()) {
      console.log("Sending message:", event.type, event) // Add logging for all sent messages
      this._socket.send(JSON.stringify(event))
      return true
    } else {
      console.error("WebSocket is not connected")
      return false
    }
  }

  // Register an event listener
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = []
    }
    this.listeners[event].push(callback)
  }

  // Remove an event listener
  off(event, callback) {
    if (this.listeners[event]) {
      const index = this.listeners[event].indexOf(callback)
      if (index !== -1) {
        this.listeners[event].splice(index, 1)
      }
    }
  }

  // Notify all listeners of an event
  notifyListeners(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((callback) => callback(data))
    }
  }

  // Check if the connection is currently open
  isConnected() {
    return this._socket && this._socket.readyState === WebSocket.OPEN
  }
}

// Create and export a singleton instance
const websocketClient = new WebSocketClient()
