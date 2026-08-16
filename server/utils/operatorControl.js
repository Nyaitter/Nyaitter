'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const MAX_COMMAND_BYTES = 8 * 1024;

function getOperatorSocketPath() {
  if (process.env.NYAITTER_OPERATOR_SOCKET) {
    return process.env.NYAITTER_OPERATOR_SOCKET;
  }

  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\nyaitter-operator';
  }

  return path.join(os.tmpdir(), 'nyaitter-operator.sock');
}

function parseUserId(value) {
  const normalized = String(value ?? '').replace(/^#/, '');
  const userId = Number(normalized);
  if (!Number.isSafeInteger(userId) || userId < 0) return null;
  return userId;
}

function writeResponse(socket, payload) {
  socket.end(`${JSON.stringify(payload)}\n`);
}

function createCommandHandler({ dbAdapter, shutdown, getStatus }) {
  return async (command) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      return { ok: false, error: 'Invalid operator command' };
    }

    if (command.action === 'status') {
      return { ok: true, status: getStatus() };
    }

    if (command.action === 'set-admin') {
      const userId = parseUserId(command.userId);
      if (userId == null || typeof command.admin !== 'boolean') {
        return { ok: false, error: 'set-admin requires a valid userId and boolean admin value' };
      }
      const existing = await dbAdapter.getUserById(userId);
      if (!existing) return { ok: false, error: `User #${userId} was not found` };

      const updated = await dbAdapter.updateUserProfile(userId, { admin: command.admin });
      if (!updated) return { ok: false, error: `Unable to update user #${userId}` };
      return {
        ok: true,
        user: {
          id: Number(updated.id),
          admin: updated.admin === true,
        },
      };
    }

    if (command.action === 'shutdown') {
      // 応答を先に返すため、CLIは停止要求の受領を確認できる。
      setImmediate(() => shutdown('operator-cli'));
      return { ok: true, stopping: true };
    }

    return { ok: false, error: `Unsupported operator action: ${String(command.action)}` };
  };
}

async function removeStaleSocket(socketPath) {
  if (process.platform === 'win32') {
    return;
  }

  try {
    await fs.promises.unlink(socketPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function startOperatorControlServer({ dbAdapter, shutdown, getStatus }) {
  const socketPath = getOperatorSocketPath();
  await removeStaleSocket(socketPath);
  const handleCommand = createCommandHandler({ dbAdapter, shutdown, getStatus });

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let input = '';
    let completed = false;

    const fail = (error) => {
      if (completed) return;
      completed = true;
      writeResponse(socket, { ok: false, error });
    };

    socket.on('data', (chunk) => {
      if (completed) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_COMMAND_BYTES) {
        fail('Operator command is too large');
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      completed = true;
      let command;
      try {
        command = JSON.parse(input.slice(0, newline));
      } catch (_) {
        writeResponse(socket, { ok: false, error: 'Operator command must be JSON' });
        return;
      }
      Promise.resolve(handleCommand(command))
        .then((response) => writeResponse(socket, response))
        .catch((error) => {
          console.error('[operator-control] Command failed:', error);
          writeResponse(socket, { ok: false, error: 'Operator command failed' });
        });
    });

    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ path: socketPath, readableAll: false, writableAll: false }, () => {
      server.off('error', reject);
      resolve();
    });
  });

  if (process.platform !== 'win32') {
    await fs.promises.chmod(socketPath, 0o600);
  }

  return {
    socketPath,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await removeStaleSocket(socketPath);
    },
  };
}

function requestOperatorCommand(command, { timeoutMs = 3000 } = {}) {
  const socketPath = getOperatorSocketPath();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Operator command timed out'));
    }, timeoutMs);

    const finish = (callback) => (value) => {
      clearTimeout(timeout);
      callback(value);
    };

    socket.setEncoding('utf8');
    socket.once('error', finish(reject));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('end', finish(() => {
      try {
        const payload = JSON.parse(response.trim());
        resolve(payload);
      } catch (_) {
        reject(new Error('Invalid response from operator control socket'));
      }
    }));
    socket.once('connect', () => socket.end(`${JSON.stringify(command)}\n`));
  });
}

module.exports = {
  getOperatorSocketPath,
  parseUserId,
  requestOperatorCommand,
  startOperatorControlServer,
};
