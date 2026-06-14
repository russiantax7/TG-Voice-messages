const express = require('express');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_CHAT_ID = 489450415;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const STORAGE_MARKER = '📦TASKS_STORAGE📦';

// ─── Telegram helpers ─────────────────────────────────────────────
async function tg(method, params) {
  const res = await axios.post(`${TG_API}/${method}`, params);
  return res.data.result;
}

async function sendMessage(chatId, text, parseMode = 'Markdown') {
  try {
    return await tg('sendMessage', { chat_id: chatId, text, parse_mode: parseMode });
  } catch (e) {
    console.error('sendMessage error:', e.response?.data || e.message);
  }
}

// ─── Telegram-based storage ───────────────────────────────────────
// Задачи хранятся в закреплённом сообщении в личке с ботом
// Формат: STORAGE_MARKER\n<JSON>

async function loadTasks() {
  try {
    const chat = await tg('getChat', { chat_id: OWNER_CHAT_ID });
    if (chat.pinned_message && chat.pinned_message.text && chat.pinned_message.text.startsWith(STORAGE_MARKER)) {
      const json = chat.pinned_message.text.replace(STORAGE_MARKER + '\n', '');
      const data = JSON.parse(json);
      data._pinned_message_id = chat.pinned_message.message_id;
      return data;
    }
  } catch (e) {
    console.error('loadTasks error:', e.message);
  }
  return { tasks: [], _pinned_message_id: null };
}

async function saveTasks(data) {
  try {
    const pinnedId = data._pinned_message_id;
    const payload = { ...data };
    delete payload._pinned_message_id;

    const json = JSON.stringify(payload);
    const text = `${STORAGE_MARKER}\n${json}`;

    if (pinnedId) {
      // Обновляем существующее сообщение
      try {
        await tg('editMessageText', {
          chat_id: OWNER_CHAT_ID,
          message_id: pinnedId,
          text
        });
        return;
      } catch (e) {
        // Сообщение удалено — создадим новое
      }
    }

    // Создаём новое закреплённое сообщение
    const msg = await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text,
      disable_notification: true
    });
    await tg('pinChatMessage', {
      chat_id: OWNER_CHAT_ID,
      message_id: msg.message_id,
      disable_notification: true
    });
  } catch (e) {
    console.error('saveTasks error:', e.message);
  }
}

// ─── Whisper transcription ────────────────────────────────────────
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

// ─── GPT-4o: parse message into tasks ────────────────────────────
async function parseWithGPT(text) {
  const prompt = `Ты — умный таск-менеджер. Разбери входящее сообщение от пользователя.

Входящее сообщение:
"""
${text}
"""

Определи:
1. Является ли это задачей (или несколькими задачами), командой управления списком, или просто разговором/цитатой/пересланным текстом.
2. Если задача(и) — раздели на отдельные, перефразируй каждую чётко и кратко, извлеки дедлайн если указан.
3. Если НЕ задача — объясни почему.

Ответь строго в формате JSON:
{
  "type": "tasks" | "command" | "unclear",
  "tasks": [
    {
      "text": "Чёткая формулировка задачи начиная с глагола",
      "deadline": "YYYY-MM-DD или null"
    }
  ],
  "command": "list" | "done" | "delete" | "postpone" | null,
  "command_arg": "номер задачи или текст или null",
  "command_deadline": "YYYY-MM-DD или null",
  "reason": "объяснение если unclear"
}

Правила:
- tasks заполняй только если type="tasks"
- command заполняй только если type="command"  
- Если несколько задач в одном сообщении — все в массиве tasks
- Дедлайн в формате YYYY-MM-DD, если не указан — null
- Сегодня: ${new Date().toISOString().slice(0,10)}
- Перефразируй лаконично на русском, начиная с глагола
- Если сомневаешься — type="unclear"`;

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.2
  }, {
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' }
  });

  return JSON.parse(res.data.choices[0].message.content);
}

// ─── Task helpers ─────────────────────────────────────────────────
function nextTaskId(tasks) {
  if (!tasks.length) return 1;
  return Math.max(...tasks.map(t => t.id)) + 1;
}

function formatDate(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

function isOverdue(task) {
  if (!task.deadline || task.status === 'done') return false;
  return task.deadline < new Date().toISOString().slice(0,10);
}

function formatTaskList(data) {
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

  // Подтверждение/отмена ожидающих задач
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
    return;
  }

  if (/^нет$/i.test(lower) && data.pending) {
    delete data.pending;
    await sendMessage(OWNER_CHAT_ID, '↩️ Отменено.');
    return;
  }

  // GPT разбор
  let parsed;
  try {
    parsed = await parseWithGPT(text);
  } catch (e) {
    console.error('GPT error:', e.message);
    await sendMessage(OWNER_CHAT_ID, '⚠️ Ошибка обработки, попробуй ещё раз.');
    return;
  }

  if (parsed.type === 'command') {
    switch (parsed.command) {
      case 'list':
        await sendMessage(OWNER_CHAT_ID, formatTaskList(data));
        break;

      case 'done': {
        const arg = parsed.command_arg;
        const byId = data.tasks.find(t => t.id === parseInt(arg));
        const byText = data.tasks.find(t => t.text.toLowerCase().includes((arg || '').toLowerCase()) && t.status === 'open');
        const task = byId || byText;
        if (task) {
          task.status = 'done';
          await sendMessage(OWNER_CHAT_ID, `✔️ *Задача выполнена* (#${task.id})\n_${task.text}_`);
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
            `📅 *Дедлайн обновлён* (#${task.id})\n_${task.text}_\nНовый дедлайн: ${formatDate(task.deadline)}`);
        } else {
          await sendMessage(OWNER_CHAT_ID, '❌ Не удалось обновить дедлайн');
        }
        break;
      }

      default:
        await sendMessage(OWNER_CHAT_ID, formatTaskList(data));
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

  } else {
    // unclear
    if (parsed.tasks && parsed.tasks.length) {
      data.pending = parsed.tasks;
      const preview = parsed.tasks.map((t, i) => `${i + 1}. ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
      await sendMessage(OWNER_CHAT_ID, `❓ *Добавить как задачу?*\n${preview}\n\nОтвети *да* или *нет*`);
    } else {
      await sendMessage(OWNER_CHAT_ID, `❓ Не понял — это задача? Перефразируй чётче.\n_${parsed.reason || ''}_`);
    }
  }
}

// ─── Webhook handler ──────────────────────────────────────────────
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
      await processText(text, data);
      await saveTasks(data);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', bot: 'GALP Task Bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GALP Bot running on port ${PORT}`));
