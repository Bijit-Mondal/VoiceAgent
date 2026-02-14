#!/bin/bash

# Kill any previously running servers
echo "Cleaning up any existing processes..."
pkill -f "node.*example/serve-client.js" || true
pkill -f "tsx.*example/ws-server.ts" || true

echo "Starting WebSocket server..."
npm run ws:server &
WS_SERVER_PID=$!

# Sleep to ensure WebSocket server has time to start
sleep 2

echo "Starting web client server..."
npm run client &
CLIENT_SERVER_PID=$!

echo "✅ Test environment started!"
echo "📱 Open http://localhost:3000 in your browser"
echo ""
echo "Press Ctrl+C to shut down both servers"

# Wait for user to Ctrl+C
trap "kill $WS_SERVER_PID $CLIENT_SERVER_PID; echo 'Servers stopped'; exit" INT
wait