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

// ─── Tasks storage ────────────────────────────────────────────────
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
  } catch (e) {}
  return { tasks: [] };
}

function saveTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

// ─── Telegram helpers ─────────────────────────────────────────────
async function sendMessage(chatId, text, parseMode = 'Markdown') {
  try {
    await axios.post(`${TG_API}/sendMessage`, { chat_id: chatId, text, parse_mode: parseMode });
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
    headers: { ...form.getHeaders(), 'Authorization': `Bearer ${OPENAI_API_KEY}` }
  });
  return res.data.text;
}

// ─── GPT-4o: parse message into tasks ────────────────────────────
async function parseWithGPT(text) {
  const prompt = `Ты — умный таск-менеджер. Твоя задача — разобрать входящее сообщение от пользователя.

Входящее сообщение:
"""
${text}
"""

Определи:
1. Является ли это сообщение задачей (или несколькими задачами), командой, или просто разговором/цитатой/пересланным текстом.
2. Если это задача(и) — раздели на отдельные задачи, перефразируй каждую чётко и кратко (убери лишнее, исправь опечатки, сделай формулировку чистой), извлеки дедлайн если указан.
3. Если это НЕ задача — объясни почему (команда управления списком, разговорная фраза, пересланный текст, вопрос и т.д.)

Ответь строго в формате JSON:
{
  "type": "tasks" | "command" | "unclear",
  "tasks": [
    {
      "text": "Чёткая формулировка задачи",
      "deadline": "YYYY-MM-DD или null"
    }
  ],
  "command": "list" | "done" | "delete" | "postpone" | "confirm" | "cancel" | null,
  "command_arg": "аргумент команды или null",
  "reason": "объяснение если type=unclear"
}

Правила:
- tasks заполняй только если type="tasks"
- command заполняй только если type="command"
- Если в одном сообщении несколько задач — возвращай все в массиве tasks
- Дедлайн указывай в формате YYYY-MM-DD, если не указан — null
- Сегодняшняя дата: ${new Date().toISOString().slice(0,10)}
- Перефразируй задачи чисто и лаконично на русском, начиная с глагола (позвонить, отправить, оплатить...)
- Если сомневаешься — используй type="unclear"`;

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
      created_at: new Date().toISOString().slice(0,10),
      category: 'work'
    };
    data.tasks.push(newTask);
    added.push(newTask);
  }
  return added;
}

// ─── Message processor ────────────────────────────────────────────
async function processText(text, data) {
  const lower = text.toLowerCase().trim();

  // Подтверждение/отмена ожидающих задач (быстрая проверка без GPT)
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

  // Прогоняем через GPT
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
        const byText = data.tasks.find(t => t.text.toLowerCase().includes((arg||'').toLowerCase()) && t.status === 'open');
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
        if (task && parsed.tasks && parsed.tasks[0]?.deadline) {
          task.deadline = parsed.tasks[0].deadline;
          await sendMessage(OWNER_CHAT_ID,
            `📅 *Дедлайн обновлён* (#${task.id})\n_${task.text}_\nНовый дедлайн: ${formatDate(task.deadline)}`);
        } else {
          await sendMessage(OWNER_CHAT_ID, `❌ Не удалось обновить дедлайн`);
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
    // unclear — спрашиваем
    if (parsed.tasks && parsed.tasks.length) {
      data.pending = parsed.tasks;
      const preview = parsed.tasks.map((t, i) => `${i+1}. ${t.text}${t.deadline ? ' 📅 ' + formatDate(t.deadline) : ''}`).join('\n');
      await sendMessage(OWNER_CHAT_ID, `❓ *Добавить как задачу?*\n${preview}\n\nОтвети *да* или *нет*`);
    } else {
      await sendMessage(OWNER_CHAT_ID, `❓ Не понял — это задача? Если да, перефразируй чётче или ответь *да*.\n_${parsed.reason || ''}_`);
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

    const data = loadTasks();
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
      saveTasks(data);
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', bot: 'GALP Task Bot' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`GALP Bot running on port ${PORT}`));
