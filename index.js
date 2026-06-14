const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_CHAT_ID = 489450415;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TASKS_FILE = '/data/tasks.json';
const BACKUP_MARKER = '🗄BACKUP🗄';

// ─── Telegram helpers ─────────────────────────────────────────────
async function tg(method, params) {
  const res = await axios.post(`${TG_API}/${method}`, params);
  return res.data.result;
}

async function sendMessage(chatId, text, parseMode = 'Markdown', extra = {}) {
  try {
    return await tg('sendMessage', { chat_id: chatId, text, parse_mode: parseMode, ...extra });
  } catch (e) {
    console.error('sendMessage error:', e.response?.data || e.message);
  }
}

async function deleteMessage(chatId, messageId) {
  try { await tg('deleteMessage', { chat_id: chatId, message_id: messageId }); } catch (e) {}
}

// ─── Storage ──────────────────────────────────────────────────────
// Основное хранилище — файл на Render
// Резервное — сообщение боту себе (восстанавливается при старте)

let _backupMsgId = null;

function loadFromFile() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { tasks: [], pinned_msg_id: null };
}

function saveToFile(data) {
  try {
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('saveToFile error:', e.message);
  }
}

async function saveBackupToTelegram(data) {
  try {
    const json = JSON.stringify({ tasks: data.tasks, pinned_msg_id: data.pinned_msg_id });
    const text = `${BACKUP_MARKER}\n${json}`;
    if (_backupMsgId) {
      try {
        await tg('editMessageText', { chat_id: OWNER_CHAT_ID, message_id: _backupMsgId, text });
        return;
      } catch (e) { _backupMsgId = null; }
    }
    const msg = await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text,
      disable_notification: true
    });
    _backupMsgId = msg.message_id;
  } catch (e) {
    console.error('saveBackup error:', e.message);
  }
}

async function restoreFromTelegram() {
  // Ищем backup сообщение в последних сообщениях
  try {
    const updates = await tg('getUpdates', { limit: 100, offset: -100 });
    for (const u of (updates || []).reverse()) {
      const msg = u.message;
      if (msg && msg.chat.id === OWNER_CHAT_ID && msg.text && msg.text.startsWith(BACKUP_MARKER)) {
        const json = msg.text.replace(BACKUP_MARKER + '\n', '');
        const data = JSON.parse(json);
        _backupMsgId = msg.message_id;
        return data;
      }
    }
  } catch (e) {}
  return null;
}

async function loadTasks() {
  // Сначала пробуем файл
  const fromFile = loadFromFile();
  if (fromFile.tasks && fromFile.tasks.length > 0) return fromFile;

  // Если файл пуст — восстанавливаем из Telegram
  const fromTelegram = await restoreFromTelegram();
  if (fromTelegram) {
    saveToFile(fromTelegram);
    return fromTelegram;
  }

  return { tasks: [], pinned_msg_id: null };
}

async function saveTasks(data) {
  saveToFile(data);
  await saveBackupToTelegram(data);
}

// ─── Pinned message (красивый список) ────────────────────────────
async function updatePinnedList(data) {
  try {
    // Удаляем старое закреплённое
    if (data.pinned_msg_id) {
      await tg('unpinChatMessage', { chat_id: OWNER_CHAT_ID, message_id: data.pinned_msg_id });
      await deleteMessage(OWNER_CHAT_ID, data.pinned_msg_id);
      data.pinned_msg_id = null;
    }

    const open = data.tasks.filter(t => t.status === 'open' && !isOverdue(t));
    const overdue = data.tasks.filter(t => isOverdue(t));

    // Не закрепляем если задач нет
    if (!open.length && !overdue.length) return;

    let text = '📋 *Задачи*\n';
    const now = new Date().toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    text += `_${now}_\n\n`;

    if (overdue.length) {
      text += '⚠️ *Просроченные:*\n';
      overdue.forEach(t => text += `#${t.id} — ${t.text} 📅 ${formatDate(t.deadline)}\n`);
      text += '\n';
    }
    if (open.length) {
      text += '📌 *Открытые:*\n';
      open.forEach(t => {
        text += `#${t.id} — ${t.text}`;
        if (t.deadline) text += ` 📅 ${formatDate(t.deadline)}`;
        text += '\n';
      });
    }

    const msg = await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_notification: true
    });
    await tg('pinChatMessage', {
      chat_id: OWNER_CHAT_ID,
      message_id: msg.message_id,
      disable_notification: true
    });
    data.pinned_msg_id = msg.message_id;
  } catch (e) {
    console.error('updatePinnedList error:', e.message);
  }
}

// ─── Whisper ──────────────────────────────────────────────────────
async function transcribeAudio(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'voice.ogg', contentType: 'audio/ogg' });
  form.append('model', 'whisper-1');
  form.append('language', 'ru');
  const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${OPENAI_API_KEY}` }
  });
  return res.data.text;
}

async function getFile(fileId) {
  const res = await tg('getFile', { file_id: fileId });
  return res.file_path;
}

async function downloadFile(filePath) {
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ─── GPT-4o ───────────────────────────────────────────────────────
async function parseWithGPT(text) {
  const prompt = `Ты — умный таск-менеджер. Разбери входящее сообщение от пользователя.

Сообщение: """${text}"""

Ответь в JSON:
{
  "type": "tasks" | "command" | "unclear",
  "tasks": [{ "text": "формулировка с глагола", "deadline": "YYYY-MM-DD или null" }],
  "command": "list" | "done" | "delete" | "postpone" | null,
  "command_arg": "номер или текст задачи или null",
  "command_deadline": "YYYY-MM-DD или null",
  "reason": "если unclear"
}

Правила:
- tasks: перефразируй лаконично с глагола, разбей на отдельные если несколько
- command: команды управления списком (показать, закрыть, удалить, перенести)
- unclear: цитата, пересланный текст, вопрос, разговор
- Дедлайн YYYY-MM-DD, сегодня: ${new Date().toISOString().slice(0,10)}
- При сомнении — unclear`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2
  }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });

  return JSON.parse(res.data.choices[0].message.content);
}

// ─── Helpers ──────────────────────────────────────────────────────
function nextTaskId(tasks) {
  if (!tasks.length) return 1;
  return Math.max(...tasks.map(t => t.id)) + 1;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}`;
}

function isOverdue(task) {
  if (!task.deadline || task.status === 'done') return false;
  return task.deadline < new Date().toISOString().slice(0, 10);
}

function formatTaskListFull(data) {
  const open = data.tasks.filter(t => t.status === 'open' && !isOverdue(t));
  const overdue = data.tasks.filter(t => isOverdue(t));
  const done = data.tasks.filter(t => t.status === 'done').slice(-5);

  let msg = '📋 *Твои задачи*\n\n';
  if (overdue.length) {
    msg += '⚠️ *Просроченные:*\n';
    overdue.forEach(t => msg += `#${t.id} — ${t.text} 📅 ${formatDate(t.deadline)}\n`);
    msg += '\n';
  }
  if (open.length) {
    msg += '📌 *Открытые:*\n';
    open.forEach(t => {
      msg += `#${t.id} — ${t.text}`;
      if (t.deadline) msg += ` 📅 ${formatDate(t.deadline)}`;
      msg += '\n';
    });
    msg += '\n';
  }
  if (done.length) {
    msg += '✔️ *Выполненные (последние 5):*\n';
    done.forEach(t => msg += `#${t.id} — ${t.text}\n`);
  }
  if (!open.length && !overdue.length && !done.length) msg += '_Список задач пуст._';
  return msg;
}

function addTasksToData(taskItems, data) {
  const added = [];
  for (const item of taskItems) {
    const newTask = {
      id: nextTaskId(data.tasks),
      text: item.text,
      deadline: item.deadline || null,
      status: 'open',
      created_at: new Date().toISOString().slice(0, 10)
    };
    data.tasks.push(newTask);
    added.push(newTask);
  }
  return added;
}

// ─── Message processor ────────────────────────────────────────────
async function processText(text, data) {
  const lower = text.toLowerCase().trim();

  // Подтверждение/отмена
  if (/^да$/i.test(lower) && data.pending && data.pending.length) {
    const items = [...data.pending];
    delete data.pending;
    const added = addTasksToData(items, data);
    if (added.length === 1) {
      await sendMessage(OWNER_CHAT_ID,
        `✅ *Задача добавлена* (#${added[0].id})\n_${added[0].text}_\n${added[0].deadline ? '📅 ' + formatDate(added[0].deadline) : '📅 Без дедлайна'}`);
    } else {
      const lines = added.map(t => `#${t.id} — ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
      await sendMessage(OWNER_CHAT_ID, `✅ *Добавлено задач: ${added.length}*\n${lines}`);
    }
    return true;
  }

  if (/^нет$/i.test(lower) && data.pending) {
    delete data.pending;
    await sendMessage(OWNER_CHAT_ID, '↩️ Отменено.');
    return false;
  }

  let parsed;
  try {
    parsed = await parseWithGPT(text);
  } catch (e) {
    await sendMessage(OWNER_CHAT_ID, '⚠️ Ошибка обработки, попробуй ещё раз.');
    return false;
  }

  let changed = false;

  if (parsed.type === 'command') {
    switch (parsed.command) {
      case 'list':
        await sendMessage(OWNER_CHAT_ID, formatTaskListFull(data));
        break;

      case 'done': {
        const arg = parsed.command_arg;
        const task = data.tasks.find(t => t.id === parseInt(arg))
          || data.tasks.find(t => t.text.toLowerCase().includes((arg || '').toLowerCase()) && t.status === 'open');
        if (task) {
          task.status = 'done';
          await sendMessage(OWNER_CHAT_ID, `✔️ *Задача выполнена* (#${task.id})\n_${task.text}_`);
          changed = true;
        } else {
          await sendMessage(OWNER_CHAT_ID, `❌ Задача не найдена: _${arg}_`);
        }
        break;
      }

      case 'delete': {
        const idx = data.tasks.findIndex(t => t.id === parseInt(parsed.command_arg));
        if (idx !== -1) {
          const task = data.tasks.splice(idx, 1)[0];
          await sendMessage(OWNER_CHAT_ID, `🗑 *Задача удалена* (#${task.id})\n_${task.text}_`);
          changed = true;
        } else {
          await sendMessage(OWNER_CHAT_ID, `❌ Задача #${parsed.command_arg} не найдена`);
        }
        break;
      }

      case 'postpone': {
        const task = data.tasks.find(t => t.id === parseInt(parsed.command_arg));
        if (task && parsed.command_deadline) {
          task.deadline = parsed.command_deadline;
          await sendMessage(OWNER_CHAT_ID,
            `📅 *Дедлайн обновлён* (#${task.id})\n_${task.text}_\nНовый: ${formatDate(task.deadline)}`);
          changed = true;
        } else {
          await sendMessage(OWNER_CHAT_ID, '❌ Не удалось обновить дедлайн');
        }
        break;
      }

      default:
        await sendMessage(OWNER_CHAT_ID, formatTaskListFull(data));
    }

  } else if (parsed.type === 'tasks' && parsed.tasks && parsed.tasks.length) {
    const added = addTasksToData(parsed.tasks, data);
    if (added.length === 1) {
      await sendMessage(OWNER_CHAT_ID,
        `✅ *Задача добавлена* (#${added[0].id})\n_${added[0].text}_\n${added[0].deadline ? '📅 ' + formatDate(added[0].deadline) : '📅 Без дедлайна'}`);
    } else {
      const lines = added.map(t => `#${t.id} — ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
      await sendMessage(OWNER_CHAT_ID, `✅ *Добавлено задач: ${added.length}*\n${lines}`);
    }
    changed = true;

  } else {
    if (parsed.tasks && parsed.tasks.length) {
      data.pending = parsed.tasks;
      const preview = parsed.tasks.map((t, i) => `${i + 1}. ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
      await sendMessage(OWNER_CHAT_ID, `❓ *Добавить как задачу?*\n${preview}\n\nОтвети *да* или *нет*`);
    } else {
      await sendMessage(OWNER_CHAT_ID, `❓ Не понял — это задача?\n_${parsed.reason || ''}_`);
    }
  }

  return changed;
}

// ─── Webhook ──────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg) return;
    if (msg.chat.id !== OWNER_CHAT_ID) return;

    const data = await loadTasks();
    let text = null;

    if (msg.text) {
      text = msg.text;
    } else if (msg.voice || msg.audio) {
      const fileId = (msg.voice || msg.audio).file_id;
      const filePath = await getFile(fileId);
      const buffer = await downloadFile(filePath);
      text = await transcribeAudio(buffer, 'voice.ogg');
      await sendMessage(OWNER_CHAT_ID, `🎤 _Распознано:_ "${text}"`);
    }

    if (text) {
      const changed = await processText(text, data);
      await saveTasks(data);
      if (changed) await updatePinnedList(data);
      await saveTasks(data); // сохраняем pinned_msg_id
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', bot: 'GALP Task Bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GALP Bot running on port ${PORT}`));
