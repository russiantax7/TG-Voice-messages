



Ежедневное резюме рабочего чата
Я добавлю чат-бота к рабочему чату для. Твоя задача читать что там написано и каждый день в 21:00 по рабочим дням кроме праздников и выходных - краткое резюме дня делать. Какие вопросы и проблемы поднимались, получили или они решение и т.д.

Хорошо, вижу что бот (@galp_ai_bot) уже настроен и подключён. Нужно уточнить несколько вещей перед настройкой расписания.

В какой чат отправлять резюме — в тот же рабочий чат или тебе лично?
Лично тебе
Какой chat_id у нового рабочего чата? (или это тот же чат -5570418094 из предыдущей задачи с Анастасией?)
Добавил бота только что
Российские праздники учитываем автоматически, но бывают ли у вас корпоративные выходные или переносы, о которых нужно знать заранее?
Только официальные РФ


Вижу новый чат — GALP Tax с chat_id -462206422. Именно туда ты только что добавил бота. Теперь настраиваю расписание.




Отлично. Теперь составлю точное расписание: 21:00 МСК = 18:00 UTC. Пн–пт — это 1-5 в cron. Праздники РФ буду проверять программно в bash_script.



Всё готово. Настроена следующая схема:

Чат-источник: GALP Tax (-462206422)
Куда приходит резюме: тебе лично в Telegram от @galp_ai_bot
Расписание: пн–пт в 21:00 МСК
Праздники РФ: автоматически пропускаются (все 8 официальных дат)

Первый запуск — завтра, 15 июня (пн) в 21:00 МСК.

Формат резюме будет примерно такой:

text
📋 Резюме дня — 15.06.2026

Ключевые темы:
— ...

Решено:
— ...

В работе / Открытые вопросы:
— ...

Итог дня: ...
Если в чате за день ничего не было — придёт короткое уведомление об этом.

Я тебя добавлю еще в несколько чатов рабочих. Резюме делай по ним по всем одно. Потому что в них примерно одни и теже члены команды и задачи связаны между чатами.
Хорошо, добавляй бота в нужные чаты. Как только добавишь — напиши мне, я подхвачу все новые chat_id автоматически из обновлений и обновлю задачу, чтобы резюме собиралось сразу по всем чатам в одном сообщении.

Добавил

Backup текст ушел. Но все еще после каждой задачи пишет общий список и закрепляет его. Исправь.
Проблема в том что updatePinnedList вызывается при changed = true, а это происходит при каждом добавлении задачи. Убираю автоматическое обновление закреплённого после каждой задачи — закреплённое будет обновляться только по команде закрепить или обновить список.


Теперь закреплённое сообщение обновляется только если написать боту закрепить или обновить список — добавлю эту команду в GPT-обработчик:




Залей на GitHub. Теперь:

После добавления задачи — только ✅ Задача добавлена, никакого списка

Закреплённое обновляется только когда напишешь боту закрепить или обновить список


index.js
JavaScript

Surface every overdue and today-due task from my personal tasker each weekday morning before the workday starts at 9:00 MSK
Таск-менеджер GALP — обработка сообщений · следующий запуск: через 8 часов 50 минут
Ежедневное резюме рабочих чатов GALP · следующий запуск: через 18 часов 33 минуты
Таск-менеджер GALP — утренний план дня · следующий запуск: через 7 часов 33 минуты
index
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

// ─── File storage ─────────────────────────────────────────────────
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

// ─── Pinned list ──────────────────────────────────────────────────
async function updatePinnedList(data) {
  try {
    // Удаляем старое
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

// ─── GPT-4o ───────────────────────────────────────────────────────
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
  "command": "list" | "done" | "delete" | "postpone" | null,
  "command_arg": "номер или текст задачи или null",
  "command_deadline": "YYYY-MM-DD или null",
  "reason": "если unclear"
}

Правила:
- tasks: перефразируй лаконично с глагола, разбей на отдельные если несколько в одном сообщении
- command: команды управления (показать список, закрыть, удалить, перенести дедлайн, закрепить/обновить список — command="pin")
- unclear: цитата, пересланный текст, вопрос, разговорная фраза — спроси подтверждение
- Сегодня: ${new Date().toISOString().slice(0, 10)}`
    }],
    response_format: { type: 'json_object' },
    temperature: 0.2
  }, { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' } });

  return JSON.parse(res.data.choices[0].message.content);
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

// ─── Message processor ────────────────────────────────────────────
async function processText(text, data) {
  const lower = text.toLowerCase().trim();

  // Подтверждение/отмена pending задач
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

  // GPT
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
