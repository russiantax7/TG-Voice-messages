const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { google } = require('googleapis');

// ─── Google Calendar ──────────────────────────────────────────────
const CALENDAR_ID = 'aguskov@galp.ru';
const SUMMARY_HOUR = 20; // Час отправки резюме (МСК) — менять только здесь

// ─── Справочник контактов ─────────────────────────────────────────
const CONTACTS = [
  { email: 'mkharitidi@galp.ru',      names: ['харитиди', 'марина харитиди', 'марина'] },
  { email: 'ykan@galp.ru',            names: ['кан', 'юлиана кан', 'юлиана'] },
  { email: 'iguskov@galp.ru',         names: ['игорь гуськов', 'игорь', 'гуськов игорь'] },
  { email: 'gknyazeva@galp.ru',       names: ['князева', 'галина князева', 'галина', 'галя'] },
  { email: 'okostrukova@galp.ru',     names: ['кострюкова', 'оксана кострюкова', 'оксана'] },
  { email: 'sofiaguskova537@gmail.com', names: ['софия', 'софик', 'соня', 'дочь', 'дочка', 'дочки', 'гускова'] },
];

function resolveAttendees(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const contact of CONTACTS) {
    if (contact.names.some(n => lower.includes(n))) {
      if (!found.includes(contact.email)) found.push(contact.email);
    }
  }
  return found;
}
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

async function createCalendarEvent(summary, startDateTime, endDateTime, description, timezone, location, attendees) {
  const calendar = getCalendarClient();
  const tz = timezone || 'Europe/Moscow';
  const event = {
    summary,
    description: description || '',
    start: { dateTime: startDateTime, timeZone: tz },
    end:   { dateTime: endDateTime,   timeZone: tz }
  };
  if (location) event.location = location;
  if (attendees && attendees.length > 0) {
    event.attendees = attendees.map(email => ({ email }));
  }
  const res = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: event, sendUpdates: attendees && attendees.length > 0 ? 'all' : 'none' });
  return res.data;
}

// ─── Events storage ──────────────────────────────────────────────
function loadEvents() {
  try { return JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8')); } catch { return []; }
}
function saveEvents(events) {
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(events, null, 2));
}
async function deleteCalendarEvent(eventId) {
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
}
async function updateCalendarEvent(eventId, summary, startDateTime, endDateTime, timezone, location, attendees) {
  const calendar = getCalendarClient();
  const tz = timezone || 'Europe/Moscow';
  const requestBody = {
    summary,
    start: { dateTime: startDateTime, timeZone: tz },
    end:   { dateTime: endDateTime,   timeZone: tz }
  };
  if (location) requestBody.location = location;
  if (attendees && attendees.length > 0) requestBody.attendees = attendees.map(email => ({ email }));
  await calendar.events.patch({
    calendarId: CALENDAR_ID, eventId, requestBody,
    sendUpdates: attendees && attendees.length > 0 ? 'all' : 'none'
  });
}

async function parseCalendarEvent(text) {
  // Используем GPT чтобы распарсить дату/время/название события
  const today = new Date().toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const res = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: `Ты парсишь текст и извлекаешь событие для календаря. Сегодня: ${today} (часовой пояс Europe/Moscow). Верни JSON: {"action": "create/delete/update", "summary": "название", "start": "YYYY-MM-DDTHH:MM:SS", "end": "YYYY-MM-DDTHH:MM:SS", "timezone": "часовой пояс", "location": "адрес или null", "attendees": ["email1", "email2"] или [], "search_query": "ключевые слова для поиска", "is_event": true/false}. Правила: 1) action=create — новое событие. action=delete — удалить (заполни search_query). action=update — перенести/изменить (заполни search_query и новые поля). 2) Если в тексте упомянут город — определи часовой пояс (Дубай → Asia/Dubai, Лондон → Europe/London, Нью-Йорк → America/New_York), иначе Europe/Moscow. 3) location — адрес встречи если упомянут, иначе null. 4) attendees — список email участников если упомянуты, иначе []. 5) Если это не событие или это рассказ о прошедшем событии ("встретился", "был на встрече", "обсудили") — is_event: false. 6) Если время окончания не указано — добавь 1 час. Верни только JSON без markdown.` },
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
const EVENTS_FILE = '/data/events.json';

// Известные рабочие чаты
const WORK_CHATS_DEFAULT = [-462206422, -788559454, -5570418094, -5161080891, -5077349043];
const WORK_CHATS_FILE = '/data/work_chats.json';

function loadWorkChats() {
  try {
    const data = JSON.parse(fs.readFileSync(WORK_CHATS_FILE, 'utf8'));
    return new Set(data);
  } catch {
    return new Set(WORK_CHATS_DEFAULT);
  }
}
function saveWorkChats(set) {
  fs.writeFileSync(WORK_CHATS_FILE, JSON.stringify([...set]));
}

WORK_CHATS = loadWorkChats();
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
  "command_arg": "номер или текст задачи (для одиночных команд) или null",
  "command_args": [1, 2, 3],
  "command_deadline": "YYYY-MM-DD или null",
  "reason": "если unclear"
}

Правила:
- tasks: перефразируй лаконично с глагола, разбей на отдельные если несколько
- command: list=показать список, done=выполнено, delete=удалить, postpone=перенести дедлайн, pin=закрепить/обновить список, reminders_on=включить уведомления календаря, reminders_off=выключить уведомления календаря
- command_args: если в команде несколько ID ("удали 1, 2, 3" или "готово 1 2 3") — заполни массив числами. Иначе пустой массив [].
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
        const doneIds = (parsed.command_args && parsed.command_args.length > 0)
          ? parsed.command_args.map(Number)
          : [parseInt(parsed.command_arg)].filter(n => !isNaN(n));
        if (doneIds.length > 0) {
          const completed = [];
          const notFound = [];
          for (const id of doneIds) {
            const task = data.tasks.find(t => t.id === id && t.status === 'open');
            if (task) { task.status = 'done'; completed.push(task); changed = true; }
            else notFound.push(id);
          }
          if (completed.length > 0) {
            const list = completed.map(t => `#${t.id} — _${t.text}_`).join('\n');
            await sendMessage(`✔️ *Выполнено задач: ${completed.length}*\n${list}`);
          }
          if (notFound.length > 0) await sendMessage(`❌ Не найдены: ${notFound.map(id => '#'+id).join(', ')}`);
        } else {
          // Поиск по тексту
          const arg = parsed.command_arg;
          const task = data.tasks.find(t => t.text.toLowerCase().includes((arg || '').toLowerCase()) && t.status === 'open');
          if (task) { task.status = 'done'; await sendMessage(`✔️ *Задача выполнена* (#${task.id})\n_${task.text}_`); changed = true; }
          else await sendMessage(`❌ Задача не найдена: _${arg}_`);
        }
        break;
      }

      case 'delete': {
        // Поддержка массового удаления: command_args (массив) или command_arg (одиночный)
        const deleteIds = (parsed.command_args && parsed.command_args.length > 0)
          ? parsed.command_args.map(Number)
          : [parseInt(parsed.command_arg)].filter(n => !isNaN(n));
        const deleted = [];
        const notFound = [];
        for (const id of deleteIds) {
          const idx = data.tasks.findIndex(t => t.id === id);
          if (idx !== -1) { deleted.push(data.tasks.splice(idx, 1)[0]); changed = true; }
          else notFound.push(id);
        }
        if (deleted.length > 0) {
          const list = deleted.map(t => `#${t.id} — _${t.text}_`).join('\n');
          await sendMessage(`🗑 *Удалено задач: ${deleted.length}*\n${list}`);
        }
        if (notFound.length > 0) await sendMessage(`❌ Не найдены: ${notFound.map(id => '#'+id).join(', ')}`);
        break;
      }

      case 'postpone': {
        const task = data.tasks.find(t => t.id === parseInt(parsed.command_arg));
        if (task && parsed.command_deadline) { task.deadline = parsed.command_deadline; await sendMessage(`📅 *Дедлайн обновлён* (#${task.id})\n_${task.text}_\nНовый: ${formatDate(task.deadline)}`); changed = true; }
        else await sendMessage('❌ Не удалось обновить дедлайн');
        break;
      }

      case 'reminders_on':
        calendarRemindersEnabled = true;
        await sendMessage('🔔 Уведомления о событиях *включены*');
        break;

      case 'reminders_off':
        calendarRemindersEnabled = false;
        await sendMessage('🔕 Уведомления о событиях *выключены*');
        break;

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
    // Бота добавили в новую группу — автоматически добавляем в WORK_CHATS
    if (update.my_chat_member) {
      const member = update.my_chat_member;
      const chat = member.chat;
      const newStatus = member.new_chat_member?.status;
      if ((chat.type === 'group' || chat.type === 'supergroup') && newStatus === 'member' || newStatus === 'administrator') {
        if (!WORK_CHATS.has(chat.id)) {
          WORK_CHATS.add(chat.id);
          saveWorkChats(WORK_CHATS);
          await sendMessage(`✅ Группа *${chat.title}* (${chat.id}) добавлена в список для резюме.`);
        }
      }
      // Бота удалили из группы
      if (newStatus === 'left' || newStatus === 'kicked') {
        if (WORK_CHATS.has(chat.id)) {
          WORK_CHATS.delete(chat.id);
          saveWorkChats(WORK_CHATS);
          await sendMessage(`❌ Группа *${chat.title}* удалена из списка резюме (бот удалён).`);
        }
      }
      return res.sendStatus(200);
    }

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
    // Новый пользователь (не владелец и не рабочий чат) — лидогенерация
    // Только личные чаты (private) — группы игнорируем
    if (chatId !== OWNER_CHAT_ID && msg.chat.type === 'private') {
      try {
        let userText = msg.text || msg.caption || null;
        // Если голосовое — расшифровываем
        if (!userText && (msg.voice || msg.audio)) {
          const buffer = await downloadVoice((msg.voice || msg.audio).file_id);
          userText = await transcribeAudio(buffer);
        }
        if (!userText) return;

        const from = msg.from || {};
        const username = from.username ? `@${from.username}` : 'без ника';
        const fullName = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Неизвестно';

        // Приветствие — первое сообщение (message_id=1) или /start
        const isFirstMessage = msg.message_id === 1 || (msg.text && msg.text.startsWith('/start'));
        const replyText = isFirstMessage
          ? `Здравствуйте! Мы шагаем в ногу со временем и приветствуем персональный неординарный подход во всём. Опишите текстом или голосовым Ваш запрос и с Вами свяжется самый подходящий эксперт из нашей команды.

С уважением,
управляющий партнёр Гуськов Александр вместе с Guskov & Associates AI`
          : `Спасибо, получено. Вернёмся в ближайшее время.`;

        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: replyText
        });

        // Уведомление владельцу и в GALP Tax
        const notify = `📩 *Новое сообщение с сайта galp.ru*
От: ${username} (${fullName})
Текст: _"${userText}"_`;
        await sendMessage(notify); // владельцу в личку
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: -462206422, // GALP Tax
          text: notify,
          parse_mode: 'Markdown'
        });
      } catch (e) {
        console.error('Lead handler error:', e.message);
      }
      return;
    }

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
      // Сообщение для помощницы — переслать в PA Shindyaeva
      const assistantMatch = text.match(/^(?:анастасии|для помощницы|напиши анастасии|помощнице|скажи помощнице|скажи насте|скажи анастасии|поставь задачу для помощницы|поставь задачу для насти|поставь задачу анастасии|задача для помощницы|задача для насти|задача анастасии|для насти|настя)[:.\s]+(.+)/is);
      if (assistantMatch) {
        const msgForAssistant = assistantMatch[1].trim();
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: -5570418094, // PA Shindyaeva
          text: `📋 *Задача от Александра:*\n${msgForAssistant}`,
          parse_mode: 'Markdown'
        });
        await sendMessage(`✅ Отправлено Анастасии:\n_${msgForAssistant}_`);
        return;
      }

      // Проверяем — не команда ли это для календаря
      // Только явные команды на добавление/изменение события (не рассказы о прошлом)
      const calKeywords = /запиши на|запишь|назначь|добавь в календар|в календар|создай встреч|запланируй|запланиров|созвон на|встреча в пятн|встреча в пон|встреча в вт|встреча в ср|встреча в чет|встреча в суб|встреча в вос|встреча завтра|встреча сегодня|ужин в|обед в|поездка в|перенеси|перенес|измени|измень|измени название|переименуй|переименова|сдвинь|сдвин|удали встреч|удали событи|отмени|отмень|удали событ|удали встреч|убери событ|убери встреч|в календаре|событие в|событие на/i;
      if (calKeywords.test(text)) {
        try {
          // Нормализация: Whisper иногда пишет "собачка" вместо "@"
          const normalizedText = text
            .replace(/собачка([а-яёa-z0-9._-]+\.[а-яёa-z]{2,})/gi, '@$1')
            .replace(/собачка/gi, '@');
          const parsed = await parseCalendarEvent(normalizedText);
          if (parsed.is_event) {
            const tz = parsed.timezone || 'Europe/Moscow';
            const action = parsed.action || 'create';
            const tzLabel = tz === 'Europe/Moscow' ? 'МСК' : tz;
            const fmtDate = (s) => { const [dp,tp] = s.split('T'); const [,m,d] = dp.split('-'); const [hh,mm] = tp.split(':'); return `${d}.${m} ${hh}:${mm}`; };

            if (action === 'create') {
              // Объединяем attendees от GPT + из справочника по именам в тексте
              const resolvedEmails = resolveAttendees(normalizedText);
              const gptEmails = (parsed.attendees || []);
              const allAttendees = [...new Set([...gptEmails, ...resolvedEmails])];
              const created = await createCalendarEvent(parsed.summary, parsed.start, parsed.end, '', tz, parsed.location, allAttendees);
              const events = loadEvents();
              events.push({ id: created.id, summary: parsed.summary, start: parsed.start });
              saveEvents(events);
              let confirmMsg = `📅 Событие добавлено в календарь:\n*${parsed.summary}*\n${fmtDate(parsed.start)} (${tzLabel})`;
              if (parsed.location) confirmMsg += `\n📍 ${parsed.location}`;
              if (parsed.attendees && parsed.attendees.length > 0) confirmMsg += `\n👥 ${parsed.attendees.join(', ')}`;
              await sendMessage(confirmMsg);
              return;
            }

            if (action === 'delete' || action === 'update') {
              const events = loadEvents();
              const q = (parsed.search_query || parsed.summary || '').toLowerCase();
              const found = events.find(e => e.summary.toLowerCase().includes(q) || q.split(' ').some(w => w.length > 2 && e.summary.toLowerCase().includes(w)));
              if (!found) {
                await sendMessage(`❓ Не нашёл событие: _${parsed.search_query || parsed.summary}_\nПопробуй уточнить название.`);
                return;
              }
              if (action === 'delete') {
                await deleteCalendarEvent(found.id);
                saveEvents(events.filter(e => e.id !== found.id));
                await sendMessage(`🗑 Событие удалено:\n*${found.summary}*`);
              } else {
                const resolvedEmailsUpd = resolveAttendees(normalizedText);
                const allAttendeesUpd = [...new Set([...(parsed.attendees || []), ...resolvedEmailsUpd])];
                await updateCalendarEvent(found.id, found.summary, parsed.start, parsed.end, tz, parsed.location, allAttendeesUpd);
                saveEvents(events.map(e => e.id === found.id ? { ...e, start: parsed.start } : e));
                let updateMsg = `📅 Событие обновлено:\n*${found.summary}*\n${fmtDate(parsed.start)} (${tzLabel})`;
                if (parsed.location) updateMsg += `\n📍 ${parsed.location}`;
                if (parsed.attendees && parsed.attendees.length > 0) updateMsg += `\n👥 ${parsed.attendees.join(', ')}`;
                await sendMessage(updateMsg);
              }
              return;
            }
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

    // Окно: с 20:00 предыдущего рабочего дня до сейчас
    // В понедельник — с 20:00 пятницы
    const dayOfWeek = nowMSK.getDay(); // 0=вс, 1=пн, ..., 5=пт, 6=сб
    const daysBack = dayOfWeek === 1 ? 3 : 1; // пн → 3 дня назад (пт), иначе 1 день
    const prevDay = new Date(nowMSK);
    prevDay.setDate(prevDay.getDate() - daysBack);
    prevDay.setHours(SUMMARY_HOUR, 0, 0, 0);
    const startTimestamp = (prevDay.getTime() - 3 * 3600 * 1000) / 1000;
    const todayMsgs = messages.filter(m => m.date >= startTimestamp);
    const dateStr = nowMSK.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

    const makeSummary = async (msgs, title) => {
      if (msgs.length === 0) {
        await sendMessage(`📋 *${title} — ${dateStr}*\n\nСообщений сегодня не было.`);
        return;
      }
      const text = msgs.map(m => `[${m.chat_name}] ${m.from}: ${m.text}`).join('\n');

      const isPA = title.includes('Shindyaeva');
      const systemPrompt = isPA
        ? `Ты бизнес-аналитик. Анализируй переписку между Alexander и его личным ассистентом Анастасией. Имена бери из поля from.

Формат:
*🗣 Вопросы и обсуждения*
— что спрашивал Alexander, какие ответы получил

*📋 Статус задач*
— задача — статус (выполнена / в работе / не начата)

*✅ Что сделано*
— что Анастасия выполнила или подтвердила сегодня

*⏳ В работе*
— что ещё не закрыто, дедлайн если есть

*❗️ Требует внимания*
— что зависло, не получило ответа или требует решения Alexander

*📎 Список задач от Анастасии*
— если она прислала свой вечерний список — воспроизведи полностью

Правила: пустые разделы пропускай. Не додумывай. Задача выполнена если есть подтверждение («готово», «сделал», «отправил»). Пиши на русском, кратко и по делу. Используй Markdown (*, —).`
        : `Ты бизнес-аналитик, работающий в компании которая занимается налогами, регистрацией компаний за рубежом и решением юридических задач для состоятельных бенефициаров. Анализируй переписку рабочего чата и составляй структурированное резюме. Имена участников бери из поля from.

Формат:
*🔑 Главное за день*
— топ-3 самых важных момента: решения, деньги, дедлайны

*🗣 Темы обсуждений*
— тема: краткое описание, кто участвовал

*✅ Поставленные задачи*
— задача — кто поставил — кому — срок (если есть)

*☑️ Выполненные / закрытые*
— что завершено или подтверждено выполненным

*👥 Без участия Alexander*
— что обсуждалось между остальными

*💡 Важные факты*
— цифры, даты, контакты, договорённости

Правила: пустые разделы пропускай. Не додумывай — только то что есть в переписке. Задача считается поставленной если кто-то явно просит что-то сделать. Задача считается выполненной если есть подтверждение («готово», «сделал», «отправил»). Пиши на русском, кратко и по делу. Используй Markdown (*, —).`;

      const r = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text }
        ]
      }, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } });
      await sendMessage(`📋 *${title} — ${dateStr}*\n\n${r.data.choices[0].message.content}`);
    };

    const paMsgs = todayMsgs.filter(m => m.chat_name === 'PA Shindyaeva');
    const otherMsgs = todayMsgs.filter(m => m.chat_name !== 'PA Shindyaeva');

    await makeSummary(paMsgs, 'Резюме: PA Shindyaeva');
    await makeSummary(otherMsgs, 'Резюме: Рабочие чаты');
  } catch (e) {
    console.error('/summary error:', e.message);
    await sendMessage('⚠️ Ошибка при формировании резюме дня.');
  }
});


// ─── /check-events — проверка предстоящих событий (для cron каждые 15 мин) ───
app.get('/check-events', async (req, res) => {
  res.json({ status: 'started' });
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const in10 = new Date(now.getTime() + 10 * 60 * 1000);
    const in20 = new Date(now.getTime() + 20 * 60 * 1000);

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: in10.toISOString(),
      timeMax: in20.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];
    for (const event of events) {
      const start = event.start.dateTime || event.start.date;
      const startDate = new Date(start);
      const timeStr = startDate.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
      let msg = `🔔 *Через 15 минут:* ${event.summary}\n🕐 ${timeStr}`;
      if (event.location) msg += `\n📍 ${event.location}`;
      if (event.attendees && event.attendees.length > 1) {
        const others = event.attendees.filter(a => a.email !== CALENDAR_ID).map(a => a.displayName || a.email);
        if (others.length > 0) msg += `\n👥 ${others.join(', ')}`;
      }
      await sendMessage(msg);
    }
  } catch (e) {
    console.error('check-events error:', e.message);
  }
});

app.get('/messages', (req, res) => {
  const messages = loadMessages();
  res.json(messages.slice(-50));
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));

// ─── Напоминания о событиях каждые 15 мин ────────────────────────
let calendarRemindersEnabled = true;
const sentReminders = new Set(); // eventId → уже отправлено

setInterval(async () => {
  if (!calendarRemindersEnabled) return;
  try {
    const calendar = getCalendarClient();
    const now = new Date();
    const in10 = new Date(now.getTime() + 10 * 60 * 1000);
    const in20 = new Date(now.getTime() + 20 * 60 * 1000);

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: in10.toISOString(),
      timeMax: in20.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = response.data.items || [];
    for (const event of events) {
      // Ключ = eventId + дата начала — чтобы не слать дважды про одно событие
      const key = `${event.id}_${event.start.dateTime || event.start.date}`;
      if (sentReminders.has(key)) continue;
      sentReminders.add(key);

      // Чистим старые ключи (старше 2 часов)
      if (sentReminders.size > 100) sentReminders.clear();

      const start = event.start.dateTime || event.start.date;
      const startDate = new Date(start);
      const timeStr = startDate.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
      let msg = `🔔 *Через 15 минут:* ${event.summary}\n🕐 ${timeStr}`;
      if (event.location) msg += `\n📍 ${event.location}`;
      if (event.attendees && event.attendees.length > 1) {
        const others = event.attendees.filter(a => a.email !== CALENDAR_ID).map(a => a.displayName || a.email);
        if (others.length > 0) msg += `\n👥 ${others.join(', ')}`;
      }
      await sendMessage(msg);
    }
  } catch (e) {
    console.error('Calendar reminder error:', e.message);
  }
}, 15 * 60 * 1000);
