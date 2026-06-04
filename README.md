# LocalChat

LocalChat is a real-time room-based chat app built with HTML, CSS, Vanilla JavaScript, Node.js, Express, Socket.IO, and WebRTC.

It supports text chat, voice chat, video chat, rooms, participant lists, media status indicators, and system messages when users join or leave.

## Features

- Create and join rooms by Room ID
- Real-time text chat with sender name and timestamp
- Voice and video chat with WebRTC
- Socket.IO signaling for offers, answers, and ICE candidates
- Participant list
- Microphone and camera status indicators for every participant
- System messages for user join and leave events
- Optional password-protected rooms
- Responsive dark meeting-style interface
- PWA manifest and service worker
- Basic production security headers and rate limits
- No database
- No Firebase or Supabase
- No React, Vue, or TypeScript

## Project Structure

```text
project/
|-- public/
|   |-- index.html
|   |-- style.css
|   |-- app.js
|   |-- manifest.json
|   |-- sw.js
|   `-- icon.svg
|-- server.js
|-- package.json
|-- package-lock.json
|-- .env.example
|-- .gitignore
|-- LICENSE
`-- README.md
```

## Requirements

- Node.js 18 or newer
- npm
- A modern browser with WebRTC support

## Installation

```bash
npm install
```

## Running Locally

```bash
npm start
```

Open:

```text
http://localhost:3000
```

To test a room, open the same URL in two browser tabs or two devices on the same network, enter different usernames, and use the same Room ID.

## Render Deployment

Use these settings on Render:

```text
Build Command: npm install
Start Command: npm start
```

Render automatically provides `PORT`, and the server already reads it through `process.env.PORT`.

Recommended environment variables:

```text
MAX_PARTICIPANTS_PER_ROOM=8
TURN_URLS=turn:your-turn-host:3478,turn:your-turn-host:3478?transport=tcp,turns:your-turn-host:443?transport=tcp
TURN_SECRET=your-turn-rest-secret
TURN_USERNAME=your-turn-username
TURN_CREDENTIAL=your-turn-password
```

`TURN_URLS` with `TURN_SECRET` is preferred for temporary TURN credentials. `TURN_URL` is also supported for a single URL. `TURN_USERNAME` and `TURN_CREDENTIAL` are supported as a static fallback. TURN is optional for same-network testing, but strongly recommended for reliable voice and video between users on different networks.

To confirm TURN is active after deployment, open:

```text
https://your-render-app.onrender.com/api/ice-servers
```

The response should include:

```json
{
  "turnConfigured": true
}
```

If it returns `false`, users may enter the same room successfully while voice/video fails across different networks.

## Security

The server includes:

- Helmet security headers
- HTTP rate limiting
- Socket.IO rate limiting for joins, messages, media state, and WebRTC signaling
- Room ID validation
- Username validation
- Message length limits
- Maximum participants per room
- Optional room passwords stored as salted PBKDF2 hashes in server memory
- Same-room checks for WebRTC signaling events
- No database persistence
- Escaped text rendering in the browser through `textContent`

For public production use, prefer temporary TURN credentials, add stronger abuse monitoring, and add user authentication if private rooms require identity.

## Notes

- Browsers require camera and microphone permission before joining a room.
- `localhost` works for local development.
- HTTPS is required for camera and microphone access on public deployments.
- For real deployment across different networks, add a TURN server. STUN alone is not enough for all NAT/firewall cases.
- This project stores room state in memory only. Restarting the server clears all active rooms.

## Future Improvements

- Screen sharing
- File sharing
- Private rooms
- Password-protected rooms
- Recording
- PWA support
- End-to-end encryption
- Temporary TURN credentials
- Better mobile call controls
- User avatars

## License

MIT
