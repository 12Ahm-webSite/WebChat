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
- Responsive dark meeting-style interface
- No database
- No Firebase or Supabase
- No React, Vue, or TypeScript

## Project Structure

```text
project/
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── server.js
├── package.json
├── package-lock.json
├── .gitignore
├── LICENSE
└── README.md
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

## Notes

- Browsers require camera and microphone permission before joining a room.
- `localhost` works for local development.
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
- TURN server configuration
- Better mobile call controls
- User avatars

## License

MIT
