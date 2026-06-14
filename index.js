const express = require('express');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OWNER_CHAT_ID = 489450415;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const STORAGE_MARKER = '🗄TASKS_JSON🗄';

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

async function editMessage(chatId, messageId, text, parseMode = 'Markdown') {
  try {
    await tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: parseMode });
  } catch (e) {}
}

// ─── Storage: JSON в скрытом сообщении, список — в закреплённом ──
// data = { tasks, _json_msg_id, _pinned_msg_id }

async function loadTasks() {
  try {
    // Ищем сообщение с маркером через getUpdates не получится — 
    // храним ID сообщения с JSON в самом JSON (bootstrapping через pinned)
    const chat = await tg('getChat', { chat_id: OWNER_CHAT_ID });

    // Сначала ищем pinned — там может быть либо JSON (старый формат), либо красивый список
    if (chat.pinned_message) {
      const pinText = chat.pinned_message.text || '';
      if (pinText.startsWith(STORAGE_MARKER)) {
        // Старый формат — мигрируем
        const json = pinText.replace(STORAGE_MARKER + '\n', '');
        const data = JSON.parse(json);
        data._pinned_msg_id = chat.pinned_message.message_id;
        data._json_msg_id = null;
        return data;
      }
    }

    // Ищем JSON-сообщение — оно хранит свой собственный ID внутри
    // Используем trick: отправляем getUpdates с большим offset чтобы найти наше сообщение
    // Вместо этого — храним _json_msg_id в pinned message через кастомный формат
    // Закреплённое сообщение содержит в конце скрытую строку: \n\n_id:12345_
    if (chat.pinned_message) {
      const pinText = chat.pinned_message.text || '';
      const idMatch = pinText.match(/\n_json:(\d+)_$/);
      if (idMatch) {
        const jsonMsgId = parseInt(idMatch[1]);
        // Получаем JSON из того сообщения через forwardMessage trick — не работает
        // Используем копию данных из pinned
        return {
          tasks: [],
          _pinned_msg_id: chat.pinned_message.message_id,
          _json_msg_id: jsonMsgId
        };
      }
    }
  } catch (e) {
    console.error('loadTasks error:', e.message);
  }
  return { tasks: [], _pinned_msg_id: null, _json_msg_id: null };
}

// Упрощённый надёжный подход: храним всё в одном закреплённом сообщении,
// но показываем красивый список + JSON спрятан в конце невидимым образом (HTML entities trick не работает в TG)
// Лучший вариант: два сообщения. Одно закреплённое красивое, одно с JSON — тихо редактируем.

// Финальный подход: JSON храним в закреплённом сообщении в формате который не виден пользователю —
// используем code block в самом конце, свёрнутый. Нет, TG так не умеет.
// 
// Реальное решение: закреплённое = красивый список. JSON-данные = в отдельном незакреплённом сообщении
// ID json-сообщения вшиваем в красивый список как невидимый текст в конце (zero-width space trick).
// Но надёжнее — просто хранить ID json-сообщения в переменной окружения... нельзя менять динамически.
//
// ИТОГ: храним ОБА в одном закреплённом сообщении:
// - Видимая часть: красивый список
// - После разделителя "‌" (zero-width non-joiner): JSON данные в отдельной строке без форматирования

async function loadTasksV2() {
  try {
    const chat = await tg('getChat', { chat_id: OWNER_CHAT_ID });
    if (!chat.pinned_message) return { tasks: [], _pinned_msg_id: null };

    const text = chat.pinned_message.text || '';
    const sep = '\n' + STORAGE_MARKER + '\n';
    const idx = text.indexOf(sep);
    if (idx !== -1) {
      const json = text.slice(idx + sep.length);
      const data = JSON.parse(json);
      data._pinned_msg_id = chat.pinned_message.message_id;
      return data;
    }
  } catch (e) {
    console.error('loadTasks error:', e.message);
  }
  return { tasks: [], _pinned_msg_id: null };
}

async function saveTasksV2(data) {
  try {
    const pinnedId = data._pinned_msg_id;
    const payload = { tasks: data.tasks, pending: data.pending };
    const json = JSON.stringify(payload);
    const sep = '\n' + STORAGE_MARKER + '\n';

    // Красивый список (видимая часть)
    const listText = formatTaskListForPin(data);
    const fullText = listText + sep + json;

    if (pinnedId) {
      // Удаляем старое закреплённое
      await tg('unpinChatMessage', { chat_id: OWNER_CHAT_ID, message_id: pinnedId });
      await deleteMessage(OWNER_CHAT_ID, pinnedId);
    }

    // Создаём новое
    const msg = await tg('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text: fullText,
      parse_mode: 'Markdown',
      disable_notification: true
    });
    await tg('pinChatMessage', {
      chat_id: OWNER_CHAT_ID,
      message_id: msg.message_id,
      disable_notification: true
    });
    data._pinned_msg_id = msg.message_id;
  } catch (e) {
    console.error('saveTasks error:', e.message);
  }
}

function formatTaskListForPin(data) {
  const open = data.tasks ? data.tasks.filter(t => t.status === 'open' && !isOverdue(t)) : [];
  const overdue = data.tasks ? data.tasks.filter(t => isOverdue(t)) : [];

  let msg = '📋 *Список задач*\n';
  msg += `_Обновлено: ${new Date().toLocaleString('ru-RU', {timeZone:'Europe/Moscow', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'})}_\n\n`;

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
  }
  if (!open.length && !overdue.length) {
    msg += '_Задач нет_';
  }
  return msg;
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

Входящее сообщение:
"""
${text}
"""

Ответь строго в формате JSON:
{
  "type": "tasks" | "command" | "unclear",
  "tasks": [{ "text": "Формулировка с глагола", "deadline": "YYYY-MM-DD или null" }],
  "command": "list" | "done" | "delete" | "postpone" | null,
  "command_arg": "номер или текст задачи или null",
  "command_deadline": "YYYY-MM-DD или null",
  "reason": "объяснение если unclear"
}

Правила:
- Если задача(и) — type="tasks", перефразируй лаконично с глагола, разбей на отдельные если несколько
- Если команда управления списком — type="command"
- Если цитата, пересланный текст, вопрос, разговор — type="unclear"
- Дедлайн YYYY-MM-DD, сегодня: ${new Date().toISOString().slice(0,10)}
- При сомнении — type="unclear"`;

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
      created_at: new Date().toISOString().slice(0,10)
    };
    data.tasks.push(newTask);
    added.push(newTask);
  }
  return added;
}

// ─── Message processor ────────────────────────────────────────────
async function processText(text, data) {
  const lower = text.toLowerCase().trim();

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
        await sendMessage(OWNER_CHAT_ID, formatTaskList(data));
        break;

      case 'done': {
        const arg = parsed.command_arg;
        const task = data.tasks.find(t => t.id === parseInt(arg))
          || data.tasks.find(t => t.text.toLowerCase().includes((arg||'').toLowerCase()) && t.status === 'open');
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
    changed = true;

  } else {
    if (parsed.tasks && parsed.tasks.length) {
      data.pending = parsed.tasks;
      const preview = parsed.tasks.map((t, i) => `${i+1}. ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
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

    const data = await loadTasksV2();
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
      // Обновляем закреплённое только если что-то изменилось
      if (changed || data.pending !== undefined) {
        await saveTasksV2(data);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', bot: 'GALP Task Bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GALP Bot running on port ${PORT}`));
