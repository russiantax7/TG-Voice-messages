const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { google } = require('googleapis');

// ─── Google Calendar ──────────────────────────────────────────────
const CALENDAR_ID = 'aguskov@galp.ru';
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');

function getCalendarClient() {
  const auth = new google.auth.JWT(
    GOOGLE_CREDENTIALS.client_email,
    null,
    GOOGLE_CREDENTIALS.private_key,
    ['https://www.googleapis.com/auth/calendar']
  );
  return google.calendar({ version: 'v3', auth });
}

async function createCalendarEvent(summary, startDateTime, endDateTime, description) {
  const calendar = getCalendarClient();
  const event = {
    summary,
    description: description || '',
    start: { dateTime: startDateTime, timeZone: 'Europe/Moscow' },
    end:   { dateTime: endDateTime,   timeZone: 'Europe/Moscow' }
  };
  const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: event });
  return res.data;
}

async function parseCalendarEvent(text) {
  // Используем GPT чтобы распарсить дату/время/название события
  const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: `Ты парсишь текст и извлекаешь событие для календаря. Сегодня: ${today} (часовой пояс Europe/Moscow). Верни JSON: {"summary": "название", "start": "YYYY-MM-DDTHH:MM:SS", "end": "YYYY-MM-DDTHH:MM:SS", "is_event": true/false}. Если это не событие/встреча — верни is_event: false. Если время окончания не указано — добавь 1 час к началу. Верни только JSON без markdown.` },
      { role: 'user', content: text }
    ],
    temperature: 0
  }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
  return JSON.parse(res.data.choices[0].message.content);
}

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_CHAT_ID = 489450415;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TASKS_FILE = '/data/tasks.json';
const MESSAGES_FILE = '/data/messages.json';

// Известные рабочие чаты
const WORK_CHATS = new Set([-462206422, -788559454, -5570418094, -5161080891, -5077349043]);
const CHAT_NAMES = {
  '-462206422': 'GALP Tax',
  '-788559454': 'GALP Incorporation',
  '-5570418094': 'PA Shindyaeva',
  '-5161080891': 'AG, SB, YK',
  '-5077349043': 'Taneev House'
};

// ─── Telegram helpers ─────────────────────────────────────────────
async function tg(method, params) {
  const res = await axios.post(`${TG_API}/${method}`, params);
  return res.data.result;
}

async function sendMessage(text, parseMode = 'Markdown') {
  try {
    return await tg('sendMessage', { chat_id: OWNER_CHAT_ID, text, parse_mode: parseMode });
  } catch (e) {
    console.error('sendMessage error:', e.response?.data || e.message);
  }
}

async function deleteMessage(messageId) {
  try { await tg('deleteMessage', { chat_id: OWNER_CHAT_ID, message_id: messageId }); } catch (e) {}
}

// ─── Tasks storage ────────────────────────────────────────────────
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch (e) {}
  return { tasks: [], pinned_msg_id: null };
}

function saveTasks(data) {
  try { fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2)); } catch (e) {
    console.error('saveTasks error:', e.message);
  }
}

// ─── Chat messages storage ────────────────────────────────────────
// Накапливаем сообщения из рабочих чатов для дневного резюме
function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) return JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function saveMessages(messages) {
  try { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2)); } catch (e) {}
}

function storeGroupMessage(msg) {
  const messages = loadMessages();
  const chatId = msg.chat.id;
  const from = msg.from?.first_name || msg.from?.username || 'Unknown';
  const text = msg.text || msg.caption || '[медиа]';
  messages.push({
    chat_id: chatId,
    chat_name: CHAT_NAMES[String(chatId)] || String(chatId),
    from,
    text,
    date: msg.date
  });
  // Храним только последние 7 дней
  const cutoff = Date.now() / 1000 - 7 * 24 * 3600;
  saveMessages(messages.filter(m => m.date > cutoff));
}

// ─── Pinned list ──────────────────────────────────────────────────
async function updatePinnedList(data) {
  try {
    if (data.pinned_msg_id) {
      try { await tg('unpinChatMessage', { chat_id: OWNER_CHAT_ID, message_id: data.pinned_msg_id }); } catch (e) {}
      await deleteMessage(data.pinned_msg_id);
      data.pinned_msg_id = null;
    }

    const open = data.tasks.filter(t => t.status === 'open' && !isOverdue(t));
    const overdue = data.tasks.filter(t => isOverdue(t));
    if (!open.length && !overdue.length) return;

    const now = new Date().toLocaleString('ru-RU', {
      timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });

    let text = `📋 *Задачи* _${now}_\n\n`;
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
      chat_id: OWNER_CHAT_ID, text, parse_mode: 'Markdown', disable_notification: true
    });
    await tg('pinChatMessage', {
      chat_id: OWNER_CHAT_ID, message_id: msg.message_id, disable_notification: true
    });
    data.pinned_msg_id = msg.message_id;
  } catch (e) {
    console.error('updatePinnedList error:', e.message);
  }
}

// ─── Whisper ──────────────────────────────────────────────────────
async function transcribeAudio(buffer) {
  const form = new FormData();
  form.append('file', buffer, { filename: 'voice.ogg', contentType: 'audio/ogg' });
  form.append('model', 'whisper-1');
  form.append('language', 'ru');
  const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${OPENAI_API_KEY}` }
  });
  return res.data.text;
}

async function downloadVoice(fileId) {
  const file = await tg('getFile', { file_id: fileId });
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

// ─── GPT helpers ──────────────────────────────────────────────────
async function parseWithGPT(text) {
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: `Ты — таск-менеджер. Разбери сообщение пользователя.

Сообщение: """${text}"""

Ответь в JSON:
{
  "type": "tasks" | "command" | "unclear",
  "tasks": [{ "text": "формулировка с глагола", "deadline": "YYYY-MM-DD или null" }],
  "command": "list" | "done" | "delete" | "postpone" | "pin" | null,
  "command_arg": "номер или текст задачи или null",
  "command_deadline": "YYYY-MM-DD или null",
  "reason": "если unclear"
}

Правила:
- tasks: перефразируй лаконично с глагола, разбей на отдельные если несколько
- command: list=показать список, done=выполнено, delete=удалить, postpone=перенести дедлайн, pin=закрепить/обновить список
- unclear: цитата, пересланный текст, вопрос, разговор
- Сегодня: ${new Date().toISOString().slice(0, 10)}`
    }],
    response_format: { type: 'json_object' },
    temperature: 0.2
  }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });
  return JSON.parse(res.data.choices[0].message.content);
}

async function makeDailySummary(messages) {
  const dateStr = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' });

  if (!messages.length) {
    return `📋 *Резюме дня — ${dateStr}*\n\n_Сообщений в рабочих чатах сегодня не было._`;
  }

  const msgText = messages.map(m => `[${m.chat_name}] ${m.from}: ${m.text}`).join('\n');

  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [{
      role: 'user',
      content: `Составь краткое резюме рабочего дня команды GALP по переписке. Сегодня ${dateStr}.

Переписка:
${msgText}

Формат (Markdown):
📋 *Резюме дня — ${dateStr}*

*Ключевые темы:*
— ...

*Решено:*
— ...

*В работе / Открытые вопросы:*
— ...

*Итог дня:* одна фраза.`
    }],
    temperature: 0.3
  }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });

  return res.data.choices[0].message.content;
}

// ─── Helpers ──────────────────────────────────────────────────────
function nextId(tasks) {
  return tasks.length ? Math.max(...tasks.map(t => t.id)) + 1 : 1;
}

function formatDate(d) {
  if (!d) return null;
  const [y, m, day] = d.split('-');
  return `${day}.${m}`;
}

function isOverdue(task) {
  if (!task.deadline || task.status === 'done') return false;
  return task.deadline < new Date().toISOString().slice(0, 10);
}

function fullList(data) {
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
    open.forEach(t => { msg += `#${t.id} — ${t.text}`; if (t.deadline) msg += ` 📅 ${formatDate(t.deadline)}`; msg += '\n'; });
    msg += '\n';
  }
  if (done.length) {
    msg += '✔️ *Выполненные (последние 5):*\n';
    done.forEach(t => msg += `#${t.id} — ${t.text}\n`);
  }
  if (!open.length && !overdue.length && !done.length) msg += '_Список задач пуст._';
  return msg;
}

function addTasks(items, data) {
  return items.map(item => {
    const t = { id: nextId(data.tasks), text: item.text, deadline: item.deadline || null, status: 'open', created_at: new Date().toISOString().slice(0, 10) };
    data.tasks.push(t);
    return t;
  });
}

// ─── Message processor (личка) ────────────────────────────────────
async function processText(text, data) {
  const lower = text.toLowerCase().trim();

  if (/^да$/i.test(lower) && data.pending?.length) {
    const added = addTasks(data.pending, data);
    delete data.pending;
    const lines = added.map(t => `#${t.id} — ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
    await sendMessage(added.length === 1
      ? `✅ *Задача добавлена* (#${added[0].id})\n_${added[0].text}_\n${added[0].deadline ? '📅 ' + formatDate(added[0].deadline) : '📅 Без дедлайна'}`
      : `✅ *Добавлено задач: ${added.length}*\n${lines}`);
    return true;
  }

  if (/^нет$/i.test(lower) && data.pending) {
    delete data.pending;
    await sendMessage('↩️ Отменено.');
    return false;
  }

  let parsed;
  try { parsed = await parseWithGPT(text); }
  catch (e) { await sendMessage('⚠️ Ошибка обработки, попробуй ещё раз.'); return false; }

  let changed = false;

  if (parsed.type === 'command') {
    switch (parsed.command) {
      case 'list':
        await sendMessage(fullList(data)); break;

      case 'done': {
        const arg = parsed.command_arg;
        const task = data.tasks.find(t => t.id === parseInt(arg) && t.status === 'open')
          || data.tasks.find(t => t.text.toLowerCase().includes((arg || '').toLowerCase()) && t.status === 'open');
        if (task) { task.status = 'done'; await sendMessage(`✔️ *Задача выполнена* (#${task.id})\n_${task.text}_`); changed = true; }
        else await sendMessage(`❌ Задача не найдена: _${arg}_`);
        break;
      }

      case 'delete': {
        const idx = data.tasks.findIndex(t => t.id === parseInt(parsed.command_arg));
        if (idx !== -1) { const t = data.tasks.splice(idx, 1)[0]; await sendMessage(`🗑 *Задача удалена* (#${t.id})\n_${t.text}_`); changed = true; }
        else await sendMessage(`❌ Задача #${parsed.command_arg} не найдена`);
        break;
      }

      case 'postpone': {
        const task = data.tasks.find(t => t.id === parseInt(parsed.command_arg));
        if (task && parsed.command_deadline) { task.deadline = parsed.command_deadline; await sendMessage(`📅 *Дедлайн обновлён* (#${task.id})\n_${task.text}_\nНовый: ${formatDate(task.deadline)}`); changed = true; }
        else await sendMessage('❌ Не удалось обновить дедлайн');
        break;
      }

      case 'pin':
        await updatePinnedList(data);
        saveTasks(data);
        break;

      default: await sendMessage(fullList(data));
    }

  } else if (parsed.type === 'tasks' && parsed.tasks?.length) {
    const added = addTasks(parsed.tasks, data);
    const lines = added.map(t => `#${t.id} — ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
    await sendMessage(added.length === 1
      ? `✅ *Задача добавлена* (#${added[0].id})\n_${added[0].text}_\n${added[0].deadline ? '📅 ' + formatDate(added[0].deadline) : '📅 Без дедлайна'}`
      : `✅ *Добавлено задач: ${added.length}*\n${lines}`);
    changed = true;

  } else {
    if (parsed.tasks?.length) {
      data.pending = parsed.tasks;
      const preview = parsed.tasks.map((t, i) => `${i + 1}. ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
      await sendMessage(`❓ *Добавить как задачу?*\n${preview}\n\nОтвети *да* или *нет*`);
    } else {
      await sendMessage(`❓ Не понял — это задача?\n_${parsed.reason || ''}_`);
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

    const chatId = msg.chat.id;

    // Сообщение из рабочего чата — сохраняем для резюме
    if (WORK_CHATS.has(chatId)) {
      if (msg.text || msg.caption) {
        storeGroupMessage(msg);
      } else if (msg.voice || msg.audio) {
        try {
          const buffer = await downloadVoice((msg.voice || msg.audio).file_id);
          const transcribed = await transcribeAudio(buffer);
          // Сохраняем как обычное сообщение с пометкой 🎤
          const from = msg.from?.first_name || msg.from?.username || 'Unknown';
          const messages = loadMessages();
          messages.push({
            chat_id: chatId,
            chat_name: CHAT_NAMES[String(chatId)] || String(chatId),
            from,
            text: `🎤 ${transcribed}`,
            date: msg.date
          });
          const cutoff = Date.now() / 1000 - 7 * 24 * 3600;
          saveMessages(messages.filter(m => m.date > cutoff));
        } catch (e) {
          console.error('Group voice transcription error:', e.message);
        }
      }
      return;
    }

    // Личка с владельцем — таск-менеджер
    if (chatId !== OWNER_CHAT_ID) return;

    const data = loadTasks();
    let text = null;

    if (msg.text) {
      text = msg.text;
    } else if (msg.voice || msg.audio) {
      const buffer = await downloadVoice((msg.voice || msg.audio).file_id);
      text = await transcribeAudio(buffer);
      await sendMessage(`🎤 _Распознано:_ "${text}"`);
    }

    if (text) {
      // Проверяем — не событие ли это для календаря
      const calKeywords = /календар|встреч|событи|запиши на|назначь|совещани|звонок|созвон|ужин|обед|поездк/i;
      if (calKeywords.test(text)) {
        try {
          const parsed = await parseCalendarEvent(text);
          if (parsed.is_event) {
            await createCalendarEvent(parsed.summary, parsed.start, parsed.end);
            const dateStr = new Date(parsed.start + '+03:00').toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
            await sendMessage(`📅 Событие добавлено в календарь:\n*${parsed.summary}*\n${dateStr}`);
            return;
          }
        } catch (e) {
          console.error('Calendar error:', e.message);
        }
      }
      await processText(text, data);
      saveTasks(data);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ─── /tasks — список задач для cron ──────────────────────────────
app.get('/tasks', (req, res) => {
  const data = loadTasks();
  res.json(data);
});

app.post('/tasks/replace', (req, res) => {
  const secret = req.headers['x-secret'];
  if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  const data = req.body;
  saveTasks(data);
  res.json({ ok: true });
});

// ─── /summary — резюме дня для cron ──────────────────────────────
app.post('/summary', async (req, res) => {
  res.json({ status: 'started' });
  try {
    const messages = loadMessages();
    const nowMSK = new Date(Date.now() + 3 * 3600 * 1000);
    const startOfDay = new Date(nowMSK);
    startOfDay.setHours(0, 0, 0, 0);
    const startTimestamp = (startOfDay.getTime() - 3 * 3600 * 1000) / 1000;

    const todayMessages = messages.filter(m => m.date >= startTimestamp);
    const summary = await makeDailySummary(todayMessages);
    await sendMessage(summary);
  } catch (e) {
    console.error('/summary error:', e.message);
    await sendMessage('⚠️ Ошибка при формировании резюме дня.');
  }
});

app.get('/messages', (req, res) => {
  const messages = loadMessages();
  res.json(messages.slice(-50));
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
