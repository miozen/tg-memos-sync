// [Category B] Dispatcher: Webhook entry point and request router.
export default {
  async fetch(request, env, ctx) {
    // [Category A] HTTP Method & Path validation for security
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== `/${env.SECRET_PATH}`) {
      return new Response("Unauthorized or Invalid Request", { status: 403 });
    }

    try {
      const update = await request.json();
      
      // [Category B] Interaction Routing: Handle button clicks
      if (update.callback_query) {
        ctx.waitUntil(handleCallback(update.callback_query, env));
        return new Response("OK");
      }

      // [Category B] Ingress Routing: Handle incoming messages
      if (update.message) {
        ctx.waitUntil(handleMessage(update.message, env));
        return new Response("OK");
      }

      return new Response("OK");
    } catch (error) {
      // [Category C] NOTE: Silent fail on serverless edge to prevent webhook retries from TG.
      console.error("Worker Error:", error);
      return new Response("Error", { status: 500 });
    }
  }
};

// ==========================================
// 核心业务函数 (Core Business Functions)
// ==========================================

async function handleMessage(msg, env) {
  // [Category A] Extract basic identifiers
  const chatId = msg.chat.id;
  const messageId = msg.message_id;
  const text = msg.caption || msg.text || "";
  
  // [Category C] WARNING: KV is eventually consistent. We use msg.message_id as unique key suffixes 
  // to avoid race conditions when TG sends media groups concurrently.
  const sessionId = msg.media_group_id || `single_${messageId}`;

  // 1. 若有图片，取最高清晰度的 file_id 并存入 KV
  if (msg.photo && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    await env.MEMOS_KV.put(`media_${sessionId}_${messageId}`, bestPhoto.file_id, { expirationTtl: 3600 });
  }

  // 2. 存入文本 (确保一个 session 只存一次有效文本)
  if (text) {
    await env.MEMOS_KV.put(`text_${sessionId}`, text, { expirationTtl: 3600 });
  }

  // 3. 触发 UI 交互 (针对单图或图组的主消息触发一次)
  // [Category C] NOTE: To avoid spamming buttons for media groups, we only send the button 
  // if the message has text, or if it's a single photo without text.
  if (text || !msg.media_group_id) {
    await sendInlineKeyboard(env, chatId, sessionId);
  }
}

async function handleCallback(callbackQuery, env) {
  const [action, visibility, sessionId] = callbackQuery.data.split("|");
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  if (action !== "vis") return;

  // [Category A] Update UI state to prevent duplicate processing
  await editMessageText(env, chatId, messageId, `🚀 正在以 ${visibility} 模式同步处理中...`);

  try {
    // 1. 从 KV 聚合状态
    const textData = await env.MEMOS_KV.get(`text_${sessionId}`) || "";
    const listData = await env.MEMOS_KV.list({ prefix: `media_${sessionId}_` });
    const fileIds = [];
    for (const key of listData.keys) {
      const fileId = await env.MEMOS_KV.get(key.name);
      if (fileId) fileIds.push(fileId);
    }

    // 2. [Category B] Storage Synchronization: Upload to Memos
    const resourceNames = [];
    for (const fId of fileIds) {
      const resourceName = await uploadToMemos(env, fId);
      if (resourceName) resourceNames.push(resourceName);
    }
    
    const memosSuccess = await postToMemos(env, textData, visibility, resourceNames);

    // 3. [Category B] Channel Forwarding: Send to Telegram Channel
    const targetChannel = visibility === "PUBLIC" ? env.CHANNEL_ID_PUBLIC : env.CHANNEL_ID_PRIVATE;
    const tgSuccess = await forwardToChannel(env, targetChannel, textData, fileIds);

    // 4. 清理 KV 数据并更新 UI
    for (const key of listData.keys) await env.MEMOS_KV.delete(key.name);
    await env.MEMOS_KV.delete(`text_${sessionId}`);

    const resultMsg = `✅ 同步完成！\nMemos状态: ${memosSuccess ? '成功' : '失败'}\n频道状态: ${tgSuccess ? '成功' : '失败'}`;
    await editMessageText(env, chatId, messageId, resultMsg);

  } catch (err) {
    console.error(err);
    await editMessageText(env, chatId, messageId, `❌ 处理发生严重异常: ${err.message}`);
  }
}

// ==========================================
// 外部 API 适配器层 (Adapter Layer)
// ==========================================

async function sendInlineKeyboard(env, chatId, sessionId) {
  const payload = {
    chat_id: chatId,
    text: "📦 资源已暂存，请选择同步模式：",
    reply_markup: {
      inline_keyboard: [[
        { text: "🌟 公开同步 (Public)", callback_data: `vis|PUBLIC|${sessionId}` },
        { text: "🔒 私有存档 (Private)", callback_data: `vis|PRIVATE|${sessionId}` }
      ]]
    }
  };
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
}

async function editMessageText(env, chatId, messageId, newText) {
  const payload = { chat_id: chatId, message_id: messageId, text: newText };
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/editMessageText`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
}

// [Category B] Memos Adapter: Handle File Streams to prevent memory limit exhaustion
async function uploadToMemos(env, fileId) {
  // Get file path from TG
  const getFileRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const fileData = await getFileRes.json();
  if (!fileData.ok) return null;
  
  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_TOKEN}/${fileData.result.file_path}`;
  const imageStreamRes = await fetch(fileUrl);
  
  // Upload to Memos V1 API via multipart/form-data
  const formData = new FormData();
  // [Category C] NOTE: Using generic filename. Memos uses internal UUIDs for storage mapping.
  formData.append("file", imageStreamRes.body, "tg_image.jpg"); 

  const uploadRes = await fetch(`${env.MEMOS_BASE_URL}/api/v1/resources`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.MEMOS_TOKEN}` },
    body: formData
  });

  if (uploadRes.ok) {
    const resJson = await uploadRes.json();
    return resJson.name; // e.g., "resources/xxxx-xxxx"
  }
  return null;
}

async function postToMemos(env, content, visibility, resourceNames) {
  let imgMarkdown = "";
  let resources = [];

  if (resourceNames.length > 0) {
    imgMarkdown = "\n";
    for (const name of resourceNames) {
      imgMarkdown += `\n![image](${env.MEMOS_BASE_URL}/file/${name}/image.jpg)`;
      resources.push({ name: name });
    }
  }

  const payload = {
    content: `${content}${imgMarkdown}`.trim(),
    visibility: visibility.toUpperCase(),
    resources: resources
  };

  const res = await fetch(`${env.MEMOS_BASE_URL}/api/v1/memos`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.MEMOS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return res.ok;
}

async function forwardToChannel(env, targetChannel, text, fileIds) {
  if (fileIds.length === 0) {
    // 纯文本
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChannel, text: text })
    });
    return res.ok;
  } else if (fileIds.length === 1) {
    // 单图
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendPhoto`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChannel, photo: fileIds[0], caption: text })
    });
    return res.ok;
  } else {
    // 图组
    // [Category A] Assemble InputMediaPhoto array for Telegram sendMediaGroup API
    const media = fileIds.map((fId, index) => ({
      type: "photo",
      media: fId,
      caption: index === 0 ? text : "" // 仅在第一张图附加文本
    }));
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMediaGroup`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: targetChannel, media: media })
    });
    return res.ok;
  }
}
