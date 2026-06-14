const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_CHAT_ID = 489450415;
const TASKS_FILE = path.join('/tmp', 'tasks.json');

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Tasks storage ───────────────────────────────────────────────
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    }
  } catch (e) {}
  return { last_update_id: 0, tasks: [] };
}

function saveTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

// ─── Telegram helpers ─────────────────────────────────────────────
async function sendMessage(chatId, text, parseMode = 'Markdown') {
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode
    });
  } catch (e) {
    console.error('sendMessage error:', e.response?.data || e.message);
  }
}

async function getFile(fileId) {
  const res = await axios.get(`${TG_API}/getFile?file_id=${fileId}`);
  return res.data.result.file_path;
}

async function downloadFile(filePath) {
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ─── Whisper transcription ────────────────────────────────────────
async function transcribeAudio(buffer, filename) {
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'voice.ogg', contentType: 'audio/ogg' });
  form.append('model', 'whisper-1');
  form.append('language', 'ru');

  const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    }
  });
  return res.data.text;
}

// ─── Task logic ───────────────────────────────────────────────────
function parseDeadline(text) {
  const months = {
    'янв': '01', 'фев': '02', 'мар': '03', 'апр': '04',
    'май': '05', 'мая': '05', 'июн': '06', 'июл': '07',
    'авг': '08', 'сен': '09', 'окт': '10', 'ноя': '11', 'дек': '12'
  };

  const now = new Date();
  const year = now.getFullYear();

  // "до 20 июня", "до 20.06", "до 20/06"
  const m1 = text.match(/до\s+(\d{1,2})[.\s\/](\d{1,2})/i);
  if (m1) return `${year}-${m1[2].padStart(2,'0')}-${m1[1].padStart(2,'0')}`;

  // "до 20 июня 2026"
  const m2 = text.match(/до\s+(\d{1,2})\s+(янв|фев|мар|апр|май|мая|июн|июл|авг|сен|окт|ноя|дек)\w*(?:\s+(\d{4}))?/i);
  if (m2) {
    const mon = months[m2[2].toLowerCase().slice(0,3)];
    const yr = m2[3] || year;
    return `${yr}-${mon}-${m2[1].padStart(2,'0')}`;
  }

  // "до пятницы / до конца недели"
  const weekdays = { 'понедельник': 1, 'вторник': 2, 'среда': 3, 'четверг': 4, 'пятница': 5, 'суббота': 6, 'воскресенье': 0 };
  const m3 = text.match(/до\s+(понедельник|вторник|среду?|четверг|пятниц[ыу]?|субботы?|воскресенья?)/i);
  if (m3) {
    const dayName = m3[1].toLowerCase();
    const target = Object.entries(weekdays).find(([k]) => dayName.startsWith(k.slice(0,4)));
    if (target) {
      const d = new Date(now);
      const diff = (target[1] - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      return d.toISOString().slice(0,10);
    }
  }

  // "до конца недели"
  if (/до конца недели/i.test(text)) {
    const d = new Date(now);
    const diff = (5 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0,10);
  }

  return null;
}

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

  if (!open.length && !overdue.length && !done.length) {
    msg += '_Список задач пуст._';
  }

  return msg;
}

// ─── Message processor ────────────────────────────────────────────
async function processText(text, data) {
  const lower = text.toLowerCase().trim();

  // Показать список
  if (/^(список|задачи|что у меня|покажи задачи|мои задачи)$/i.test(lower)) {
    await sendMessage(OWNER_CHAT_ID, formatTaskList(data));
    return;
  }

  // Закрыть задачу
  const doneMatch = lower.match(/^(готово|done|закрыть|выполнено|закончил|сделал)[:\s]+(.+)$/i)
    || lower.match(/^#?(\d+)\s+(готово|done|закрыть|выполнено|закончил|сделал)$/i);
  if (doneMatch) {
    const query = doneMatch[2] || doneMatch[1];
    const byId = data.tasks.find(t => t.id === parseInt(query));
    const byText = data.tasks.find(t => t.text.toLowerCase().includes(query.toLowerCase()) && t.status === 'open');
    const task = byId || byText;
    if (task) {
      task.status = 'done';
      await sendMessage(OWNER_CHAT_ID, `✔️ *Задача выполнена* (#${task.id})\n_${task.text}_`);
    } else {
      await sendMessage(OWNER_CHAT_ID, `❌ Задача не найдена: _${query}_`);
    }
    return;
  }

  // Перенести дедлайн
  const moveMatch = text.match(/перенести\s+#?(\d+)\s+на\s+(.+)/i);
  if (moveMatch) {
    const task = data.tasks.find(t => t.id === parseInt(moveMatch[1]));
    if (task) {
      const newDeadline = parseDeadline('до ' + moveMatch[2]);
      task.deadline = newDeadline;
      await sendMessage(OWNER_CHAT_ID, `📅 *Дедлайн обновлён* (#${task.id})\n_${task.text}_\nНовый дедлайн: ${newDeadline ? formatDate(newDeadline) : 'без дедлайна'}`);
    } else {
      await sendMessage(OWNER_CHAT_ID, `❌ Задача #${moveMatch[1]} не найдена`);
    }
    return;
  }

  // Удалить задачу
  const delMatch = text.match(/удалить\s+#?(\d+)/i);
  if (delMatch) {
    const idx = data.tasks.findIndex(t => t.id === parseInt(delMatch[1]));
    if (idx !== -1) {
      const task = data.tasks.splice(idx, 1)[0];
      await sendMessage(OWNER_CHAT_ID, `🗑 *Задача удалена* (#${task.id})\n_${task.text}_`);
    } else {
      await sendMessage(OWNER_CHAT_ID, `❌ Задача #${delMatch[1]} не найдена`);
    }
    return;
  }

  // Добавить задачу (всё остальное)
  const deadline = parseDeadline(text);
  const cleanText = text
    .replace(/до\s+\d{1,2}[.\s\/]\d{1,2}(\.\d{4})?/gi, '')
    .replace(/до\s+\d{1,2}\s+(янв|фев|мар|апр|май|мая|июн|июл|авг|сен|окт|ноя|дек)\w*/gi, '')
    .replace(/до\s+(понедельник|вторник|среду?|четверг|пятниц[ыу]?|субботы?|воскресенья?)/gi, '')
    .replace(/до конца недели/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  const newTask = {
    id: nextTaskId(data.tasks),
    text: cleanText,
    deadline,
    status: 'open',
    created_at: new Date().toISOString().slice(0,10),
    category: 'work'
  };
  data.tasks.push(newTask);

  let reply = `✅ *Задача добавлена* (#${newTask.id})\n_${newTask.text}_\n`;
  reply += deadline ? `📅 Дедлайн: ${formatDate(deadline)}` : `📅 Без дедлайна`;
  await sendMessage(OWNER_CHAT_ID, reply);
}

// ─── Webhook handler ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Отвечаем Telegram сразу

  try {
    const update = req.body;
    const msg = update.message || update.edited_message;
    if (!msg) return;

    // Только сообщения от владельца
    if (msg.chat.id !== OWNER_CHAT_ID) return;

    const data = loadTasks();
    let text = null;

    if (msg.text) {
      text = msg.text;
    } else if (msg.voice || msg.audio) {
      const fileId = (msg.voice || msg.audio).file_id;
      const filePath = await getFile(fileId);
      const buffer = await downloadFile(filePath);
      text = await transcribeAudio(buffer, 'voice.ogg');

      // Отправляем расшифровку чтобы пользователь видел что понял бот
      await sendMessage(OWNER_CHAT_ID, `🎤 _Распознано:_ "${text}"`);
    }

    if (text) {
      await processText(text, data);
      saveTasks(data);
    }

  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ─── Health check ─────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', bot: 'GALP Task Bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GALP Bot running on port ${PORT}`));
