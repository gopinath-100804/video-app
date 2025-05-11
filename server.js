require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store active meetings
const meetings = new Map();

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint to check if meeting exists
app.get('/api/meeting/:id', (req, res) => {
  const meetingId = req.params.id;
  res.json({
    exists: meetings.has(meetingId),
    isActive: meetings.has(meetingId) ? meetings.get(meetingId).isActive : false
  });
});

// Generate unique ID
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// Generate meeting ID
function generateMeetingId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 3; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  result += '-';
  for (let i = 0; i < 3; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  result += '-';
  for (let i = 0; i < 3; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

wss.on('connection', (ws) => {
  let participantId = generateId();
  let meetingId = null;
  let participantName = null;
  let isHost = false;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    if (meetingId && meetings.has(meetingId)) {
      const meeting = meetings.get(meetingId);
      if (meeting.participants.has(participantId)) {
        // Notify other participants
        meeting.participants.forEach((p, id) => {
          if (id !== participantId && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify({
              type: 'participant_left',
              participantId,
              participantName
            }));
          }
        });

        // Remove participant
        meeting.participants.delete(participantId);

        // End meeting if host leaves
        if (isHost) {
          meeting.participants.forEach(p => p.ws.close());
          meetings.delete(meetingId);
        }
      }
    }
  });

  function handleMessage(data) {
    switch (data.type) {
      case 'create_meeting':
        handleCreateMeeting(data);
        break;
      case 'join_meeting':
        handleJoinMeeting(data);
        break;
      case 'webrtc_offer':
        handleWebRTCOffer(data);
        break;
      case 'webrtc_answer':
        handleWebRTCAnswer(data);
        break;
      case 'ice_candidate':
        handleICECandidate(data);
        break;
      case 'chat_message':
        handleChatMessage(data);
        break;
      case 'participant_update':
        handleParticipantUpdate(data);
        break;
      default:
        console.warn('Unknown message type:', data.type);
    }
  }

  function handleCreateMeeting(data) {
    meetingId = generateMeetingId();
    participantName = data.name || 'Host';
    isHost = true;

    meetings.set(meetingId, {
      participants: new Map(),
      isActive: true,
      createdAt: new Date()
    });

    const meeting = meetings.get(meetingId);
    meeting.participants.set(participantId, { ws, name: participantName, isHost });

    ws.send(JSON.stringify({
      type: 'meeting_created',
      meetingId,
      participantId
    }));
  }

  function handleJoinMeeting(data) {
    meetingId = data.meetingId;
    participantName = data.name || 'Guest';

    if (!meetings.has(meetingId)) {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Meeting not found'
      }));
      return;
    }

    const meeting = meetings.get(meetingId);
    meeting.participants.set(participantId, { ws, name: participantName, isHost: false });

    // Send list of existing participants to new joiner
    const participants = Array.from(meeting.participants.entries())
      .filter(([id]) => id !== participantId)
      .map(([id, p]) => ({ id, name: p.name }));

    ws.send(JSON.stringify({
      type: 'meeting_joined',
      meetingId,
      participantId,
      participants
    }));

    // Notify others about new participant
    meeting.participants.forEach((p, id) => {
      if (id !== participantId && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({
          type: 'participant_joined',
          participantId,
          participantName
        }));
      }
    });
  }

  function handleWebRTCOffer(data) {
    const meeting = meetings.get(meetingId);
    if (!meeting) return;

    const targetParticipant = meeting.participants.get(data.target);
    if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
      targetParticipant.ws.send(JSON.stringify({
        type: 'webrtc_offer',
        sender: participantId,
        offer: data.offer
      }));
    }
  }

  function handleWebRTCAnswer(data) {
    const meeting = meetings.get(meetingId);
    if (!meeting) return;

    const targetParticipant = meeting.participants.get(data.target);
    if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
      targetParticipant.ws.send(JSON.stringify({
        type: 'webrtc_answer',
        sender: participantId,
        answer: data.answer
      }));
    }
  }

  function handleICECandidate(data) {
    const meeting = meetings.get(meetingId);
    if (!meeting) return;

    const targetParticipant = meeting.participants.get(data.target);
    if (targetParticipant && targetParticipant.ws.readyState === WebSocket.OPEN) {
      targetParticipant.ws.send(JSON.stringify({
        type: 'ice_candidate',
        sender: participantId,
        candidate: data.candidate
      }));
    }
  }

  function handleChatMessage(data) {
    const meeting = meetings.get(meetingId);
    if (!meeting) return;

    meeting.participants.forEach((p, id) => {
      if (id !== participantId && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({
          type: 'chat_message',
          sender: participantId,
          senderName: participantName,
          message: data.message,
          timestamp: new Date().toISOString()
        }));
      }
    });
  }

  function handleParticipantUpdate(data) {
    const meeting = meetings.get(meetingId);
    if (!meeting) return;

    meeting.participants.forEach((p, id) => {
      if (id !== participantId && p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify({
          type: 'participant_update',
          participantId,
          ...data
        }));
      }
    });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});